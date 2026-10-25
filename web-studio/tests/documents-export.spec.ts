import { readFileSync } from "node:fs";
import { strFromU8, unzipSync } from "fflate";
import {
  MEMBER,
  clearBody,
  editor,
  ensureOwner,
  expect,
  focusBody,
  newBlankDoc,
  register,
  select,
  test,
  trackHealth,
  type Health,
  type Page,
} from "./support/documents-fixture";

/** Documents — exports relus (DOCX, Markdown, HTML, texte), enregistrement .elium, import et réouverture. */
let page: Page;
let health: Health;

test.beforeAll(async ({ browser }) => {
  await ensureOwner(browser);
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
  // Pas d'accès disque natif : l'enregistrement retombe sur un téléchargement (le sélecteur natif n'est pas pilotable).
  await ctx.addInitScript(() => {
    (window as unknown as Record<string, unknown>).showSaveFilePicker = undefined;
  });
  page = await ctx.newPage();
  health = trackHealth(page);
  await register(page, { ...MEMBER, email: `exp-${MEMBER.email}` });
});
test.beforeEach(async () => {
  await newBlankDoc(page, "Rapport d'essai");
  await clearBody(page);
  health.consoleErrors.length = 0;
  health.pageErrors.length = 0;
});
test.afterEach(async () => {
  expect(health.pageErrors, "exceptions JS").toEqual([]);
  expect(health.consoleErrors, "erreurs console").toEqual([]);
  await page.getByTitle("Accueil").first().click();
});

async function writeSample() {
  await focusBody(page);
  await page.keyboard.type("Bonjour le monde");
  await select(page, "Shift+Home");
  await page.keyboard.press("Control+b");
  await page.keyboard.press("End");
  // la saisie qui suit prolonge le gras, comme dans Word
  await page.keyboard.type(" et la suite.");
}

async function exportAs(label: string): Promise<{ name: string; bytes: Buffer }> {
  // Panneau replié : on clique directement l'icône Export de la rampe (elle ouvre le panneau sur cet onglet) ;
  // panneau déjà ouvert : l'onglet Export du panneau.
  await page.locator('[aria-label="Export"], aside button:has-text("Export")').first().click();
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.locator("aside").getByRole("button", { name: label }).first().click(),
  ]);
  const path = await dl.path();
  return { name: dl.suggestedFilename(), bytes: readFileSync(path!) };
}

test("export Word (.docx) : le fichier s'ouvre et contient texte et gras", async () => {
  await writeSample();
  const { name, bytes } = await exportAs("Word");
  expect(name).toMatch(/\.docx$/);
  const zip = unzipSync(new Uint8Array(bytes));
  const xml = strFromU8(zip["word/document.xml"]!);
  expect(xml).toContain("Bonjour le monde");
  expect(xml).toMatch(/<w:b\/>|<w:b /);
  expect(xml).toContain("et la suite.");
});

test("export Markdown et texte brut", async () => {
  await writeSample();
  const md = await exportAs("Markdown");
  expect(md.name).toMatch(/\.md$/);
  expect(md.bytes.toString("utf8")).toContain("**Bonjour le monde et la suite.**");
  const txt = await exportAs("Texte");
  expect(txt.bytes.toString("utf8")).toContain("Bonjour le monde et la suite.");
});

test("export HTML : balises sémantiques", async () => {
  await writeSample();
  const { bytes } = await exportAs("HTML");
  const html = bytes.toString("utf8");
  expect(html).toContain("<strong>Bonjour le monde et la suite.</strong>");
  expect(html).toContain("</html>");
});

test("enregistrer en .elium puis rouvrir le fichier téléchargé", async () => {
  await writeSample();
  // Sans accès disque natif (Playwright), l'enregistrement retombe sur un téléchargement.
  const [dl] = await Promise.all([
    page.waitForEvent("download", { timeout: 60_000 }),
    page.getByRole("button", { name: "Enregistrer", exact: true }).click(),
  ]);
  expect(dl.suggestedFilename()).toMatch(/\.elium$/);
  const saved = readFileSync((await dl.path())!);
  expect(saved.length).toBeGreaterThan(200);
  await page.getByTitle("Accueil").first().click();
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "rapport.elium",
    mimeType: "application/x-elium",
    buffer: saved,
  });
  await expect(editor(page)).toContainText("Bonjour le monde et la suite.", { timeout: 60_000 });
});

test("importer un .docx, un .md et un .html", async () => {
  await page.getByTitle("Accueil").first().click();
  const input = () => page.locator('input[type="file"]').first();
  await input().setInputFiles({
    name: "note.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Titre MD\n\nCorps **gras**.\n"),
  });
  await expect(editor(page).locator("h1")).toHaveText("Titre MD");
  await page.getByTitle("Accueil").first().click();
  await input().setInputFiles({
    name: "page.html",
    mimeType: "text/html",
    buffer: Buffer.from("<h2>Titre HTML</h2><p>Un <em>paragraphe</em>.</p>"),
  });
  await expect(editor(page).locator("h2")).toHaveText("Titre HTML");
  // aller-retour DOCX : on exporte le document courant puis on le réimporte
  await focusBody(page);
  await page.keyboard.press("Control+End");
  await page.keyboard.type(" Fin de page.");
  const { bytes } = await exportAs("Word");
  await page.getByTitle("Accueil").first().click();
  await input().setInputFiles({
    name: "retour.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: bytes,
  });
  await expect(editor(page)).toContainText("Titre HTML");
  await expect(editor(page)).toContainText("Fin de page.");
});
