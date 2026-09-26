import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { PDFDocument, StandardFonts } from "pdf-lib";

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
});
