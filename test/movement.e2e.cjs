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
    let relayMessages = 0;
    await one.routeWebSocket("**/socket.io/**", (socket) => {
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        relayMessages++;
        setTimeout(() => server.send(message), 75);
      });
      server.onMessage((message) => setTimeout(() => socket.send(message), 75));
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
    const start = Date.now();
    await one.keyboard.down("ArrowRight");
    await one.waitForFunction(
      () => Number(document.querySelector("#gameCanvas").dataset.localX) > 912,
      {},
      { timeout: 2300 },
    );
    const traversalMs = Date.now() - start;
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
    assert.ok(stopped > 770 && stopped < 890, "reversal position " + stopped);
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
    await two
      .locator("#move-left")
      .dispatchEvent("pointerdown", {
        pointerId: 9,
        pointerType: "touch",
        isPrimary: true,
        button: 0,
      });
    const mobileStopSequence = 1;
    await pause(350);
    await two
      .locator("#move-left")
      .dispatchEvent("pointerup", {
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
    const finalAuthoritativeX = 321;
    player().x = finalAuthoritativeX;
    room.round.ended = true;
    instance.io
      .of("/jeu")
      .to(room.id)
      .emit("roundEnded", {
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
    const metrics = await one
      .locator("#gameCanvas")
      .evaluate((c) => ({ ...c.dataset }));
    const output = {
      baseSpeed: 550,
      traversalMs,
      expectedTraversalMs: (915 / 550) * 1000,
      injectedRttFloorMs: 150,
      stopAckWaitMs,
      relayMessages,
      mobileHeldDistance: mobileX - after,
      finalAuthoritativeX,
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
