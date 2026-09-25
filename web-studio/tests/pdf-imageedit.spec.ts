import { test, expect, type Page } from "@playwright/test";
import { deflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream, decodePDFRawStream } from "pdf-lib";
import { parseContentStream, walkPlacements } from "../src/pdf/core/contentstream";

/**
 * The page's own pictures in « Modifier le texte » (projects « drive » and
 * « desktop »): an image of a Chromium PDF moved, then replaced; a new one
 * added into the page content — and the saved file read back.
 */

function png(w: number, h: number, rgb: [number, number, number]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = table[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The page's image placements, top-left page space (as `pageImages` gives them, without its font imports). */
async function pageImages(bytes: Uint8Array, _password: null, index: number) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(index);
  const decode = (s: unknown) => (s instanceof PDFRawStream ? decodePDFRawStream(s).decode() : new Uint8Array());
  const c = page.node.Contents();
  const parts = c instanceof PDFArray ? Array.from({ length: c.size() }, (_, i) => decode(c.lookup(i))) : [decode(c)];
  const all = parts.flatMap((p) => [...p, 0x0a]);
  const xo = page.node.Resources()?.lookup(PDFName.of("XObject"));
  const box = page.getCropBox();
  return walkPlacements(parseContentStream(new Uint8Array(all)))
    .filter((p) => {
      const x = p.name && xo instanceof PDFDict ? xo.lookup(PDFName.of(p.name)) : null;
      return x instanceof PDFStream && x.dict.lookup(PDFName.of("Subtype"))?.toString() === "/Image";
    })
    .map((p) => {
      const xs = p.corners.map((q) => q.x - box.x);
      const ys = p.corners.map((q) => box.y + box.height - q.y);
      const x = Math.min(...xs);
      const y = Math.min(...ys);
      return { rect: { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y } };
    })
    .filter((p) => p.rect.w >= 2 && p.rect.h >= 2);
}

async function chromePdf(page: Page): Promise<Buffer> {
  // Noisy pixels, so Chromium keeps it a real image (not a flat fill).
  const img = png(40, 20, [200, 30, 30]).toString("base64");
  await page.setContent(`<html><body style="font-family:Arial,sans-serif;margin:40px">
    <h1 style="font-size:22px;margin:0 0 12px">Catalogue</h1>
    <img src="data:image/png;base64,${img}" style="width:200px;height:100px;display:block">
    <p style="font-size:12px">Légende de l'image.</p></body></html>`);
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
    name: "catalogue.pdf",
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

function health(page: Page) {
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("ERR_CERT_AUTHORITY_INVALID")) problems.push(m.text());
  });
  return problems;
}

test.describe("PDF — modifier les images", () => {
  test("déplacer puis remplacer une image de la page", async ({ page, context }) => {
    const problems = health(page);
    const bytes = await chromePdf(await context.newPage());
    const before = await pageImages(new Uint8Array(bytes), null, 0);
    expect(before).toHaveLength(1);
    await open(page, bytes);
    await page.getByRole("button", { name: "Modifier le texte" }).first().click();
    const box = page.getByRole("button", { name: "Image de la page" });
    await expect(box).toBeVisible();
    const b = (await box.boundingBox())!;
    const scale = b.width / before[0].rect.w;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + 100 * scale, b.y + b.height / 2 + 50 * scale, { steps: 6 });
    await page.mouse.up();
    // The rebuilt page shows it moved: the frame followed.
    await expect.poll(async () => Math.round(((await box.boundingBox())!.x - b.x) / scale)).toBe(100);
    await box.click();
    await page.getByTestId("image-replace-input").setInputFiles({
      name: "bleu.png",
      mimeType: "image/png",
      buffer: png(30, 30, [20, 40, 220]),
    });
    await expect(page.locator(".pdfx-editpreview__raster")).toBeVisible();
    const out = await save(page);
    const after = await pageImages(out, null, 0);
    expect(after).toHaveLength(1);
    const r = after[0].rect;
    expect(Math.round(r.x - before[0].rect.x)).toBe(100);
    expect(Math.round(r.y - before[0].rect.y)).toBe(50);
    // The square replacement keeps the frame's width, with its own proportions.
    expect(Math.round(r.w)).toBe(Math.round(before[0].rect.w));
    expect(Math.round(r.h)).toBe(Math.round(before[0].rect.w));
    expect(problems).toEqual([]);
  });

  test("supprimer, rétablir, et ajouter une image dans le contenu", async ({ page, context }) => {
    const problems = health(page);
    const bytes = await chromePdf(await context.newPage());
    await open(page, bytes);
    await page.getByRole("button", { name: "Modifier le texte" }).first().click();
    const box = page.getByRole("button", { name: "Image de la page" });
    await box.click();
    await page.keyboard.press("Delete");
    await expect(page.getByRole("button", { name: "Image supprimée" })).toBeVisible();
    await page.locator(".pdfx-imagebar").getByRole("button", { name: "Rétablir" }).click();
    await expect(box).toBeVisible();

    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Ajouter une image" }).click();
    await (await chooser).setFiles({ name: "vert.png", mimeType: "image/png", buffer: png(20, 10, [20, 180, 40]) });
    await expect(page.getByTestId("image-layer").first()).toHaveClass(/is-adding/);
    const canvas = (await page.getByTestId("image-layer").first().boundingBox())!;
    await page.mouse.click(canvas.x + canvas.width * 0.3, canvas.y + 350);
    await expect(page.getByRole("button", { name: "Image ajoutée" })).toBeVisible();

    const out = await save(page);
    const imgs = await pageImages(out, null, 0);
    expect(imgs).toHaveLength(2);
    // Added where clicked, 240 pt wide (at most), 2:1 as the picture.
    const added = imgs[1].rect;
    expect(Math.round(added.w)).toBe(240);
    expect(Math.round(added.h)).toBe(120);
    expect(problems).toEqual([]);
  });
});
