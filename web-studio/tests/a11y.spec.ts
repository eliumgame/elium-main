import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    await page.getByRole("button", { name: "PDF" }).click();
    await expect(page.getByRole("heading", { name: "Ouvrir un PDF" })).toBeVisible();
    await expectNoSeriousViolations(page, "PDF (écran d'ouverture)");
  });

  test("PDF — espace de travail chargé", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "PDF" }).click();
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
});
