import {
  MEMBER,
  clearBody,
  editor,
  ensureOwner,
  expect,
  focusBody,
  longTasks,
  newBlankDoc,
  register,
  ribbon,
  select,
  tab,
  test,
  trackHealth,
  watchLongTasks,
  type Health,
  type Page,
} from "./support/documents-fixture";

/**
 * Documents — édition au clavier réel : mise en forme, styles, listes, tableaux, liens, images,
 * annuler/rétablir, raccourcis. Un MEMBRE du Drive (compte simple) pilote tout.
 */
let page: Page;
let health: Health;

test.beforeAll(async ({ browser }) => {
  await ensureOwner(browser);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  page = await ctx.newPage();
  health = trackHealth(page);
  await register(page, MEMBER);
  await watchLongTasks(page);
});

test.beforeEach(async () => {
  await newBlankDoc(page);
  await clearBody(page);
  health.consoleErrors.length = 0;
  health.pageErrors.length = 0;
});

test.afterEach(async () => {
  expect(health.pageErrors, "exceptions JS non interceptées").toEqual([]);
  expect(health.consoleErrors, "erreurs console").toEqual([]);
  // retour accueil pour repartir d'un état propre
  await page.getByTitle("Accueil").first().click();
});

const html = () => editor(page).innerHTML();

test("saisie, sélection au clavier et mise en forme Ctrl+B / Ctrl+I / Ctrl+U", async () => {
  await focusBody(page);
  await page.keyboard.type("Bonjour le monde");
  await select(page, "Shift+Home");
  await page.keyboard.press("Control+b");
  await expect.poll(html).toContain("<strong>Bonjour le monde</strong>");
  await page.keyboard.press("Control+i");
  await page.keyboard.press("Control+u");
  const h = await html();
  expect(h).toMatch(/<em>/);
  expect(h).toMatch(/<u>/);
  // Ctrl+Z annule la dernière mise en forme, Ctrl+Y la rétablit
  await page.keyboard.press("Control+z");
  expect(await html()).not.toMatch(/<u>/);
  await page.keyboard.press("Control+y");
  expect(await html()).toMatch(/<u>/);
  // Effacer la mise en forme : Ctrl+Espace
  await page.keyboard.press("Control+Space");
  expect(await html()).not.toMatch(/<strong>|<em>|<u>/);
});

test("indice et exposant, petites majuscules", async () => {
  await focusBody(page);
  await page.keyboard.type("H2O");
  await select(page, "Shift+ArrowLeft");
  await page.keyboard.press("Control+=");
  await expect.poll(html).toContain("<sub>");
  await page.keyboard.press("End");
  await page.keyboard.type(" x2");
  await select(page, "Shift+ArrowLeft");
  await page.keyboard.press("Control+Shift+=");
  await expect.poll(html).toContain("<sup>");
});

test("titres, listes à puces et numérotées, retrait au clavier (Tab / Maj+Tab)", async () => {
  await focusBody(page);
  await tab(page, "Accueil");
  await page.locator(".elx-ribbon").getByRole("button", { name: "Titre 1" }).click();
  await page.keyboard.type("Mon titre");
  await page.keyboard.press("Enter");
  await page.locator(".elx-ribbon").getByRole("button", { name: "Liste à puces" }).click();
  await page.keyboard.type("Premier");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Deuxième");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Sous-point");
  await select(page, "Shift+Tab");
  const h = await html();
  expect(h).toMatch(/<h1[^>]*>Mon titre<\/h1>/);
  expect(h).toContain("<ul");
  expect(h).toContain("Sous-point");
  expect(h).toContain("Deuxième");
  // liste numérotée
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.locator(".elx-ribbon").getByRole("button", { name: "Liste numérotée" }).click();
  await page.keyboard.type("Un");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Deux");
  expect(await html()).toContain("<ol");
});

test("alignement, police et taille", async () => {
  await focusBody(page);
  await page.keyboard.type("Texte centré");
  await tab(page, "Accueil");
  await page.locator(".elx-ribbon").getByRole("button", { name: "Centrer" }).click();
  expect(await html()).toMatch(/text-align:\s*center/);
  await select(page, "Shift+Home");
  await page.locator(".elx-ribbon").getByLabel("Taille de police").first().selectOption({ label: "24" });
  await expect.poll(html).toMatch(/font-size:\s*24/);
});

test("tableau 3×3 : saisie dans chaque cellule avec Tab", async () => {
  await focusBody(page);
  await ribbon(page, "Insertion", /Insérer un tableau 3×3/);
  for (let i = 1; i <= 9; i++) {
    await page.keyboard.type(`c${i}`);
    if (i < 9) await page.keyboard.press("Tab");
  }
  const cells = await editor(page).locator("td, th").allInnerTexts();
  expect(cells.map((c) => c.trim())).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"]);
});

test("lien hypertexte via le dialogue du ruban", async () => {
  await focusBody(page);
  await page.keyboard.type("voir le site");
  await select(page, "Shift+Home");
  await ribbon(page, "Insertion", /^Lien/);
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible();
  await dlg.locator("input").first().fill("https://exemple.test/page");
  await page.keyboard.press("Enter");
  await expect(editor(page).locator('a[href="https://exemple.test/page"]')).toHaveCount(1);
});

test("image insérée depuis un fichier", async () => {
  await focusBody(page);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: "pixel.png",
    mimeType: "image/png",
    buffer: png,
  });
  await expect(editor(page).locator("img")).toHaveCount(1, { timeout: 15_000 });
  expect(await editor(page).locator("img").first().getAttribute("src")).toMatch(/^data:image\/png/);
});

test("saut de page, séparateur, symbole, équation", async () => {
  await focusBody(page);
  await page.keyboard.type("avant");
  await ribbon(page, "Insertion", /Saut de page/);
  await ribbon(page, "Insertion", /^Séparateur/);
  expect(await html()).toMatch(/page-break|data-page-break|pageBreak/i);
  expect(await html()).toContain("<hr");
});

test("annuler / rétablir plusieurs saisies", async () => {
  await focusBody(page);
  // Laisse l'historique fermer le groupe de la remise à blanc (sinon Ctrl+Z annulerait aussi celle-ci).
  await page.waitForTimeout(800);
  await page.keyboard.type("un deux trois");
  await page.keyboard.press("Control+z");
  const afterUndo = (await editor(page).innerText()).trim();
  expect(afterUndo.length).toBeLessThan("un deux trois".length);
  await page.keyboard.press("Control+y");
  await expect.poll(async () => (await editor(page).innerText()).trim()).toBe("un deux trois");
});

test("aucune tâche longue > 200 ms pendant la saisie courante", async () => {
  await focusBody(page);
  await watchLongTasks(page);
  for (let i = 0; i < 60; i++) await page.keyboard.type("lorem ipsum dolor ");
  await page.waitForTimeout(500);
  const big = (await longTasks(page)).filter((d) => d > 200);
  expect(big, `tâches > 200 ms : ${big.join(", ")}`).toEqual([]);
});
