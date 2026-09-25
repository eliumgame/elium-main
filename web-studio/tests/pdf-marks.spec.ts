import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";

/** Page marks (watermark, background, header/footer) in a real browser (projects « drive » and « desktop »). */

async function pdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Page ${i + 1}`, { x: 40, y: 780, size: 14, font });
    if (i === 1) p.setRotation(degrees(90));
  }
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
    name: "doc.pdf",
    mimeType: "application/pdf",
    buffer: bytes,
  });
  await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
}

async function save(page: Page): Promise<Buffer> {
  const dl = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return Buffer.concat(await (await (await dl).createReadStream()).toArray());
}

function health(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("ERR_CERT_AUTHORITY_INVALID")) problems.push(m.text());
  });
  return problems;
}

/** Marks of each kind on each page, as `stripPageMarks` recognises them. */
async function marks(bytes: Buffer): Promise<string[][]> {
  const { readPageContentBytes } = await import("../src/pdf/ops/content");
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => {
    const text = new TextDecoder("latin1").decode(readPageContentBytes(p));
    return [...text.matchAll(/\/EliumMark \/(\w+)/g)].map((m) => m[1]).sort();
  });
}

test.describe("PDF — marques de page", () => {
  test("fond de couleur et en-tête numéroté, puis remplacés sans s'empiler", async ({ page, browser }) => {
    const problems = health(page);
    await open(page, await pdf());
    await page.getByRole("tab", { name: "Modifier" }).click();

    await page.getByRole("button", { name: "Filigrane" }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Couleur de fond" }).click();
    await dialog.getByRole("button", { name: "Appliquer" }).click();

    await page.getByRole("button", { name: "En-tête / pied" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: /Activer l'en-tête/ }).check();
    await dialog.getByRole("textbox", { name: "Centre" }).fill("Réf. {page}");
    await dialog.getByRole("spinbutton", { name: "Premier n° de page" }).fill("10");
    await dialog.getByRole("button", { name: "Appliquer" }).click();

    const once = await save(page);
    expect(await marks(once)).toEqual([
      ["Background", "Header"],
      ["Background", "Header"],
    ]);

    // The saved file reopened: a new header, the old marks removed first.
    const again = await browser.newPage();
    const problems2 = health(again);
    await open(again, once);
    await again.getByRole("tab", { name: "Modifier" }).click();
    await again.getByRole("button", { name: "En-tête / pied" }).click();
    dialog = again.getByRole("dialog");
    await dialog.getByRole("checkbox", { name: /Activer l'en-tête/ }).check();
    await dialog.getByRole("textbox", { name: "Centre" }).fill("Nouvelle réf. {page}");
    await dialog.getByRole("checkbox", { name: /Supprimer d'abord/ }).check();
    await dialog.getByRole("button", { name: "Appliquer" }).click();
    expect(await marks(await save(again))).toEqual([["Header"], ["Header"]]);
    expect([...problems, ...problems2]).toEqual([]);
  });
});
