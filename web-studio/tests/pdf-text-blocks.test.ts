// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjs from "pdfjs-dist";
import { buildRuns, groupBlocks, groupLines, pageFontFacts, type TextBlock } from "../src/pdf/core/text";

pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

type Draw = { text: string; x: number; y: number; size?: number; bold?: boolean };

async function blocksOf(draws: Draw[]): Promise<TextBlock[]> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([595, 842]);
  for (const d of draws) page.drawText(d.text, { x: d.x, y: d.y, size: d.size ?? 10, font: d.bold ? bold : regular });
  const task = pdfjs.getDocument({ data: await doc.save(), isEvalSupported: false });
  const js = await task.promise;
  const p = await js.getPage(1);
  const tc = await p.getTextContent();
  const vp = p.getViewport({ scale: 1 });
  const fonts = await pageFontFacts(p as never, tc as never);
  const blocks = groupBlocks(groupLines(buildRuns(tc as never, vp.transform as number[], fonts), tc.items as never));
  await task.destroy();
  return blocks;
}

const texts = (b: TextBlock[]) => b.map((x) => x.text.replace(/\s+/g, " ").trim());

describe("text blocks for « Modifier le texte »", () => {
  it("keeps two columns apart (they used to merge line by line)", async () => {
    const lines = [760, 748, 736];
    const blocks = await blocksOf([
      ...lines.map((y, i) => ({ text: `Gauche ligne ${i + 1} du premier paragraphe`, x: 40, y })),
      ...lines.map((y, i) => ({ text: `Droite ligne ${i + 1} du second paragraphe`, x: 320, y })),
    ]);
    expect(texts(blocks)).toEqual([
      "Gauche ligne 1 du premier paragraphe Gauche ligne 2 du premier paragraphe Gauche ligne 3 du premier paragraphe",
      "Droite ligne 1 du second paragraphe Droite ligne 2 du second paragraphe Droite ligne 3 du second paragraphe",
    ]);
  });

  it("splits table cells on one row into separate columns", async () => {
    const rows = [
      ["Désignation", "Quantité", "Prix"],
      ["Chaise", "4", "45,00"],
    ];
    const draws: Draw[] = [];
    rows.forEach((r, i) => r.forEach((t, j) => draws.push({ text: t, x: 40 + j * 90, y: 760 - i * 16 })));
    const blocks = await blocksOf(draws);
    expect(texts(blocks)).toEqual(["Désignation Chaise", "Quantité 4", "Prix 45,00"]);
  });

  it("does not merge a bold heading into the paragraph under it", async () => {
    const blocks = await blocksOf([
      { text: "Conditions générales", x: 40, y: 760, bold: true },
      { text: "Le présent contrat prend effet à sa signature.", x: 40, y: 748 },
      { text: "Il est conclu pour une durée d'un an.", x: 40, y: 736 },
    ]);
    expect(texts(blocks)).toEqual([
      "Conditions générales",
      "Le présent contrat prend effet à sa signature. Il est conclu pour une durée d'un an.",
    ]);
    // The real font says bold (pdf.js' font ids never did).
    expect(blocks[0].bold).toBe(true);
    expect(blocks[1].bold).toBe(false);
  });

  it("ends a paragraph where the line spacing opens up", async () => {
    const blocks = await blocksOf([
      { text: "Premier paragraphe, ligne un", x: 40, y: 760 },
      { text: "premier paragraphe, ligne deux", x: 40, y: 748 },
      { text: "Second paragraphe après un espace", x: 40, y: 728 },
    ]);
    expect(blocks).toHaveLength(2);
  });

  it("recognises justified text (every line but the last full width)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    void doc;
    const full = "Ligne de texte justifiée qui remplit";
    const w = font.widthOfTextAtSize(full, 10);
    const spaced = (t: string) => {
      // Stretch each line to the same width with word spacing, like a justifying writer.
      const words = t.split(" ");
      const natural = font.widthOfTextAtSize(t, 10);
      return { words, extra: (w - natural) / (words.length - 1) };
    };
    const draws: Draw[] = [];
    ["Ligne de texte justifiée qui remplit", "la largeur de la colonne en entier", "fin."].forEach((t, i) => {
      if (i === 2) {
        draws.push({ text: t, x: 40, y: 760 - i * 12 });
        return;
      }
      const { words, extra } = spaced(t);
      let x = 40;
      for (const word of words) {
        draws.push({ text: word, x, y: 760 - i * 12 });
        x += font.widthOfTextAtSize(`${word} `, 10) + extra;
      }
    });
    const blocks = await blocksOf(draws);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].align).toBe("justify");
  });
});

describe("text blocks — the family a rewritten paragraph is set in", () => {
  it("follows the PDF's real font", async () => {
    const { familyOf } = await import("../src/pdf/core/text");
    expect(familyOf("ABCDEF+TimesNewRomanPS-BoldMT", "serif")).toBe("Times New Roman");
    expect(familyOf("ABCDEF+ArialMT", "sans-serif")).toBe("Arial");
    expect(familyOf("CourierNewPSMT", "monospace")).toBe("Courier New");
    expect(familyOf("ABCDEF+LiberationSans-Bold", undefined)).toBe("Arial");
    expect(familyOf(undefined, "serif")).toBe("Times New Roman");
    expect(familyOf(undefined, "sans-serif")).toBe("Arial");
  });
});
