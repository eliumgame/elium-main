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
  tab,
  test,
  trackHealth,
  watchLongTasks,
  type Health,
  type Page,
} from "./support/documents-fixture";

/** Documents — références (sommaire, notes, renvois, légendes, index, signets) et mise en page. */
let page: Page;
let health: Health;

test.beforeAll(async ({ browser }) => {
  await ensureOwner(browser);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  page = await ctx.newPage();
  health = trackHealth(page);
  await register(page, { ...MEMBER, email: `refs-${MEMBER.email}` });
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

/** Les notes demandent leur texte dans un dialogue. */
async function note(button: RegExp, text: string) {
  await ribbon(page, "Références", button);
  await dlg().locator("textarea").fill(text);
  await dlg().getByRole("button", { name: "Valider" }).click();
}

async function heading(text: string, button = "Titre 1") {
  await tab(page, "Accueil");
  await page.locator(".elx-ribbon").getByRole("button", { name: button, exact: true }).click();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

test("table des matières : suit les titres et se met à jour à la frappe", async () => {
  await focusBody(page);
  await heading("Introduction");
  await heading("Méthode", "Titre 2");
  await ribbon(page, "Références", /Insérer une table des matières/);
  const toc = editor(page).locator(".elium-toc");
  await expect(toc).toContainText("Introduction");
  await expect(toc).toContainText("Méthode");
  // un nouveau titre apparaît dans le sommaire sans le régénérer
  await editor(page).locator("h1").first().click();
  await page.keyboard.press("End");
  await page.waitForTimeout(300); // laisse ProseMirror relire la position du curseur
  await page.keyboard.type(" générale");
  await expect(toc).toContainText("Introduction générale");
});

test("notes de bas de page et de fin : numérotation dérivée de l'ordre", async () => {
  await focusBody(page);
  await page.keyboard.type("Premier passage");
  await note(/Insérer une note de bas de page/, "Première note");
  await expect(editor(page).locator(".elium-fn-ref")).toHaveCount(1);
  await page.keyboard.type(" puis un second");
  await note(/Insérer une note de bas de page/, "Seconde note");
  const refs = editor(page).locator(".elium-fn-ref");
  await expect(refs).toHaveCount(2);
  await expect(refs.nth(0)).toHaveText("1");
  await expect(refs.nth(1)).toHaveText("2");
  await note(/Insérer une note de fin/, "Note finale");
  await expect(editor(page).locator("sup[data-endnote-id]")).toHaveCount(1);
});

test("renvoi vers un titre : le texte affiché suit le titre", async () => {
  await focusBody(page);
  await heading("Conclusion");
  await page.keyboard.type("Voir ");
  await ribbon(page, "Références", /Insérer un renvoi/);
  await expect(dlg()).toBeVisible();
  await dlg().getByText("Conclusion").first().click();
  await dlg()
    .getByRole("button", { name: /Insérer/ })
    .last()
    .click();
  const xref = editor(page).locator(".elium-xref");
  await expect(xref).toHaveCount(1);
  await expect(xref).toContainText("Conclusion");
  await editor(page).locator("h1").first().click();
  await page.keyboard.press("End");
  await page.keyboard.type("s");
  await expect(xref).toContainText("Conclusions");
});

test("légende numérotée au-dessus / au-dessous", async () => {
  await focusBody(page);
  await ribbon(page, "Références", /Insérer une légende/);
  await dlg().locator("input[type=text], input:not([type])").last().fill("Évolution des ventes");
  await dlg().getByRole("button", { name: "Insérer" }).click();
  const cap = editor(page).locator("figcaption, [data-caption-label], .elium-caption");
  await expect(cap.first()).toContainText("Figure 1");
  await expect(cap.first()).toContainText("Évolution des ventes");
});

test("index : marquer une entrée puis insérer l'index alphabétique", async () => {
  await focusBody(page);
  await page.keyboard.type("Le chat dort");
  await ribbon(page, "Références", /Marquer une entrée d'index/);
  await dlg().locator("input").first().fill("chat");
  await dlg().getByRole("button", { name: "Marquer", exact: true }).click();
  await ribbon(page, "Références", /Insérer l'index alphabétique/);
  const idx = editor(page).locator(".elium-index");
  await expect(idx).toContainText("chat");
  await expect(idx).toContainText("C");
});

test("signet : insertion avec un nom", async () => {
  await focusBody(page);
  await page.keyboard.type("cible");
  await ribbon(page, "Insertion", /Signet/);
  await dlg().locator("input").first().fill("mon_signet");
  await dlg().getByRole("button", { name: "Valider" }).click();
  await expect.poll(html).toMatch(/mon_signet/);
});

test("symbole, équation, filigrane", async () => {
  await focusBody(page);
  await ribbon(page, "Insertion", /Insérer un symbole/);
  await dlg().getByRole("button", { name: "§" }).first().click();
  await dlg().locator("button.eb--primary", { hasText: "Fermer" }).click();
  await expect.poll(async () => editor(page).innerText()).toContain("§");
  await ribbon(page, "Insertion", /Insérer une équation/);
  await dlg().locator("textarea, input").first().fill("x^2+y^2=z^2");
  await dlg().getByRole("button", { name: "Insérer" }).click();
  await expect(editor(page).locator(".elium-equation .katex").first()).toBeVisible();
  await ribbon(page, "Insertion", /Filigrane/);
  await dlg().getByRole("button", { name: "BROUILLON" }).click();
  await dlg().getByRole("button", { name: "Appliquer" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll("[style]")].some((e) => {
          try {
            return /BROUILLON/.test(decodeURIComponent(e.getAttribute("style") ?? ""));
          } catch {
            return false;
          }
        }),
      ),
    )
    .toBe(true);
});

test("colonnes et saut de section", async () => {
  await focusBody(page);
  await page.keyboard.type("texte en colonnes");
  await ribbon(page, "Mise en page", /colonnes/);
  await page
    .getByRole("menuitem", { name: /2 colonnes/ })
    .or(page.getByText("2 colonnes"))
    .first()
    .click();
  await expect.poll(html).toMatch(/column/i);
  await ribbon(page, "Mise en page", /Saut de page ou de section/);
  await page.getByText("Page suivante").first().click();
  await expect.poll(html).toMatch(/section/i);
});

test("format de page : passage en paysage et marges", async () => {
  await ribbon(page, "Mise en page", /Format, marges/);
  await expect(dlg()).toContainText("Feuille actuelle : 210 × 297 mm");
  await dlg().locator("select").filter({ hasText: "Paysage" }).selectOption("landscape");
  await expect(dlg()).toContainText("297 × 210 mm");
  // Les réglages s'appliquent en direct : on ferme, puis on rouvre pour vérifier qu'ils ont tenu.
  await dlg().locator("button.eb--primary", { hasText: "Fermer" }).click();
  await ribbon(page, "Mise en page", /Format, marges/);
  await expect(dlg()).toContainText("297 × 210 mm");
  await dlg().locator("button.eb--primary", { hasText: "Fermer" }).click();
});

test("styles rapides et thème du document", async () => {
  await focusBody(page);
  await page.keyboard.type("Un titre stylé");
  await ribbon(page, "Accueil", /Galerie de styles/);
  await page.getByRole("button", { name: "Titre 2", exact: true }).last().click();
  await expect.poll(html).toMatch(/<h2/);
  await ribbon(page, "Accueil", /Thème du document/);
  await dlg().getByText("Émeraude").first().click();
  const close = dlg().locator("button.eb--primary", { hasText: "Fermer" });
  if (await close.isVisible().catch(() => false)) await close.click();
});
