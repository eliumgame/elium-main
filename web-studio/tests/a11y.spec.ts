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
    await page.getByRole("button", { name: "Documents" }).click();
    await expect(page.getByRole("dialog", { name: "Comment protéger ce document ?" })).toBeVisible();
    await expectNoSeriousViolations(page, "Document (choix du niveau de protection)");
  });

  test("Document", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Documents" }).click();
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
    await page.getByRole("button", { name: "Présentations" }).click();
    await expect(page.locator(".sv-stage")).toBeVisible();
    await expectNoSeriousViolations(page, "Présentations");
  });

  test("PDF — écran d'ouverture", async ({ page }) => {
    await page.goto("/");
    // Nom exact via une regex ancrée : le bouton "Détecteur" mentionne aussi
    // ".pdf" dans sa description, donc un match par sous-chaîne insensible à
    // la casse ("PDF") matcherait les deux boutons (strict mode violation).
    await page.getByRole("button", { name: /^PDF/ }).click();
    await expect(page.getByRole("heading", { name: "Ouvrir un PDF" })).toBeVisible();
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
