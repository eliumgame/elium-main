import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeTiff } from "../src/pdf/ops/imagefile";
import { unzipSync, strFromU8 } from "fflate";

/** Exports follow the document as it is shown (projects « drive » and « desktop »). */

async function twoPages(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595, 842]).drawText("PREMIERE PAGE", { x: 60, y: 760, size: 20, font });
  doc.addPage([595, 842]).drawText("SECONDE PAGE", { x: 60, y: 760, size: 20, font });
  return Buffer.from(await doc.save());
}

async function open(page: Page, bytes: Buffer) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    delete w.showSaveFilePicker;
    delete w.showOpenFilePicker;
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^PDF/ }).click();
  await page.setInputFiles('input[type="file"][accept*="pdf"]', {
    name: "deux.pdf",
    mimeType: "application/pdf",
    buffer: bytes,
  });
  await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
}

test.describe("PDF — conversion", () => {
  test("l'export texte suit le document affiché : une page supprimée n'y figure plus", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    await open(page, await twoPages());
    // Page 1 is current: delete it.
    await page.getByRole("tab", { name: "Organiser" }).click();
    await page.getByLabel("Barre d'outils PDF").getByRole("button", { name: "Supprimer", exact: true }).click();
    await expect(page.locator(".pdfx-canvas")).toHaveCount(1);

    await page.getByRole("tab", { name: "Convertir" }).click();
    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "Texte", exact: true }).click();
    const text = await readFile((await (await dl).path())!, "utf-8");
    expect(text).toContain("SECONDE PAGE");
    expect(text).not.toContain("PREMIERE PAGE");
    expect(problems).toEqual([]);
  });

  test("créer un PDF : un TIFF à 300 dpi donne une page A4 ; le presse-papiers donne un document", async ({
    page,
    context,
  }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      delete w.showSaveFilePicker;
      delete w.showOpenFilePicker;
    });
    await page.goto("/");
    await page.getByRole("button", { name: /^PDF/ }).click();
    // An A4 page scanned at 300 dpi, grey.
    const tif = await writeTiff({ width: 2480, height: 3508, rgba: new Uint8Array(2480 * 3508 * 4).fill(180) }, 300);
    await page
      .locator('input[type="file"][accept="image/*"]')
      .first()
      .setInputFiles({
        name: "scan.tif",
        mimeType: "image/tiff",
        buffer: Buffer.from(tif),
      });
    await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
    const dl = page.waitForEvent("download");
    await page.keyboard.press("Control+s");
    const saved = await PDFDocument.load(await readFile((await (await dl).path())!));
    const { width, height } = saved.getPage(0).getSize();
    expect(width).toBeCloseTo(595.2, 0);
    expect(height).toBeCloseTo(841.9, 0);

    // A new document from copied text.
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await page.getByRole("button", { name: /^PDF/ }).click();
    await page.evaluate(() => navigator.clipboard.writeText("Texte venu du presse-papiers"));
    await page.getByRole("button", { name: "Depuis le presse-papiers" }).click();
    await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
    await page.keyboard.press("Control+f");
    await page.getByPlaceholder("Rechercher dans le document…").fill("presse-papiers");
    await expect(page.locator(".pdfx-find__count")).toHaveText("1/1");
    expect(problems).toEqual([]);
  });

  test("exporter vers Word et Excel : le texte et le tableau du document", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const p = doc.addPage([595, 842]);
    p.drawText("Facture annuelle", { x: 60, y: 780, size: 22, font });
    const rows = [
      ["Article", "Qte", "Prix", "Total"],
      ["Pommes", "12", "3,50", "42,00"],
      ["Poires", "7", "2,10", "14,70"],
      ["Cerises", "250", "14,00", "3500,00"],
    ];
    rows.forEach((r, i) =>
      r.forEach((c, j) => p.drawText(c, { x: [60, 220, 300, 440][j]!, y: 700 - i * 18, size: 11, font })),
    );
    await open(page, Buffer.from(await doc.save()));
    await page.getByRole("tab", { name: "Convertir" }).click();

    let dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "Word", exact: true }).click();
    let files = unzipSync(new Uint8Array(await readFile((await (await dl).path())!)));
    const docxml = strFromU8(files["word/document.xml"]!);
    expect(docxml).toContain("Facture annuelle");
    expect(docxml).toContain("<w:tbl>");

    dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "Excel", exact: true }).click();
    files = unzipSync(new Uint8Array(await readFile((await (await dl).path())!)));
    expect(strFromU8(files["xl/worksheets/sheet1.xml"]!)).toContain("<v>3500</v>");
    expect(problems).toEqual([]);
  });

  test("imprimer : boîte avec aperçu, 2 pages par feuille, envoi à l'impression", async ({ page }) => {
    const problems: string[] = [];
    page.on("pageerror", (e) => problems.push(e.message));
    await open(page, await twoPages());
    await page.keyboard.press("Control+p");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Feuille 1 sur 2");
    await dialog.getByRole("tab", { name: "Multiple" }).click();
    await expect(dialog).toContainText("Feuille 1 sur 1");
    await dialog.getByRole("button", { name: "Imprimer", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('iframe[src^="blob:"]')).toHaveCount(1);
    expect(problems).toEqual([]);
  });
});
