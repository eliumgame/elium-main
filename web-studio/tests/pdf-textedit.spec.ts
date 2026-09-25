import { test, expect, type Page } from "@playwright/test";
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

/**
 * « Modifier le texte » in a real browser (projects « drive » and « desktop »):
 * a PDF made by Chromium itself (the kind that was broken), a paragraph
 * restyled and moved with the editor's bar, text added — and the saved file
 * read back.
 */

async function chromePdf(page: Page): Promise<Buffer> {
  await page.setContent(`<html><body style="font-family:Arial,sans-serif;margin:40px">
    <h1 style="font-size:22px;margin:0 0 6px">Rapport annuel 2025</h1>
    <p style="font-size:12px;line-height:1.4;margin:0 0 12px">Premier paragraphe du rapport, sur plusieurs lignes pour vérifier le reflux du texte modifié dans sa zone et sa largeur d'origine.</p>
    <div style="columns:2;column-gap:30px;font-size:11px;line-height:1.4">
      <p style="margin:0">Colonne gauche du document, assez longue pour occuper deux ou trois lignes dans la colonne de gauche.</p>
      <p style="margin:0">Colonne droite, qui ne doit jamais être touchée quand on modifie la colonne gauche du document.</p>
    </div></body></html>`);
  return page.pdf({ format: "A4" });
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
    name: "rapport.pdf",
    mimeType: "application/pdf",
    buffer: bytes,
  });
  await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
}

async function save(page: Page): Promise<Uint8Array> {
  const dl = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return new Uint8Array(Buffer.concat(await (await (await dl).createReadStream()).toArray()));
}

async function textItems(bytes: Uint8Array) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  return (tc.items as { str: string; transform: number[] }[]).filter((i) => i.str.trim());
}

function health(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("ERR_CERT_AUTHORITY_INVALID")) problems.push(m.text());
  });
  return problems;
}

test.describe("PDF — modifier le texte", () => {
  test("mise en forme et déplacement d'un paragraphe, sans toucher la colonne voisine", async ({ page, context }) => {
    const problems = health(page);
    const bytes = await chromePdf(await context.newPage());
    await open(page, bytes);
    await page.getByRole("button", { name: "Modifier le texte" }).first().click();
    const left = page.getByRole("button", { name: /Modifier : Colonne gauche/ });
    await expect(left).toBeVisible();
    await expect(page.getByRole("button", { name: /Modifier : Colonne droite/ })).toBeVisible();
    await left.click();
    await page.locator(".pdfx-editblock__input").fill("Colonne gauche réécrite — Łódź.");
    await page.getByRole("button", { name: "Gras" }).click();
    await page.getByRole("button", { name: "Centrer" }).click();
    // Move the box 60 px down with its grip.
    const grip = (await page.getByRole("button", { name: "Déplacer" }).boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 + 60, { steps: 5 });
    await page.mouse.up();
    await page.locator(".pdfx-editblock__input").click();
    await page.keyboard.press("Control+Enter");
    await expect(page.locator("img.pdfx-editpreview__raster")).toHaveCount(1);

    const out = await save(page);
    const items = await textItems(out);
    const all = items.map((i) => i.str).join(" ");
    expect(all).toContain("Colonne gauche réécrite — Łódź.");
    expect(all).not.toContain("Colonne gauche du document");
    // The right column is intact.
    expect(all).toContain("Colonne droite, qui ne doit jamais être touchée");
    // Bold face.
    const doc = await PDFDocument.load(out);
    const fonts = doc.context
      .enumerateIndirectObjects()
      .map(([, o]) => (o instanceof PDFDict ? o.lookup(PDFName.of("BaseFont")) : undefined))
      .filter(Boolean)
      .map(String);
    expect(fonts.join(" ")).toMatch(/Bold/);
    // Moved down (PDF y smaller than the original column top).
    const orig = (await textItems(new Uint8Array(bytes))).find((i) => i.str.startsWith("Colonne gauche"))!;
    const moved = items.find((i) => i.str.includes("Colonne gauche réécrite"))!;
    expect(moved.transform[5]).toBeLessThan(orig.transform[5] - 20);
    expect(problems).toEqual([]);
  });

  test("ajouter du texte dans la page", async ({ page, context }) => {
    const problems = health(page);
    const bytes = await chromePdf(await context.newPage());
    await open(page, bytes);
    await page.getByRole("tab", { name: "Modifier" }).click();
    await page.getByRole("button", { name: "Ajouter du texte" }).click();
    const layer = (await page.locator(".pdfx-editlayer").first().boundingBox())!;
    await page.mouse.click(layer.x + layer.width * 0.1, layer.y + 380);
    await page.locator(".pdfx-editblock__input").fill("Texte ajouté — Ελλάδα");
    await page.keyboard.press("Control+Enter");
    const out = await save(page);
    const items = await textItems(out);
    expect(items.map((i) => i.str).join(" ")).toContain("Texte ajouté — Ελλάδα");
    // Where it was clicked, in page space (Chromium's stream leaves a `cm` in force).
    const first = items.find((i) => i.str.startsWith("Texte ajouté"))!;
    const pt = layer.width / 595.92;
    expect(Math.abs(first.transform[4] - (layer.width * 0.1) / pt)).toBeLessThan(3);
    expect(Math.abs(842 - first.transform[5] - 380 / pt)).toBeLessThan(16);
    expect(problems).toEqual([]);
  });
});
