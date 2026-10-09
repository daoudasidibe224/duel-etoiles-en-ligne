const path = require("node:path");
const fs = require("node:fs");
const root = path.join(__dirname, "..");
const results = path.join(root, "test-results");
fs.mkdirSync(results, { recursive: true });
const { MongoMemoryServer } = require(
  path.join(root, "node_modules/mongodb-memory-server"),
);
const mongoose = require(path.join(root, "node_modules/mongoose"));
const MongoStore = require(
  path.join(root, "node_modules/connect-mongo"),
).default;
const { createApp } = require(path.join(root, "dist/src/app"));
const { chromium } = require("playwright");
const { itemY } = require(path.join(root, "dist/shared/progression"));
const assert = require("node:assert/strict");
(async () => {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  const store = MongoStore.create({ client: mongoose.connection.getClient() });
  const { app, server, io } = createApp({ secret: "q".repeat(48), store, gameOptions: { random: () => 0 } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const track = (page) =>
    page.on("pageerror", (error) => errors.push(error.message));
  const a = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    b = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const one = await a.newPage(),
    two = await b.newPage();
  for (const page of [one, two]) {
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.dismiss());
  }
  for (const width of [320, 390, 800, 1440]) {
    await two.setViewportSize({ width, height: 900 });
    for (const route of ["/connexion", "/inscription"]) {
      await two.goto(base + route);
      assert.equal(
        await two.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${width} ${route}`,
      );
    }
  }
  await two.setViewportSize({ width: 390, height: 844 });
  await two.emulateMedia({ reducedMotion: "reduce" });
  await two.goto(base + "/connexion");
  await two.screenshot({
    path: path.join(results, "jeu-mobile-auth.png"),
    fullPage: true,
  });
  await one.goto(base + "/connexion");
  await one.screenshot({
    path: path.join(results, "jeu-desktop.png"),
    fullPage: true,
  });
  async function signUp(page, name) {
    await page.goto(base + "/inscription");
    await page
      .getByText("Choisir un pseudo (facultatif)", { exact: true })
      .click();
    await page.locator("#nomUtilisateur").fill(name);
    await page.locator("#email").fill(name + "@example.test");
    await page.locator("#mdp").fill("Password1234");
    await page.getByRole("button", { name: "Créer mon compte" }).click();
    await page.waitForURL("**/salon");
    await page.getByText("En ligne", { exact: true }).waitFor();
  }
  await signUp(one, "qa_one");
  await signUp(two, "qa_two");
  const optionalError = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  track(optionalError);
  await optionalError.goto(base + "/inscription");
  await optionalError.locator("#email").fill("pseudo-collision@example.test");
  await optionalError.locator("#mdp").fill("Password1234");
  await optionalError
    .getByText("Choisir un pseudo (facultatif)", { exact: true })
    .click();
  await optionalError.locator("#nomUtilisateur").fill("qa_one");
  await optionalError.getByRole("button", { name: "Créer mon compte" }).click();
  await optionalError
    .getByText("Ce pseudo est déjà utilisé.", { exact: true })
    .waitFor();
  assert.equal(
    await optionalError
      .locator("details.optional-profile")
      .getAttribute("open"),
    "",
  );
  assert.equal(
    await optionalError.locator("#nomUtilisateur").getAttribute("aria-invalid"),
    "true",
  );
  assert.equal(
    await optionalError.evaluate(() =>
      document.activeElement?.getAttribute("role"),
    ),
    "alert",
  );
  await optionalError.close();

  await two.screenshot({
    path: path.join(results, "jeu-mobile-lobby.png"),
    fullPage: true,
  });
  assert.equal(
    await two.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await two.getByRole("button", { name: "Ouvrir le menu" }).focus();
  await two.keyboard.press("Enter");
  assert.equal(
    await two
      .getByRole("button", { name: "Ouvrir le menu" })
      .getAttribute("aria-expanded"),
    "true",
  );
  await two.keyboard.press("Escape");
  assert.equal(
    await two
      .getByRole("button", { name: "Ouvrir le menu" })
      .getAttribute("aria-expanded"),
    "false",
  );
  await one.getByRole("button", { name: "Ouvrir une partie" }).click();
  await one.waitForURL("**/salon/salonDeJeu/*");
  await two.getByRole("link", { name: "Rejoindre" }).click();
  await two.waitForURL("**/salon/salonDeJeu/*");
  await one
    .getByRole("button", { name: "Jouer", exact: true })
    .waitFor({ state: "visible" });
  await two.locator("#airDeJeu").waitFor({ state: "visible" });
  await two
    .getByRole("button", { name: "Activer le son", exact: true })
    .click();
  assert.equal(
    await two
      .getByRole("button", { name: "Couper le son", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  const matchUrl = one.url();
  for (let repetition = 0; repetition < 3; repetition++) {
    const twins = await Promise.all([a.newPage(), a.newPage()]);
    for (const page of twins) track(page);
    await Promise.all(twins.map((page) => page.goto(matchUrl)));
    await Promise.all(
      twins.map((page) =>
        page
          .locator("#self-name")
          .getByText("qa_one", { exact: true })
          .waitFor(),
      ),
    );
    const players = app.salons[matchUrl.split("/").pop()].utilisateurs;
    assert.equal(players.length, 2);
    assert.equal(new Set(players.map((player) => player.userId)).size, 2);
    await Promise.all(twins.map((page) => page.close()));
    await one.reload();
    await one
      .getByRole("button", { name: "Jouer", exact: true })
      .waitFor({ state: "visible" });
  }
  await one.getByRole("button", { name: "Jouer", exact: true }).click();
  await one.getByText("La partie a commencé.", { exact: true }).waitFor();
  await two.getByText("La partie a commencé.", { exact: true }).waitFor();
  assert.equal(await two.locator("#self-name").textContent(), "qa_two");
  const live = app.salons[matchUrl.split("/").pop()];
  const contactItem = (kind) => {
    const now = Date.now();
    const item = { id: require("node:crypto").randomUUID(), kind, x: live.utilisateurs[0].x + 22.5, bornAt: now, speed: 140 };
    let low = now - 5000, high = now;
    for (let i = 0; i < 40; i++) {
      item.bornAt = (low + high) / 2;
      if (itemY(item, now, live.round) > 450) low = item.bornAt;
      else high = item.bornAt;
    }
    live.round.stars.push(item);
  };
  contactItem("multiplier");
  await one.getByText("Points ×2 activé", { exact: true }).waitFor();
  assert.equal(await one.locator("#bonus-multiplier").count(), 0);
  await one.waitForFunction(() => document.querySelector("#gameCanvas")?.dataset.renderer === "canvas-2d");
  await one.waitForFunction(
    () => Number(document.querySelector("#self-score")?.textContent) >= 2,
    null,
    { timeout: 8000 },
  );
  await b.setOffline(true);
  await two.reload({ timeout: 4000 }).catch(() => {});
  await b.setOffline(false);
  await two.goto(matchUrl);
  await two.getByText("La partie a commencé.", { exact: true }).waitFor();
  assert.equal(app.salons[matchUrl.split("/").pop()].utilisateurs.length, 2);
  await one.screenshot({
    path: path.join(results, "jeu-desktop-game.png"),
    fullPage: true,
  });
  await two.locator("#countdown").waitFor({ state: "visible" });
  await two
    .locator("#move-right")
    .dispatchEvent("pointerdown", { pointerId: 1 });
  await two.waitForTimeout(150);
  await two.locator("#move-right").dispatchEvent("pointerup", { pointerId: 1 });
  await two.keyboard.press("ArrowLeft");
  await two.screenshot({
    path: path.join(results, "jeu-mobile-game.png"),
    fullPage: true,
  });
  assert.equal(
    await two.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  await one
    .getByText("Étape 2 / 3 · Pluie cosmique", { exact: true })
    .waitFor({ timeout: 35000 });
  contactItem("sprint");
  await one.getByText("Vitesse +50 % activée", { exact: true }).waitFor();
  await one.getByText("Étape 3 / 3 · Dernière rafale", { exact: true }).waitFor({ timeout: 37000 });
  contactItem("shield");
  await one.getByText("Bouclier activé", { exact: true }).waitFor();
  await one
    .getByText("Score enregistré. Retrouvez cette partie dans vos scores.", {
      exact: true,
    })
    .waitFor({ timeout: 110000 });
  await one.getByRole("button", { name: "Terminer", exact: true }).click();
  await one.waitForURL("**/salon");
  await one.goto(base + "/stats");
  await one.getByText("qa_one / qa_two", { exact: true }).waitFor();
  await two.goto(base + "/salon/discussion&jeu");
  await one.goto(base + "/salon/discussion&jeu");
  await one.getByText("Vous êtes en ligne.", { exact: true }).waitFor();
  await one.locator("#message").fill("<img src=x onerror=alert(1)>");
  await one.getByRole("button", { name: "Envoyer", exact: true }).click();
  await two
    .getByText("<img src=x onerror=alert(1)>", { exact: true })
    .waitFor();
  assert.equal(await two.locator(".chatBox img").count(), 0);
  await two.screenshot({
    path: path.join(results, "jeu-mobile-chat.png"),
    fullPage: true,
  });
  assert.equal(
    await two.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  for (const width of [320, 390, 800, 1440]) {
    await two.setViewportSize({ width, height: 900 });
    for (const route of [
      "/salon",
      "/profil",
      "/stats",
      "/salon/discussion&jeu",
    ]) {
      await two.goto(base + route);
      assert.equal(
        await two.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
        `${width} ${route}`,
      );
    }
  }
  await two.goto(base + "/missing");
  await two
    .getByRole("heading", { name: "Page introuvable", exact: true })
    .waitFor();
  assert.equal(
    await two.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        desktop: 1440,
        mobile: 390,
        flows: [
          "register",
          "menu",
          "lobby",
          "two players",
          "same account concurrent tabs x3",
          "offline refresh and round resume",
          "start",
          "server shared stars confirmed score",
          "three stages, 2D renderer and automatic pickup bonus",
          "touch",
          "results",
          "stats",
          "safe chat",
        ],
        pageErrors: errors,
      },
      null,
      2,
    ),
  );
  await one.goto(base + "/profil");
  await two.goto(base + "/profil");
  await new Promise((resolve) => setTimeout(resolve, 200));
  await browser.close();
  await new Promise((resolve) => io.close(resolve));
  await store.close();
  await mongoose.disconnect();
  await mongo.stop();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
