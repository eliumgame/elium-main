import { describe, it, expect } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import {
  hasImportableAnnots,
  importPageAnnots,
  stripImportedAnnots,
  type RawAnnotation,
} from "../src/pdf/ops/import-annots";
import * as D from "../src/pdf/model/doc";
import { emptyState } from "../src/pdf/model/types";
import { buildPdf } from "../src/pdf/ops/save";

const PAGE_H = 842;

/** A pdf.js-shaped annotation, in PDF space (bottom-left origin). */
const raw = (over: Partial<RawAnnotation>): RawAnnotation => ({
  id: "src-1",
  subtype: "Square",
  rect: [100, 700, 300, 760],
  color: new Uint8ClampedArray([225, 29, 72]),
  opacity: 1,
  contentsObj: { str: "À vérifier" },
  titleObj: { str: "Maître Durand" },
  creationDate: "D:20260214093000+01'00'",
  modificationDate: "D:20260214100000+01'00'",
  borderStyle: { width: 2, style: 1 },
  annotationFlags: 4,
  ...over,
});

describe("Importing a PDF's existing markup", () => {
  it("recognises what it can model", () => {
    expect(hasImportableAnnots([raw({ subtype: "Highlight" })])).toBe(true);
    expect(hasImportableAnnots([raw({ subtype: "Widget" })])).toBe(false);
    expect(hasImportableAnnots([])).toBe(false);
  });

  it("flips the rectangle into page space", () => {
    const { annots } = importPageAnnots([raw({})], "p1", PAGE_H, "Moi");
    expect(annots[0].rect).toEqual({ x: 100, y: 82, w: 200, h: 60 });
  });

  it("keeps the author, the comment and the timestamps", () => {
    const { annots } = importPageAnnots([raw({})], "p1", PAGE_H, "Moi");
    expect(annots[0].author).toBe("Maître Durand");
    expect(annots[0].contents).toBe("À vérifier");
    expect(annots[0].createdAt.startsWith("2026-02-14")).toBe(true);
  });

  it("reorders /QuadPoints from the spec order into reading order", () => {
    const { annots } = importPageAnnots(
      [
        raw({
          subtype: "Highlight",
          // upper-left, upper-right, lower-left, lower-right
          quadPoints: Float32Array.from([100, 760, 300, 760, 100, 740, 300, 740]),
        }),
      ],
      "p1",
      PAGE_H,
      "Moi",
    );
    const [tl, tr, br, bl] = annots[0].quads![0];
    expect(tl).toEqual({ x: 100, y: 82 });
    expect(tr).toEqual({ x: 300, y: 82 });
    expect(br).toEqual({ x: 300, y: 102 });
    expect(bl).toEqual({ x: 100, y: 102 });
  });

  it("reads ink strokes, one path per gesture", () => {
    const { annots } = importPageAnnots(
      [
        raw({
          subtype: "Ink",
          inkLists: [Float32Array.from([10, 800, 40, 780]), Float32Array.from([50, 700, 60, 690])],
        }),
      ],
      "p1",
      PAGE_H,
      "Moi",
    );
    expect(annots[0].kind).toBe("ink");
    expect(annots[0].paths).toHaveLength(2);
    expect(annots[0].paths![0][0]).toEqual({ x: 10, y: 42 });
  });

  it("turns a line with an arrow head into an arrow", () => {
    const { annots } = importPageAnnots(
      [
        raw({
          subtype: "Line",
          lineCoordinates: [100, 700, 300, 640],
          lineEndings: ["None", "ClosedArrow"],
        }),
      ],
      "p1",
      PAGE_H,
      "Moi",
    );
    expect(annots[0].kind).toBe("arrow");
    expect(annots[0].lineEnd).toBe("arrow");
    expect(annots[0].paths![0][1]).toEqual({ x: 300, y: 202 });
  });

  it("reads polygon vertices", () => {
    const { annots } = importPageAnnots(
      [
        raw({
          subtype: "Polygon",
          vertices: Float32Array.from([100, 700, 200, 700, 150, 640]),
        }),
      ],
      "p1",
      PAGE_H,
      "Moi",
    );
    expect(annots[0].paths![0]).toHaveLength(3);
    expect(annots[0].rect.h).toBeCloseTo(60, 3);
  });

  it("attaches an /IRT annotation to its parent instead of showing it twice", () => {
    const { annots } = importPageAnnots(
      [
        raw({ id: "parent", subtype: "Text", contentsObj: { str: "Question ?" } }),
        raw({
          id: "child",
          subtype: "Text",
          inReplyTo: "parent",
          replyType: "R",
          contentsObj: { str: "Réponse" },
          titleObj: { str: "Bob" },
        }),
      ],
      "p1",
      PAGE_H,
      "Moi",
    );
    expect(annots).toHaveLength(1);
    expect(annots[0].replies).toHaveLength(1);
    expect(annots[0].replies![0].author).toBe("Bob");
  });

  it("honours the locked and hidden flags", () => {
    const { annots } = importPageAnnots([raw({ annotationFlags: 4 | 128 | 2 })], "p1", PAGE_H, "Moi");
    expect(annots[0].locked).toBe(true);
    expect(annots[0].hidden).toBe(true);
  });

  // Regression: a PDF touched by another app often carries a crop box whose
  // lower-left is NOT (0,0). pdf.js reports annotation geometry in absolute PDF
  // space, so the flip into page space must subtract that origin — the exact
  // inverse of what export applies. Ignoring it left imported markup shifted,
  // and mirrored vertically when the offset was large ("à l'envers").
  describe("crop box whose origin is not (0,0)", () => {
    const ORIGIN = { x: 50, y: 100 }; // page.view = [50, 100, 645, 942]

    it("subtracts the origin so the box is the exact inverse of export", () => {
      // rect [150, 800, 350, 860] on a 842-high crop box offset by (50,100).
      const { annots } = importPageAnnots([raw({ rect: [150, 800, 350, 860] })], "p1", PAGE_H, "Moi", ORIGIN);
      // x_ps = 150 − 50 = 100 ; y_ps = (100 + 842) − 860 = 82
      expect(annots[0].rect).toEqual({ x: 100, y: 82, w: 200, h: 60 });
    });

    it("offsets quads and ink the same way", () => {
      const { annots } = importPageAnnots(
        [
          raw({
            subtype: "Highlight",
            quadPoints: Float32Array.from([150, 860, 350, 860, 150, 840, 350, 840]),
          }),
        ],
        "p1",
        PAGE_H,
        "Moi",
        ORIGIN,
      );
      const [tl] = annots[0].quads![0];
      expect(tl).toEqual({ x: 100, y: 82 }); // 150−50, (100+842)−860
    });

    it("is a no-op when the origin is (0,0), matching the default path", () => {
      const withOrigin = importPageAnnots([raw({})], "p1", PAGE_H, "Moi", { x: 0, y: 0 });
      const without = importPageAnnots([raw({})], "p1", PAGE_H, "Moi");
      expect(withOrigin.annots[0].rect).toEqual(without.annots[0].rect);
    });
  });

  it("skips what it cannot model, and says how many", () => {
    const { annots, skipped } = importPageAnnots(
      [raw({ subtype: "Square" }), raw({ subtype: "Movie" }), raw({ subtype: "3D" })],
      "p1",
      PAGE_H,
      "Moi",
    );
    expect(annots).toHaveLength(1);
    expect(skipped).toBe(2);
  });
});

describe("Imported markup is written back exactly once", () => {
  async function sourceWithComment(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText("Texte du contrat", { x: 60, y: 760, size: 14, font });
    const annot = doc.context.obj({
      Type: "Annot",
      Subtype: "Square",
      Rect: [100, 700, 300, 760],
      C: [0.88, 0.11, 0.28],
      F: 4,
    } as never);
    page.node.addAnnot(doc.context.register(annot));
    return doc.save();
  }

  const markupCount = (doc: PDFDocument) => {
    const arr = doc.getPage(0).node.Annots();
    if (!(arr instanceof PDFArray)) return 0;
    let n = 0;
    for (let i = 0; i < arr.size(); i++) {
      const d = arr.lookup(i);
      if (!(d instanceof PDFDict)) continue;
      const sub = d.lookup(PDFName.of("Subtype"));
      const name = sub instanceof PDFName ? sub.asString().replace(/^\//, "") : "";
      if (name === "Square") n++;
    }
    return n;
  };

  it("strips the original once the model owns it", async () => {
    const src = await sourceWithComment();
    const doc = await PDFDocument.load(src);
    expect(markupCount(doc)).toBe(1);
    expect(await stripImportedAnnots(doc.getPage(0))).toBe(1);
    expect(markupCount(doc)).toBe(0);
  });

  it("exports one copy, not two, after an import-then-edit round trip", async () => {
    const src = await sourceWithComment();
    let state = { ...emptyState(), pages: D.pagesFromSource(1), importedAnnots: true };
    state = D.addAnnot(state, {
      id: "imported-1",
      pageId: state.pages[0].id,
      kind: "square",
      rect: { x: 100, y: 82, w: 200, h: 60 },
      color: "#e11d48",
      opacity: 1,
      strokeWidth: 2,
      author: "Maître Durand",
      contents: "commentaire modifié",
      createdAt: "2026-02-14T09:30:00.000Z",
      modifiedAt: "2026-02-14T10:00:00.000Z",
      replies: [],
    });

    const { bytes } = await buildPdf(src, state, { interactiveAnnots: true });
    const out = await PDFDocument.load(bytes);
    expect(markupCount(out)).toBe(1);
  });

  it("leaves the originals alone when nothing was imported", async () => {
    const src = await sourceWithComment();
    const state = { ...emptyState(), pages: D.pagesFromSource(1) };
    const { bytes } = await buildPdf(src, state);
    expect(markupCount(await PDFDocument.load(bytes))).toBe(1);
  });
});
