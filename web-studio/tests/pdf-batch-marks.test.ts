// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import {
  DEFAULT_BATCH_MARKS,
  applyMarksToFiles,
  batesRegister,
  hasAnyMark,
  type BatchMarksSpec,
} from "../src/pdf/ops/batch-marks";
import { readPageContentBytes } from "../src/pdf/ops/content";

async function pdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([600, 800]).drawText("Corps", { x: 40, y: 400, size: 12, font });
  return doc.save({ useObjectStreams: false });
}

const spec = (over: Partial<BatchMarksSpec> = {}): BatchMarksSpec => ({
  ...DEFAULT_BATCH_MARKS,
  bates: { enabled: true, prefix: "ABC-", suffix: "", start: 1, digits: 4 },
  ...over,
});

describe("marques en lot", () => {
  it("poursuit la numérotation Bates d'un fichier à l'autre et rapporte les plages", async () => {
    const inputs = [
      { name: "a.pdf", bytes: await pdf(3) },
      { name: "b.pdf", bytes: await pdf(2) },
    ];
    const outs = await applyMarksToFiles(inputs, spec({ footer: { ...DEFAULT_BATCH_MARKS.footer, enabled: true, right: "{bates}" } }));
    expect(outs.map((o) => o.error)).toEqual([undefined, undefined]);
    expect(outs[0]!.bates).toEqual({ first: "ABC-0001", last: "ABC-0003" });
    expect(outs[1]!.bates).toEqual({ first: "ABC-0004", last: "ABC-0005" });
    expect(outs[1]!.name).toBe("b-marque.pdf");
    const doc = await PDFDocument.load(outs[1]!.bytes!);
    expect(doc.getPageCount()).toBe(2);
    expect(new TextDecoder("latin1").decode(readPageContentBytes(doc.getPage(0)))).toContain("Artifact");
    const csv = batesRegister(inputs, outs);
    expect(csv).toContain("a.pdf;a-marque.pdf;3;ABC-0001;ABC-0003");
  });

  it("repart du même numéro si la continuité est désactivée, et isole les fichiers illisibles", async () => {
    const outs = await applyMarksToFiles(
      [
        { name: "a.pdf", bytes: await pdf(1) },
        { name: "casse.pdf", bytes: new Uint8Array([1, 2, 3]) },
        { name: "b.pdf", bytes: await pdf(1) },
      ],
      spec({ continueBates: false }),
    );
    expect(outs[0]!.bates!.first).toBe("ABC-0001");
    expect(outs[1]!.error).toBeTruthy();
    expect(outs[2]!.bates!.first).toBe("ABC-0001");
  });

  it("détecte l'absence de marque", () => {
    expect(hasAnyMark({ ...DEFAULT_BATCH_MARKS })).toBe(false);
    expect(hasAnyMark(spec())).toBe(true);
  });
});
