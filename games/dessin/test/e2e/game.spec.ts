import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
// Accounts and guests belong to the shared site. The test host exposes the
// same session contract through small routes, then the browser opens /dessin.
async function register(page: Page, name: string) {
  const response = await page.request.post("/test/login", {
    data: { name, email: `${name.toLowerCase()}-${Date.now()}@example.fr` },
  });
  expect(response.ok()).toBeTruthy();
  await page.goto("/dessin/lobby");
  await expect(page.locator("#welcome")).toHaveText("Bienvenue, " + name);
}
async function enterGuest(page: Page, name: string) {
  const response = await page.request.post("/test/guest", { data: { name } });
  expect(response.ok()).toBeTruthy();
  await page.goto("/dessin/lobby");
  await expect(page.getByLabel("Nom du salon")).toBeVisible();
}
async function targets(page: Page) {
  // Every visible control offers a 44 px touch target.
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "button, a[href], select, input:not([type=hidden]):not([type=range]), summary",
      ),
    ]
      .filter((item) => item.offsetParent !== null)
      .filter((item) => {
        const box = item.getBoundingClientRect();
        return box.height < 43.5 || (box.width < 43.5 && box.width > 0);
      })
      .map((item) => item.id || item.textContent?.trim() || item.tagName),
  );
}
async function ink(page: Page) {
  return page.locator("canvas").evaluate((canvas) => {
    if (!(canvas instanceof HTMLCanvasElement)) return 0;
    const ctx = canvas.getContext("2d");
    if (!ctx) return 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4)
      if (data[i] < 230 && data[i + 1] < 230 && data[i + 2] < 230) sum++;
    return sum;
  });
}
async function overflow(page: Page) {
  for (const width of [320, 390, 800, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  }
}
test("partie réelle : deux comptes, dessin, redimensionnement, PNG, score et clavier", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await register(page, "Alice");
  await page.getByLabel("Nom du salon").fill("Partie " + Date.now());
  await page.getByRole("button", { name: "Entrer dans le salon" }).click();
  await expect(
    page.getByText("Connecté au salon", { exact: true }),
  ).toBeVisible();
  const url = page.url();
  const context = await browser.newContext();
  const bob = await context.newPage();
  bob.on("pageerror", (error) => errors.push(error.message));
  await register(bob, "Bob");
  await bob.goto(url);
  await expect(page.locator("#player-count")).toHaveText("2 / 10");
  await expect(bob.locator("#start-form")).toBeHidden();
  await page.getByRole("button", { name: "Lancer la partie" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#choices button")).toHaveCount(3);
  await expect(bob.locator("#choices button")).toHaveCount(0);
  await overflow(page);
  const choice = page.locator("#choices button").first(),
    word = await choice.innerText();
  await choice.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#word")).toHaveText(word);
  await expect(bob.locator("#word")).not.toHaveText(word);
  await expect(
    bob.getByRole("button", { name: "Annuler le trait", includeHidden: true }),
  ).toBeDisabled();
  const rect = await page.locator("canvas").boundingBox();
  expect(rect).not.toBeNull();
  if (!rect) throw new Error("Canvas absent");
  await page.mouse.move(rect.x + rect.width * 0.2, rect.y + rect.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(
    rect.x + rect.width * 0.75,
    rect.y + rect.height * 0.65,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect.poll(() => ink(bob)).toBeGreaterThan(0);
  const original = await ink(page);
  expect(original).toBeGreaterThan(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => ink(page)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => ink(page)).toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Annuler le trait", includeHidden: true })
    .click();
  await expect.poll(() => ink(bob)).toBe(0);
  await page.locator("canvas").scrollIntoViewIfNeeded();
  const second = await page.locator("canvas").boundingBox();
  if (!second) throw new Error("Canvas absent");
  await page.mouse.move(second.x + 30, second.y + 30);
  await page.mouse.down();
  await page.mouse.move(second.x + 100, second.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => ink(page)).toBeGreaterThan(0);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Exporter PNG" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("dessine-et-devine.png");
  const path = await file.path();
  expect(path).not.toBeNull();
  if (path) {
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  }
  await bob.reload();
  await expect.poll(() => ink(bob)).toBeGreaterThan(0);
  await expect(bob.locator("#player-count")).toHaveText("2 / 10");
  await bob.getByLabel("Votre réponse", { exact: true }).focus();
  await bob.keyboard.type(word);
  await bob.keyboard.press("Enter");
  await expect(
    bob.getByText("Bob a trouvé le mot !", { exact: true }),
  ).toBeVisible();
  await expect(bob.locator("#word")).toHaveText(word);
  await expect(bob.locator("#players")).toContainText(/1\d\d/);
  await page.screenshot({
    path: process.env.QA_SCREENSHOT || "test-results/canvas-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: process.env.QA_MOBILE_SCREENSHOT || "test-results/canvas-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
  await context.close();
});
test("tactile, outils et formulaires à 320 pixels", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 320, height: 900 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await register(page, "Touch");
  await page.getByLabel("Nom du salon").fill("Touch " + Date.now());
  await page.getByRole("button", { name: "Entrer dans le salon" }).click();
  const url = page.url();
  const other = await browser.newContext();
  const guest = await other.newPage();
  await register(guest, "Guest");
  await guest.goto(url);
  await expect(page.locator("#player-count")).toHaveText("2 / 10");
  await page.getByRole("button", { name: "Lancer la partie" }).click();
  await page.locator("#choices button").first().click();
  await expect(page.getByRole("button", { name: "Crayon bleu" })).toBeEnabled();
  const rect = await page.locator("canvas").boundingBox();
  if (!rect) throw new Error("Toile absente");
  await page.touchscreen.tap(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await expect.poll(() => ink(guest)).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  expect(await targets(page)).toEqual([]);
  await page
    .getByRole("combobox", { name: "Couleur", exact: true })
    .selectOption("#ffffff");
  await expect(
    page.getByRole("combobox", { name: "Couleur", exact: true }),
  ).toHaveValue("#ffffff");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Effacer", exact: true }).click();
  await expect.poll(() => ink(guest)).toBe(0);
  await other.close();
  await context.close();
});
test("chat sans HTML, retour clavier, liens communs et déconnexion du site", async ({
  page,
}) => {
  await register(page, "Safe");
  await expect(
    page.getByRole("link", { name: "Tous les jeux" }),
  ).toHaveAttribute("href", "/");
  await expect(page.getByRole("link", { name: "Mon profil" })).toHaveAttribute(
    "href",
    "/profil",
  );
  await expect(page.locator("#nav-identity")).toHaveText("Safe");
  await page.getByLabel("Nom du salon").fill("Safe " + Date.now());
  await page.getByRole("button", { name: "Entrer dans le salon" }).click();
  await expect(
    page.getByText("Connecté au salon", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Votre idée ou message")
    .fill("<img src=x onerror=alert(1)>");
  await page.getByRole("button", { name: "Envoyer le message" }).click();
  await expect(page.locator("#messages")).toContainText(
    "<img src=x onerror=alert(1)>",
  );
  await expect(page.locator("#messages img")).toHaveCount(0);
  await overflow(page);
  await page.getByRole("button", { name: "Quitter le salon" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dessin\/lobby/);
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toMatch(/csrf|password|run\.sid/i);
  await page.getByRole("button", { name: "Se déconnecter" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/dessin\/lobby/);
  await expect(
    page.getByRole("link", { name: "Jouer avec un pseudo" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Mon profil" })).toBeHidden();
});

test("un compte dans deux onglets : reprise de la place, toile conservée et hôte transféré une fois", async ({
  page,
  browser,
  context,
}) => {
  await register(page, "Onglet");
  await page.getByLabel("Nom du salon").fill("Onglets " + Date.now());
  await page.getByRole("button", { name: "Entrer dans le salon" }).click();
  const url = page.url();
  const friendContext = await browser.newContext();
  const friend = await friendContext.newPage();
  await register(friend, "AmiTab");
  await friend.goto(url);
  await expect(page.locator("#player-count")).toHaveText("2 / 10");
  await page.getByRole("button", { name: "Lancer la partie" }).click();
  await page.locator("#choices button").first().click();
  await expect(page.getByRole("button", { name: "Crayon bleu" })).toBeEnabled();
  const box = await page.locator("canvas").boundingBox();
  if (!box) throw new Error("Toile absente");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 75, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => ink(friend)).toBeGreaterThan(0);
  const second = await context.newPage();
  await second.goto(url);
  await expect(second.locator("#player-count")).toHaveText("2 / 10");
  await expect(
    page.getByRole("button", { name: "Reprendre ma place ici" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Annuler le trait", includeHidden: true }),
  ).toBeDisabled();
  await expect(
    second.getByRole("button", {
      name: "Annuler le trait",
      includeHidden: true,
    }),
  ).toBeEnabled();
  await expect.poll(() => ink(second)).toBeGreaterThan(0);
  await expect(friend.locator("#messages")).toContainText(
    "Onglet rejoint le salon.",
  );
  expect(await friend.locator("#messages").innerText()).not.toMatch(
    /Onglet rejoint le salon.[\s\S]*Onglet rejoint le salon./,
  );
  await second.getByRole("button", { name: "Crayon corail" }).focus();
  await second.keyboard.press("Enter");
  await expect(
    second.getByRole("button", { name: "Crayon corail" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    second.getByRole("combobox", { name: "Couleur", exact: true }),
  ).toHaveValue("#df6151");
  await overflow(second);
  await second.getByRole("button", { name: "Quitter le salon" }).click();
  await expect(second).toHaveURL(/\/dessin\/lobby/);
  await expect(friend.locator("#player-count")).toHaveText("1 / 10");
  await expect(friend.locator("#start-form")).toBeVisible();
  await expect(friend.locator("#messages")).toContainText(
    "Onglet quitte le salon.",
  );
  await second.close();
  await friendContext.close();
});

test("formes, rétablissement, manche archivée et derniers salons après reprise", async ({
  page,
  browser,
  context,
}) => {
  await register(page, "Crayon");
  const room = "Outils " + Date.now();
  await page.getByLabel("Nom du salon").fill(room);
  await page.getByRole("button", { name: "Entrer dans le salon" }).click();
  const url = page.url();
  const friendContext = await browser.newContext();
  const friend = await friendContext.newPage();
  await register(friend, "FormesGuest");
  await friend.goto(url);
  await expect(page.locator("#player-count")).toHaveText("2 / 10");
  await page.getByRole("button", { name: "Lancer la partie" }).click();
  await page.locator("#choices button").first().click();
  await expect(page.getByRole("button", { name: "Crayon bleu" })).toBeEnabled();
  await page
    .getByRole("combobox", { name: "Outil", exact: true })
    .selectOption("rectangle");
  const rect = await page.locator("#drawing").boundingBox();
  if (!rect) throw new Error("Toile absente");
  await page.mouse.move(rect.x + rect.width * 0.2, rect.y + rect.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width * 0.7, rect.y + rect.height * 0.7, {
    steps: 4,
  });
  await page.mouse.up();
  await expect.poll(() => ink(friend)).toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Annuler le trait", includeHidden: true })
    .click();
  await expect.poll(() => ink(friend)).toBe(0);
  await page.getByRole("button", { name: "Rétablir le trait" }).click();
  await expect.poll(() => ink(friend)).toBeGreaterThan(0);
  for (const tool of ["line", "ellipse"]) {
    await page
      .getByRole("combobox", { name: "Outil", exact: true })
      .selectOption(tool);
    await page.locator("#drawing").scrollIntoViewIfNeeded();
    const box = await page.locator("#drawing").boundingBox();
    if (!box) throw new Error("Toile absente");
    const previous = await ink(friend);
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, {
      steps: 3,
    });
    await page.mouse.up();
    await expect.poll(() => ink(friend)).toBeGreaterThan(previous);
  }
  const second = await context.newPage();
  await second.goto(url);
  await expect(second.locator("#player-count")).toHaveText("2 / 10");
  await expect.poll(() => ink(second)).toBeGreaterThan(0);
  await expect(
    second.getByRole("button", { name: "Passer mon tour" }),
  ).toBeVisible();
  await expect(
    friend.getByRole("button", { name: "Passer mon tour" }),
  ).toBeHidden();
  second.once("dialog", (dialog) => dialog.accept());
  await second.getByRole("button", { name: "Passer mon tour" }).click();
  await expect(second.locator("#gallery-count")).toHaveText("1");
  await second.locator(".round-gallery summary").click();
  await expect(second.locator("#gallery canvas")).toHaveCount(1);
  const download = second.waitForEvent("download");
  await second.getByRole("button", { name: "Exporter cette manche" }).click();
  expect((await download).suggestedFilename()).toMatch(/^manche-1.png$/);
  await expect(friend.locator("#gallery-count")).toHaveText("1");
  for (const width of [1440, 800, 390, 320]) {
    await second.setViewportSize({ width, height: 900 });
    expect(
      await second.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  }
  await second.getByRole("button", { name: "Quitter le salon" }).click();
  await expect(second.locator("#recent-links")).toContainText(room);
  await second.reload();
  await expect(second.locator("#recent-links")).toContainText(room);
  await second
    .getByRole("button", { name: "Oublier ces salons sur cet appareil" })
    .click();
  await expect(second.locator("#recent-rooms")).toBeHidden();
  await second.reload();
  await expect(second.locator("#recent-rooms")).toBeHidden();
  await second.close();
  await friendContext.close();
});

test("invités sans compte : accès commun, rename, takeover, réseau, conversion et sortie", async ({
  page,
  context,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/dessin/room?room=Visite");
  const play = page.getByRole("link", { name: "Jouer avec un pseudo" });
  await expect(play).toHaveAttribute("href", "/jouer?next=%2Fdessin%2Flobby");
  expect((await play.boundingBox())?.y).toBeLessThan(700);
  await expect(
    page.getByRole("link", { name: "Se connecter" }),
  ).toHaveAttribute("href", "/connexion");
  await expect(
    page.getByRole("link", { name: "Créer un compte" }),
  ).toHaveAttribute("href", "/inscription");
  await expect(
    page.getByRole("link", { name: "Tous les jeux" }),
  ).toHaveAttribute("href", "/");
  await overflow(page);
  expect(await targets(page)).toEqual([]);
  await enterGuest(page, "Camille");
  await expect(page.getByRole("link", { name: "Mon profil" })).toBeHidden();
  await expect(page.locator("#access-link")).toBeHidden();
  await expect(page.locator("#nav-identity")).toHaveText("Camille · invité");
  const identity = (
    await (await page.request.get("/dessin/api/session")).json()
  ).user.id;
  const cookie = (await context.cookies()).find(
    (cookie) => cookie.name === "run.sid",
  );
  expect(cookie?.httpOnly).toBe(true);
  await page
    .getByLabel("Nom du salon")
    .fill("Invités navigateur " + Date.now());
  await page.getByRole("button", { name: "Entrer dans le salon" }).click();
  const room = page.url();
  const otherContext = await browser.newContext(),
    friend = await otherContext.newPage();
  await enterGuest(friend, "Alex");
  await friend.goto(room);
  await expect(page.locator("#player-count")).toHaveText("2 / 10");
  // A rename on the shared site reaches the room without a new identity.
  await page.request.post("/test/guest", { data: { name: "Camille crayon" } });
  await expect(friend.locator("#players")).toContainText("Camille crayon");
  expect(
    (await (await page.request.get("/dessin/api/session")).json()).user.id,
  ).toBe(identity);
  const second = await context.newPage();
  await second.goto(room);
  await expect(second.locator("#player-count")).toHaveText("2 / 10");
  await expect(page.locator("#resume")).toBeVisible();
  await context.setOffline(true);
  await expect(second.locator("#network")).toContainText("interrompue");
  await context.setOffline(false);
  await second.reload();
  await expect(second.locator("#player-count")).toHaveText("2 / 10");
  expect(
    (await (await second.request.get("/dessin/api/session")).json()).user.id,
  ).toBe(identity);
  await second.getByRole("button", { name: "Lancer la partie" }).click();
  const choice = second.locator("#choices button").first();
  const word = await choice.innerText();
  await choice.click();
  await friend.getByLabel("Votre réponse", { exact: true }).fill(word);
  await friend.getByRole("button", { name: "Proposer la réponse" }).click();
  await expect(second.locator("#players")).toContainText("50");
  // Account creation on the shared site ends the guest seat (no transfer).
  await second.request.post("/test/login", {
    data: {
      name: "Compte Camille",
      email: "camille-" + Date.now() + "@example.fr",
    },
  });
  await expect(friend.locator("#player-count")).toHaveText("1 / 10");
  await second.goto("/dessin/lobby");
  await expect(second.getByRole("link", { name: "Mon profil" })).toBeVisible();
  const account = await (
    await second.request.get("/dessin/api/session")
  ).json();
  expect(account.kind).toBe("account");
  expect(account.user.id).not.toBe(identity);
  await second.goto(room);
  await expect(second.locator("#player-count")).toHaveText("2 / 10");
  await expect(second.locator("#players")).not.toContainText("Camille crayon");
  if (!cookie) throw Error("Cookie absent");
  const copied = await browser.newContext();
  await copied.addCookies([cookie]);
  const stale = await copied.newPage();
  await stale.goto(room);
  await expect(
    stale.getByRole("link", { name: "Jouer avec un pseudo" }),
  ).toBeVisible();
  await copied.close();
  await second.getByRole("button", { name: "Se déconnecter" }).click();
  await expect(
    second.getByRole("link", { name: "Jouer avec un pseudo" }),
  ).toBeVisible();
  await expect(friend.locator("#player-count")).toHaveText("1 / 10");
  await page.bringToFront();
  await expect(
    page.getByRole("link", { name: "Jouer avec un pseudo" }),
  ).toBeVisible();
  await friend.getByRole("button", { name: "Quitter l’accès invité" }).click();
  await expect(
    friend.getByRole("link", { name: "Jouer avec un pseudo" }),
  ).toBeVisible();
  await otherContext.close();
  expect(errors).toEqual([]);
});

test("mouvement réduit et couleur des actions", async ({ browser }) => {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  const page = await context.newPage();
  await enterGuest(page, "Calme");
  const primary = page.getByRole("button", { name: /Entrer dans le salon/ });
  expect(
    await primary.evaluate((item) => getComputedStyle(item).transitionDuration),
  ).toMatch(/^0s/);
  expect(
    await primary.evaluate((item) => getComputedStyle(item).backgroundColor),
  ).toBe("rgb(191, 70, 48)");
  await context.close();
});

test("annuaire en direct, réponses par phase et navigation au clavier", async ({
  page,
  browser,
}) => {
  await enterGuest(page, "Hôte annuaire");
  const watch = await browser.newContext();
  const guest = await watch.newPage();
  await enterGuest(guest, "Ami annuaire");
  const name = "Annuaire " + Date.now();
  await page.getByLabel("Nom du salon").fill(name);
  await page.getByRole("button", { name: "Entrer dans le salon" }).click();
  await expect(
    guest.locator(".room-card").filter({ hasText: name }),
  ).toContainText("1 / 10");
  await overflow(guest);
  await guest
    .locator(".room-card")
    .filter({ hasText: name })
    .getByRole("link", { name: "Rejoindre", exact: true })
    .click();
  await expect(page.locator("#player-count")).toHaveText("2 / 10");
  await watch.setOffline(true);
  await expect(page.locator("#phase")).toHaveText("Un joueur se reconnecte");
  await expect(page.locator("#start")).toBeDisabled();
  await watch.setOffline(false);
  await expect(page.locator("#phase")).toHaveText("Prêts · départ par l’hôte");
  await expect(page.locator("#start")).toBeEnabled();
  await expect(page.locator("#player-count")).toHaveText("2 / 10");
  await expect(guest.locator("#answer-form")).toBeHidden();
  await expect(
    guest.getByRole("button", { name: "Crayon bleu", includeHidden: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Lancer la partie" }).click();
  await expect(guest.locator("#answer-form")).toBeHidden();
  await expect(guest.locator("#chat-form")).toBeHidden();
  await page.locator("#choices button").first().click();
  await expect(page.locator("#phase")).toHaveText(
    "À vos crayons · départ imminent",
  );
  await expect(page.locator("#timer")).toHaveText(/^0:0[1-3]$/);
  await expect(page.locator("#toolbar")).toBeHidden();
  await expect(guest.locator("#answer-form")).toBeHidden();
  await expect(page.locator("#answer-form")).toBeHidden();
  await expect(guest.locator("#answer-form")).toBeVisible();
  await expect(guest.locator("#players")).toContainText("Devine");
  await expect(page.locator("#players")).toContainText("Dessine");
  await expect(
    page.getByRole("button", { name: "Crayon bleu", includeHidden: true }),
  ).toBeEnabled();
  await expect(
    guest.getByRole("button", { name: "Crayon bleu", includeHidden: true }),
  ).toBeDisabled();
  for (const width of [1440, 800, 390, 320]) {
    await guest.setViewportSize({ width, height: 844 });
    const back = guest.getByRole("link", { name: "Tous les jeux" });
    await guest.locator(".brand").focus();
    await guest.keyboard.press("Tab");
    await expect(back).toBeFocused();
    expect(
      await back.evaluate((item) => getComputedStyle(item).boxShadow),
    ).toContain("rgb(11, 127, 145)");
    expect(
      await guest.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    expect(await targets(guest)).toEqual([]);
  }
  await watch.close();
});

test("échec initial lisible, réessai et session conservée après retour réseau", async ({
  page,
}) => {
  await page.route("**/dessin/api/session", (route) => route.abort());
  await page.goto("/dessin/lobby");
  await expect(page.locator("#global-error")).toBeVisible();
  await expect(page.locator("#initial-loading")).toBeHidden();
  await page.unroute("**/dessin/api/session");
  await page.getByRole("button", { name: "Réessayer le chargement" }).click();
  await expect(
    page.getByRole("link", { name: "Jouer avec un pseudo" }),
  ).toBeVisible();
});
