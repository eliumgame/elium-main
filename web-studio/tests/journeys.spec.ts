import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Parcours utilisateur "gestes réels" en Playwright (vrai navigateur, vraies
 * interactions clavier/souris/fichiers) — complète a11y.spec.ts, qui ne teste
 * que l'accessibilité statique de chaque vue. Ici on vérifie que les
 * fonctionnalités marchent vraiment : créer/renommer/éditer un document,
 * round-trip chiffré à mot de passe (la garantie de sécurité centrale du
 * produit), import Markdown, exports réels (téléchargement constaté, pas
 * juste "le bouton existe"), et l'ouverture saine de chaque module.
 *
 * Mêmes conventions que a11y.spec.ts : sélecteurs par rôle/nom ou par texte
 * visible (accessible names réels lus dans le code source), pas de
 * data-testid, UI en français.
 */

/**
 * Créer un document : le tuile "Documents" ouvre d'abord le sélecteur de
 * niveau de sécurité ("Comment protéger ce document ?") — on choisit "Simple"
 * (profil standard, non chiffré) pour obtenir le document vierge par défaut.
 */
async function createBlankDocument(page: Page) {
  await page.getByRole("button", { name: "Documents" }).click();
  await page.getByRole("button", { name: /Simple/ }).click();
  await expect(page.locator(".elx-ribbon")).toBeVisible();
}

/** Attrape les erreurs console ("error" uniquement) et les exceptions JS non interceptées. */
function trackPageHealth(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  return {
    assertClean(label: string) {
      expect(pageErrors, `Exception(s) JS non interceptée(s) sur "${label}":\n${pageErrors.join("\n")}`).toEqual([]);
      expect(consoleErrors, `Erreur(s) console sur "${label}":\n${consoleErrors.join("\n")}`).toEqual([]);
    },
  };
}

test.describe("Parcours utilisateur — gestes réels", () => {
  test("Documents — création, renommage et saisie de texte", async ({ page }) => {
    await page.goto("/");
    await createBlankDocument(page);

    const titleInput = page.getByLabel("Titre du document");
    await titleInput.fill("Rapport trimestriel Q3");
    await expect(titleInput).toHaveValue("Rapport trimestriel Q3");

    // Le modèle "Document vierge" démarre avec un paragraphe d'accroche —
    // triple-clic pour le sélectionner entièrement, puis on tape par-dessus.
    await page.getByText("Commencez à rédiger…").click({ clickCount: 3 });
    await page.keyboard.type("Contenu saisi par le test Playwright.");

    await expect(page.locator(".elium-prose")).toContainText("Contenu saisi par le test Playwright.");
  });

  test("Sécurité — profil confidentiel, mot de passe, round-trip chiffré", async ({ page }) => {
    test.setTimeout(60_000); // deux dérivations Argon2id (enregistrement + réouverture)

    await page.goto("/");
    await createBlankDocument(page);

    const secretText = "Clause confidentielle : le montant convenu est de 42 000 euros.";
    await page.getByText("Commencez à rédiger…").click({ clickCount: 3 });
    await page.keyboard.type(secretText);
    await expect(page.locator(".elium-prose")).toContainText(secretText);

    // Bascule vers le profil "Document confidentiel" (chiffré, mot de passe requis).
    await page.getByRole("tab", { name: "Sécurité" }).click();
    await page.getByRole("button", { name: /Document confidentiel/ }).click();
    await expect(page.getByText("Chiffrement actif")).toBeVisible();

    const password = "CoffreFort#2026";

    // Enregistrer déclenche la demande de mot de passe (aucun secret encore en mémoire).
    await page.getByRole("button", { name: "Enregistrer" }).click();
    const setDialog = page.getByRole("dialog");
    await expect(setDialog).toBeVisible();
    await setDialog.getByLabel("Mot de passe", { exact: true }).fill(password);
    await setDialog.getByLabel("Confirmer le mot de passe").fill(password);

    const downloadPromise = page.waitForEvent("download");
    await setDialog.getByRole("button", { name: "Valider" }).click();
    const download = await downloadPromise;

    const savedPath = path.join(
      os.tmpdir(),
      `elium-journey-${Date.now()}-${Math.random().toString(36).slice(2)}.elium`,
    );
    await download.saveAs(savedPath);

    // Repart de zéro (accueil rechargé) et réimporte le fichier .elium téléchargé.
    await page.goto("/");
    await page.locator('input[type="file"][accept*=".elium"]').setInputFiles(savedPath);

    const openDialog = page.getByRole("dialog");
    await expect(openDialog).toBeVisible();
    await openDialog.getByLabel("Mot de passe", { exact: true }).fill(password);
    await openDialog.getByRole("button", { name: "Valider" }).click();

    // Le document rouvre en aperçu (lecture seule) — le contenu déchiffré doit
    // correspondre EXACTEMENT à ce qui a été tapé avant chiffrement.
    await expect(page.locator(".elium-prose")).toContainText(secretText);
  });

  test("Import Markdown", async ({ page }) => {
    await page.goto("/");
    const markdown = [
      "# Titre importé",
      "",
      "Un paragraphe avec du **gras** et de l'*italique*.",
      "",
      "- Premier point",
      "- Second point",
      "",
    ].join("\n");

    await page.locator('input[type="file"][accept*=".md"]').setInputFiles({
      name: "note.md",
      mimeType: "text/markdown",
      buffer: Buffer.from(markdown, "utf-8"),
    });

    await expect(page.locator(".elx-ribbon")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Titre importé" })).toBeVisible();
    await expect(page.locator(".elium-prose")).toContainText("gras");
    await expect(page.getByText("Premier point")).toBeVisible();
    await expect(page.getByText("Second point")).toBeVisible();
  });

  test("Exports — HTML, DOCX, Markdown, texte brut, rapport de preuve", async ({ page }) => {
    await page.goto("/");
    await createBlankDocument(page);
    await page.getByRole("tab", { name: "Export" }).click();

    // "PDF (impression)" est volontairement exclu : il ouvre un onglet
    // d'impression (window.open + print()) et ne déclenche jamais d'évènement
    // "download" — les 5 autres passent tous par downloadBlob (a.click()).
    const exportCases: Array<{ label: string; suffix: string }> = [
      { label: "HTML", suffix: ".html" },
      { label: "Word (.docx)", suffix: ".docx" },
      { label: "Markdown", suffix: ".md" },
      { label: "Texte brut", suffix: ".txt" },
      { label: "Rapport de preuve (JSON)", suffix: "-preuve.json" },
    ];

    for (const { label, suffix } of exportCases) {
      const downloadPromise = page.waitForEvent("download");
      await page.getByRole("button", { name: label, exact: true }).click();
      const download = await downloadPromise;
      const filename = download.suggestedFilename();
      expect(filename.endsWith(suffix), `Export "${label}" : nom de fichier inattendu "${filename}"`).toBe(true);
    }
  });

  test("Tableur — ouverture sans erreur", async ({ page }) => {
    const health = trackPageHealth(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Tableur" }).click();
    await expect(page.locator(".sheet-grid-wrap")).toBeVisible();
    await expect(page.getByRole("button", { name: "Gras" })).toBeVisible();
    health.assertClean("Tableur");
  });

  test("Présentations — ouverture sans erreur", async ({ page }) => {
    const health = trackPageHealth(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Présentations" }).click();
    await expect(page.locator(".sv-stage")).toBeVisible();
    await expect(page.getByRole("button", { name: "Annuler (Ctrl+Z)" })).toBeVisible();
    health.assertClean("Présentations");
  });

  test("PDF — ouverture sans erreur", async ({ page }) => {
    const health = trackPageHealth(page);
    await page.goto("/");
    // Nom exact via une regex ancrée : le bouton "Détecteur" mentionne aussi
    // ".pdf" dans sa description (match par sous-chaîne insensible à la
    // casse sinon => strict mode violation, cf. tests/a11y.spec.ts).
    await page.getByRole("button", { name: /^PDF/ }).click();
    await page.setInputFiles('input[type="file"][accept*="pdf"]', path.join(__dirname, "fixtures", "minimal.pdf"));
    await expect(page.locator(".pdfx-canvas")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Organiser" })).toBeVisible();
    health.assertClean("PDF");
  });

  test("Drive (non connecté) — ouverture sans erreur", async ({ page }) => {
    const health = trackPageHealth(page);
    await page.goto("/");
    await page.getByRole("button", { name: /Drive entreprise chiffré/ }).click();
    await expect(page.locator(".dc-auth__panel")).toBeVisible();
    await expect(page.getByRole("button", { name: "Créer un compte" })).toBeVisible();
    health.assertClean("Drive (non connecté)");
  });

  test("Documentation — ouverture sans erreur", async ({ page }) => {
    const health = trackPageHealth(page);
    await page.goto("/");
    await page.getByRole("button", { name: "Documentation", exact: true }).click();
    await expect(page.locator(".doc-body")).toBeVisible();
    await expect(page.getByLabel("Rechercher")).toBeVisible();
    health.assertClean("Documentation");
  });
});
