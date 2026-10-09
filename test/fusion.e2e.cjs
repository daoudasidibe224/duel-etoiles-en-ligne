const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");
const MongoStore = require("connect-mongo").default;
const { chromium } = require("playwright");
const { createApp } = require("../dist/src/app");
const { expect } = require("@playwright/test");

(async () => {
  const database = await MongoMemoryServer.create();
  await mongoose.connect(database.getUri());
  const store = MongoStore.create({ client: mongoose.connection.getClient() });
  const host = createApp({
    secret: "integration-fusion-local-only-".repeat(3),
    store,
    enableDrawing: true,
    gameOptions: { durationMs: 7000, random: () => 0 },
  });
  await host.drawing.ready;
  await new Promise((resolve) => host.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + host.server.address().port;
  const browser = await chromium.launch();
  const contexts = await Promise.all(
    [1440, 390].map((width) =>
      browser.newContext({
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      }),
    ),
  );
  const [alice, bob] = await Promise.all(
    contexts.map((context) => context.newPage()),
  );
  const errors = [];
  for (const page of [alice, bob])
    page.on("pageerror", (error) => errors.push(error.message));
  const output = path.join(__dirname, "../test-results");
  fs.mkdirSync(output, { recursive: true });
  const overflow = async (page) =>
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "Pas de débordement : " + page.url(),
    );
  try {
    for (const width of [1440, 800, 390, 320]) {
      await alice.setViewportSize({ width, height: 900 });
      await alice.goto(base);
      await expect(
        alice.getByRole("heading", { name: /Faites une pause/ }),
      ).toBeVisible();
      await overflow(alice);
      await alice.screenshot({
        path: path.join(output, "salle-home-" + width + ".png"),
        fullPage: true,
      });
    }
    await alice.setViewportSize({ width: 1440, height: 900 });
    // La carte choisie reste la destination après la création du compte.
    for (const [page, name] of [
      [alice, "alice_fusion"],
      [bob, "bob_fusion"],
    ]) {
      await page.goto(base + "/inscription?next=/dessin/lobby");
      await page
        .getByText("Choisir un pseudo (facultatif)", { exact: true })
        .click();
      await page.locator("#nomUtilisateur").fill(name);
      await page.locator("#email").fill(name + "@example.test");
      await page.locator("#mdp").fill("LocalTestPass1234");
      await page.getByRole("button", { name: "Créer mon compte" }).click();
      await page.waitForURL("**/dessin/lobby");
      await expect(page.locator("#nav-identity")).toContainText(name);
      await overflow(page);
    }
    const identityBefore = await alice.evaluate(async () =>
      (await fetch("/dessin/api/session")).json(),
    );
    await alice.getByLabel("Nom du salon").fill("Salon de fusion");
    await alice
      .getByRole("button", { name: "Entrer dans le salon", exact: true })
      .click();
    await expect(
      alice.getByText("Connecté au salon", { exact: true }),
    ).toBeVisible();
    const invitation = alice.url();
    await bob.goto(invitation);
    await expect(alice.locator("#player-count")).toHaveText("2 / 10");
    await alice
      .getByRole("button", { name: "Lancer la partie", exact: true })
      .click();
    await expect(alice.locator("#choices button")).toHaveCount(3);
    await expect(bob.locator("#choices button")).toHaveCount(0);
    const word = await alice.locator("#choices button").first().innerText();
    await alice.locator("#choices button").first().click();
    await expect(alice.locator("#word")).toHaveText(word);
    await expect(bob.locator("#word")).not.toHaveText(word);
    await expect(
      alice.getByText("À vous de dessiner. Gardez le mot secret.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(alice.locator("canvas")).toBeVisible();
    await expect
      .poll(async () => alice.locator("canvas").getAttribute("aria-disabled"))
      .not.toBe("true");
    const rect = await alice.locator("canvas").boundingBox();
    await alice.mouse.move(rect.x + 40, rect.y + 40);
    await alice.mouse.down();
    await alice.mouse.move(rect.x + 140, rect.y + 100, { steps: 8 });
    await alice.mouse.up();
    const ink = (page) =>
      page.locator("canvas").evaluate((canvas) => {
        const data = canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4)
          if (
            data[i + 3] > 0 &&
            data[i] < 230 &&
            data[i + 1] < 230 &&
            data[i + 2] < 230
          )
            count++;
        return count;
      });
    await expect.poll(() => ink(bob)).toBeGreaterThan(0);
    await bob.reload();
    await expect.poll(() => ink(bob)).toBeGreaterThan(0);
    await bob.getByLabel("Votre réponse", { exact: true }).fill(word);
    await bob
      .getByRole("button", { name: "Proposer la réponse", exact: true })
      .click();
    await expect(bob.locator("#players")).toContainText(/1\d\d/);
    await alice.screenshot({
      path: path.join(output, "salle-dessin-desktop.png"),
      fullPage: true,
    });
    await bob.screenshot({
      path: path.join(output, "salle-dessin-mobile.png"),
      fullPage: true,
    });
    await overflow(bob);
    // Les mêmes comptes rejoignent l'autre jeu sans nouvelle authentification.
    await alice.goto(base + "/salon");
    await bob.goto(base + "/salon");
    await expect(alice.getByText("En ligne", { exact: true })).toBeVisible();
    const identityAfter = await alice.evaluate(async () =>
      (await fetch("/dessin/api/session")).json(),
    );
    assert.deepEqual(identityAfter.user, identityBefore.user);
    await alice.getByRole("button", { name: "Ouvrir une partie" }).click();
    await alice.waitForURL("**/salon/salonDeJeu/*");
    await bob.getByRole("link", { name: "Rejoindre" }).click();
    await bob.waitForURL("**/salon/salonDeJeu/*");
    await alice.getByRole("button", { name: "Jouer", exact: true }).click();
    await alice.getByText("La partie a commencé.", { exact: true }).waitFor();
    await alice.keyboard.press("ArrowRight");
    await alice.keyboard.press("ArrowUp");
    await alice.screenshot({
      path: path.join(output, "salle-duel-desktop.png"),
      fullPage: true,
    });
    await bob.screenshot({
      path: path.join(output, "salle-duel-mobile.png"),
      fullPage: true,
    });
    await overflow(bob);
    await expect(alice.getByText(/Partie terminée/)).toBeVisible({
      timeout: 15000,
    });
    // La déconnexion du site révoque aussi une place de dessin ouverte.
    await alice.goto(invitation);
    await expect(
      alice.getByText("Connecté au salon", { exact: true }),
    ).toBeVisible();
    const secondTab = await contexts[0].newPage();
    await secondTab.goto(base + "/salon");
    await secondTab
      .getByRole("button", { name: "Déconnexion", exact: true })
      .click();
    await expect
      .poll(async () =>
        alice.evaluate(async () => (await fetch("/dessin/api/session")).json()),
      )
      .toMatchObject({ user: null });
    await expect(
      alice.getByRole("link", { name: "Jouer avec un pseudo", exact: true }),
    ).toBeVisible();
    await alice.goto(base + "/jouer?next=/dessin/lobby");
    await alice.locator("#nomUtilisateur").fill("fusion_invite");
    await alice.getByRole("button", { name: "Jouer par pseudo" }).click();
    await alice.waitForURL("**/dessin/lobby");
    const guestBefore = await alice.evaluate(async () =>
      (await fetch("/dessin/api/session")).json(),
    );
    assert.equal(guestBefore.kind, "guest");
    await expect(alice.locator("#nav-identity")).toContainText("fusion_invite");
    await alice.getByLabel("Nom du salon").fill("Salon invité commun");
    await alice
      .getByRole("button", { name: "Entrer dans le salon", exact: true })
      .click();
    await expect(alice.locator("#player-count")).toHaveText("1 / 10");
    await alice.goto(base + "/salon");
    await expect(alice.getByText("En ligne", { exact: true })).toBeVisible();
    const guestAfter = await alice.evaluate(async () =>
      (await fetch("/dessin/api/session")).json(),
    );
    assert.deepEqual(guestAfter.user, guestBefore.user);
    await alice
      .getByRole("button", { name: "Quitter la session invitée", exact: true })
      .click();
    await expect
      .poll(async () =>
        alice.evaluate(async () => (await fetch("/dessin/api/session")).json()),
      )
      .toMatchObject({ user: null });
    assert.deepEqual(errors, []);
    console.log(
      "Fusion validée : accueil 1440/800/390/320, comptes et invités communs, dessin synchronisé, mots privés, reprise, duel terminé, déconnexion commune.",
    );
  } catch (error) {
    await alice
      .screenshot({
        path: path.join(output, "fusion-failure-alice.png"),
        fullPage: true,
      })
      .catch(() => {});
    await bob
      .screenshot({
        path: path.join(output, "fusion-failure-bob.png"),
        fullPage: true,
      })
      .catch(() => {});
    throw error;
  } finally {
    await browser.close();
    await host.drawing.close();
    await new Promise((resolve) => host.io.close(resolve));
    await store.close();
    await mongoose.disconnect();
    await database.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
