import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

/**
 * Collaboration Présentations à deux navigateurs, contre un VRAI serveur Drive de développement :
 *   SINGLE_DRIVE=true OWNER_EMAIL=owner-d@test.local PORT=8803 DEV_PG_PORT=54413 npx tsx tests/dev-drive-server.ts
 *   DEV_API_TARGET=http://127.0.0.1:8803 npx vite --port 3203 --strictPort
 * Variables : SLIDES_ACTIVATION_CODE (1er démarrage du Drive neuf, seulement si l'organisation n'existe pas encore).
 * Comptes @test.local ; le propriétaire crée l'organisation, les membres s'inscrivent librement.
 */

const OWNER = { name: "Owner D", email: "owner-d@test.local", password: "Motdepasse!42-owner" };
const MEMBER = { name: "Membre D", email: "membre-d@test.local", password: "Motdepasse!42-membre" };

async function signInOrUp(
  page: Page,
  u: { name: string; email: string; password: string },
  code?: string,
  fresh = false,
) {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Connexion" })).toBeVisible({ timeout: 60_000 });
  const tile = page.getByRole("button", { name: /^Drive entreprise chiffré/ }).first();
  if (!fresh) {
    await page.locator("input[type=email]").fill(u.email);
    await page.locator("input[type=password]").fill(u.password);
    await page.getByRole("button", { name: "Se connecter", exact: true }).click();
    const failed = page.getByText(/incorrect|invalide|échec|inconnu/i).first();
    const outcome = await Promise.race([
      tile.waitFor({ timeout: 40_000 }).then(() => "ok"),
      failed.waitFor({ timeout: 40_000 }).then(() => "ko"),
    ]).catch(() => "ko");
    if (outcome === "ok") return;
  }
  // compte inexistant : inscription
  await page.getByRole("button", { name: "Créer un compte" }).click();
  await page.getByPlaceholder("Prénom Nom").fill(u.name);
  if (code) await page.getByPlaceholder("XXXX-XXXX-XXXX").fill(code);
  await page.locator("input[type=email]").fill(u.email);
  const pw = page.locator("input[type=password]");
  await pw.nth(0).fill(u.password);
  await pw.nth(1).fill(u.password);
  await page.getByRole("button", { name: "Créer le compte" }).click();
  await expect(tile).toBeVisible({ timeout: 60_000 });
}

async function openDrive(page: Page, orgCode?: string) {
  await page
    .getByRole("button", { name: /^Drive entreprise chiffré/ })
    .first()
    .click();
  const create = page.getByPlaceholder("Ma société");
  const files = page.getByTitle("Présentation collaborative");
  const which = await Promise.race([
    create.waitFor({ timeout: 90_000 }).then(() => "create"),
    files.waitFor({ timeout: 90_000 }).then(() => "files"),
  ]);
  if (which === "create") {
    await create.fill("Société D");
    await page.getByPlaceholder("XXXX-XXXX-XXXX").fill(orgCode ?? process.env.SLIDES_ACTIVATION_CODE ?? "");
    await page.getByRole("button", { name: "Créer l'organisation" }).click();
    await expect(files).toBeVisible({ timeout: 60_000 });
  }
}

async function newUserPage(
  browser: Browser,
  u: typeof OWNER,
  code?: string,
  fresh = false,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  await signInOrUp(page, u, code, fresh);
  return { ctx, page };
}

test("A : l'organisation et les comptes existent", async ({ browser }) => {
  const o = await newUserPage(browser, OWNER, process.env.SLIDES_ACTIVATION_CODE);
  await openDrive(o.page);
  await o.ctx.close();
  const m = await newUserPage(browser, MEMBER);
  await m.page
    .getByRole("button", { name: /^Drive entreprise chiffré/ })
    .first()
    .click();
  await m.ctx.close();
});

const thumbsOf = (p: Page) => p.locator(".slides-rail .slide-thumb");
const titleOf = (p: Page) => p.locator(".sv-stage .ce-text").first();

async function createDeck(page: Page, name: string) {
  await page.getByTitle("Présentation collaborative").click();
  await page.locator("input[type=text]").last().fill(name);
  await page.getByRole("button", { name: "Valider" }).click();
  await expect(page.locator(".sv-stage")).toBeVisible({ timeout: 60_000 });
  await expect(thumbsOf(page)).toHaveCount(1, { timeout: 30_000 });
}

async function closeEditor(page: Page) {
  await page
    .getByRole("button", { name: /^Fermer|Quitter/ })
    .last()
    .click()
    .catch(async () => {
      await page.locator("button:has(svg.lucide-x)").last().click();
    });
  await expect(page.getByTitle("Présentation collaborative")).toBeVisible({ timeout: 30_000 });
}

async function shareDeck(page: Page, name: string, email: string, role: string) {
  await page
    .getByRole("row", { name: new RegExp(name) })
    .getByRole("button", { name: /Partager/ })
    .click();
  await page.getByPlaceholder("E-mail du membre").fill(email);
  await page.locator('input[placeholder="E-mail du membre"] + select').selectOption({ label: role });
  await page.getByRole("button", { name: "Partager", exact: true }).last().click();
  await expect(page.getByRole("button", { name: /Retirer l'accès de/ }).nth(1)).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Fermer", exact: true }).first().click();
}

async function openDeck(page: Page, name: string) {
  await page
    .getByRole("row", { name: new RegExp(name) })
    .first()
    .dblclick();
  await expect(page.locator(".sv-stage")).toBeVisible({ timeout: 60_000 });
}

async function editTitle(page: Page, text: string) {
  await thumbsOf(page).first().locator("button.slide-thumb__preview").click();
  const box = page.locator(".sv-stage .ce").first();
  await box.dblclick();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(text);
  await page.keyboard.press("Escape");
}

test.describe.serial("B : co-édition à deux navigateurs", () => {
  const deck = `Collab ${Date.now()}`;
  let owner: { ctx: BrowserContext; page: Page };
  let member: { ctx: BrowserContext; page: Page };

  test("propriétaire crée et partage ; membre ouvre", async ({ browser }) => {
    owner = await newUserPage(browser, OWNER);
    await openDrive(owner.page);
    await createDeck(owner.page, deck);
    await editTitle(owner.page, "Titre du propriétaire");
    await closeEditor(owner.page);
    await shareDeck(owner.page, deck, MEMBER.email, "Éditeur");
    member = await newUserPage(browser, MEMBER);
    await openDrive(member.page);
    await openDeck(member.page, deck);
    await expect(titleOf(member.page)).toHaveText("Titre du propriétaire", { timeout: 30_000 });
    await openDeck(owner.page, deck);
    // présence : chacun voit l'autre
    await expect(thumbsOf(member.page)).toHaveCount(1);
  });

  test("éditions simultanées : tout converge, rien n'est perdu", async () => {
    // le propriétaire retape le titre pendant que le membre ajoute 3 diapositives
    await Promise.all([
      editTitle(owner.page, "Titre v2 propriétaire"),
      (async () => {
        for (let i = 0; i < 3; i++) await member.page.getByRole("button", { name: /^\s*Vierge/ }).click();
      })(),
    ]);
    await expect(thumbsOf(owner.page)).toHaveCount(4, { timeout: 30_000 });
    await expect(thumbsOf(member.page)).toHaveCount(4, { timeout: 30_000 });
    await thumbsOf(member.page).first().locator("button.slide-thumb__preview").click();
    await expect(titleOf(member.page)).toHaveText("Titre v2 propriétaire", { timeout: 30_000 });
    // le membre modifie le titre, le propriétaire le voit sur sa miniature
    await editTitle(member.page, "Titre du membre");
    await expect(thumbsOf(owner.page).first()).toContainText("Titre du membre", { timeout: 30_000 });
  });

  test("rattrapage : un membre déconnecté retrouve tout à la reconnexion", async ({ browser }) => {
    await member.ctx.close();
    for (let i = 0; i < 25; i++) await owner.page.getByRole("button", { name: /^\s*Vierge/ }).click();
    await expect(thumbsOf(owner.page)).toHaveCount(29);
    await editTitle(owner.page, "Après absence");
    member = await newUserPage(browser, MEMBER);
    await openDrive(member.page);
    await openDeck(member.page, deck);
    await expect(thumbsOf(member.page)).toHaveCount(29, { timeout: 60_000 });
    await expect(thumbsOf(member.page).first()).toContainText("Après absence", { timeout: 30_000 });
  });

  test("annuler ne défait que mes propres modifications", async () => {
    await member.page.getByRole("button", { name: /^\s*Vierge/ }).click();
    await expect(thumbsOf(owner.page)).toHaveCount(30, { timeout: 30_000 });
    await member.page.getByRole("button", { name: "Annuler (Ctrl+Z)" }).click();
    await expect(thumbsOf(member.page)).toHaveCount(29, { timeout: 30_000 });
    await expect(thumbsOf(owner.page)).toHaveCount(29, { timeout: 30_000 });
    await expect(thumbsOf(owner.page).first()).toContainText("Après absence"); // les éditions du propriétaire survivent
  });

  test("fin", async () => {
    await owner.ctx.close();
    await member.ctx.close();
  });
});

test.describe.serial("C : sauvegarde → effacement du navigateur → restauration (compte membre)", () => {
  const unique = `Local ${Date.now()}`;
  const me = { name: "Membre Sauvegarde", email: `membre-${Date.now()}@test.local`, password: "Motdepasse!42-sauv" };

  test("un deck local est sauvegardé dans le Drive puis restauré sur un appareil vide", async ({ browser }) => {
    // 1. le membre crée un deck local et attend l'enregistrement dans le Drive
    const a = await newUserPage(browser, me, undefined, true);
    await a.page
      .getByRole("button", { name: /^Accueil|Retour à l'accueil/ })
      .first()
      .click()
      .catch(() => {});
    await a.page.getByRole("button", { name: /^Présentation Diapositives/ }).click();
    await expect(a.page.locator(".sv-stage")).toBeVisible({ timeout: 60_000 });
    await a.page.locator(".sv-stage .ce").first().dblclick();
    await a.page.keyboard.press("Control+A");
    await a.page.keyboard.type(unique);
    await a.page.keyboard.press("Escape");
    await a.page.getByRole("button", { name: /^\s*Diapo/ }).click();
    await expect(thumbsOf(a.page)).toHaveCount(2);
    // pastille de sauvegarde : « Enregistré dans le Drive »
    await expect(a.page.getByText(/Enregistré dans le Drive/).first()).toBeVisible({ timeout: 90_000 });
    await a.page.waitForTimeout(3000);
    await a.ctx.close();

    // 2. appareil vide (nouveau contexte = aucun stockage) : reconnexion → restauration automatique
    const b = await newUserPage(browser, me);
    await expect(b.page.getByText(/restauré/i).first()).toBeVisible({ timeout: 90_000 });
    // le deck restauré s'ouvre avec son contenu
    await b.page
      .getByRole("button", { name: /^Retour à l'accueil|^Accueil/ })
      .first()
      .click()
      .catch(() => {});
    await b.page
      .getByRole("button", { name: /^Présentation sans titre$/ })
      .first()
      .click();
    await expect(b.page.locator(".sv-stage")).toBeVisible({ timeout: 60_000 });
    await expect(thumbsOf(b.page)).toHaveCount(2, { timeout: 30_000 });
    await expect(thumbsOf(b.page).first()).toContainText(unique);
    await b.ctx.close();
  });
});

test("D : un lecteur voit la présentation mais ne peut rien modifier", async ({ browser }) => {
  const deck = `Lecture ${Date.now()}`;
  const owner = await newUserPage(browser, OWNER);
  await openDrive(owner.page);
  await createDeck(owner.page, deck);
  await editTitle(owner.page, "Contenu protégé");
  await closeEditor(owner.page);
  await shareDeck(owner.page, deck, MEMBER.email, "Lecteur");
  const member = await newUserPage(browser, MEMBER);
  await openDrive(member.page);
  await openDeck(member.page, deck);
  await expect(titleOf(member.page)).toHaveText("Contenu protégé", { timeout: 30_000 });
  // aucune commande d'écriture
  await expect(member.page.getByRole("button", { name: /^\s*Vierge/ })).toHaveCount(0);
  await expect(member.page.getByRole("button", { name: /^Texte/ })).toHaveCount(0);
  // et une tentative d'édition au clavier / souris ne change rien
  await member.page
    .locator(".sv-stage .ce")
    .first()
    .dblclick()
    .catch(() => {});
  await member.page.keyboard.press("Control+A");
  await member.page.keyboard.type("piratage");
  await expect(titleOf(member.page)).toHaveText("Contenu protégé");
  await member.page.waitForTimeout(1500);
  await owner.ctx.close();
  await member.ctx.close();
});
