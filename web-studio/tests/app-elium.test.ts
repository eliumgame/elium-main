import { describe, it, expect } from "vitest";
import { createEliumFile } from "../src/format/document";
import { readEliumPackage, writeEliumPackage } from "../src/format/elium-package";
import type { ProseMirrorNode } from "../src/format/types";

/**
 * Spreadsheet/presentation apps are stored inside a normal .elium via a marker
 * node (eliumSheet / eliumSlides) whose `data` attribute carries the serialized
 * workbook/deck. This verifies the payload survives the encrypt/sign/seal
 * write→read pipeline unchanged — i.e. app files get the same protection as
 * documents, with no format change.
 */
describe("app .elium round-trip (marker nodes)", () => {
  it("round-trips a spreadsheet payload", async () => {
    const workbook = {
      sheets: [{ name: "F1", rows: 5, cols: 5, cells: { A1: "1", A2: "2", A3: "=SUM(A1:A2)" } }],
      active: 0,
    };
    const doc: ProseMirrorNode = {
      type: "doc",
      content: [{ type: "eliumSheet", attrs: { data: JSON.stringify(workbook) } }],
    };
    const file = await createEliumFile({ title: "Classeur test", profile: "standard", doc });
    const bytes = await writeEliumPackage(file);

    const { file: read, integrity } = await readEliumPackage(bytes);
    expect(integrity.contentIntact).toBe(true);
    const first = read.document.doc.content?.[0];
    expect(first?.type).toBe("eliumSheet");
    const parsed = JSON.parse(String(first?.attrs?.data));
    expect(parsed.sheets[0].cells.A3).toBe("=SUM(A1:A2)");
  });

  it("round-trips a presentation payload", async () => {
    const deck = { slides: [{ id: "s1", title: "Titre", body: "a\nb", layout: "title-content" }], active: 0 };
    const doc: ProseMirrorNode = {
      type: "doc",
      content: [{ type: "eliumSlides", attrs: { data: JSON.stringify(deck) } }],
    };
    const file = await createEliumFile({ title: "Deck test", profile: "standard", doc });
    const bytes = await writeEliumPackage(file);

    const { file: read } = await readEliumPackage(bytes);
    const first = read.document.doc.content?.[0];
    expect(first?.type).toBe("eliumSlides");
    const parsed = JSON.parse(String(first?.attrs?.data));
    expect(parsed.slides[0].title).toBe("Titre");
  });
});
