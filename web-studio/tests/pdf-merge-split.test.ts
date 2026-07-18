import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { parsePageRange, mergePdfs, extractPages } from "../src/pdf/merge-split";

/** A PDF with `n` pages, each a distinct size so we can identify them by width. */
async function pdfWithPages(widths: number[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const w of widths) doc.addPage([w, 200]);
  return doc.save();
}

describe("PDF split — parsePageRange", () => {
  it("parses mixed singles and ranges into ordered 0-based indices", () => {
    expect(parsePageRange("1-3, 5, 8-10", 12)).toEqual([0, 1, 2, 4, 7, 8, 9]);
  });
  it("clamps out-of-range values and skips malformed tokens", () => {
    expect(parsePageRange("0, 3, 99, abc, 2-100", 4)).toEqual([2, 1, 2, 3]);
  });
  it("expands a descending range descending", () => {
    expect(parsePageRange("3-1", 5)).toEqual([2, 1, 0]);
  });
  it("returns empty for blank spec or zero pages", () => {
    expect(parsePageRange("   ", 5)).toEqual([]);
    expect(parsePageRange("1-3", 0)).toEqual([]);
  });
});

describe("PDF merge — mergePdfs", () => {
  it("concatenates documents and keeps the first doc's pages at the front", async () => {
    const a = await pdfWithPages([100, 110]); // 2 pages
    const b = await pdfWithPages([300]);       // 1 page
    const c = await pdfWithPages([400, 410]);  // 2 pages
    const { bytes, pageCount } = await mergePdfs([a, b, c]);
    expect(pageCount).toBe(5);
    const reloaded = await PDFDocument.load(bytes);
    expect(reloaded.getPageCount()).toBe(5);
    // Original order preserved: first two are a's pages (widths 100, 110).
    expect(Math.round(reloaded.getPage(0).getWidth())).toBe(100);
    expect(Math.round(reloaded.getPage(1).getWidth())).toBe(110);
    expect(Math.round(reloaded.getPage(2).getWidth())).toBe(300);
    expect(Math.round(reloaded.getPage(4).getWidth())).toBe(410);
  });

  it("handles a single source (identity merge)", async () => {
    const a = await pdfWithPages([100, 110, 120]);
    const { pageCount } = await mergePdfs([a]);
    expect(pageCount).toBe(3);
  });
});

describe("PDF split — extractPages", () => {
  it("extracts the given indices in order into a new PDF", async () => {
    const src = await pdfWithPages([100, 110, 120, 130, 140]);
    const out = await extractPages(src, [3, 1]); // pages 4 then 2
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(2);
    expect(Math.round(reloaded.getPage(0).getWidth())).toBe(130);
    expect(Math.round(reloaded.getPage(1).getWidth())).toBe(110);
  });

  it("ignores out-of-range indices but keeps the valid ones", async () => {
    const src = await pdfWithPages([100, 110]);
    const out = await extractPages(src, [0, 9, 1]);
    expect((await PDFDocument.load(out)).getPageCount()).toBe(2);
  });

  it("throws when no valid page remains", async () => {
    const src = await pdfWithPages([100]);
    await expect(extractPages(src, [5, 6])).rejects.toThrow();
  });

  it("round-trips with parsePageRange (extract pages '2-3')", async () => {
    const src = await pdfWithPages([100, 110, 120, 130]);
    const out = await extractPages(src, parsePageRange("2-3", 4));
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(2);
    expect(Math.round(reloaded.getPage(0).getWidth())).toBe(110);
    expect(Math.round(reloaded.getPage(1).getWidth())).toBe(120);
  });
});
