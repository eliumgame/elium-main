import { describe, it, expect } from "vitest";
import {
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFRef,
  StandardFonts,
  decodePDFRawStream,
  degrees,
  fill,
  rectangle,
} from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import { parseContentStream, type Op } from "../src/pdf/core/contentstream";
import { readPageContentBytes } from "../src/pdf/ops/content";
import {
  DEFAULT_PRINT_OPTIONS,
  bookletOrder,
  cellOf,
  contentState,
  describeSheets,
  imposeForPrint,
  keepFormFieldsOnly,
  resolvePageSpec,
  selectPages,
  tileColumnName,
  type PrintOptions,
} from "../src/pdf/ops/impose";
import { PAGE_SIZES } from "../src/pdf/ops/organize";
import { emptyState, type Annot } from "../src/pdf/model/types";

/** Print imposition: page choice, n-up, booklet, poster, sizing. */

const A4 = PAGE_SIZES.A4;
const A4L: [number, number] = [A4[1], A4[0]];

type Opts = Omit<Partial<PrintOptions>, "size" | "multiple" | "booklet" | "poster"> & {
  size?: Partial<PrintOptions["size"]>;
  multiple?: Partial<PrintOptions["multiple"]>;
  booklet?: Partial<PrintOptions["booklet"]>;
  poster?: Partial<PrintOptions["poster"]>;
};

function options(o: Opts = {}): PrintOptions {
  const d = DEFAULT_PRINT_OPTIONS;
  return {
    ...d,
    ...o,
    size: { ...d.size, ...o.size },
    multiple: { ...d.multiple, ...o.multiple },
    booklet: { ...d.booklet, ...o.booklet },
    poster: { ...d.poster, ...o.poster },
  };
}

/** A PDF whose page i carries a marker `100+i 0 1 1 re`, to recognise it once embedded. */
async function makePdf(sizes: [number, number][], rotate: number[] = []): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  sizes.forEach((size, i) => {
    const page = doc.addPage(size);
    page.pushOperators(rectangle(100 + i, 0, 1, 1), fill());
    if (rotate[i]) page.setRotation(degrees(rotate[i]));
  });
  return doc.save();
}

const pagesOf = (n: number, size: [number, number] = A4) => makePdf(Array.from({ length: n }, () => size));

function decoded(stream: unknown): Uint8Array {
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  throw new Error("not a raw stream");
}

interface Placed {
  /** Source page index (from its marker). */
  src: number;
  m: number[];
}

/** Every page drawn on a sheet: the `cm` right before each `Do`, and which source page it is. */
function placements(page: PDFPage): Placed[] {
  const ops = parseContentStream(readPageContentBytes(page));
  const xobjects = page.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
  const out: Placed[] = [];
  let cm: number[] = [];
  for (const op of ops) {
    if (op.op === "cm") cm = op.args.map((a) => (a.t === "num" ? a.v : NaN));
    if (op.op !== "Do") continue;
    const name = op.args[0].t === "name" ? op.args[0].v : "";
    const inner = parseContentStream(decoded(xobjects.lookup(PDFName.of(name))));
    const marker = inner.find((o: Op) => o.op === "re");
    const v = marker?.args[0];
    out.push({ src: v && v.t === "num" ? v.v - 100 : -1, m: cm });
  }
  return out;
}

async function impose(bytes: Uint8Array, o: Opts) {
  const out = await PDFDocument.load(await imposeForPrint(bytes, options(o)));
  return out.getPages();
}

const size = (p: PDFPage) => [p.getWidth(), p.getHeight()];

describe("page choice", () => {
  it("selects all, the current page, a range, odd or even pages, reversed", () => {
    expect(selectPages(options(), 4)).toEqual([0, 1, 2, 3]);
    expect(selectPages(options({ pages: "current", currentPage: 2 }), 4)).toEqual([2]);
    expect(selectPages(options({ pages: "range", range: "1-3, 5, 8-" }), 9)).toEqual([0, 1, 2, 4, 7, 8]);
    expect(selectPages(options({ subset: "odd" }), 5)).toEqual([0, 2, 4]);
    expect(selectPages(options({ subset: "even" }), 5)).toEqual([1, 3]);
    expect(selectPages(options({ reverse: true, subset: "even" }), 5)).toEqual([3, 1]);
    expect(selectPages(options({ pages: "range", range: "2-4", reverse: true }), 5)).toEqual([3, 2, 1]);
  });

  it("accepts the document's page labels", () => {
    const labels = ["i", "ii", "iii", "1", "2", "3", "A-1", "A-2"];
    expect(resolvePageSpec("ii", 8, labels)).toEqual([1]);
    expect(resolvePageSpec("1-2", 8, labels)).toEqual([3, 4]);
    expect(resolvePageSpec("iii-2", 8, labels)).toEqual([2, 3, 4]);
    expect(resolvePageSpec("A-2, i", 8, labels)).toEqual([7, 0]);
    expect(resolvePageSpec("3-", 8, labels)).toEqual([5, 6, 7]);
    // Not a label: physical page numbers.
    expect(resolvePageSpec("8", 8, labels)).toEqual([7]);
    expect(resolvePageSpec("impaires", 4, ["a", "b", "c", "d"])).toEqual([0, 2]);
    expect(resolvePageSpec("2-3", 4)).toEqual([1, 2]);
  });

  it("prints only the pages chosen, in the order chosen", async () => {
    const bytes = await pagesOf(5);
    const odd = await impose(bytes, { subset: "odd" });
    expect(odd.map((p) => placements(p)[0].src)).toEqual([0, 2, 4]);
    const rev = await impose(bytes, { reverse: true });
    expect(rev.map((p) => placements(p)[0].src)).toEqual([4, 3, 2, 1, 0]);
    const range = await impose(bytes, { pages: "range", range: "2, 4-5" });
    expect(range.map((p) => placements(p)[0].src)).toEqual([1, 3, 4]);
    const current = await impose(bytes, { pages: "current", currentPage: 3 });
    expect(current.map((p) => placements(p)[0].src)).toEqual([3]);
  });

  it("returns the document untouched when nothing changes", async () => {
    const bytes = await pagesOf(3);
    expect(await imposeForPrint(bytes, options())).toBe(bytes);
  });

  it("refuses an empty selection", async () => {
    await expect(imposeForPrint(await pagesOf(2), options({ pages: "range", range: "9" }))).rejects.toThrow();
  });
});

describe("size", () => {
  it("fits, shrinks only oversized pages, keeps the actual size or a custom scale", async () => {
    const bytes = await makePdf([PAGE_SIZES.A5, PAGE_SIZES.A3]);
    const scaleOf = async (o: Opts) => (await impose(bytes, { paper: "A4", ...o })).map((p) => placements(p)[0].m[0]);

    const fit = await scaleOf({ size: { scaling: "fit" } });
    expect(fit[0]).toBeCloseTo(Math.SQRT2, 3);
    expect(fit[1]).toBeCloseTo(Math.SQRT1_2, 3);
    const shrink = await scaleOf({ size: { scaling: "shrink" } });
    expect(shrink[0]).toBeCloseTo(1, 5);
    expect(shrink[1]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(await scaleOf({ size: { scaling: "actual" } })).toEqual([1, 1]);
    expect(await scaleOf({ size: { scaling: "custom", scale: 50 } })).toEqual([0.5, 0.5]);
  });

  it("centres the page, or puts it in the top-left corner", async () => {
    const bytes = await makePdf([PAGE_SIZES.A5]);
    const [centred] = await impose(bytes, { paper: "A4", size: { scaling: "actual", center: true } });
    const m = placements(centred)[0].m;
    expect(m[4]).toBeCloseTo((A4[0] - PAGE_SIZES.A5[0]) / 2, 3);
    expect(m[5]).toBeCloseTo((A4[1] - PAGE_SIZES.A5[1]) / 2, 3);
    const [corner] = await impose(bytes, { paper: "A4", size: { scaling: "actual", center: false } });
    const c = placements(corner)[0].m;
    expect(c[4]).toBeCloseTo(0, 5);
    expect(c[5]).toBeCloseTo(A4[1] - PAGE_SIZES.A5[1], 3);
  });

  it("auto orientation: a landscape page on A4 gets a landscape sheet", async () => {
    const bytes = await makePdf([A4L, A4]);
    const [land, port] = await impose(bytes, { paper: "A4", orientation: "auto" });
    expect(size(land)).toEqual(A4L);
    expect(size(port)).toEqual(A4);
    expect(placements(land)[0].m).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("fixed portrait paper: auto-rotate turns a landscape page, or else shrinks it", async () => {
    const bytes = await makePdf([A4L]);
    const [turned] = await impose(bytes, { paper: "A4", orientation: "portrait", size: { autoRotate: true } });
    expect(size(turned)).toEqual(A4);
    const t = placements(turned)[0].m;
    expect(t[0]).toBeCloseTo(0, 6);
    expect(Math.abs(t[1])).toBeCloseTo(1, 5);
    const [straight] = await impose(bytes, { paper: "A4", orientation: "portrait", size: { autoRotate: false } });
    const s = placements(straight)[0].m;
    expect(s[1]).toBeCloseTo(0, 6);
    expect(s[0]).toBeCloseTo(A4[0] / A4[1], 4);
  });

  it("honours /Rotate: a portrait page turned 90° prints as landscape", async () => {
    const bytes = await makePdf([A4], [90]);
    const [sheet] = await impose(bytes, { paper: "A4" });
    expect(size(sheet)).toEqual(A4L);
    const m = placements(sheet)[0].m;
    // (u, v) → (v, width − u): the page's top goes to the right.
    expect(m.slice(0, 4)).toEqual([0, -1, 1, 0]);
    expect(m[5]).toBeCloseTo(A4[0], 3);
  });
});

describe("multiple pages per sheet", () => {
  it("2 per sheet: side by side on a landscape sheet, scaled by 1/√2", async () => {
    const bytes = await pagesOf(3);
    const sheets = await impose(bytes, { layout: "multiple", paper: "A4", multiple: { perSheet: 2 } });
    expect(sheets).toHaveLength(2);
    expect(size(sheets[0])).toEqual(A4L);
    const [a, b] = placements(sheets[0]);
    expect([a.src, b.src]).toEqual([0, 1]);
    expect(a.m[0]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(a.m[4]).toBeCloseTo(0, 1);
    expect(b.m[4]).toBeCloseTo(A4[1] / 2, 1);
    expect(placements(sheets[1]).map((p) => p.src)).toEqual([2]);
  });

  it("4 per sheet: a 2 × 2 grid at half size, in the order chosen", async () => {
    const bytes = await pagesOf(5);
    const sheets = await impose(bytes, { layout: "multiple", paper: "A4", multiple: { perSheet: 4 } });
    expect(sheets).toHaveLength(2);
    expect(size(sheets[0])).toEqual(A4);
    const p = placements(sheets[0]);
    expect(p.map((x) => x.src)).toEqual([0, 1, 2, 3]);
    for (const x of p) expect(x.m[0]).toBeCloseTo(0.5, 5);
    const pos = p.map((x) => [Math.round(x.m[4]), Math.round(x.m[5])]);
    const [hw, hh] = [Math.round(A4[0] / 2), Math.round(A4[1] / 2)];
    expect(pos).toEqual([
      [0, hh],
      [hw, hh],
      [0, 0],
      [hw, 0],
    ]);

    const vertical = await impose(bytes, {
      layout: "multiple",
      paper: "A4",
      multiple: { perSheet: 4, order: "vertical" },
    });
    const v = placements(vertical[0]).map((x) => [Math.round(x.m[4]), Math.round(x.m[5])]);
    expect(v).toEqual([
      [0, hh],
      [0, 0],
      [hw, hh],
      [hw, 0],
    ]);
  });

  it("draws page borders and keeps margins", async () => {
    const bytes = await pagesOf(2);
    const [sheet] = await impose(bytes, {
      layout: "multiple",
      paper: "A4",
      multiple: { perSheet: 2, border: true, marginMm: 10 },
    });
    const ops = parseContentStream(readPageContentBytes(sheet));
    expect(ops.filter((o) => o.op === "S")).toHaveLength(2);
    const [a] = placements(sheet);
    expect(a.m[4]).toBeGreaterThanOrEqual(10 * (72 / 25.4) - 0.01);
  });

  it("orders cells horizontally, vertically, or reversed", () => {
    expect([0, 1, 2, 3, 4, 5].map((k) => cellOf(k, 2, 3, "horizontal"))).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [1, 1],
      [1, 2],
    ]);
    expect(cellOf(0, 2, 3, "horizontalReversed")).toEqual([0, 2]);
    expect(cellOf(1, 2, 3, "vertical")).toEqual([1, 0]);
    expect(cellOf(2, 2, 3, "verticalReversed")).toEqual([0, 1]);
  });
});

describe("booklet", () => {
  it("orders 8 pages for saddle stitching", () => {
    const one = (s: (number | null)[][]) => s.map((sheet) => sheet.map((i) => (i === null ? null : i + 1)));
    expect(one(bookletOrder(8))).toEqual([
      [8, 1, 2, 7],
      [6, 3, 4, 5],
    ]);
    expect(one(bookletOrder(5))).toEqual([
      [null, 1, 2, null],
      [null, 3, 4, 5],
    ]);
    expect(one(bookletOrder(8, "right"))).toEqual([
      [1, 8, 7, 2],
      [3, 6, 5, 4],
    ]);
  });

  it("imposes 8 pages as 4 sides, two pages each", async () => {
    const sheets = await impose(await pagesOf(8), { layout: "booklet", paper: "A4" });
    expect(sheets).toHaveLength(4);
    expect(size(sheets[0])).toEqual(A4L);
    expect(sheets.map((s) => placements(s).map((p) => p.src + 1))).toEqual([
      [8, 1],
      [2, 7],
      [6, 3],
      [4, 5],
    ]);
    const [left, right] = placements(sheets[0]);
    expect(left.m[0]).toBeCloseTo(Math.SQRT1_2, 3);
    expect(right.m[4]).toBeCloseTo(A4[1] / 2, 1);
  });

  it("pads 5 pages with blanks", async () => {
    const sheets = await impose(await pagesOf(5), { layout: "booklet", paper: "A4" });
    expect(sheets.map((s) => placements(s).map((p) => p.src + 1))).toEqual([[1], [2], [3], [4, 5]]);
    // Page 1 is on the right half, the left one blank.
    expect(placements(sheets[0])[0].m[4]).toBeCloseTo(A4[1] / 2, 1);
  });

  it("prints one side only, or some sheets only", async () => {
    const bytes = await pagesOf(8);
    const front = await impose(bytes, { layout: "booklet", paper: "A4", booklet: { sides: "front" } });
    expect(front.map((s) => placements(s).map((p) => p.src + 1))).toEqual([
      [8, 1],
      [6, 3],
    ]);
    const back = await impose(bytes, { layout: "booklet", paper: "A4", booklet: { sides: "back", sheetFrom: 2 } });
    expect(back.map((s) => placements(s).map((p) => p.src + 1))).toEqual([[4, 5]]);
  });
});

describe("poster", () => {
  it("tiles an A4 page at 200 % on A4 paper with overlap over 3 × 3 sheets", async () => {
    const bytes = await pagesOf(1);
    const tiles = await impose(bytes, {
      layout: "poster",
      paper: "A4",
      orientation: "portrait",
      poster: { scale: 200, overlapMm: 10 },
    });
    expect(tiles).toHaveLength(9);
    for (const t of tiles) expect(size(t)).toEqual(A4);
    const first = placements(tiles[0])[0].m;
    expect(first[0]).toBe(2);
    // Automatic orientation takes landscape paper: 2 × 4 sheets.
    const auto = await impose(bytes, { layout: "poster", paper: "A4", poster: { scale: 200, overlapMm: 10 } });
    expect(auto).toHaveLength(8);
    expect(size(auto[0])).toEqual(A4L);
    // The label names the tile.
    const shown = parseContentStream(readPageContentBytes(tiles[0]))
      .filter((o) => o.op === "Tj")
      .map((o) => {
        const a = o.args[0];
        return a.t === "hex" || a.t === "str" ? new TextDecoder("latin1").decode(a.v) : "";
      });
    expect(shown[0]).toMatch(/^A1 . page 1 \(ligne 1, colonne 1/);
  });

  it("without overlap nor marks, 200 % is exactly 2 × 2", async () => {
    const tiles = await impose(await pagesOf(1), {
      layout: "poster",
      paper: "A4",
      poster: { scale: 200, overlapMm: 0, cutMarks: false, labels: false },
    });
    expect(tiles).toHaveLength(4);
    const offsets = tiles.map((t) => placements(t)[0].m.slice(4).map(Math.round));
    const [w, h] = A4.map(Math.round);
    expect(offsets).toEqual([
      [0, -h],
      [-w, -h],
      [0, 0],
      [-w, 0],
    ]);
  });

  it("tiles only large pages when asked", async () => {
    const bytes = await makePdf([A4, PAGE_SIZES.A3]);
    const tiles = await impose(bytes, {
      layout: "poster",
      paper: "A4",
      poster: { scale: 100, overlapMm: 0, cutMarks: false, labels: false, largeOnly: true },
    });
    // The A4 page on one sheet, the A3 one over two.
    expect(tiles).toHaveLength(3);
    expect(tileColumnName(0)).toBe("A");
    expect(tileColumnName(27)).toBe("AB");
  });
});

describe("describeSheets", () => {
  it("counts the sheets of each layout", () => {
    expect(describeSheets(options(), 7)).toEqual({ pages: 7, sheets: 7, paperSheets: 7 });
    expect(describeSheets(options({ subset: "even" }), 7).sheets).toBe(3);
    expect(describeSheets(options({ layout: "multiple", multiple: { perSheet: 4 } }), 10).sheets).toBe(3);
    expect(describeSheets(options({ layout: "multiple", multiple: { perSheet: 6 } }), 6).sheets).toBe(1);
    expect(
      describeSheets(options({ layout: "multiple", multiple: { perSheet: "custom", rows: 3, cols: 2 } }), 13).sheets,
    ).toBe(3);
    expect(describeSheets(options({ layout: "booklet" }), 5)).toEqual({ pages: 5, sheets: 4, paperSheets: 2 });
    expect(describeSheets(options({ layout: "booklet", booklet: { sides: "front" } }), 9).sheets).toBe(3);
    expect(describeSheets(options({ layout: "booklet", booklet: { sheetFrom: 2, sheetTo: 2 } }), 16).sheets).toBe(2);
    expect(
      describeSheets(
        options({ layout: "poster", paper: "A4", orientation: "portrait", poster: { scale: 200, overlapMm: 10 } }),
        1,
        [A4],
      ).sheets,
    ).toBe(9);
    expect(describeSheets(options({ pages: "range", range: "42" }), 3).sheets).toBe(0);
  });
});

describe("annotations and content modes", () => {
  it("bakes printable annotation appearances into the imposed page", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage(A4);
    page.pushOperators(rectangle(100, 0, 1, 1), fill());
    const ap = doc.context.register(
      doc.context.stream("0 0 1 rg 0 0 20 10 re f", { Type: "XObject", Subtype: "Form", BBox: [0, 0, 20, 10] }),
    );
    const annot = (flags: number) =>
      doc.context.register(
        doc.context.obj({ Type: "Annot", Subtype: "Square", Rect: [100, 100, 140, 120], F: flags, AP: { N: ap } }),
      );
    page.node.set(PDFName.of("Annots"), doc.context.obj([annot(4), annot(4 | 2), annot(0)]));
    const [sheet] = await impose(await doc.save(), { layout: "multiple", paper: "A4", multiple: { perSheet: 2 } });
    const xobjects = sheet.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const [key] = xobjects.keys();
    const inner = parseContentStream(decoded(xobjects.lookup(key)));
    const does = inner.filter((o) => o.op === "Do");
    // Only the printable, visible one; its 20 × 10 box stretched onto the 40 × 20 rect.
    expect(does).toHaveLength(1);
    const cm = inner[inner.indexOf(does[0]) - 1];
    expect(cm.args.map((a) => (a.t === "num" ? a.v : NaN))).toEqual([2, 0, 0, 2, 100, 100]);
  });

  it("form fields only: blank pages with the fields drawn", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage(A4);
    page.drawText("Contenu de la page", {
      x: 50,
      y: 700,
      size: 12,
      font: await doc.embedFont(StandardFonts.Helvetica),
    });
    const field = doc.getForm().createTextField("nom");
    field.setText("Dupont");
    field.addToPage(page, { x: 50, y: 600, width: 200, height: 20 });
    const out = await PDFDocument.load(await keepFormFieldsOnly(await doc.save()));
    const [p] = out.getPages();
    const ops = parseContentStream(readPageContentBytes(p));
    expect(ops.some((o) => o.op === "Tj" || o.op === "TJ")).toBe(false);
    expect(ops.filter((o) => o.op === "Do")).toHaveLength(1);
    expect(p.node.Annots()).toBeUndefined();
    expect(out.catalog.get(PDFName.of("AcroForm"))).toBeUndefined();
    expect(p.node.Resources()!.lookup(PDFName.of("XObject"), PDFDict).values()[0]).toBeInstanceOf(PDFRef);
  });

  it("filters the annotations for each content mode", () => {
    const st = emptyState();
    const mk = (kind: Annot["kind"]) => ({ id: kind, kind }) as unknown as Annot;
    st.annots = [mk("highlight"), mk("stamp"), mk("image"), mk("note"), mk("signature")];
    st.watermark = { ...st.watermark, enabled: true };
    const kinds = (m: Parameters<typeof contentState>[1]) => contentState(st, m).annots.map((a) => a.kind);
    expect(kinds("markups")).toEqual(["highlight", "stamp", "image", "note", "signature"]);
    expect(kinds("document")).toEqual(["image", "signature"]);
    expect(kinds("stamps")).toEqual(["stamp", "image", "signature"]);
    expect(kinds("forms")).toEqual([]);
    expect(contentState(st, "forms").watermark.enabled).toBe(false);
  });
});
