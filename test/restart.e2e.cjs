const fs = require("node:fs"),
  assert = require("node:assert/strict"),
  { spawn } = require("node:child_process"),
  { once } = require("node:events"),
  net = require("node:net"),
  { randomUUID } = require("node:crypto");
const mongoose = require("mongoose"),
  { MongoMemoryServer, MongoMemoryReplSet } = require("mongodb-memory-server"),
  { chromium } = require("playwright"),
  { io } = require("socket.io-client");
const Score = require("../dist/src/models/Score").default,
  RoundResult = require("../dist/src/models/RoundResult").default,
  { recoverResults } = require("../dist/src/services/results");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const replica = process.argv.includes("--replica");
  const mongo = replica
    ? await MongoMemoryReplSet.create({ replSet: { count: 1 } })
    : await MongoMemoryServer.create();
  const uri = mongo.getUri("restart_fixture");
  await mongoose.connect(uri);
  await Score.init();
  await RoundResult.init();
  async function freePort() {
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, "127.0.0.1", r));
    const p = probe.address().port;
    await new Promise((r) => probe.close(r));
    return p;
  }
  let port = await freePort(),
    base = `http://127.0.0.1:${port}`,
    child;
  const children = [],
    clients = [],
    errors = [],
    proofs = [];
  async function start({ pending = false, targetPort = port, durationMs = 6000 } = {}) {
    const c = spawn(
      process.execPath,
      [require.resolve("./restart-server.cjs")],
      {
        env: {
          ...process.env,
          MONGODB_URI: uri,
          SECRET: "restart-fixture-".repeat(4),
          PORT: String(targetPort),
          WAIT_ENGINE: pending ? "1" : "0",
          GAME_DURATION: String(durationMs),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(c);
    child = c;
    let output = "";
    c.stdout.on("data", (d) => (output += d));
    c.stderr.on("data", (d) => (output += d));
    for (let n = 0; n < 140; n++) {
      if (output.includes(pending ? "HTTP" : "READY")) return c;
      if (c.exitCode !== null) throw Error(output);
      await wait(50);
    }
    throw Error("Startup failed " + output);
  }
  async function kill(c = child, signal = "SIGKILL") {
    const ended = once(c, "exit", { signal: AbortSignal.timeout(15000) });
    c.kill(signal);
    await ended;
  }
  const browser = await chromium.launch();
  async function page(width) {
    const c = await browser.newContext({
      viewport: { width, height: 844 },
      reducedMotion: "reduce",
    });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    return p;
  }
  async function enter(p, name) {
    await p.goto(base + "/jouer");
    await p.locator("#nomUtilisateur").fill(name);
    await p.getByRole("button", { name: "Jouer par pseudo" }).click();
    await p.waitForURL("**/salon");
    await p.getByText("En ligne", { exact: true }).waitFor();
  }
  async function cookie(p) {
    return (await p.context().cookies())
      .filter((c) => c.name === "run.sid")
      .map((c) => c.name + "=" + c.value)
      .join("; ");
  }
  async function socket(p, url = base) {
    const c = io(url + "/jeu", {
      transports: ["websocket"],
      extraHeaders: { Cookie: await cookie(p) },
      forceNew: true,
      reconnection: false,
    });
    clients.push(c);
    await once(c, "connect");
    return c;
  }
  async function create(p) {
    await p.goto(base + "/salon");
    await p.getByText("En ligne", { exact: true }).waitFor();
    await p.getByRole("button", { name: "Ouvrir une partie" }).click();
    await p.waitForURL("**/salon/salonDeJeu/*");
    return p.url().split("/").pop();
  }
  async function state(c, room) {
    let value;
    c.on("roomData", (r) => (value = r));
    assert.equal(await c.emitWithAck("join", { room }), undefined);
    return () => value;
  }
  try {
    await start();
    const a = await page(1440),
      b = await page(390);
    await enter(a, "restart_one");
    await enter(b, "restart_two");
    const identity = await a.request
        .get(base + "/session")
        .then((r) => r.json()),
      bIdentity = await b.request.get(base + "/session").then((r) => r.json());
    const waiting = await create(a);
    await kill();
    await start();
    await a.reload();
    await a
      .locator("#room-recovery")
      .getByText(/salon et ses places ont été restaurés/)
      .waitFor();
    assert.equal(a.url().split("/").pop(), waiting);
    assert.equal(
      (await a.request.get(base + "/session").then((r) => r.json())).identity,
      identity.identity,
    );
    let room = waiting;
    for (const stage of [0, 1, 2]) {
      assert.equal(await create(a), room);
      await b.goto(base + "/salon/salonDeJeu/" + room);
      await a.getByRole("button", { name: "Jouer", exact: true }).click();
      await a.getByText("La partie a commencé.", { exact: true }).waitFor();
      const c = await socket(a),
        get = await state(c, room);
      for (let n = 0; n < 130 && get()?.round?.stage !== stage; n++)
        await wait(50);
      assert.equal(get().round.stage, stage);
      const roundId = get().round.id;
      const bonus = { id: randomUUID(), roundId, stage, kind: "multiplier" };
      assert.equal(await c.emitWithAck("activateBonus", bonus), undefined);
      const expiration = get().utilisateurs.find(
        (p) => p.userId === identity.identity.split(":")[1],
      ).bonus.expiresAt;
      assert.equal(await c.emitWithAck("activateBonus", bonus), undefined);
      const consumed = get().utilisateurs.find(
        (p) => p.userId === identity.identity.split(":")[1],
      );
      assert.deepEqual(consumed.usedStages, [stage]);
      assert.equal(consumed.bonus.expiresAt, expiration);
      const d = await socket(a),
        replaced = once(c, "replaced");
      await d.emitWithAck("join", { room });
      await replaced;
      await kill();
      await start();
      await b
        .locator("#room-recovery")
        .getByText(/manche interrompue a été annulée/)
        .waitFor({ timeout: 10000 });
      assert.equal(
        (await b.request.get(base + "/session").then((r) => r.json())).identity,
        bIdentity.identity,
      );
      const resumed = await socket(a),
        restored = await state(resumed, room);
      assert.equal(restored().utilisateurs.length, 2);
      assert.deepEqual(
        restored()
          .utilisateurs.map((p) => p.userId)
          .sort(),
        [
          identity.identity.split(":")[1],
          bIdentity.identity.split(":")[1],
        ].sort(),
      );
      assert.equal(restored().round, undefined);
      assert.equal(restored().interruptedRoundId, roundId);
      assert.ok(
        restored().utilisateurs.every(
          (p) => p.score === 0 && p.usedStages.length === 0 && !p.bonus,
        ),
      );
      assert.match(
        await resumed.emitWithAck("activateBonus", bonus),
        /invalide|absent/,
      );
      assert.match(
        await resumed.emitWithAck("scoreFinDeJeu", { roundId }),
        /invalide/,
      );
      assert.equal(await Score.countDocuments({ matchId: roundId }), 0);
      assert.equal(await RoundResult.countDocuments({ _id: roundId }), 0);
      proofs.push({
        phase: stage,
        method: "real SIGKILL",
        roomIdPreserved: room,
        roundId,
        cancellationVisible: true,
        identityPreserved: true,
        seats: 2,
        scoresAndBonusesReset: true,
        replayChargeCount: 1,
        replayExpiryUnchanged: true,
        oldBonusRejected: true,
        oldResultRejected: true,
        scoreRows: 0,
        outboxRows: 0,
      });
      resumed.disconnect();
      await a.goto(base + "/salon");
      await a.getByRole("link", { name: "Reprendre votre salon" }).waitFor();
    }
    assert.equal(await create(a), room);
    await b.goto(base + "/salon/salonDeJeu/" + room);
    await a.getByRole("button", { name: "Jouer", exact: true }).click();
    await a.locator("#finPartie").waitFor({ state: "visible", timeout: 12000 });
    const result = await a.locator("#resultat").textContent(),
      selfScore = await a.locator("#monScore").textContent(),
      otherScore = await a.locator("#autreScore").textContent();
    await kill();
    await start();
    await a.reload();
    await a.locator("#finPartie").waitFor({ state: "visible" });
    assert.equal(await a.locator("#resultat").textContent(), result);
    assert.equal(await a.locator("#monScore").textContent(), selfScore);
    assert.equal(await a.locator("#autreScore").textContent(), otherScore);
    assert.equal(await a.locator("#menuDepart").isVisible(), false);
    const completedSocket = await socket(a),
      ended = await state(completedSocket, room);
    assert.equal(ended().round.ended, true);
    const completedRoundId = ended().round.id;
    await RoundResult.deleteOne({ _id: completedRoundId });
    await kill();
    await start();
    await a.reload();
    await a.locator("#finPartie").waitFor({ state: "visible" });
    assert.equal(await a.locator("#monScore").textContent(), selfScore);
    assert.equal(await a.locator("#autreScore").textContent(), otherScore);
    assert.equal((await RoundResult.findById(completedRoundId)).saved, true);
    const gapSocket = await socket(a);
    await state(gapSocket, room);
    await gapSocket.emitWithAck("leave");
    // Canonical account and guest reservations survive a mixed-room restart.
    const account = await page(800);
    await account.goto(base + "/inscription");
    await account.locator("#email").fill("restart_account@example.test");
    await account.locator("#mdp").fill("Password1234");
    await account.getByRole("button", { name: "Créer mon compte" }).click();
    await account.waitForURL("**/salon");
    const accountIdentity = await account.request
      .get(base + "/session")
      .then((r) => r.json());
    const mixedRoom = await create(account);
    await b.goto(base + "/salon/salonDeJeu/" + mixedRoom);
    await account.getByRole("button", { name: "Jouer", exact: true }).click();
    await account.getByText("La partie a commencé.", { exact: true }).waitFor();
    await kill();
    await start();
    await account.reload();
    await account
      .locator("#room-recovery")
      .getByText(/manche interrompue a été annulée/)
      .waitFor();
    assert.equal(
      (await account.request.get(base + "/session").then((r) => r.json()))
        .identity,
      accountIdentity.identity,
    );
    const mixedSocket = await socket(account),
      mixedState = await state(mixedSocket, mixedRoom);
    assert.equal(mixedState().utilisateurs.length, 2);
    assert.deepEqual(
      mixedState()
        .utilisateurs.map((p) => p.kind)
        .sort(),
      ["account", "guest"],
    );
    assert.equal(
      await Score.countDocuments({ matchId: mixedState().interruptedRoundId }),
      0,
    );
    await mixedSocket.emitWithAck("leave");
    const duplicate = spawn(
      process.execPath,
      [require.resolve("./restart-server.cjs")],
      {
        env: {
          ...process.env,
          MONGODB_URI: uri,
          SECRET: "restart-fixture-".repeat(4),
          PORT: String(await freePort()),
          WAIT_ENGINE: "0",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    children.push(duplicate);
    let failure = "";
    duplicate.stderr.on("data", (d) => (failure += d));
    await once(duplicate, "exit");
    assert.match(failure, /instance Duel/);
    assert.equal(duplicate.exitCode, 1);
    await kill();
    await start({ durationMs: 20000 });
    const logoutPage = await page(320);
    await enter(logoutPage, "restart_cross_logout");
    const oldChat = io(base + "/discussion", {
      transports: ["websocket"],
      extraHeaders: { Cookie: await cookie(logoutPage) },
      forceNew: true,
      reconnection: false,
    });
    clients.push(oldChat);
    await once(oldChat, "connect");
    await oldChat.emitWithAck("join", {});
    // Render order: new HTTP is promoted while old WS engine still runs; old SIGTERM arrives later.
    room = await create(a);
    await b.goto(base + "/salon/salonDeJeu/" + room);
    await a.getByRole("button", { name: "Jouer", exact: true }).click();
    await a.getByText("La partie a commencé.", { exact: true }).waitFor();
    const oldSocket = await socket(a),
      oldState = await state(oldSocket, room),
      oldRoundId = oldState().round.id,
      oldProcess = child,
      oldBase = base;
    const nextPort = await freePort();
    await start({ pending: true, targetPort: nextPort, durationMs: 20000 });
    port = nextPort;
    base = `http://127.0.0.1:${port}`;
    const deploy = await a.request.get(base + "/health/deploy");
    assert.equal(deploy.status(), 200);
    assert.equal((await deploy.json()).engine, "waiting");
    assert.equal((await a.request.get(base + "/health/ready")).status(), 503);
    await a.goto(base + "/salon");
    await a
      .locator("#connection-status")
      .getByText(/mise à jour/)
      .waitFor();
    assert.equal(
      await a.getByRole("button", { name: "Ouvrir une partie" }).isEnabled(),
      false,
    );
    assert.equal(
      await a.getByText("Aucun salon en attente", { exact: true }).count(),
      0,
    );
    const csrf = await a
      .locator(".lancerJeuForm input[name=_csrf]")
      .inputValue();
    assert.equal(
      (
        await a.request.post(base + "/salon/salonDeJeu/room", {
          form: { _csrf: csrf },
        })
      ).status(),
      503,
    );
    const pending = await socket(a);
    assert.match(await pending.emitWithAck("join", { room }), /mise à jour/);
    await wait(1500);
    assert.equal((await a.request.get(base + "/health/ready")).status(), 503);
    assert.equal(
      (await b.request.get(oldBase + "/health/ready")).status(),
      200,
    );
    const oldBonus = {
      id: randomUUID(),
      roundId: oldRoundId,
      stage: oldState().round.stage,
      kind: "sprint",
    };
    assert.equal(
      await oldSocket.emitWithAck("activateBonus", oldBonus),
      undefined,
    );
    console.log("OVERLAP pre logout", new Date().toISOString(), oldState().round.endsAt - Date.now());
    await logoutPage.goto(base + "/salon");
    const logoutCsrf = await logoutPage
      .locator(".lancerJeuForm input[name=_csrf]")
      .inputValue();
    const endedAccess = once(oldChat, "accessEnded", { signal: AbortSignal.timeout(5000) });
    await logoutPage.request.post(base + "/utilisateur/deconnexion", {
      form: { _csrf: logoutCsrf },
    });
    const rejectedMessage = randomUUID();
    oldChat.emit(
      "envoyerMessage",
      { id: rejectedMessage, text: "revoked cross process" },
      () => {},
    );
    await endedAccess;
    console.log("OVERLAP post logout", new Date().toISOString());
    assert.equal(
      await mongoose.connection.db
        .collection("chatmessages")
        .countDocuments({ messageId: rejectedMessage }),
      0,
    );
    await a.goto(base + "/salon/salonDeJeu/" + room);
    await a
      .locator("#game-status")
      .getByText(/mise à jour/)
      .waitFor();
    console.log("OVERLAP pre SIGTERM", new Date().toISOString(), oldState().round.endsAt - Date.now());
    await kill(oldProcess, "SIGTERM");
    console.log("OVERLAP post SIGTERM", new Date().toISOString());
    await a
      .locator("#room-recovery")
      .getByText(/manche interrompue a été annulée/)
      .waitFor({ timeout: 10000 });
    assert.equal((await a.request.get(base + "/health/ready")).status(), 200);
    const current = await socket(a),
      currentState = await state(current, room);
    assert.equal(currentState().utilisateurs.length, 2);
    assert.equal(currentState().round, undefined);
    assert.equal(currentState().interruptedRoundId, oldRoundId);
    assert.equal(oldSocket.connected, false);
    assert.match(
      await current.emitWithAck("activateBonus", oldBonus),
      /invalide|absent/,
    );
    assert.equal(await Score.countDocuments({ matchId: oldRoundId }), 0);
    assert.equal(await RoundResult.countDocuments({ _id: oldRoundId }), 0);
    await current.emitWithAck("leave");
    // A suspended old process resumes after another process has acquired its expired lease.
    await kill();
    await start();
    const fencedRoom = await create(a);
    await b.goto(base + "/salon/salonDeJeu/" + fencedRoom);
    await a.getByRole("button", { name: "Jouer", exact: true }).click();
    await a.getByText("La partie a commencé.", { exact: true }).waitFor();
    const staleSocket = await socket(a),
      staleState = await state(staleSocket, fencedRoom),
      staleRound = staleState().round,
      suspendedProcess = child,
      suspendedBase = base;
    suspendedProcess.kill("SIGSTOP");
    await wait(1400);
    const replacementPort = await freePort();
    await start({ pending: true, targetPort: replacementPort });
    port = replacementPort;
    base = `http://127.0.0.1:${port}`;
    for (let n = 0; n < 100; n++) {
      if ((await a.request.get(base + "/health/ready")).status() === 200) break;
      await wait(50);
    }
    assert.equal((await a.request.get(base + "/health/ready")).status(), 200);
    await a.goto(base + "/salon/salonDeJeu/" + fencedRoom);
    await a.locator("#room-recovery").getByText(/manche interrompue a été annulée/).waitFor();
    await wait(Math.max(0, staleRound.endsAt + 150 - Date.now()));
    const staleDisconnected = once(staleSocket, "disconnect", { signal: AbortSignal.timeout(5000) });
    suspendedProcess.kill("SIGCONT");
    await staleDisconnected;
    assert.equal((await b.request.get(suspendedBase + "/health/ready")).status(), 503);
    const replacementSocket = await socket(a),
      replacementState = await state(replacementSocket, fencedRoom);
    assert.equal(replacementState().round, undefined);
    assert.equal(replacementState().interruptedRoundId, staleRound.id);
    assert.equal(replacementState().utilisateurs.length, 2);
    assert.ok(replacementState().utilisateurs.every(p => p.score === 0 && p.usedStages.length === 0));
    assert.match(await replacementSocket.emitWithAck("activateBonus", {
      id: randomUUID(), roundId: staleRound.id, stage: 0, kind: "sprint",
    }), /invalide|absent/);
    assert.match(await replacementSocket.emitWithAck("scoreFinDeJeu", { roundId: staleRound.id }), /invalide/);
    assert.equal(await RoundResult.countDocuments({ _id: staleRound.id }), 0);
    assert.equal(await Score.countDocuments({ matchId: staleRound.id }), 0);
    await replacementSocket.emitWithAck("leave");
    await kill(suspendedProcess);
    const id = randomUUID(),
      p1 = new mongoose.Types.ObjectId().toString(),
      p2 = new mongoose.Types.ObjectId().toString();
    const round = {
      id,
      startedAt: 1,
      endsAt: 2,
      ended: true,
      saved: false,
      stars: [],
      stage: 2,
    };
    const players = [p1, p2].map((userId, n) => ({
      id: userId,
      userId,
      nomUtilisateur: "durable_" + n,
      kind: "account",
      room: "fixture",
      score: 3 + n,
      usedStages: [0, 1, 2],
    }));
    await RoundResult.create({ _id: id, round, players });
    await Score.create({
      matchId: id,
      monJoueurId: p1,
      monNom: "durable_0",
      monScore: 3,
      nomUtilisateurAutreJoueur: "durable_1",
      scoreAutreJoueur: 4,
    });
    await kill();
    await start();
    await Promise.all(Array.from({ length: 8 }, () => recoverResults()));
    assert.equal(await Score.countDocuments({ matchId: id }), 2);
    assert.equal((await RoundResult.findById(id)).saved, true);
    // Persisted reservation revocation and the 24-hour room limit are enforced on recovery.
    const revokedRoom = await create(a),
      expiredRoom = await create(b);
    child.kill("SIGSTOP");
    const journalCollection = mongoose.connection.db.collection("roomjournals");
    const journalDoc = await journalCollection.findOne({ _id: "arena" });
    const ownerSession =
      journalDoc.entries[revokedRoom].reservations[
        identity.identity.split(":")[1]
      ].sessionId;
    await mongoose.connection.db
      .collection("sessions")
      .deleteOne({ _id: ownerSession });
    await journalCollection.updateOne(
      { _id: "arena" },
      {
        $set: {
          ["entries." + expiredRoom + ".room.createdAt"]: Date.now() - 86400001,
        },
      },
    );
    await kill();
    await start();
    const revokedResponse = await b.request.get(
      base + "/salon/salonDeJeu/" + revokedRoom,
    );
    assert.equal(revokedResponse.status(), 404);
    assert.match(await revokedResponse.text(), /expiré/);
    const expiredResponse = await b.request.get(
      base + "/salon/salonDeJeu/" + expiredRoom,
    );
    assert.equal(expiredResponse.status(), 404);
    assert.match(await expiredResponse.text(), /conservation/);
    await enter(a, "restart_after_revocation");
    for (const p of [a, b]) {
      await p.goto(base + "/salon");
      assert.equal(await p.locator("#access-ended").isVisible(), false);
      assert.equal(
        await p.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
    }
    assert.deepEqual(errors, []);
    const report = {
      replica,
      date: new Date().toISOString(),
      fixture: {
        leaseMs: 1200,
        durationMs: 6000,
        mongo: replica ? "real replica set one node" : "real standalone",
        deploymentOverlapMs: 1500,
        deploymentRoundMs: 20000,
      },
      waiting: {
        method: "SIGKILL",
        roomIdPreserved: waiting,
        ownerSeatPreserved: true,
        identityPreserved: true,
      },
      phases: proofs,
      mixed: {
        accountIdentityAndGuestSeatPreserved: true,
        sameRoomId: mixedRoom,
        noPartialAccountScore: true,
      },
      completed: {
        guestResultRecovered: true,
        exactScoresRetained: true,
        menuHidden: true,
        terminalJournalWithoutOutboxRecovered: true,
        terminalGapMethod: "delete outbox fixture before SIGKILL; recover from fenced ended room snapshot",
      },
      exclusive: {
        secondBlockingProcessRejected: true,
        lostLeaseTest: "test/journal.test.ts",
        suspendedOldProcessReplacedByRealSecondProcess: true,
        resumedOldProcessAfterRoundDeadlineRejected: true,
        oldSocketsDisconnected: true,
        cancelledRoundNoOutboxOrAccountScore: true,
      },
      renderOverlap: {
        newInfrastructure200EngineWaiting: true,
        newGameReady503: true,
        oldEngineReady200: true,
        pendingListExplicit: true,
        crossProcessLogoutRejectsOldChatSocket: true,
        creation503: true,
        joinRejectedClearly: true,
        oldWSBonusAcceptedBeforeSIGTERM: true,
        sigtermOldAfterPromotion: true,
        newEngineReadyAfterRelease: true,
        sameRoomTwoSeats: true,
        noPartialResult: true,
        lateOldBonusRejected: true,
      },
      retention: {
        revokedCanonicalOwnerSessionRemovedRoom: true,
        createdAtOver24hRemovedRoom: true,
        method: "real persisted fixtures before SIGKILL",
      },
      outbox: {
        partialInsertBeforeKill: true,
        concurrentRetries: 8,
        scoreRows: 2,
        saved: true,
      },
      errors,
    };
    fs.mkdirSync(require("node:path").join(__dirname, "../test-results"), {
      recursive: true,
    });
    fs.writeFileSync(
      require("node:path").join(
        __dirname,
        replica
          ? "../test-results/restart-replica-proof.json"
          : "../test-results/restart-proof.json",
      ),
      JSON.stringify(report, null, 2) + "\n",
    );
    console.log(
      "PASS real SIGKILL waiting/seats and stages 0/1/2; same room and identity; bonuses reset; completed guest result; Render overlap HTTP200+engine503 then old SIGTERM and exclusive recovery; partial outbox restart 8 retries 2 scores; no browser errors/overflow",
    );
  } finally {
    clients.forEach((c) => c.disconnect());
    await browser.close();
    for (const c of children)
      if (c.exitCode === null) c.kill("SIGKILL");
    await mongoose.disconnect();
    await mongo.stop();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
