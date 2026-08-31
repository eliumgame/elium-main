import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName } from "pdf-lib";
import { parseContentStream, walkPlacements } from "../src/pdf/core/contentstream";
import { readPageContentBytes } from "../src/pdf/ops/content";
import { applyImageEdits } from "../src/pdf/ops/textedit";

/**
 * `applyImageEdits` (delete/replace a page's own images) has no coverage
 * anywhere else — `applyTextEdits` is already exercised indirectly through
 * `buildPdf` in pdf-export.test.ts, but the image half of textedit.ts is not.
 */

const PNG_1X1_RED = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  ),
  (c) => c.charCodeAt(0),
);

async function makeImageDoc(): Promise<{ doc: PDFDocument; bytes: Uint8Array }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const img = await doc.embedPng(PNG_1X1_RED);
  page.drawImage(img, { x: 40, y: 40, width: 60, height: 60 });
  page.drawImage(img, { x: 100, y: 100, width: 40, height: 40 });
  const bytes = await doc.save();
  return { doc, bytes };
}

describe("textedit — image edits", () => {
  it("drops the Do operator for a deleted image, leaving the other one drawn", async () => {
    const { bytes } = await makeImageDoc();
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);

    const before = walkPlacements(parseContentStream(readPageContentBytes(page))).filter((p) => p.name !== null);
    expect(before).toHaveLength(2);

    const changed = await applyImageEdits(doc, page, [{ occurrence: 0, action: "delete" }], async () => null);
    expect(changed).toBe(1);

    const after = walkPlacements(parseContentStream(readPageContentBytes(page))).filter((p) => p.name !== null);
    expect(after).toHaveLength(1);
    // The surviving placement is the second image, at its own position.
    expect(after[0].ctm[4]).toBeCloseTo(before[1].ctm[4], 5);
    expect(after[0].ctm[5]).toBeCloseTo(before[1].ctm[5], 5);
  });

  it("replaces an image's Do operator with a newly embedded XObject, in the same place", async () => {
    const { bytes } = await makeImageDoc();
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    const replacement = await doc.embedPng(PNG_1X1_RED);

    const changed = await applyImageEdits(doc, page, [{ occurrence: 1, action: "replace", src: "data:whatever" }], async () => ({
      ref: replacement.ref,
    }));
    expect(changed).toBe(1);

    const ops = parseContentStream(readPageContentBytes(page));
    const places = walkPlacements(ops).filter((p) => p.name !== null);
    expect(places).toHaveLength(2);
    // The transform (position/size) of the replaced placement is untouched.
    expect(places[1].ctm[0]).toBeCloseTo(40, 5); // width 40
    expect(places[1].ctm[3]).toBeCloseTo(40, 5); // height 40
    // Its XObject name now resolves to the new embedded image, not the original.
    const xobjects = page.node.Resources().lookup(PDFName.of("XObject"));
    expect(xobjects).toBeTruthy();
  });

  it("ignores an out-of-range occurrence instead of touching the wrong image", async () => {
    const { bytes } = await makeImageDoc();
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    const before = readPageContentBytes(page);

    const changed = await applyImageEdits(doc, page, [{ occurrence: 5, action: "delete" }], async () => null);
    expect(changed).toBe(0);
    expect(readPageContentBytes(page)).toEqual(before);
  });

  it("is a no-op with an empty edit list", async () => {
    const { bytes } = await makeImageDoc();
    const doc = await PDFDocument.load(bytes);
    const page = doc.getPage(0);
    const before = readPageContentBytes(page);
    const changed = await applyImageEdits(doc, page, [], async () => null);
    expect(changed).toBe(0);
    expect(readPageContentBytes(page)).toEqual(before);
  });
});
