import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

/**
 * The Acrobat-like surface in a real browser (projects « drive » and
 * « desktop »): « Tous les outils », « Rechercher des outils », context menus,
 * mode lecture, the editable zoom box and the status bar.
 */

async function source(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 3; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText(`Page ${i + 1} du document`, { x: 60, y: 760, size: 18, font });
  }
  return Buffer.from(await doc.save());
}

async function open(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    delete w.showOpenFilePicker;
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^PDF/ }).click();
  await page.setInputFiles('input[type="file"][accept*="pdf"]', {
    name: "doc.pdf",
    mimeType: "application/pdf",
    buffer: await source(),
  });
  await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
  await expect(page.locator(".pdfx-slot.is-ready").first()).toBeVisible({ timeout: 30_000 });
}

function health(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("ERR_CERT_AUTHORITY_INVALID")) problems.push(m.text());
  });
  return problems;
}

test.describe("PDF — interface", () => {
  test("Tous les outils : une famille montre son onglet, une commande s'exécute", async ({ page }) => {
    const problems = health(page);
    await open(page);
    const rail = page.getByRole("button", { name: "Tous les outils" });
    await rail.click();
    await expect(rail).toHaveAttribute("aria-pressed", "true");
    const pane = page.locator(".pdfx-alltools");
    await expect(pane.getByRole("button", { name: "Normes PDF" })).toBeVisible();
    // A family: its ribbon tab.
    await pane.getByRole("button", { name: "Mesurer" }).click();
    await expect(page.getByRole("tab", { name: "Affichage" })).toHaveAttribute("aria-selected", "true");
    // A command: runs as from the ribbon.
    await pane.getByRole("button", { name: "Filigrane" }).click();
    await expect(page.getByRole("dialog")).toContainText("Filigrane");
    expect(problems).toEqual([]);
  });

  test("Rechercher des outils : « filig » trouve le filigrane, accents ignorés, récents gardés", async ({ page }) => {
    const problems = health(page);
    await open(page);
    await page.locator(".pdfx-canvas").first().focus();
    await page.keyboard.press("Control+Shift+P");
    const palette = page.getByRole("dialog", { name: "Rechercher des outils" });
    await expect(palette).toBeVisible();
    const box = palette.getByRole("combobox", { name: "Rechercher des outils" });
    await box.fill("echelle");
    await expect(palette.getByRole("option").first()).toContainText("Échelle de mesure");
    await box.fill("filig");
    await expect(palette.getByRole("option").first()).toContainText("Filigrane");
    await box.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.getByRole("dialog")).toContainText("Filigrane");
    await page.getByRole("dialog").getByRole("button", { name: "Fermer" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
    // The top bar's button opens it too; the last command comes first.
    await page.getByRole("button", { name: "Rechercher des outils" }).click();
    await expect(palette.getByRole("option").first()).toContainText("Filigrane");
    await expect(palette.getByRole("option").first()).toContainText("Récent");
    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
    expect(problems).toEqual([]);
  });

  test("clic droit sur une page : menu de la page, « Faire pivoter à droite »", async ({ page }) => {
    const problems = health(page);
    await open(page);
    const slot = page.locator('.pdfx-slot[data-page="1"]');
    const before = await slot.boundingBox();
    expect(before!.height).toBeGreaterThan(before!.width);
    await slot.click({ button: "right", position: { x: 40, y: Math.round(before!.height / 2) } });
    const menu = page.getByRole("menu", { name: "Page 1" });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: "Faire pivoter à droite" })).toBeFocused();
    await menu.getByRole("menuitem", { name: "Faire pivoter à droite" }).click();
    await expect(menu).toBeHidden();
    await expect
      .poll(async () => {
        const b = await slot.boundingBox();
        return b!.width > b!.height;
      })
      .toBe(true);
    // Keyboard: Maj+F10 on the document, Échap closes.
    await page.locator(".pdfx-canvas").first().focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "Faire pivoter à gauche" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toBeHidden();
    expect(problems).toEqual([]);
  });

  test("mode lecture : Ctrl+H masque le ruban, Échap le rend", async ({ page }) => {
    const problems = health(page);
    await open(page);
    await page.locator(".pdfx-canvas").first().focus();
    await expect(page.locator(".pdfx-ribbon")).toBeVisible();
    await page.keyboard.press("Control+h");
    await expect(page.locator(".pdfx-ribbon")).toBeHidden();
    await expect(page.locator(".pdfx-rail")).toBeHidden();
    await expect(page.locator(".pdfx-status")).toBeHidden();
    await expect(page.getByRole("button", { name: "Quitter le mode lecture" })).toBeVisible();
    await expect(page.locator(".pdfx-slot").first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".pdfx-ribbon")).toBeVisible();
    await expect(page.locator(".pdfx-status")).toBeVisible();
    expect(problems).toEqual([]);
  });

  test("zoom : 150 tapé dans la zone de zoom donne 150 %, la barre d'état suit", async ({ page }) => {
    const problems = health(page);
    await open(page);
    const zoom = page.getByRole("combobox", { name: "Niveau de zoom" });
    await zoom.fill("150");
    await zoom.press("Enter");
    await expect(zoom).toHaveValue("150 %");
    const status = page.locator(".pdfx-status");
    await expect(status.getByRole("button", { name: "150 %" })).toBeVisible();
    // The status bar's zoom menu: « Page entière » changes it.
    await status.getByRole("button", { name: "150 %" }).click();
    await page.getByRole("menuitem", { name: "Page entière" }).click();
    await expect(zoom).not.toHaveValue("150 %");
    expect(problems).toEqual([]);
  });

  test("barre d'état : page courante et son format", async ({ page }) => {
    const problems = health(page);
    await open(page);
    const status = page.locator(".pdfx-status");
    await expect(status).toContainText("Page 1 sur 3");
    await expect(status).toContainText("210 × 297 mm");
    await page.getByRole("button", { name: "Page suivante" }).click();
    await expect(status).toContainText("Page 2 sur 3");
    expect(problems).toEqual([]);
  });
});
