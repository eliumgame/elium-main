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
});
