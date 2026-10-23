import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { assertDocxWithinLimits, MAX_DOCX_BYTES } from "../src/detector/ingest/loadFile";
import { splitSentences } from "../src/detector/textSignals";
import { extractPdfImages } from "../src/detector/ingest/pdfImages";
import { PDFDocument } from "pdf-lib";

describe("splitSentences : temps linéaire", () => {
  it("découpe comme avant", () => {
    expect(splitSentences("Bonjour le monde. Il fait beau ! J. K. Rowling écrit. Fin")).toEqual([
      "Bonjour le monde.",
      "Il fait beau !",
      "J. K. Rowling écrit.",
      "Fin",
    ]);
    expect(splitSentences("Le prix est 3.5 euros. M. Dupont arrive.")).toEqual([
      "Le prix est 3.5 euros.",
      "M. Dupont arrive.",
    ]);
  });
  it("un paragraphe de 100 000 initiales (sans frontière) se traite en un temps raisonnable", () => {
    const text = "J. ".repeat(100_000) + "fin.";
    const t0 = performance.now();
    const out = splitSentences(text);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect(out).toHaveLength(1);
  });
});

describe("plafonds du .docx", () => {
  it("accepte un petit .docx", () => {
    const zip = zipSync({ "word/document.xml": strToU8("<w:document/>") });
    expect(() => assertDocxWithinLimits(zip)).not.toThrow();
  });
  it("refuse un fichier au-dessus du plafond de taille, message clair", () => {
    expect(() => assertDocxWithinLimits(new Uint8Array(MAX_DOCX_BYTES + 1))).toThrow(/trop volumineux/);
  });
  it("refuse une bombe de décompression sans la décompresser", () => {
    const zip = zipSync({ "word/document.xml": new Uint8Array(8 * 1024 * 1024) }, { level: 1 });
    expect(zip.length).toBeLessThan(MAX_DOCX_BYTES);
    expect(() => assertDocxWithinLimits(zip, 4 * 1024 * 1024)).toThrow(/décompressé/);
  });
});

describe("extractPdfImages (cœur du Worker)", () => {
  it("renvoie une liste vide pour un PDF sans image", async () => {
    const d = await PDFDocument.create();
    d.addPage();
    const out = await extractPdfImages(await d.save(), 1);
    expect(out).toEqual({ images: [], skippedNonJpeg: 0 });
  });
});

describe("plafonds de la conversion en PDF", () => {
  it("refuse une feuille de 50 000 lignes avec un message clair, accepte une feuille normale", async () => {
    const { assertSheetPrintable } = await import("../src/pdf/ops/create-from-file");
    const small = { name: "A", cols: 3, rows: 3, cells: { A1: "x", C3: "y" } };
    expect(() => assertSheetPrintable(small as never)).not.toThrow();
    const big = { name: "Gros", cols: 5, rows: 60000, cells: { A1: "x", E50000: "y" } };
    expect(() => assertSheetPrintable(big as never)).toThrow(/trop grande.*Gros|Gros.*trop grande/);
  });
});
