import { test, expect, type Page } from "@playwright/test";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";

/**
 * Commenting in a real browser (projects « drive » and « desktop »): the
 * stamp library (a dynamic stamp placed and saved with Acrobat's /Name) and
 * the « Surface » measure drawn point by point.
 */

async function blankPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([595, 842]);
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
    name: "vierge.pdf",
    mimeType: "application/pdf",
    buffer: bytes,
  });
  await expect(page.locator(".pdfx-canvas").first()).toBeVisible();
}

async function save(page: Page): Promise<PDFDocument> {
  const dl = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  const bytes = Buffer.concat(await (await (await dl).createReadStream()).toArray());
  return PDFDocument.load(bytes);
}

function annotDicts(doc: PDFDocument): PDFDict[] {
  const arr = doc.getPage(0).node.Annots();
  return arr instanceof PDFArray ? arr.asArray().map((r) => doc.context.lookup(r, PDFDict)) : [];
}

function health(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("ERR_CERT_AUTHORITY_INVALID")) problems.push(m.text());
  });
  return problems;
}

test.describe("PDF — commentaires", () => {
  test("bibliothèque de tampons : un tampon dynamique", async ({ page }) => {
    const problems = health(page);
    await open(page, await blankPdf());
    await page.getByRole("tab", { name: "Commenter" }).click();
    await page.getByRole("button", { name: "Tampon" }).click();
    const menu = page.getByRole("menu", { name: "Tampons" });
    await expect(menu).toBeVisible();
    await menu.getByRole("menuitem", { name: /Reçu/ }).click();
    await expect(menu).toBeHidden();
    const canvas = (await page.locator(".pdfx-canvas").first().boundingBox())!;
    await page.mouse.click(canvas.x + 120, canvas.y + 150);
    const stamp = page.locator(".pdfx-stamp.has-sub").first();
    await expect(stamp).toContainText("Reçu");
    await expect(stamp).toContainText(/le \d\d\/\d\d\/\d{4}/);
    const doc = await save(page);
    const stamps = annotDicts(doc).filter((d) => d.lookup(PDFName.of("Subtype"), PDFName).decodeText() === "Stamp");
    expect(stamps).toHaveLength(1);
    expect(stamps[0].lookup(PDFName.of("Name"), PDFName).decodeText()).toBe("#DReceived");
    expect(problems).toEqual([]);
  });

  test("mesure de surface dessinée point par point", async ({ page }) => {
    const problems = health(page);
    await open(page, await blankPdf());
    await page.getByRole("tab", { name: "Affichage" }).click();
    await page.getByRole("button", { name: "Surface" }).click();
    const c = (await page.locator(".pdfx-canvas").first().boundingBox())!;
    const pts = [
      [100, 100],
      [300, 100],
      [300, 250],
    ];
    for (const [x, y] of pts) await page.mouse.click(c.x + x, c.y + y);
    await page.mouse.dblclick(c.x + 100, c.y + 250);
    const doc = await save(page);
    const polys = annotDicts(doc).filter((d) => d.lookup(PDFName.of("Subtype"), PDFName).decodeText() === "Polygon");
    expect(polys).toHaveLength(1);
    expect(polys[0].lookup(PDFName.of("IT"), PDFName).decodeText()).toBe("PolygonDimension");
    expect(polys[0].lookup(PDFName.of("Vertices"), PDFArray).size()).toBeGreaterThanOrEqual(8);
    expect(problems).toEqual([]);
  });

  test("exporter puis importer les commentaires en FDF", async ({ page }) => {
    const problems = health(page);
    await open(page, await blankPdf());
    await page.getByRole("tab", { name: "Commenter" }).click();
    await page.getByRole("button", { name: "Tampon" }).click();
    await page
      .getByRole("menu", { name: "Tampons" })
      .getByRole("menuitem", { name: /Confidentiel/ })
      .first()
      .click();
    const c = (await page.locator(".pdfx-canvas").first().boundingBox())!;
    await page.mouse.click(c.x + 150, c.y + 200);
    await expect(page.locator(".pdfx-stamp").first()).toContainText("Confidentiel");
    const dl = page.waitForEvent("download");
    await page.getByRole("button", { name: "Exporter FDF" }).click();
    const fdf = Buffer.concat(await (await (await dl).createReadStream()).toArray());
    expect(fdf.subarray(0, 8).toString("latin1")).toBe("%FDF-1.2");

    // A fresh copy of the document, then « Importer » the FDF.
    await open(page, await blankPdf());
    await expect(page.locator(".pdfx-stamp")).toHaveCount(0);
    await page.setInputFiles('input[type="file"][accept*=".fdf"]', {
      name: "vierge-commentaires.fdf",
      mimeType: "application/vnd.fdf",
      buffer: fdf,
    });
    await expect(page.locator(".pdfx-stamp").first()).toContainText("Confidentiel");
    expect(problems).toEqual([]);
  });

  test("panneau : coche, réponse modifiée puis supprimée", async ({ page }) => {
    const problems = health(page);
    await open(page, await blankPdf());
    await page.getByRole("tab", { name: "Commenter" }).click();
    await page.getByRole("button", { name: "Note autocollante" }).first().click();
    const c = (await page.locator(".pdfx-canvas").first().boundingBox())!;
    await page.mouse.click(c.x + 200, c.y + 200);
    await expect(page.locator(".pdfx-note")).toHaveCount(1);
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Commentaire" }).fill("À vérifier");
    await dialog.getByRole("button", { name: "Valider" }).click();
    await expect(page.locator(".pdfx-note .pdfx-note__icon")).toBeVisible();
    await page.locator('.pdfx-rail__btn[title="Commentaires"]').click();
    const card = page.locator(".pdfx-comment").first();
    await expect(card).toBeVisible();
    await card.getByRole("checkbox").check();
    await card.getByRole("button", { name: "Répondre" }).click();
    await card.locator("textarea").fill("Première réponse");
    await page.keyboard.press("Control+Enter");
    await expect(card.locator(".pdfx-reply")).toContainText("Première réponse");
    await card.locator(".pdfx-reply p").dblclick();
    await card.locator(".pdfx-reply textarea").fill("Réponse corrigée");
    await card.locator(".pdfx-comment__head").click();
    await expect(card.locator(".pdfx-reply")).toContainText("Réponse corrigée");
    const saved = await save(page);
    const dicts = annotDicts(saved);
    const texts = dicts.map((d) => d.lookup(PDFName.of("Contents"))?.toString() ?? "");
    expect(texts.some((t) => t.includes("corrig") || t.startsWith("<FEFF"))).toBe(true);
    expect(dicts.some((d) => d.lookup(PDFName.of("StateModel"))?.toString() === "(Marked)")).toBe(true);
    await card.locator(".pdfx-reply").hover();
    await card.getByRole("button", { name: "Supprimer la réponse" }).click();
    await expect(card.locator(".pdfx-reply")).toHaveCount(0);
    await expect(card.getByRole("checkbox")).toBeChecked();
    expect(problems).toEqual([]);
  });
});
