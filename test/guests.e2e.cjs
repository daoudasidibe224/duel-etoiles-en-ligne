const path = require("node:path"),
  fs = require("node:fs"),
  assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server"),
  mongoose = require("mongoose"),
  MongoStore = require("connect-mongo").default,
  { chromium } = require("playwright");
const { createApp } = require("../dist/src/app"),
  Score = require("../dist/src/models/Score").default,
  User = require("../dist/src/models/Utilisateur").default;
(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const store = MongoStore.create({ client: mongoose.connection.getClient() });
  const instance = createApp({
    secret: "i".repeat(48),
    store,
    gameOptions: { durationMs: 9000, reconnectMs: 12000, random: () => 0 },
  });
  await new Promise((resolve) =>
    instance.server.listen(0, "127.0.0.1", resolve),
  );
  const base = "http://127.0.0.1:" + instance.server.address().port;
  const browser = await chromium.launch();
  const errors = [],
    contexts = [],
    extra = [];
  const results = path.join(__dirname, "../test-results");
  fs.mkdirSync(results, { recursive: true });
  async function context(width = 390) {
    const c = await browser.newContext({
      viewport: { width, height: 844 },
      reducedMotion: "reduce",
    });
    contexts.push(c);
    return c;
  }
  function track(p) {
    p.on("pageerror", (e) => errors.push(e.message));
    return p;
  }
  async function noOverflow(p) {
    assert.equal(
      await p.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      p.url(),
    );
  }
  async function menu(p) {
    const button = p.getByRole("button", {
      name: "Ouvrir le menu",
      exact: true,
    });
    if (await button.isVisible()) {
      await button.focus();
      await p.keyboard.press("Enter");
      assert.equal(await button.getAttribute("aria-expanded"), "true");
      await noOverflow(p);
      await p.keyboard.press("Escape");
      assert.equal(await button.getAttribute("aria-expanded"), "false");
      assert.equal(
        await button.evaluate((b) => document.activeElement === b),
        true,
      );
    }
  }
  async function enter(p, name, url = base) {
    await p.goto(url + "/jouer");
    await p.locator("#nomUtilisateur").fill(name);
    await p.getByRole("button", { name: "Jouer par pseudo" }).click();
    await p.waitForURL("**/salon");
    await p.getByText("En ligne", { exact: true }).waitFor();
    assert.equal(
      await p.locator("#access-ended").isVisible(),
      false,
      "aucun faux bandeau d’expiration pendant une session canonique",
    );
  }
  try {
    const ca = await context(1440),
      cb = await context(390);
    const a = track(await ca.newPage()),
      b = track(await cb.newPage());
    for (const width of [1440, 800, 390, 320]) {
      await b.setViewportSize({ width, height: 844 });
      for (const route of ["/jouer", "/connexion", "/inscription"]) {
        await b.goto(base + route);
        await noOverflow(b);
        await menu(b);
        if (width === 390) {
          const button = await b
            .locator("form button[type=submit]")
            .boundingBox();
          assert.ok(
            button && button.y + button.height <= 844,
            `CTA visible ${route}`,
          );
        }
      }
    }
    await enter(a, "qa_guest_one");
    await enter(b, "qa_guest_two");
    assert.equal(await User.countDocuments(), 0);
    for (const width of [1440, 800, 390, 320]) {
      await b.setViewportSize({ width, height: 844 });
      await b.goto(base + "/salon");
      await noOverflow(b);
      await menu(b);
      await b.goto(base + "/salon/discussion&jeu");
      await b.getByText("Vous êtes en ligne.", { exact: true }).waitFor();
      await noOverflow(b);
      await b.goto(base + "/profil");
      await b.waitForURL("**/connexion");
      await b
        .getByText("La connexion quitte votre salon invité.", { exact: false })
        .waitFor();
      await noOverflow(b);
    }
    await b.setViewportSize({ width: 390, height: 844 });
    await b.goto(base + "/salon");
    await ca.setOffline(true);
    await a.evaluate(() => window.dispatchEvent(new Event("focus")));
    await a
      .getByText(
        "La connexion au serveur est interrompue. Votre saisie reste dans cet onglet.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await a.getByRole("link", { name: /Profil/ }).count(),
      0,
      "un invité reste invité pendant la panne",
    );
    await ca.setOffline(false);
    await a
      .getByRole("button", { name: "Réessayer la connexion", exact: true })
      .click();
    await a.waitForFunction(
      () => document.getElementById("access-ended").hidden,
    );
    await a.getByText("En ligne", { exact: true }).waitFor();
    await a.getByRole("button", { name: "Ouvrir une partie" }).click();
    await a.waitForURL("**/salon/salonDeJeu/*");
    const matchUrl = a.url(),
      room = matchUrl.split("/").pop();
    await b.getByRole("link", { name: "Rejoindre" }).click();
    await b.waitForURL("**/salon/salonDeJeu/*");
    await a.getByRole("button", { name: "Jouer", exact: true }).waitFor();
    const deniedContext = await context(320),
      visitor = track(await deniedContext.newPage());
    await visitor.goto(matchUrl);
    await visitor.waitForURL("**/jouer");
    await visitor.locator("#nomUtilisateur").fill("qa_guest_outside");
    await visitor.getByRole("button", { name: "Jouer par pseudo" }).click();
    await visitor
      .getByRole("heading", { name: "Salon complet", exact: true })
      .waitFor();
    assert.equal(instance.app.salons[room].utilisateurs.length, 2);
    await noOverflow(visitor);
    await a.getByRole("button", { name: "Jouer", exact: true }).click();
    await a.getByText("La partie a commencé.", { exact: true }).waitFor();
    const live = instance.app.salons[room];
    live.round.stars.push({
      id: require("node:crypto").randomUUID(),
      kind: "multiplier",
      x: live.utilisateurs[0].x + 22.5,
      bornAt: Date.now() - (450 / 140) * 1000,
      speed: 140,
    });
    await a.getByText("Points ×2 activé", { exact: true }).waitFor();
    await a.waitForFunction(
      () =>
        document.querySelector("#gameCanvas")?.dataset.renderer === "canvas-2d",
    );
    await b.waitForFunction(
      () =>
        document.querySelector("#gameCanvas")?.dataset.renderer === "canvas-2d",
    );
    assert.equal(await b.locator("#renderer-notice").isVisible(), false);
    await a.waitForFunction(
      () => Number(document.querySelector("#self-score")?.textContent) >= 2,
      null,
      { timeout: 8000 },
    );
    const originalRound = instance.app.salons[room].round.id,
      expiry = instance.app.salons[room].utilisateurs[0].bonus.expiresAt;
    const twins = await Promise.all([ca.newPage(), ca.newPage()]);
    twins.forEach(track);
    await Promise.all(twins.map((p) => p.goto(matchUrl)));
    await Promise.all(
      twins.map((p) =>
        p
          .locator("#self-name")
          .getByText("qa_guest_one", { exact: true })
          .waitFor(),
      ),
    );
    assert.equal(instance.app.salons[room].utilisateurs.length, 2);
    assert.equal(
      new Set(instance.app.salons[room].utilisateurs.map((p) => p.userId)).size,
      2,
    );
    await Promise.all(twins.map((p) => p.close()));
    await a.reload();
    await a.getByText("La partie a commencé.", { exact: true }).waitFor();
    assert.equal(instance.app.salons[room].round.id, originalRound);
    assert.equal(
      instance.app.salons[room].utilisateurs[0].bonus.expiresAt,
      expiry,
    );
    await cb.setOffline(true);
    await b.reload({ timeout: 2000 }).catch(() => {});
    await cb.setOffline(false);
    await b.goto(matchUrl);
    await b.getByText("La partie a commencé.", { exact: true }).waitFor();
    assert.equal(instance.app.salons[room].utilisateurs.length, 2);
    await a
      .getByText("Partie terminée. Votre score invité reste visible ici.", {
        exact: true,
      })
      .waitFor({ timeout: 15000 })
      .catch(async (error) => {
        console.error(
          "Guest finish diagnostics",
          JSON.stringify({
            page: await a.locator("main").innerText(),
            state: instance.app.salons[room] && {
              round: instance.app.salons[room].round,
              players: instance.app.salons[room].utilisateurs.map((p) => ({
                id: p.id,
                kind: p.kind,
                score: p.score,
              })),
            },
            errors,
          }),
        );
        throw error;
      });
    assert.equal(await Score.countDocuments({ matchId: originalRound }), 0);
    assert.ok(Number(await a.locator("#self-score").textContent()) >= 2);
    await noOverflow(a);
    await noOverflow(b);
    await a.locator("#replay-game").waitFor({ state: "visible" });
    assert.equal(await b.locator("#replay-game").isVisible(), false);
    await b
      .getByText("Le propriétaire peut relancer une manche.", { exact: true })
      .waitFor();
    const oldRoundPayload = structuredClone({
      room,
      ownerId: instance.app.salons[room].proprietaireId,
      utilisateurs: instance.app.salons[room].utilisateurs,
      round: instance.app.salons[room].round,
    });
    await a.locator("#replay-game").click();
    await a.getByText("La partie a commencé.", { exact: true }).waitFor();
    await b.getByText("La partie a commencé.", { exact: true }).waitFor();
    assert.notEqual(instance.app.salons[room].round.id, originalRound);
    assert.equal(instance.app.salons[room].utilisateurs.length, 2);
    assert.deepEqual(
      instance.app.salons[room].utilisateurs.map((player) => player.score),
      [0, 0],
    );
    assert.equal(Number(await a.locator("#self-score").textContent()), 0);
    assert.equal(Number(await b.locator("#self-score").textContent()), 0);
    assert.equal(await a.locator("#finPartie").isVisible(), false);
    assert.equal(
      Number(
        await a.locator("#gameCanvas").getAttribute("data-local-jump-offset"),
      ),
      0,
    );
    assert.equal(
      Number(
        await a.locator("#gameCanvas").getAttribute("data-movement-sequence"),
      ),
      -1,
    );
    // Late packets from a previous round cannot restore its position, jump or result.
    oldRoundPayload.utilisateurs[0].x = 10;
    oldRoundPayload.utilisateurs[0].jumpStartedAt = Date.now();
    oldRoundPayload.utilisateurs[0].movementSequence = 99;
    oldRoundPayload.utilisateurs[0].movementStartedAt = Date.now();
    oldRoundPayload.utilisateurs[0].sampledAt = Date.now();
    instance.io.of("/jeu").to(room).emit("roomData", oldRoundPayload);
    instance.io
      .of("/jeu")
      .to(room)
      .emit("init", { ...oldRoundPayload.round, ended: false });
    instance.io.of("/jeu").to(room).emit("roundEnded", oldRoundPayload);
    await a.waitForTimeout(150);
    assert.equal(await a.locator("#finPartie").isVisible(), false);
    assert.equal(
      Number(
        await a.locator("#gameCanvas").getAttribute("data-local-jump-offset"),
      ),
      0,
    );
    assert.equal(
      Number(
        await a.locator("#gameCanvas").getAttribute("data-movement-sequence"),
      ),
      -1,
    );
    assert.ok(
      Number(await a.locator("#gameCanvas").getAttribute("data-local-x")) > 400,
    );
    await a.keyboard.down("ArrowLeft");
    await a.waitForFunction(
      () =>
        Number(
          document.querySelector("#gameCanvas").dataset.movementSequence,
        ) === 0,
    );
    await a.keyboard.up("ArrowLeft");
    await a.waitForFunction(
      () =>
        Number(
          document.querySelector("#gameCanvas").dataset.movementSequence,
        ) === 1,
    );
    await a.keyboard.down("ArrowUp");
    await a.waitForFunction(
      () =>
        Number(document.querySelector("#gameCanvas").dataset.localJumpOffset) >
        0,
    );
    await a.keyboard.up("ArrowUp");
    await a.waitForFunction(
      () =>
        Number(
          document.querySelector("#gameCanvas").dataset.movementSequence,
        ) === 3,
    );
    assert.ok(
      instance.app.salons[room].utilisateurs[0].jumpStartedAt >=
        instance.app.salons[room].round.startedAt,
    );
    // La création d'un compte remplace la session invitée, sans reprendre ses points.
    await a.goto(base + "/inscription");
    await a.locator("#email").fill("guest_to_account@example.test");
    await a.locator("#mdp").fill("Password1234");
    await a
      .getByText("Choisir un pseudo (facultatif)", { exact: true })
      .click();
    await a.locator("#nomUtilisateur").fill("qa_saved");
    await a.getByRole("button", { name: "Créer mon compte" }).click();
    await a.waitForURL("**/salon");
    assert.equal(instance.app.salons[room], undefined);
    assert.equal(await Score.countDocuments({ matchId: originalRound }), 0);
    for (const width of [1440, 800, 390, 320]) {
      await a.setViewportSize({ width, height: 844 });
      for (const route of [
        "/salon",
        "/profil",
        "/stats",
        "/salon/discussion&jeu",
      ]) {
        await a.goto(base + route);
        await noOverflow(a);
        assert.equal(await a.locator("#access-ended").isVisible(), false);
        await menu(a);
      }
    }
    await a.goto(base + "/salon");
    const next = await a
      .getByRole("button", { name: "Ouvrir une partie" })
      .click();
    await a.waitForURL("**/salon/salonDeJeu/*");
    const nextRoom = a.url().split("/").pop();
    await a
      .locator("#self-name")
      .getByText("qa_saved", { exact: true })
      .waitFor();
    await b.goto(base + "/salon");
    await b
      .getByRole("button", { name: "Ouvrir le menu", exact: true })
      .click();
    await b
      .getByRole("button", { name: "Quitter la session invitée", exact: true })
      .click();
    await b.waitForURL("**/jouer");
    await b.reload();
    assert.equal(instance.app.salons[nextRoom].utilisateurs.length, 1);
    const staleProfile = track(await ca.newPage()),
      staleStats = track(await ca.newPage());
    await staleProfile.goto(base + "/profil");
    await staleStats.goto(base + "/stats");
    let releaseSession, sessionCaptured;
    const heldSession = new Promise((resolve) => {
        releaseSession = resolve;
      }),
      capturedSession = new Promise((resolve) => {
        sessionCaptured = resolve;
      });
    let heldOnce = false;
    await staleProfile.route("**/session", async (route) => {
      if (heldOnce) return route.continue();
      heldOnce = true;
      const response = await route.fetch();
      sessionCaptured();
      await heldSession;
      await route.fulfill({ response });
    });
    await staleProfile.evaluate(() => window.dispatchEvent(new Event("focus")));
    await capturedSession;
    await a.goto(base + "/profil");
    if (
      await a
        .getByRole("button", { name: "Ouvrir le menu", exact: true })
        .isVisible()
    )
      await a
        .getByRole("button", { name: "Ouvrir le menu", exact: true })
        .click();
    await a.getByRole("button", { name: "Déconnexion", exact: true }).click();
    await a.waitForURL("**/jouer");
    assert.equal(instance.app.salons[nextRoom], undefined);
    await staleProfile.evaluate(() => window.dispatchEvent(new Event("focus")));
    releaseSession();
    await Promise.all([
      staleProfile.waitForURL("**/jouer", { timeout: 2000 }),
      staleStats.waitForURL("**/jouer", { timeout: 10000 }),
    ]);
    assert.equal(
      await staleProfile.getByRole("link", { name: /Profil/ }).count(),
      0,
    );
    await a.goto(base + "/connexion");
    await a.locator("#email").fill("guest_to_account@example.test");
    await a.locator("#mdp").fill("Password1234");
    await a
      .getByRole("button", { name: "Entrer dans l’arcade →", exact: true })
      .click();
    await a.waitForURL("**/salon");
    await staleProfile.waitForURL("**/salon", { timeout: 10000 });
    await staleStats.waitForURL("**/salon", { timeout: 10000 });
    await staleProfile.close();
    await staleStats.close();
    for (const mode of ["guest", "account"]) {
      const short = createApp({
        secret: "i".repeat(48),
        store,
        ...(mode === "guest"
          ? { guestDurationMs: 1800 }
          : { sessionDurationMs: 2000 }),
      });
      await new Promise((resolve) =>
        short.server.listen(0, "127.0.0.1", resolve),
      );
      extra.push(short);
      const url = "http://127.0.0.1:" + short.server.address().port,
        cp = await context(390),
        p = track(await cp.newPage());
      if (mode === "guest") await enter(p, "qa_expiring", url);
      else {
        await p.goto(url + "/inscription");
        await p.locator("#email").fill("expiring_account@example.test");
        await p.locator("#mdp").fill("Password1234");
        await p.getByRole("button", { name: "Créer mon compte" }).click();
        await p.waitForURL("**/salon");
        await p.getByText("En ligne", { exact: true }).waitFor();
        assert.equal(
          await p.locator("#access-ended").isVisible(),
          false,
          "aucun faux bandeau d’expiration pendant une session canonique",
        );
      }
      await p.waitForURL(mode === "guest" ? "**/jouer" : "**/jouer", {
        timeout: 7000,
      });
      assert.equal(
        await p.locator("#navMenubd a[href='/connexion']").count(),
        1,
      );
      await p.waitForFunction(() =>
        document.activeElement?.classList.contains("session-notice"),
      );
      assert.equal(
        await p
          .locator(".session-notice")
          .evaluate((el) => document.activeElement === el),
        true,
      );
      await noOverflow(p);
      await cp.close();
    }
    assert.deepEqual(errors, []);
    console.log(
      JSON.stringify(
        {
          widths: [1440, 800, 390, 320],
          flows: [
            "visitor menus and visible CTA",
            "two guests no accounts",
            "full invitation denied",
            "shared stars server bonus score",
            "simultaneous same guest tabs",
            "offline refresh resume",
            "guest result not durable",
            "guest to account no duplicate place or transfer",
            "account navigation all widths",
            "guest logout",
            "account logout",
            "guest and account expiration focus",
          ],
          pageErrors: errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await browser.close();
    for (const short of extra)
      await new Promise((resolve) => short.io.close(resolve));
    await new Promise((resolve) => instance.io.close(resolve));
    await store.close();
    await mongoose.disconnect();
    await mongo.stop();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
