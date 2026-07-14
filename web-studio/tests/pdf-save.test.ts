import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { buildEditedPdf } from "../src/pdf/pdf-save";
import type { Anno, PageRef } from "../src/pdf/model";

async function sourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 300]);
  return doc.save();
}

const anno = (over: Partial<Anno>): Anno =>
  ({ id: "a", type: "rect", x: 10, y: 10, w: 50, h: 30, color: "#ff0000", strokeWidth: 2, fontSize: 16, ...over });

describe("PDF editing — buildEditedPdf", () => {
  it("applies page order (duplicate + insert blank) and stays a valid PDF", async () => {
    const src = await sourcePdf();
    const pages: PageRef[] = [
      { id: "p1", from: 0 },
      { id: "p2", from: 0 }, // duplicate
      { id: "p3", from: null }, // blank
    ];
    const out = await buildEditedPdf(src, pages, {});
    expect(new TextDecoder().decode(out.slice(0, 5))).toBe("%PDF-");
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(3);
  });

  it("bakes text and shape annotations without throwing (and drops non-WinAnsi safely)", async () => {
    const src = await sourcePdf();
    const pages: PageRef[] = [{ id: "p1", from: 0 }];
    const annos = {
      p1: [
        anno({ id: "t", type: "text", text: "Approuvé — ✓ déjà", fontSize: 18 }),
        anno({ id: "r", type: "rect" }),
        anno({ id: "h", type: "highlight", color: "#fde047" }),
        anno({ id: "l", type: "line", w: 80, h: 0 }),
        anno({ id: "d", type: "draw", points: [{ x: 5, y: 5 }, { x: 20, y: 25 }, { x: 40, y: 10 }] }),
      ] as Anno[],
    };
    const out = await buildEditedPdf(src, pages, annos);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
    expect(out.length).toBeGreaterThan(400);
  });

  it("respects deletion (only kept pages survive)", async () => {
    const src = await sourcePdf();
    const out = await buildEditedPdf(src, [{ id: "only", from: 0 }], {});
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
  });

  it("bakes edited existing-text lines (cover + redraw) only when changed", async () => {
    const src = await sourcePdf();
    const out = await buildEditedPdf(src, [{ id: "p1", from: 0 }], {}, {
      p1: [
        { key: "L0", x: 20, y: 40, w: 200, h: 18, fontSize: 14, text: "Texte corrigé", original: "Texte original" },
        { key: "L1", x: 20, y: 80, w: 200, h: 18, fontSize: 14, text: "Inchangé", original: "Inchangé" }, // no-op
      ],
    });
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
    expect(new TextDecoder().decode(out.slice(0, 5))).toBe("%PDF-");
  });

  it("bakes user page rotation onto the output page (/Rotate)", async () => {
    const src = await sourcePdf(); // source page has no /Rotate
    const out = await buildEditedPdf(src, [
      { id: "p1", from: 0, rotate: 90 },
      { id: "p2", from: 0, rotate: 270 },
      { id: "p3", from: 0 }, // unrotated
    ], {});
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPage(0).getRotation().angle).toBe(90);
    expect(reloaded.getPage(1).getRotation().angle).toBe(270);
    expect(reloaded.getPage(2).getRotation().angle).toBe(0);
  });

  it("bakes rich text (built-in family + bold/italic/underline) into a valid PDF", async () => {
    const src = await sourcePdf();
    const annos = {
      p1: [
        anno({ id: "t1", type: "text", text: "Titre", fontSize: 24, fontFamily: "Times New Roman", bold: true, underline: true }),
        anno({ id: "t2", type: "text", text: "corps en italique", fontSize: 14, fontFamily: "Arial", italic: true, y: 60 }),
      ] as Anno[],
    };
    const out = await buildEditedPdf(src, [{ id: "p1", from: 0 }], annos);
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPageCount()).toBe(1);
    expect(out.length).toBeGreaterThan(400);
  });

  it("adds user rotation on top of the source page's own /Rotate", async () => {
    const doc = await PDFDocument.create();
    const p = doc.addPage([400, 300]);
    p.setRotation((await import("pdf-lib")).degrees(90));
    const src = await doc.save();
    const out = await buildEditedPdf(src, [{ id: "p1", from: 0, rotate: 90 }], {});
    const reloaded = await PDFDocument.load(out);
    expect(reloaded.getPage(0).getRotation().angle).toBe(180); // 90 (source) + 90 (user)
  });
});
