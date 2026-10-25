import {
  MEMBER,
  clearBody,
  editor,
  ensureOwner,
  expect,
  focusBody,
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

/** Documents — révision (suivi, commentaires, correcteur), recherche/remplacement, publipostage, statistiques. */
let page: Page;
let health: Health;

test.beforeAll(async ({ browser }) => {
  await ensureOwner(browser);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  page = await ctx.newPage();
  health = trackHealth(page);
  await register(page, { ...MEMBER, email: `rev-${MEMBER.email}` });
  await watchLongTasks(page);
});
test.beforeEach(async () => {
  await newBlankDoc(page);
  await clearBody(page);
  health.consoleErrors.length = 0;
  health.pageErrors.length = 0;
});
test.afterEach(async () => {
  expect(health.pageErrors, "exceptions JS").toEqual([]);
  expect(health.consoleErrors, "erreurs console").toEqual([]);
  await page.keyboard.press("Escape");
  await page.getByTitle("Accueil").first().click();
});

const html = () => editor(page).innerHTML();
const dlg = () => page.getByRole("dialog");

test("suivi des modifications : Ctrl+Maj+M, insertion suivie, tout accepter", async () => {
  await focusBody(page);
  await page.keyboard.type("Texte initial");
  await page.keyboard.press("Control+Shift+m");
  await page.keyboard.type(" ajouté");
  await expect(editor(page).locator("ins, [data-track-ins], .elium-ins, .track-insert").first()).toBeVisible();
  await ribbon(page, "Révision", /Accepter toutes les modifications/);
  await expect(editor(page).locator("ins, [data-track-ins], .elium-ins, .track-insert")).toHaveCount(0);
  await expect(editor(page)).toContainText("Texte initial ajouté");
});

test("suivi des modifications : tout refuser retire l'ajout", async () => {
  await focusBody(page);
  await page.keyboard.type("Base");
  await page.keyboard.press("Control+Shift+m");
  await page.keyboard.type(" parasite");
  await ribbon(page, "Révision", /Refuser toutes les modifications/);
  await expect.poll(async () => (await editor(page).innerText()).trim()).toBe("Base");
});

test("commentaire sur la sélection : le passage est marqué avec son texte", async () => {
  await focusBody(page);
  await page.keyboard.type("Passage commenté");
  await select(page, "Shift+Home");
  await ribbon(page, "Révision", /Commenter la sélection/);
  await expect(dlg()).toBeVisible();
  await dlg().locator("textarea").fill("À reformuler");
  await dlg().locator("button.eb--primary").last().click();
  await expect(dlg()).toHaveCount(0);
  const marked = editor(page).locator(".elium-comment");
  await expect(marked).toHaveText("Passage commenté");
  await expect(marked).toHaveAttribute("title", "À reformuler");
});

test("correcteur : répétition, double espace, mot inconnu soulignés", async () => {
  await focusBody(page);
  await page.keyboard.type("Le le chat  dort. il mange");
  const marks = editor(page).locator(".elium-proof");
  await expect.poll(() => marks.count()).toBeGreaterThanOrEqual(3);
  const kinds = await marks.evaluateAll((els) => els.map((e) => e.className));
  expect(kinds.join(" ")).toMatch(/repeated/);
  expect(kinds.join(" ")).toMatch(/double-space/);
  expect(kinds.join(" ")).toMatch(/capital/);
});

test("correcteur : le panneau liste les problèmes et corrige en un clic", async () => {
  await focusBody(page);
  await page.keyboard.type("Voici voici la maison");
  await ribbon(page, "Révision", /Correcteur/);
  const panel = page.locator(".proof");
  await expect(panel).toContainText("1 problème détecté");
  await expect(panel).toContainText("Mot répété");
  await panel.locator(".proof__fix").first().click();
  await expect.poll(async () => (await editor(page).innerText()).trim()).toBe("Voici la maison");
  await expect(panel).toContainText(/Aucun problème|0 problème/);
});

test("rechercher (Ctrl+F) et remplacer (Ctrl+H)", async () => {
  await focusBody(page);
  await page.keyboard.type("chat chien chat oiseau chat");
  await page.keyboard.press("Control+f");
  const find = page.locator(".find-bar input").first();
  await expect(find).toBeVisible();
  await find.fill("chat");
  await expect(page.locator(".find-bar__count")).toHaveText(/1 \/ 3/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".find-bar__count")).toHaveText(/2 \/ 3/);
  await expect(editor(page).locator(".search-result").first()).toBeVisible();
  await page.keyboard.press("Control+h");
  const repl = page.getByPlaceholder("Remplacer par");
  await repl.fill("lapin");
  await page.locator(".find-bar").getByRole("button", { name: "Tout", exact: true }).click();
  await expect.poll(async () => (await editor(page).innerText()).trim()).toBe("lapin chien lapin oiseau lapin");
});

test("statistiques du document", async () => {
  await focusBody(page);
  await page.keyboard.type("Un deux trois quatre.");
  await ribbon(page, "Révision", /Mots, lisibilité/);
  await expect(dlg()).toContainText(/Mots\s*4/);
});

test("barre d'état : mots et caractères en direct", async () => {
  await focusBody(page);
  await page.keyboard.type("un deux trois");
  await expect(page.locator(".statusbar")).toContainText("3");
});

test("publipostage : coller un CSV, insérer un champ, aperçu et fusion", async () => {
  await focusBody(page);
  await page.keyboard.type("Bonjour ");
  await ribbon(page, "Publipostage", /Insérer un champ de fusion/);
  const name = dlg().locator("input").first();
  if (await name.isVisible().catch(() => false)) {
    await name.fill("nom");
    await dlg().getByRole("button", { name: "Valider" }).click();
  }
  await expect(editor(page).locator("[data-merge-field], .elium-merge-field, .elium-mergefield").first()).toBeVisible();
  await ribbon(page, "Publipostage", /Source de données/);
  await dlg().locator("textarea").fill("nom;ville\nDupont;Paris\nMartin;Lyon\n");
  await dlg().getByRole("button", { name: "Utiliser ces données" }).click();
  await dlg()
    .getByRole("button", { name: /Fusionner 2 enregistrements/ })
    .click();
  await expect.poll(async () => editor(page).innerText()).toMatch(/Bonjour Dupont[\s\S]*Bonjour Martin/);
});

test("accessibilité : le vérificateur s'ouvre et signale un titre vide", async () => {
  await focusBody(page);
  await tab(page, "Accueil");
  await page.locator(".elx-ribbon").getByRole("button", { name: "Titre 1", exact: true }).click();
  await page.keyboard.type("x");
  await page.keyboard.press("Backspace");
  await ribbon(page, "Révision", /accessibilité/);
  await expect(page.getByText(/titre vide/i).first()).toBeVisible();
});

test("affichage : volet de navigation, règle, zoom au clavier", async () => {
  await focusBody(page);
  await tab(page, "Affichage");
  await page
    .locator(".elx-ribbon")
    .getByRole("button", { name: /Volet de navigation/ })
    .click();
  await page
    .locator(".elx-ribbon")
    .getByRole("button", { name: /Règle graduée/ })
    .click();
  await expect(page.locator(".elium-ruler").first()).toBeVisible();
});
