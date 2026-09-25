import { test, expect, type Page } from "@playwright/test";
import { PDFDocument, StandardFonts } from "pdf-lib";

/** Page organisation in a real browser (projects « drive » and « desktop »). */

async function pdf(sizes: [number, number][], label: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  sizes.forEach(([w, h], i) => doc.addPage([w, h]).drawText(`${label} ${i + 1}`, { x: 30, y: h - 50, size: 14, font }));
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

async function save(page: Page): Promise<PDFDocument> {
  const dl = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  return PDFDocument.load(Buffer.concat(await (await (await dl).createReadStream()).toArray()));
}

function health(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("ERR_CERT_AUTHORITY_INVALID")) problems.push(m.text());
  });
  return problems;
}

test.describe("PDF — organiser", () => {
  test("insérer un PDF avant la page 1", async ({ page }) => {
    const problems = health(page);
    await open(
      page,
      await pdf(
        [
          [595, 842],
          [595, 842],
        ],
        "Page",
      ),
    );
    await page.getByRole("tab", { name: "Organiser" }).click();
    await page.getByRole("button", { name: "Depuis un PDF" }).click();
    await page.setInputFiles('input[type="file"][accept="application/pdf,.pdf"][multiple]', {
      name: "couverture.pdf",
      mimeType: "application/pdf",
      buffer: await pdf([[400, 300]], "Couverture"),
    });
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("couverture.pdf");
    await dialog.getByRole("combobox").first().selectOption("before");
    await dialog.getByRole("spinbutton").fill("1");
    await dialog.getByRole("button", { name: "Insérer" }).click();
    await expect(page.getByText("1 page(s) insérée(s)")).toBeVisible();
    const doc = await save(page);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getSize()).toEqual({ width: 400, height: 300 });
    expect(problems).toEqual([]);
  });

  test("insérer une image à sa taille, après la page 1", async ({ page }) => {
    const problems = health(page);
    await open(
      page,
      await pdf(
        [
          [595, 842],
          [595, 842],
        ],
        "Page",
      ),
    );
    await page.getByRole("tab", { name: "Organiser" }).click();
    await page.getByRole("button", { name: "Depuis une image" }).click();
    // A 400×200 px PNG (a 1×1 red pixel scaled by the browser is not enough: build one).
    const png = await page.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 400;
      c.height = 200;
      const g = c.getContext("2d")!;
      g.fillStyle = "#c00";
      g.fillRect(0, 0, 400, 200);
      const b = await new Promise<Blob>((r) => c.toBlob((x) => r(x!), "image/png"));
      return Array.from(new Uint8Array(await b.arrayBuffer()));
    });
    await page.setInputFiles('input[type="file"][accept*="image"]', {
      name: "photo.png",
      mimeType: "image/png",
      buffer: Buffer.from(png),
    });
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").first().selectOption("after");
    await dialog.getByRole("spinbutton").fill("1");
    await dialog.getByRole("button", { name: "Insérer" }).click();
    await expect(page.getByText("1 page(s) image ajoutée(s).")).toBeVisible();
    const doc = await save(page);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(1).getSize()).toEqual({ width: 300, height: 150 });
    expect(problems).toEqual([]);
  });

  test("pivoter les pages paires de 180°, déplacer, redimensionner, remplacer", async ({ page }) => {
    const problems = health(page);
    await open(
      page,
      await pdf(
        [
          [595, 842],
          [595, 842],
          [595, 842],
          [595, 842],
        ],
        "Page",
      ),
    );
    await page.getByRole("tab", { name: "Organiser" }).click();

    await page.getByRole("button", { name: /Faire pivoter/ }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").nth(0).selectOption("180");
    await dialog.getByRole("combobox").nth(1).selectOption("even");
    await dialog.getByRole("button", { name: "Faire pivoter" }).click();

    // Page 4 to the start.
    await page.keyboard.press("End").catch(() => {});
    await page.getByRole("button", { name: "Déplacer vers la page…" }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Déplacer");
    await dialog.getByRole("combobox").selectOption("start");
    await dialog.getByRole("button", { name: "Déplacer" }).click();

    // Resize everything to A5 landscape, content fitted.
    await page.getByRole("button", { name: "Redimensionner" }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox").nth(0).selectOption("A5");
    await dialog.getByRole("combobox").nth(1).selectOption("l");
    await dialog.getByRole("combobox").nth(3).selectOption("all");
    await dialog.getByRole("button", { name: "Redimensionner" }).click();
    await expect(page.getByText(/page\(s\) redimensionnée\(s\)/).first()).toBeVisible();

    // Page 2 replaced by the page of another file.
    await page.getByRole("button", { name: "Remplacer" }).click();
    await page.getByTestId("replace-input").setInputFiles({
      name: "neuf.pdf",
      mimeType: "application/pdf",
      buffer: await pdf([[300, 300]], "Neuf"),
    });
    dialog = page.getByRole("dialog");
    await dialog.getByRole("spinbutton").nth(0).fill("2");
    await dialog.getByRole("spinbutton").nth(1).fill("2");
    await dialog.getByRole("button", { name: "Remplacer" }).click();
    await expect(page.getByText(/remplacée\(s\)/).first()).toBeVisible();

    const doc = await save(page);
    expect(doc.getPageCount()).toBe(4);
    const sizes = doc
      .getPages()
      .map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight()), p.getRotation().angle]);
    // Order after the move: 4 (180°), 1, 2 (180°), 3 — resized to A5 landscape as seen
    // (a page turned 180° is seen the same way round); then page 2 replaced by « Neuf ».
    expect(sizes[0]).toEqual([595, 420, 180]);
    expect(sizes[1]).toEqual([300, 300, 0]);
    expect(sizes[2]).toEqual([595, 420, 180]);
    expect(sizes[3]).toEqual([595, 420, 0]);
    expect(problems).toEqual([]);
  });

  test("recadrer : détecter les marges blanches", async ({ page }) => {
    const problems = health(page);
    // Content only in the middle: a block 200 × 100 at (200, 400).
    const doc0 = await PDFDocument.create();
    const p = doc0.addPage([600, 800]);
    const { rgb } = await import("pdf-lib");
    p.drawRectangle({ x: 200, y: 400, width: 200, height: 100, color: rgb(0, 0, 0) });
    await open(page, Buffer.from(await doc0.save()));
    await page.getByRole("tab", { name: "Organiser" }).click();
    await page.getByRole("button", { name: "Recadrer" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "Détecter les marges blanches" }).click();
    await expect(dialog.getByRole("spinbutton").first()).not.toHaveValue("0");
    await dialog.getByRole("button", { name: "Appliquer" }).click();
    const doc = await save(page);
    const box = doc.getPage(0).getCropBox();
    // The block, with a hair of margin.
    expect(Math.abs(box.x - 200)).toBeLessThan(4);
    expect(Math.abs(box.y - 400)).toBeLessThan(4);
    expect(Math.abs(box.width - 200)).toBeLessThan(6);
    expect(Math.abs(box.height - 100)).toBeLessThan(6);
    expect(problems).toEqual([]);
  });
});
