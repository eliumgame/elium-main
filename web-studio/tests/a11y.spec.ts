import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { generateRecipientKeypair } from "../src/crypto/recipients";
import { generateNodeKey, wrapNodeKeyFor, encryptName, encryptContent } from "../src/drive-cloud/node-crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Scan d'accessibilité réel (navigateur Chromium + axe-core) sur les 7 vues
 * clés du Studio. jsdom (Vitest) ne calcule ni la mise en page ni le
 * contraste réel des couleurs — la plupart des bugs trouvés lors de l'audit
 * (contrastes, boutons sans nom accessible, landmarks) ne sont détectables
 * que par un vrai rendu. D'où Playwright, réservé à ce seul usage ici.
 *
 * On échoue sur les violations "serious"/"critical" uniquement : les
 * "moderate"/"minor" sont surveillées (voir le rapport joint) mais ne
 * bloquent pas la CI, cohérent avec le critère de sortie de l'audit.
 */

const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

async function expectNoSeriousViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const blocking = results.violations.filter((v) => BLOCKING_IMPACTS.has(v.impact ?? ""));
  const detail = blocking
    .map(
      (v) =>
        `- [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} élément(s): ${v.nodes.map((n) => n.target.join(" ")).join(", ")})`,
    )
    .join("\n");
  expect(blocking, `Violations axe-core sérieuses/critiques sur "${label}":\n${detail}`).toEqual([]);
}

/**
 * SignLinkView (signataire externe, sans compte) résout un token contre le
 * serveur Drive et déchiffre le document dans le navigateur — il n'y a pas de
 * mode "hors-ligne" pour l'atteindre. On simule donc le serveur : fabrique une
 * VRAIE enveloppe chiffrée (même crypto que la production — node-crypto.ts /
 * crypto/recipients.ts) pour un lien de signature PDF, puis intercepte les
 * deux routes publiques qu'`openSignLink` (drive-cloud/ops.ts) appelle. Le
 * secret de déchiffrement voyage dans le fragment d'URL, jamais envoyé au
 * serveur (ni ici à l'interception réseau) — cohérent avec l'invariant réel.
 */
async function mockSignLink(page: Page, opts: { name: string; bytes: Uint8Array }): Promise<string> {
  const kp = await generateRecipientKeypair();
  const nodeKey = generateNodeKey();
  const wrappedKey = await wrapNodeKeyFor(nodeKey, kp.publicHex);
  const encName = await encryptName(nodeKey, opts.name);
  const content = await encryptContent(nodeKey, opts.bytes);
  const token = randomUUID();

  await page.route(`**/api/links/${token}`, (route) =>
    route.fulfill({
      json: {
        node: { kind: "file", hasContent: true, nameEncrypted: encName.nameEncrypted, nameNonce: encName.nameNonce },
        wrappedKey,
        hasPassword: false,
        roleKey: "signer",
      },
    }),
  );
  await page.route(`**/api/links/${token}/content`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/octet-stream",
      headers: { "x-content-nonce": content.nonceHex },
      body: Buffer.from(content.ciphertext),
    }),
  );
  return `/?sign=${token}#k=${kp.privateHex}.${kp.publicHex}`;
}

test.describe("Accessibilité (axe-core) — vues clés", () => {
  test("Accueil", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Votre espace de travail documentaire" })).toBeVisible();
    await expectNoSeriousViolations(page, "Accueil");
  });

  test("Document — choix du niveau de protection", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Documents? Éditeur/ }).click();
    await expect(page.getByRole("dialog", { name: "Comment protéger ce document ?" })).toBeVisible();
    await expectNoSeriousViolations(page, "Document (choix du niveau de protection)");
  });

  test("Document", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Documents? Éditeur/ }).click();
    await page.getByRole("button", { name: "Simple" }).click();
    await expect(page.locator(".elx-ribbon")).toBeVisible();
    await expectNoSeriousViolations(page, "Document");
  });

  test("Tableur", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Tableur" }).click();
    await expect(page.locator(".sheet-grid-wrap")).toBeVisible();
    await expectNoSeriousViolations(page, "Tableur");
  });

  test("Présentations", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Présentations? Diapositives/ }).click();
    await expect(page.locator(".sv-stage")).toBeVisible();
    await expectNoSeriousViolations(page, "Présentations");
  });

  test("PDF — écran d'ouverture", async ({ page }) => {
    await page.goto("/");
    // Nom exact via une regex ancrée : le bouton "Détecteur" mentionne aussi
    // ".pdf" dans sa description, donc un match par sous-chaîne insensible à
    // la casse ("PDF") matcherait les deux boutons (strict mode violation).
    await page.getByRole("button", { name: /^PDF/ }).click();
    // Le lecteur PDF est chargé à la demande : première compilation lente en dev.
    await expect(page.getByRole("heading", { name: "Ouvrir un PDF" })).toBeVisible({ timeout: 25_000 });
    await expectNoSeriousViolations(page, "PDF (écran d'ouverture)");
  });

  test("PDF — espace de travail chargé", async ({ page }) => {
    await page.goto("/");
    // Nom exact via une regex ancrée : le bouton "Détecteur" mentionne aussi
    // ".pdf" dans sa description, donc un match par sous-chaîne insensible à
    // la casse ("PDF") matcherait les deux boutons (strict mode violation).
    await page.getByRole("button", { name: /^PDF/ }).click();
    await page.setInputFiles('input[type="file"][accept*="pdf"]', path.join(__dirname, "fixtures", "minimal.pdf"));
    await expect(page.locator(".pdfx-canvas")).toBeVisible();
    await expectNoSeriousViolations(page, "PDF (espace de travail chargé)");
  });

  test("Détecteur — écran de dépôt", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Détecteur/ }).click();
    await expect(page.getByRole("heading", { name: "Détecteur", level: 1 })).toBeVisible();
    await expectNoSeriousViolations(page, "Détecteur (dépôt)");
  });

  test("Détecteur — gestion des racines de confiance C2PA", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Détecteur/ }).click();
    await page.locator("summary", { hasText: "Racines de confiance C2PA" }).click();
    await expect(page.getByRole("heading", { name: "Racines de confiance C2PA" })).toBeVisible();
    await expectNoSeriousViolations(page, "Détecteur (racines de confiance)");
  });

  test("Drive (non connecté)", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Drive entreprise chiffré/ }).click();
    await expect(page.locator(".dc-auth__panel")).toBeVisible();
    await expectNoSeriousViolations(page, "Drive (non connecté)");
  });

  test("Documentation", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Documentation", exact: true }).click();
    await expect(page.locator(".doc-body")).toBeVisible();
    await expectNoSeriousViolations(page, "Documentation");
  });

  test("Signature à distance (lien externe, sans compte)", async ({ page }) => {
    const bytes = await readFile(path.join(__dirname, "fixtures", "minimal.pdf"));
    const url = await mockSignLink(page, { name: "Contrat.pdf", bytes: new Uint8Array(bytes) });
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "Contrat.pdf" })).toBeVisible();
    await expectNoSeriousViolations(page, "Signature à distance (lien externe)");
  });

  test("Signature à distance — placement de la signature sur le PDF", async ({ page }) => {
    const bytes = await readFile(path.join(__dirname, "fixtures", "minimal.pdf"));
    const url = await mockSignLink(page, { name: "Contrat.pdf", bytes: new Uint8Array(bytes) });
    await page.goto(url);
    await page.getByLabel("Votre nom").fill("Alix Martin");
    await page.getByRole("checkbox", { name: /Placer ma signature/ }).click();
    await expect(page.getByAltText("Page 1 du document à signer")).toBeVisible();
    await expectNoSeriousViolations(page, "Signature à distance (placement)");
  });
});

test.describe("Accessibilité — navigation clavier des éditeurs canevas", () => {
  test("Tableur : les flèches déplacent la cellule active et l'annoncent", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Tableur" }).click();
    const grid = page.getByLabel("Grille de la feuille de calcul");
    await expect(grid).toBeVisible();
    await grid.focus();
    const ref = page.locator(".sheet-formula__ref");
    await expect(ref).toHaveText("A1");
    await page.keyboard.press("ArrowDown");
    // Le focus clavier est visible : un anneau (ombre ou contour) est bien dessiné.
    const ring = await grid.evaluate((el) => {
      const cs = getComputedStyle(el);
      return `${cs.outlineStyle}|${cs.boxShadow}`;
    });
    expect(ring).not.toBe("none|none");
    await page.keyboard.press("ArrowRight");
    await expect(ref).toHaveText("B2");
    // Saisie au clavier + annonce par la région aria-live partagée.
    await page.keyboard.type("42");
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowUp");
    await expect(page.locator('.elx-announcer[aria-live="polite"]')).toContainText(/Cellule B\d/);
  });

  test("PDF : la zone des pages est atteignable au clavier", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^PDF/ }).click();
    await page.setInputFiles('input[type="file"][accept*="pdf"]', path.join(__dirname, "fixtures", "minimal.pdf"));
    const pages = page.getByRole("main", { name: "Pages du document" });
    await expect(pages).toBeVisible();
    await pages.focus();
    await expect(pages).toBeFocused();
    await expectNoSeriousViolations(page, "PDF (focus clavier sur les pages)");
  });

  test("Présentations : Tab sélectionne un élément, les flèches le déplacent, annonce vocale", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Présentations? Diapositives/ }).click();
    const canvas = page.locator(".slide-cv.is-editable").first();
    await expect(canvas).toBeVisible();
    await canvas.focus();
    await page.keyboard.press("Tab");
    const selected = page.locator(".slide-cv .ce.is-selected").first();
    await expect(selected).toBeVisible();
    await expect(page.locator('.elx-announcer[aria-live="polite"]')).toContainText(/sur \d+/);
    const before = await selected.evaluate((el) => (el as HTMLElement).style.left);
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => selected.evaluate((el) => (el as HTMLElement).style.left)).not.toBe(before);
  });
});

test.describe("Détecteur — analyse par lot (rendu réel)", () => {
  // PNG 1×1 valide : suffit pour traverser tout le pipeline d'ingestion et d'analyse d'image.
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );

  test("plusieurs fichiers : tableau de résultats, ligne en erreur isolée, export CSV", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /^Détecteur/ }).click();
    await page.getByLabel("Choisir un ou plusieurs fichiers à analyser").setInputFiles([
      { name: "a.png", mimeType: "image/png", buffer: PNG },
      { name: "b.png", mimeType: "image/png", buffer: PNG },
      { name: "c.docx", mimeType: "application/octet-stream", buffer: Buffer.from("pas un docx") },
    ]);
    const table = page.getByRole("table", { name: "Résultats de l'analyse par lot" });
    await expect(table).toBeVisible();
    await expect(page.getByRole("status")).toContainText("3 fichier(s) traité(s)", { timeout: 30_000 });
    await expect(table.getByRole("row")).toHaveCount(4); // en-tête + 3 lignes
    await expect(table.getByRole("rowheader", { name: "a.png" })).toBeVisible();
    // Le fichier illisible est signalé sur sa ligne sans arrêter le lot.
    await expect(table.getByRole("row", { name: /c\.docx/ })).toContainText(/Erreur|Format/);
    const saved = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exporter CSV" }).click();
    expect((await saved).suggestedFilename()).toMatch(/^Detecteur-lot-.*\.csv$/);
    await expectNoSeriousViolations(page, "Détecteur (lot)");
  });
});
