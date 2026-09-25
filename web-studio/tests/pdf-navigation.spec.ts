import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";

/** Navigation in a real browser (projects « drive » and « desktop »): find, page box, view history, bookmarks. */

async function source(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 4; i++) {
    const p = doc.addPage([595, 842]);
    p.drawText(`Page ${i + 1}`, { x: 40, y: 780, size: 14, font });
  }
  // Page 3: a word cut at the end of a line.
  doc.getPage(2).drawText("un exam-", { x: 40, y: 700, size: 12, font });
  doc.getPage(2).drawText("ple suit", { x: 40, y: 684, size: 12, font });
  doc.getPage(3).drawText("examen final", { x: 40, y: 700, size: 12, font });
  // Labels: i, ii, then 1, 2.
  doc.catalog.set(
    PDFName.of("PageLabels"),
    doc.context.obj({ Nums: [0, { S: PDFName.of("r") }, 2, { S: PDFName.of("D") }] } as never),
  );
  // A bookmark to page 4.
  const ctx = doc.context;
  const item = ctx.register(
    ctx.obj({ Title: PDFString.of("Annexe"), Dest: [doc.getPage(3).ref, PDFName.of("XYZ"), null, 842, null] } as never),
  );
  const root = ctx.register(ctx.obj({ Type: "Outlines", First: item, Last: item, Count: 1 } as never));
  ctx.lookup(item, (await import("pdf-lib")).PDFDict).set(PDFName.of("Parent"), root);
  doc.catalog.set(PDFName.of("Outlines"), root);
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

function health(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("ERR_CERT_AUTHORITY_INVALID")) problems.push(m.text());
  });
  return problems;
}

test.describe("PDF — navigation", () => {
  test("rechercher : mot coupé en fin de ligne, options qui relancent la recherche", async ({ page }) => {
    const problems = health(page);
    await open(page, await source());
    await page.keyboard.press("Control+f");
    const find = page.getByPlaceholder("Rechercher dans le document…");
    await find.fill("example");
    const count = page.locator(".pdfx-find__count");
    await expect(count).toHaveText("1/1");
    await find.fill("exam");
    await expect(count).toHaveText("1/2");
    // « Mots entiers » alone re-runs the search: « exam » is no whole word here.
    await page.getByTitle("Mots entiers uniquement").click();
    await expect(count).toHaveText("0");
    await page.getByTitle("Mots entiers uniquement").click();
    await expect(count).toHaveText("1/2");
    // The results list names pages by their labels.
    await page.getByTitle("Tous les résultats").click();
    await expect(page.locator(".pdfx-hits-group__head").first()).toContainText("Page 1");
    expect(problems).toEqual([]);
  });

  test("case de page : étiquette, Entrée ; Alt+← revient à la vue d'avant", async ({ page }) => {
    const problems = health(page);
    await open(page, await source());
    const box = page.getByRole("textbox", { name: /Numéro ou étiquette de page/ });
    await expect(box).toHaveValue("i");
    await box.click();
    await box.fill("2");
    // Nothing moves while typing.
    await expect(page.locator(".pdfx-pagenav__total")).toContainText("(1 / 4)");
    await box.press("Enter");
    // « 2 » is the label of the 4th page.
    await expect(box).toHaveValue("2");
    await expect(page.locator(".pdfx-pagenav__total")).toContainText("(4 / 4)");
    await page
      .locator(".pdfx-viewcol")
      .click({ position: { x: 5, y: 5 } })
      .catch(() => {});
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(box).toHaveValue("i");
    await page.keyboard.press("Alt+ArrowRight");
    await expect(box).toHaveValue("2");
    expect(problems).toEqual([]);
  });

  test("un signet mène à sa page ; Alt+← revient", async ({ page }) => {
    const problems = health(page);
    await open(page, await source());
    await page.locator('.pdfx-rail__btn[title="Signets"]').click();
    await page.getByRole("button", { name: "Annexe" }).click();
    const box = page.getByRole("textbox", { name: /Numéro ou étiquette de page/ });
    await expect(box).toHaveValue("2");
    await page.keyboard.press("Alt+ArrowLeft");
    await expect(box).toHaveValue("i");
    expect(problems).toEqual([]);
  });
});
