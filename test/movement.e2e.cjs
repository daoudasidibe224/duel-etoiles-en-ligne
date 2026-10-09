const path = require("node:path"),
  assert = require("node:assert/strict"),
  fs = require("node:fs");
const { MongoMemoryServer } = require("mongodb-memory-server"),
  mongoose = require("mongoose"),
  MongoStore = require("connect-mongo").default;
const { chromium } = require("playwright"),
  { createApp } = require("../dist/src/app");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const store = MongoStore.create({ client: mongoose.connection.getClient() });
  const instance = createApp({
    secret: "movement-check-".repeat(6),
    store,
    gameOptions: { durationMs: 30000, random: () => 0 },
  });
  await new Promise((resolve) =>
    instance.server.listen(0, "127.0.0.1", resolve),
  );
  const base = "http://127.0.0.1:" + instance.server.address().port;
  const browser = await chromium.launch(),
    errors = [];
  try {
    const a = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      b = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
      });
    const one = await a.newPage(),
      two = await b.newPage();
    for (const page of [one, two])
      page.on("pageerror", (e) => errors.push(e.message));
    let relayMessages = 0,
      jitter = false;
    const relayDelays = [];
    let upstreamAt = 0,
      downstreamAt = 0,
      jitterIndex = 0;
    function relay(deliver, upstream) {
      const delay = 75 + (jitter ? [0, 70, 20, 110, 35][jitterIndex++ % 5] : 0);
      const at = Math.max(
        Date.now() + delay,
        (upstream ? upstreamAt : downstreamAt) + 1,
      );
      if (upstream) upstreamAt = at;
      else downstreamAt = at;
      relayDelays.push(at - Date.now());
      setTimeout(deliver, at - Date.now());
    }
    await one.routeWebSocket("**/socket.io/**", (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        relayMessages++;
        relay(() => server.send(message), true);
      });
      server.onMessage((message) => relay(() => socket.send(message), false));
    });
    for (const [page, name] of [
      [one, "Motion_Atlas"],
      [two, "Motion_Nova"],
    ]) {
      await page.goto(base + "/jouer");
      await page.getByRole("textbox", { name: "Votre pseudo" }).fill(name);
      await page.getByRole("button", { name: "Jouer par pseudo" }).click();
      await page.waitForURL("**/salon");
    }
    await one.getByRole("button", { name: "Ouvrir une partie" }).click();
    await one.waitForURL("**/salon/salonDeJeu/*");
    await two.goto(one.url());
    await one.evaluate(() => {
      const spacer = document.createElement("div");
      spacer.id = "scroll-proof-spacer";
      spacer.style.height = "2000px";
      document.body.append(spacer);
      document.body.tabIndex = -1;
      document.body.focus();
      window.scrollTo({ top: 100, behavior: "instant" });
    });
    const idleScrollBefore = await one.evaluate(() => scrollY);
    await one.keyboard.press("ArrowDown");
    await one.waitForFunction((y) => scrollY > y + 20, idleScrollBefore);
    const idleScrollDown = await one.evaluate(() => scrollY);
    await one.keyboard.press("ArrowUp");
    await one.waitForFunction((y) => scrollY < y - 20, idleScrollDown);
    const idleScrollUp = await one.evaluate(() => scrollY);
    await one.getByRole("button", { name: "Jouer", exact: true }).click();
    await one.waitForFunction(
      () =>
        document.querySelector("#gameCanvas")?.dataset.scene ===
          "lunar-arcade" &&
        document.querySelector("#gameCanvas").dataset.renderer === "canvas-2d",
    );
    const room = instance.app.salons[one.url().split("/").pop()],
      player = () =>
        room.utilisateurs.find((p) => p.nomUtilisateur === "motion_atlas");
    const rendered = () =>
      one.locator("#gameCanvas").getAttribute("data-local-x").then(Number);
    await one.evaluate(() => {
      window.scrollTo({ top: 150, behavior: "instant" });
    });
    const runningScrollBefore = await one.evaluate(() => scrollY);
    for (const key of ["ArrowDown", "ArrowUp", "ArrowDown", "ArrowUp"])
      await one.keyboard.press(key);
    await pause(250);
    const runningScrollAfter = await one.evaluate(() => scrollY);
    assert.equal(
      runningScrollAfter,
      runningScrollBefore,
      "vertical arrows do not scroll an active arena",
    );
    const toolbarChecks = [];
    for (const button of ["#sound-toggle", "#share-room"]) {
      await one.locator(button).click();
      await one.evaluate(() =>
        window.scrollTo({ top: 150, behavior: "instant" }),
      );
      const toolbarScroll = await one.evaluate(() => scrollY);
      await one.keyboard.press("ArrowDown");
      await one.keyboard.press("ArrowUp");
      await pause(150);
      assert.equal(await one.evaluate(() => scrollY), toolbarScroll);
      const beforeToolbarMove = await rendered();
      await one.keyboard.down("ArrowLeft");
      await pause(100);
      await one.keyboard.up("ArrowLeft");
      await pause(220);
      const leftToolbarMove = await rendered();
      assert.ok(
        leftToolbarMove < beforeToolbarMove - 30,
        button + " retains left input",
      );
      await one.keyboard.down("ArrowRight");
      await pause(100);
      await one.keyboard.up("ArrowRight");
      await pause(220);
      assert.ok(
        (await rendered()) > leftToolbarMove + 30,
        button + " retains right input",
      );
      toolbarChecks.push({
        button,
        scrollBefore: toolbarScroll,
        scrollAfter: await one.evaluate(() => scrollY),
      });
    }
    await one.evaluate(() => {
      document.getElementById("scroll-proof-spacer").remove();
      window.scrollTo({ top: 0, behavior: "instant" });
    });
    await one.waitForFunction(
      () =>
        Number(
          document.querySelector("#gameCanvas").dataset.localJumpOffset,
        ) === 0,
    );
    const jumpSequence = player().movementSequence + 1;
    const jumpPressedAt = Date.now();
    jitter = true;
    await one.keyboard.down("ArrowUp");
    await one.waitForFunction(
      () =>
        Number(document.querySelector("#gameCanvas").dataset.localJumpOffset) >
        0,
      null,
      { timeout: 120 },
    );
    const jumpVisibleMs = Date.now() - jumpPressedAt;
    assert.ok(
      Number(
        await one.locator("#gameCanvas").getAttribute("data-movement-sequence"),
      ) < jumpSequence,
      "jump is visible before the network ACK",
    );
    await one.waitForFunction(
      () =>
        Number(document.querySelector("#gameCanvas").dataset.localJumpOffset) >
        60,
    );
    fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true });
    await one.locator("#gameCanvas").screenshot({
      path: path.join(__dirname, "../test-results/jump-airborne.png"),
    });
    await one.waitForFunction(
      (sequence) =>
        Number(
          document.querySelector("#gameCanvas").dataset.movementSequence,
        ) >= sequence,
      jumpSequence,
    );
    const jumpAckWaitMs = Date.now() - jumpPressedAt;
    assert.ok(jumpAckWaitMs >= 145, "jump ACK includes the 150ms relay floor");
    const heldJumpStartedAt = player().jumpStartedAt;
    await pause(850);
    await one.keyboard.down("ArrowUp");
    await pause(220);
    assert.equal(
      Number(
        await one.locator("#gameCanvas").getAttribute("data-local-jump-offset"),
      ),
      0,
    );
    assert.equal(
      player().jumpStartedAt,
      heldJumpStartedAt,
      "held up cannot jump again after landing",
    );
    assert.equal(
      player().movementSequence,
      jumpSequence,
      "key repeats do not send another jump",
    );
    await one.keyboard.up("ArrowUp");
    await pause(350);
    await one.keyboard.down("ArrowUp");
    await one.waitForFunction(
      () =>
        Number(document.querySelector("#gameCanvas").dataset.localJumpOffset) >
        0,
    );
    await one.keyboard.up("ArrowUp");
    await pause(800);
    assert.ok(
      player().jumpStartedAt > heldJumpStartedAt,
      "release and a second press launch another jump",
    );
    const rulesStopSequence = player().movementSequence + 4;
    await one.keyboard.down("ArrowLeft");
    await pause(100);
    await one.keyboard.down("ArrowUp");
    await one.locator("#rules-toggle").click();
    await one.locator("#game-rules-panel").waitFor({ state: "visible" });
    await one.keyboard.up("ArrowLeft");
    await one.keyboard.up("ArrowUp");
    await one.waitForFunction(
      (sequence) =>
        Number(
          document.querySelector("#gameCanvas").dataset.movementSequence,
        ) >= sequence,
      rulesStopSequence,
    );
    const rulesStopped = await rendered();
    for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"])
      await one.keyboard.press(key);
    await pause(200);
    assert.ok(
      Math.abs((await rendered()) - rulesStopped) < 2,
      "opening rules stops movement and panel arrows stay native",
    );
    assert.equal(player().movementSequence, rulesStopSequence);
    await one.keyboard.press("Escape");
    await one.locator("#game-rules-panel").waitFor({ state: "hidden" });
    await one.evaluate(() => {
      const input = document.createElement("input");
      input.id = "typing-proof-input";
      input.value = "abc";
      input.style.position = "fixed";
      input.style.top = "0";
      document.body.append(input);
      input.focus();
      input.setSelectionRange(3, 3);
    });
    await one.keyboard.press("ArrowLeft");
    assert.equal(
      await one
        .locator("#typing-proof-input")
        .evaluate((input) => input.selectionStart),
      2,
      "typing fields keep caret navigation",
    );
    await one.keyboard.press("ArrowUp");
    await pause(200);
    assert.equal(
      player().movementSequence,
      rulesStopSequence,
      "typing does not send movement commands",
    );
    await one.evaluate(() => {
      document.getElementById("typing-proof-input").remove();
      document.body.focus();
    });
    await one.keyboard.down("ArrowLeft");
    await one.waitForFunction(
      () => Number(document.querySelector("#gameCanvas").dataset.localX) < 1,
      {},
      { timeout: 1800 },
    );
    await one.keyboard.up("ArrowLeft");
    await pause(300);
    assert.ok(player().x < 1);
    assert.ok((await rendered()) < 1);
    // Measure base speed independently of pickups collected during the focus checks.
    room.round.stars = [];
    delete player().bonus;
    delete player().slowedUntil;
    instance.io.of("/jeu").to(room.id).emit("roomData", {
      room: room.id,
      ownerId: room.proprietaireId,
      utilisateurs: room.utilisateurs,
      round: room.round,
    });
    await pause(150);
    await one.evaluate(() => {
      window.motionFrames = [];
      window.recordMotion = true;
      const record = () => {
        if (!window.recordMotion) return;
        window.motionFrames.push({
          at: performance.now(),
          x: Number(document.querySelector("#gameCanvas").dataset.localX),
        });
        requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });
    const start = Date.now();
    await one.keyboard.down("ArrowRight");
    await pause(250);
    await one.keyboard.down("ArrowUp");
    await pause(40);
    await one.keyboard.up("ArrowUp");
    await one.waitForFunction(
      () => Number(document.querySelector("#gameCanvas").dataset.localX) > 912,
      {},
      { timeout: 2300 },
    );
    const traversalMs = Date.now() - start;
    const movingFrames = await one.evaluate(() => {
      window.recordMotion = false;
      return window.motionFrames;
    });
    let maxMovingFrameDelta = 0;
    for (let i = 1; i < movingFrames.length; i++) {
      const dx = movingFrames[i].x - movingFrames[i - 1].x;
      const dt = movingFrames[i].at - movingFrames[i - 1].at;
      assert.ok(
        dx >= -0.05,
        "late jump ACK does not reverse a continuous move",
      );
      assert.ok(
        dx <= ((550 * dt) / 1000) * 1.4 + 1.5,
        "no position discontinuity while traversing: " +
          dx +
          " in " +
          dt +
          "ms",
      );
      maxMovingFrameDelta = Math.max(maxMovingFrameDelta, dx);
    }
    await one.keyboard.up("ArrowRight");
    await pause(300);
    assert.ok(
      traversalMs >= 1450 && traversalMs <= 2100,
      "traversal " + traversalMs + "ms",
    );
    assert.ok(player().x > 912);
    assert.ok((await rendered()) > 912);
    const expectedStopSequence = player().movementSequence + 4;
    await one.keyboard.down("ArrowLeft");
    await pause(230);
    await one.keyboard.down("ArrowRight");
    await one.keyboard.up("ArrowLeft");
    await pause(100);
    const stopSentAt = Date.now();
    await one.keyboard.up("ArrowRight");
    await one.waitForFunction(
      (sequence) =>
        Number(
          document.querySelector("#gameCanvas").dataset.movementSequence,
        ) >= sequence,
      expectedStopSequence,
      { timeout: 2500 },
    );
    const stopAckWaitMs = Date.now() - stopSentAt;
    await one.waitForFunction(
      (x) =>
        Math.abs(
          Number(document.querySelector("#gameCanvas").dataset.localX) - x,
        ) < 15,
      player().x,
      { timeout: 1500 },
    );
    const stopped = await rendered();
    assert.ok(
      stopped > 730 && stopped < 912,
      "reversal moves away from the right boundary: " + stopped,
    );
    assert.ok(
      Math.abs(stopped - player().x) < 15,
      "render/server convergence: rendered=" +
        stopped +
        " server=" +
        player().x +
        " sequence=" +
        player().movementSequence +
        " sampledAt=" +
        player().sampledAt +
        " startedAt=" +
        player().movementStartedAt,
    );
    await pause(200);
    assert.ok(
      Math.abs((await rendered()) - stopped) < 2,
      "no drift after release",
    );
    // Mobile pointer events use the same hold controls as a real touch surface.
    await two.locator("#gameCanvas").waitFor({ state: "visible" });
    const mobileX = Number(
      await two.locator("#gameCanvas").getAttribute("data-local-x"),
    );
    await two.locator("#move-left").dispatchEvent("pointerdown", {
      pointerId: 9,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    });
    const mobileStopSequence = 1;
    await pause(350);
    await two.locator("#move-left").dispatchEvent("pointerup", {
      pointerId: 9,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    });
    await two.waitForFunction(
      (sequence) =>
        Number(
          document.querySelector("#gameCanvas").dataset.movementSequence,
        ) >= sequence,
      mobileStopSequence,
      { timeout: 2500 },
    );
    const after = Number(
      await two.locator("#gameCanvas").getAttribute("data-local-x"),
    );
    assert.ok(
      mobileX - after > 150 && mobileX - after < 235,
      "mobile held distance " + (mobileX - after),
    );
    const mobileServer = room.utilisateurs.find(
      (p) => p.nomUtilisateur === "motion_nova",
    ).x;
    assert.ok(Math.abs(mobileServer - after) < 15);
    const cancelStopSequence = mobileStopSequence + 2;
    await two.locator("#move-right").dispatchEvent("pointerdown", {
      pointerId: 10,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    });
    await pause(120);
    await two.locator("#move-right").dispatchEvent("pointercancel", {
      pointerId: 10,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    });
    await two.waitForFunction(
      (sequence) =>
        Number(
          document.querySelector("#gameCanvas").dataset.movementSequence,
        ) >= sequence,
      cancelStopSequence,
    );
    // ACK metadata updates on receipt; the position dataset updates on the next RAF.
    // Wait for that frame before comparing two rendered stopped positions.
    const cancelAuthority = room.utilisateurs.find((p) => p.nomUtilisateur === "motion_nova").x;
    await two.waitForFunction(
      (x) => Math.abs(Number(document.querySelector("#gameCanvas").dataset.localX) - x) < 0.1,
      cancelAuthority,
      { timeout: 2500 },
    );
    const cancelled = Number(
      await two.locator("#gameCanvas").getAttribute("data-local-x"),
    );
    await pause(220);
    assert.ok(
      Math.abs(
        Number(await two.locator("#gameCanvas").getAttribute("data-local-x")) -
          cancelled,
      ) < 2,
      "pointer cancellation halts input",
    );
    assert.ok(
      Math.abs(
        room.utilisateurs.find((p) => p.nomUtilisateur === "motion_nova").x -
          cancelled,
      ) < 15,
    );
    const mobilePlayer = () =>
      room.utilisateurs.find((p) => p.nomUtilisateur === "motion_nova");
    const mobileJumpSequence = mobilePlayer().movementSequence + 1;
    const touchJump = {
      pointerId: 11,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
    };
    await two.locator("#jump-button").dispatchEvent("pointerdown", touchJump);
    await two.waitForFunction(
      () =>
        Number(document.querySelector("#gameCanvas").dataset.localJumpOffset) >
        0,
    );
    await pause(900);
    const mobileHeldJumpAt = mobilePlayer().jumpStartedAt;
    assert.equal(
      Number(
        await two.locator("#gameCanvas").getAttribute("data-local-jump-offset"),
      ),
      0,
    );
    assert.equal(mobilePlayer().movementSequence, mobileJumpSequence);
    await two.locator("#jump-button").dispatchEvent("pointercancel", touchJump);
    await two.waitForFunction(
      (sequence) =>
        Number(
          document.querySelector("#gameCanvas").dataset.movementSequence,
        ) === sequence,
      mobileJumpSequence + 1,
    );
    await two
      .locator("#jump-button")
      .dispatchEvent("pointerdown", { ...touchJump, pointerId: 12 });
    await two.waitForFunction(
      () =>
        Number(document.querySelector("#gameCanvas").dataset.localJumpOffset) >
        0,
    );
    await two
      .locator("#jump-button")
      .dispatchEvent("pointerup", { ...touchJump, pointerId: 12 });
    await pause(800);
    assert.ok(
      mobilePlayer().jumpStartedAt > mobileHeldJumpAt,
      "touch cancel permits a fresh jump",
    );
    await one.evaluate(() => document.body.focus());
    const blurStopSequence = player().movementSequence + 2;
    await one.keyboard.down("ArrowLeft");
    await pause(160);
    await one.evaluate(() => window.dispatchEvent(new Event("blur")));
    await one.waitForFunction(
      (sequence) =>
        Number(
          document.querySelector("#gameCanvas").dataset.movementSequence,
        ) >= sequence,
      blurStopSequence,
      { timeout: 2500 },
    );
    const blurred = await rendered();
    await pause(220);
    assert.ok(Math.abs((await rendered()) - blurred) < 2, "blur halts input");
    await one.keyboard.up("ArrowLeft");
    assert.ok(relayMessages > 0, "real websocket relay exercised");
    assert.deepEqual(errors, []);
    await one.keyboard.down("ArrowRight");
    await pause(100);
    await one.keyboard.down("ArrowUp");
    const finalAuthoritativeX = 321;
    player().x = finalAuthoritativeX;
    room.round.ended = true;
    instance.io.of("/jeu").to(room.id).emit("roundEnded", {
      room: room.id,
      ownerId: room.proprietaireId,
      utilisateurs: room.utilisateurs,
      round: room.round,
    });
    await one.waitForFunction(
      (x) => Number(document.querySelector("#gameCanvas").dataset.localX) === x,
      finalAuthoritativeX,
      { timeout: 2500 },
    );
    await pause(250);
    assert.equal(
      await rendered(),
      finalAuthoritativeX,
      "round end freezes authoritative position",
    );
    await one.keyboard.up("ArrowRight");
    await one.keyboard.up("ArrowUp");
    assert.equal(
      Number(
        await one.locator("#gameCanvas").getAttribute("data-local-jump-offset"),
      ),
      0,
      "round end resets the jump",
    );
    const metrics = await one
      .locator("#gameCanvas")
      .evaluate((c) => ({ ...c.dataset }));
    const output = {
      baseSpeed: 550,
      traversalMs,
      movingFrameSamples: movingFrames.length,
      maxMovingFrameDelta,
      expectedTraversalMs: (915 / 550) * 1000,
      injectedRttFloorMs: 150,
      relayOneWayDelayRange: [
        Math.min(...relayDelays),
        Math.max(...relayDelays),
      ],
      jumpVisibleMs,
      jumpAckWaitMs,
      heldJumpDoesNotRepeat: true,
      touchJumpCancelVerified: true,
      stopAckWaitMs,
      relayMessages,
      mobileHeldDistance: mobileX - after,
      finalAuthoritativeX,
      keyboardScrollProof: {
        idleScrollBefore,
        idleScrollDown,
        idleScrollUp,
        runningScrollBefore,
        runningScrollAfter,
      },
      typingNavigationVerified: true,
      toolbarChecks,
      rulesStopVerified: true,
      pointerCancelStops: true,
      errors,
      metrics,
    };
    fs.mkdirSync(path.join(__dirname, "../test-results"), { recursive: true });
    fs.writeFileSync(
      path.join(__dirname, "../test-results/movement-proof.json"),
      JSON.stringify(output, null, 2),
    );
    console.log(
      "PASS browser movement with at least 150ms injected WebSocket RTT",
      JSON.stringify(output),
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => instance.io.close(resolve));
    await store.close();
    await mongoose.disconnect();
    await mongo.stop();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
