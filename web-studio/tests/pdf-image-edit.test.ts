// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { deflateSync } from "node:zlib";
import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildPdf } from "../src/pdf/ops/save";
import { pageImages, rewrittenPage } from "../src/pdf/ops/editpreview";
import { pagePlacements } from "../src/pdf/ops/textedit";
import { resizeFrom } from "../src/pdf/ui/ImageEditLayer";
import * as D from "../src/pdf/model/doc";
import { emptyState, type ImageEdit, type PdfState } from "../src/pdf/model/types";

/**
 * « Modifier » edits the pictures of the page content itself: moved, resized,
 * replaced, deleted, or new ones added — written into the content stream, so
 * any reader shows them (no annotation on top).
 */

/** A w×h opaque PNG of one colour, as a data URL. */
function png(w: number, h: number, rgb: [number, number, number]): string {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
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
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

const RED = png(4, 2, [255, 0, 0]);
const BLUE = png(2, 2, [0, 0, 255]);

/** A 400×600 page with two pictures: one plain, one under an outer `cm` (as scanners write). */
async function source(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);
  const img = await doc.embedPng(Buffer.from(RED.split(",")[1], "base64"));
  page.drawImage(img, { x: 50, y: 400, width: 100, height: 50 });
  page.pushOperators();
  const small = await doc.embedPng(Buffer.from(BLUE.split(",")[1], "base64"));
  // Drawn at (200, 100) 80×80 through a translate + scale.
  const { pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } = await import("pdf-lib");
  const name = page.node.newXObject("Image", small.ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(2, 0, 0, 2, 100, 50),
    concatTransformationMatrix(40, 0, 0, 40, 50, 25),
    drawObject(name),
    popGraphicsState(),
  );
  return doc.save({ useObjectStreams: false });
}

const base = (): PdfState => ({ ...emptyState(), pages: D.pagesFromSource(1) });

async function placed(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  return (await pagePlacements(doc.getPage(0))).map((p) => {
    const xs = p.corners.map((c) => c.x);
    const ys = p.corners.map((c) => c.y);
    const r = (v: number) => Math.round(v * 100) / 100;
    return {
      isImage: p.isImage,
      x: r(Math.min(...xs)),
      y: r(Math.min(...ys)),
      w: r(Math.max(...xs) - Math.min(...xs)),
      h: r(Math.max(...ys) - Math.min(...ys)),
    };
  });
}

const edit = (e: Partial<ImageEdit> & Pick<ImageEdit, "occurrence" | "action">): ImageEdit => ({
  id: `img:p:${e.occurrence}:${e.action}`,
  pageId: "",
  ...e,
});

describe("pictures of the page content", () => {
  it("lists them in editor space (top-left), through every cm", async () => {
    const imgs = await pageImages(await source(), null, 0);
    expect(imgs).toEqual([
      { occurrence: 0, rect: { x: 50, y: 150, w: 100, h: 50 } },
      { occurrence: 1, rect: { x: 200, y: 420, w: 80, h: 80 } },
    ]);
  });

  it("moves and resizes, even under an outer transform", async () => {
    const state = base();
    const pageId = state.pages[0].id;
    const s = {
      ...state,
      imageEdits: [
        edit({ pageId, occurrence: 0, action: "move", rect: { x: 10, y: 20, w: 200, h: 100 } }),
        edit({ pageId, occurrence: 1, action: "move", rect: { x: 300, y: 500, w: 40, h: 40 } }),
      ],
    };
    const { bytes, report } = await buildPdf(await source(), s);
    expect(report.lost).toEqual([]);
    expect(await placed(bytes)).toEqual([
      { isImage: true, x: 10, y: 480, w: 200, h: 100 },
      { isImage: true, x: 300, y: 60, w: 40, h: 40 },
    ]);
  });

  it("replaces one, deletes another, adds a third", async () => {
    const state = base();
    const pageId = state.pages[0].id;
    const s = {
      ...state,
      imageEdits: [
        edit({ pageId, occurrence: 0, action: "replace", src: BLUE, rect: { x: 50, y: 150, w: 100, h: 100 } }),
        edit({ pageId, occurrence: 1, action: "delete" }),
        { id: "im1", pageId, occurrence: -1, action: "add", src: RED, rect: { x: 0, y: 0, w: 40, h: 20 } } as ImageEdit,
      ],
    };
    const { bytes, report } = await buildPdf(await source(), s);
    expect(report.lost).toEqual([]);
    expect(await placed(bytes)).toEqual([
      { isImage: true, x: 50, y: 350, w: 100, h: 100 },
      { isImage: true, x: 0, y: 580, w: 40, h: 20 },
    ]);
    // The replacement is the blue 2×2, the addition the red 4×2.
    const doc = await PDFDocument.load(bytes);
    const imgs = await pageImages(bytes, null, 0);
    expect(imgs).toHaveLength(2);
    const { PDFName, PDFDict } = await import("pdf-lib");
    const xo = doc.getPage(0).node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
    const widths = (await pagePlacements(doc.getPage(0))).map((p) =>
      (xo.lookup(PDFName.of(p.name)) as unknown as { dict: InstanceType<typeof PDFDict> }).dict
        .get(PDFName.of("Width"))
        ?.toString(),
    );
    expect(widths).toEqual(["2", "4"]);
  });

  it("previews exactly what the save writes", async () => {
    const src = await source();
    const edits = [edit({ occurrence: 0, action: "move", rect: { x: 10, y: 20, w: 200, h: 100 } })];
    const prev = await rewrittenPage(src, null, 0, [], edits);
    const state = base();
    const saved = await buildPdf(src, {
      ...state,
      imageEdits: edits.map((e) => ({ ...e, pageId: state.pages[0].id })),
    });
    expect(await placed(prev.bytes)).toEqual(await placed(saved.bytes));
  });

  it("keeps proportions on a corner drag unless asked not to", () => {
    const r = { x: 10, y: 10, w: 100, h: 50 };
    expect(resizeFrom(r, "se", { x: 210, y: 20 }, false)).toEqual({ x: 10, y: 10, w: 200, h: 100 });
    expect(resizeFrom(r, "nw", { x: 60, y: 50 }, false)).toEqual({ x: 60, y: 35, w: 50, h: 25 });
    expect(resizeFrom(r, "ne", { x: 60, y: 0 }, true)).toEqual({ x: 10, y: 0, w: 50, h: 60 });
  });

  it("restores by dropping the edit; an added picture is told apart by id", () => {
    let s = base();
    const pageId = s.pages[0].id;
    s = D.upsertImageEdit(s, {
      id: "a",
      pageId,
      occurrence: -1,
      action: "add",
      src: RED,
      rect: { x: 0, y: 0, w: 1, h: 1 },
    });
    s = D.upsertImageEdit(s, {
      id: "b",
      pageId,
      occurrence: -1,
      action: "add",
      src: RED,
      rect: { x: 0, y: 0, w: 1, h: 1 },
    });
    s = D.upsertImageEdit(s, { id: "c", pageId, occurrence: 0, action: "move", rect: { x: 0, y: 0, w: 1, h: 1 } });
    s = D.upsertImageEdit(s, { id: "c", pageId, occurrence: 0, action: "delete" });
    expect(s.imageEdits.map((e) => [e.id, e.action])).toEqual([
      ["a", "add"],
      ["b", "add"],
      ["c", "delete"],
    ]);
    s = D.removeImageEdit(s, "c");
    expect(s.imageEdits.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("content left in a transformed state (Chromium)", () => {
  /** A page whose stream starts with a bare `cm`, never undone — as Skia writes. */
  async function skiaLike(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const { concatTransformationMatrix, drawObject } = await import("pdf-lib");
    const img = await doc.embedPng(Buffer.from(RED.split(",")[1], "base64"));
    const name = page.node.newXObject("Image", img.ref);
    page.pushOperators(
      concatTransformationMatrix(0.5, 0, 0, -0.5, 0, 600),
      concatTransformationMatrix(200, 0, 0, -100, 100, 300),
      drawObject(name),
    );
    return doc.save({ useObjectStreams: false });
  }

  it("adds a picture in page space all the same", async () => {
    const state = base();
    const pageId = state.pages[0].id;
    const { bytes } = await buildPdf(await skiaLike(), {
      ...state,
      imageEdits: [{ id: "n", pageId, occurrence: -1, action: "add", src: BLUE, rect: { x: 20, y: 30, w: 60, h: 60 } }],
    });
    const got = await pageImages(bytes, null, 0);
    expect(got[0].rect).toEqual({ x: 50, y: 100, w: 100, h: 50 });
    expect(got[1].rect).toEqual({ x: 20, y: 30, w: 60, h: 60 });
  });

  it("tells a clean stream from one that leaves state behind", async () => {
    const { leavesDefaultState } = await import("../src/pdf/ops/textedit");
    const n = (v: number) => ({ t: "num", v }) as const;
    expect(
      leavesDefaultState([
        { op: "q", args: [] },
        { op: "cm", args: [1, 0, 0, 1, 5, 5].map(n) },
        { op: "Q", args: [] },
      ]),
    ).toBe(true);
    expect(leavesDefaultState([{ op: "cm", args: [1, 0, 0, 1, 5, 5].map(n) }])).toBe(false);
    expect(leavesDefaultState([{ op: "q", args: [] }])).toBe(false);
    expect(
      leavesDefaultState([
        { op: "W", args: [] },
        { op: "n", args: [] },
      ]),
    ).toBe(false);
  });
});

describe("« Rogner »", () => {
  it("clips the picture to its visible part, in the file", async () => {
    const state = base();
    const pageId = state.pages[0].id;
    const { bytes, report } = await buildPdf(await source(), {
      ...state,
      imageEdits: [
        // Keep the right half, bottom 60 %, of the 100×50 picture at (50, 150).
        edit({ pageId, occurrence: 0, action: "move", crop: { x: 0.5, y: 0.4, w: 0.5, h: 0.6 } }),
      ],
    });
    expect(report.lost).toEqual([]);
    const doc = await PDFDocument.load(bytes);
    const { readPageContent } = await import("../src/pdf/ops/content");
    const { ops } = await readPageContent(doc.getPage(0));
    const re = ops.find((o) => o.op === "re")!;
    // PDF space: x 100..150, y from 600-150-50 = 400 up to 400 + 30.
    expect(re.args.map((a) => (a.t === "num" ? a.v : NaN))).toEqual([100, 400, 50, 30]);
    const at = ops.indexOf(re);
    expect(ops.slice(at + 1, at + 3).map((o) => o.op)).toEqual(["W", "n"]);
    // Frame unchanged: the picture is only cut, not moved.
    expect((await placed(bytes))[0]).toEqual({ isImage: true, x: 50, y: 400, w: 100, h: 50 });
  });

  it("maps visible box, frame and crop onto each other", async () => {
    const { croppedBox, frameOf, cropOf } = await import("../src/pdf/ui/ImageEditLayer");
    const frame = { x: 10, y: 20, w: 200, h: 100 };
    const crop = { x: 0.25, y: 0.5, w: 0.5, h: 0.5 };
    const vis = croppedBox(frame, crop);
    expect(vis).toEqual({ x: 60, y: 70, w: 100, h: 50 });
    expect(frameOf(vis, crop)).toEqual(frame);
    expect(cropOf(frame, vis)).toEqual(crop);
    // Dragged beyond the picture: kept inside it; nothing cut off: no crop.
    expect(cropOf(frame, { x: 0, y: 0, w: 500, h: 500 })).toBeNull();
    // A scaled visible box scales the whole frame with it.
    expect(frameOf({ x: 60, y: 70, w: 200, h: 100 }, crop)).toEqual({ x: -40, y: -30, w: 400, h: 200 });
  });
});

describe("pictures already clipped by the file (Word, Acrobat)", () => {
  /**
   * Top-level `cm`, then a picture inside `q re W n … Q` whose clip keeps its
   * left half, then a second picture after it that relies on the outer `cm`.
   */
  async function clipped(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const lib = await import("pdf-lib");
    const red = page.node.newXObject("Image", (await doc.embedPng(Buffer.from(RED.split(",")[1], "base64"))).ref);
    const blue = page.node.newXObject("Image", (await doc.embedPng(Buffer.from(BLUE.split(",")[1], "base64"))).ref);
    page.pushOperators(
      lib.concatTransformationMatrix(1, 0, 0, 1, 10, 0),
      lib.pushGraphicsState(),
      lib.rectangle(40, 400, 50, 50),
      lib.clip(),
      lib.endPath(),
      lib.concatTransformationMatrix(100, 0, 0, 50, 40, 400),
      lib.drawObject(red),
      lib.popGraphicsState(),
      lib.concatTransformationMatrix(20, 0, 0, 20, 200, 100),
      lib.drawObject(blue),
    );
    return doc.save({ useObjectStreams: false });
  }

  it("reads the file's clip as the picture's crop", async () => {
    const imgs = await pageImages(await clipped(), null, 0);
    expect(imgs[0]).toEqual({
      occurrence: 0,
      rect: { x: 50, y: 150, w: 100, h: 50 },
      crop: { x: 0, y: 0, w: 0.5, h: 1 },
    });
    expect(imgs[1].crop).toBeUndefined();
  });

  it("moves it out of its old clip, keeps its crop, and leaves what follows in place", async () => {
    const state = base();
    const pageId = state.pages[0].id;
    const { bytes, report } = await buildPdf(await clipped(), {
      ...state,
      imageEdits: [edit({ pageId, occurrence: 0, action: "move", rect: { x: 200, y: 400, w: 100, h: 50 } })],
    });
    expect(report.lost).toEqual([]);
    const { walkPlacements } = await import("../src/pdf/core/contentstream");
    const { readPageContent } = await import("../src/pdf/ops/content");
    const { ops } = await readPageContent((await PDFDocument.load(bytes)).getPage(0));
    const [moved, after] = walkPlacements(ops);
    // Drawn at its new place, cut by a clip there (its left half), not by the old one.
    expect(moved.corners[0]).toEqual({ x: 200, y: 150 });
    expect(moved.clip).toEqual({ x0: 200, y0: 150, x1: 250, y1: 200 });
    // The next picture still sees the outer `cm` (x + 10) and no clip.
    expect(after.corners[0]).toEqual({ x: 210, y: 100 });
    expect(after.clip).toBeNull();
    expect(await pageImages(bytes, null, 0)).toEqual([
      { occurrence: 0, rect: { x: 200, y: 400, w: 100, h: 50 }, crop: { x: 0, y: 0, w: 0.5, h: 1 } },
      { occurrence: 1, rect: { x: 210, y: 480, w: 20, h: 20 } },
    ]);
  });

  it("uncrops on request (an explicit full crop)", async () => {
    const state = base();
    const pageId = state.pages[0].id;
    const { bytes } = await buildPdf(await clipped(), {
      ...state,
      imageEdits: [edit({ pageId, occurrence: 0, action: "move", crop: { x: 0, y: 0, w: 1, h: 1 } })],
    });
    expect((await pageImages(bytes, null, 0))[0].crop).toBeUndefined();
  });
});
