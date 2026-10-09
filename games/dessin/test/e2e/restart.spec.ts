import { test, expect, type Page } from "@playwright/test";
import { MongoMemoryServer } from "mongodb-memory-server";
import { ServerProcess } from "../fixtures/server-process";

// Guest entry happens on the shared site; the test host offers the same session.
async function enter(page: Page, base: string, name: string) {
  const response = await page.request.post(base + "/test/guest", {
    data: { name },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto(base + "/dessin/lobby");
  await expect(page.locator("#welcome")).toContainText(name);
}

test("vrai redémarrage : navigateur reconnecté, partie interrompue visible, points et places uniques", async ({
  page,
  browser,
  context,
}) => {
  test.setTimeout(60000);
  const database = await MongoMemoryServer.create();
  const server = new ServerProcess();
  const friendContext = await browser.newContext();
  const watcherContext = await browser.newContext();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const uri = database.getUri("browser_restart");
    const base = await server.start(uri);
    await enter(page, base, "Crayon durable");
    await page.getByLabel("Nom du salon").fill("Redémarrage navigateur");
    await page.getByRole("button", { name: "Entrer dans le salon" }).click();
    const url = page.url();
    const friend = await friendContext.newPage();
    const watcher = await watcherContext.newPage();
    await enter(friend, base, "Devineur durable");
    await enter(watcher, base, "Témoin durable");
    await friend.goto(url);
    await watcher.goto(url);
    await expect(page.locator("#player-count")).toHaveText("3 / 10");
    await page.getByRole("button", { name: "Lancer la partie" }).click();
    const choice = page.locator("#choices button").first();
    const word = await choice.innerText();
    await choice.click();
    await expect(page.locator("#phase")).toHaveText("À vous de dessiner !");
    await friend.locator("#answer").fill(word);
    await friend.locator("#answer-form button").click();
    await expect(friend.locator("#players")).toContainText("Mot trouvé !");
    await expect(
      page
        .locator("#players li")
        .filter({ hasText: "Crayon durable" })
        .locator("b"),
    ).toHaveText("50");
    const points = await friend
      .locator("#players li")
      .filter({ hasText: "Devineur durable" })
      .locator("b")
      .innerText();
    await server.kill();
    await expect(page.locator("#network")).toContainText(
      "Connexion interrompue",
    );
    await expect(page.locator("#drawing-tools")).toHaveAttribute(
      "disabled",
      "",
    );
    await server.start(uri);
    await expect(page.locator("#network")).toHaveText("Connecté au salon", {
      timeout: 15000,
    });
    await expect(page.locator("#messages")).toContainText(
      "La partie est interrompue",
    );
    await expect(page.locator("#player-count")).toHaveText("3 / 10");
    await expect(page.locator("#phase")).toHaveText(
      "Prêts · départ par l’hôte",
    );
    await expect(page.locator("#timer")).toHaveText("—");
    await expect(page.locator("#choices button")).toHaveCount(0);
    await expect(friend.locator("#answer-form")).toBeHidden();
    await expect(
      page
        .locator("#players li")
        .filter({ hasText: "Crayon durable" })
        .locator("b"),
    ).toHaveText("50");
    await expect(
      friend
        .locator("#players li")
        .filter({ hasText: "Devineur durable" })
        .locator("b"),
    ).toHaveText(points);
    await expect(page.locator("#gallery article")).toHaveCount(1);
    const second = await context.newPage();
    await second.goto(url);
    await expect(
      page.getByRole("button", { name: "Reprendre ma place ici" }),
    ).toBeVisible();
    await expect(page.locator("#start")).toBeDisabled();
    await expect(second.locator("#player-count")).toHaveText("3 / 10");
    await expect(second.locator("#start")).toBeEnabled();
    await second.getByRole("button", { name: "Quitter le salon" }).click();
    await expect(friend.locator("#player-count")).toHaveText("2 / 10");
    await expect(friend.locator("#start-form")).toBeVisible();
    await second.close();
    expect(errors).toEqual([]);
  } finally {
    await server.kill();
    await friendContext.close();
    await watcherContext.close();
    await database.stop();
  }
});

test("promotion HTTP pendant attente du moteur : message visible, aucun faux annuaire vide, reprise après SIGTERM", async ({
  page,
  context,
}) => {
  test.setTimeout(30000);
  const database = await MongoMemoryServer.create();
  const first = new ServerProcess(),
    second = new ServerProcess();
  try {
    const uri = database.getUri("browser_lease_handoff");
    const base = await first.start(uri);
    await enter(page, base, "Crayon promotion");
    await page.getByLabel("Nom du salon").fill("Salon à reprendre");
    await page.getByRole("button", { name: "Entrer dans le salon" }).click();
    await expect(page.locator("#player-count")).toHaveText("1 / 10");
    const waitingBase = await second.start(uri, 30000, false);
    const next = await context.newPage();
    await next.goto(waitingBase + "/dessin/lobby");
    await expect(next.locator("#directory-status")).toContainText(
      "Le serveur reprend les salons",
    );
    await expect(next.locator("#directory-status")).not.toContainText(
      "Aucun salon ouvert",
    );
    await next.getByLabel("Nom du salon").fill("Salon interdit");
    await next.getByRole("button", { name: "Entrer dans le salon" }).click();
    await expect(next).toHaveURL(waitingBase + "/dessin/lobby");
    await expect(next.locator("#lobby-error")).toContainText(
      "Le serveur reprend les salons",
    );
    await first.kill("SIGTERM");
    await expect(next.locator("#directory-status")).toContainText("1 salon", {
      timeout: 15000,
    });
    await expect(next.locator(".room-card")).toContainText("Salon à reprendre");
    await next
      .locator(".room-card")
      .getByRole("link", { name: "Reprendre ma place" })
      .click();
    await expect(next.locator("#network")).toHaveText("Connecté au salon");
    await expect(next.locator("#player-count")).toHaveText("1 / 10");
    await expect(next.locator("#messages")).toContainText(
      "Le serveur a redémarré",
    );
    await next.close();
  } finally {
    await first.kill();
    await second.kill();
    await database.stop();
  }
});
