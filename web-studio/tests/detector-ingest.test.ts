// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { documentModelFromProseMirrorDoc } from "../src/detector/ingest/fromProseMirror";
import { documentModelFromPdf, withTimeout, IMAGE_EXTRACTION_TIMEOUT_MS } from "../src/detector/ingest/fromPdf";
import { PdfPasswordRequired } from "../src/pdf/core/engine";
import { protectDocument } from "../src/pdf/ops/security";
import type { ProseMirrorNode } from "../src/format/types";

// `pdf/core/engine.ts` points pdfjs-dist's worker at a Vite `?url` asset path,
// which only resolves inside a running Vite dev/build. Under plain vitest it
// becomes an unresolvable path and pdf.js's Node "fake worker" fallback fails
// to `import()` it — so point it at the real file on disk. This mutates the
// same shared `GlobalWorkerOptions` singleton `PdfEngine` reads, and runs
// after `fromPdf`'s own import (above) already set the broken value.
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

// ---------------------------------------------------------------------------
// ProseMirror fixtures
// ---------------------------------------------------------------------------

function text(t: string, marks?: ProseMirrorNode["marks"]): ProseMirrorNode {
  return marks ? { type: "text", text: t, marks } : { type: "text", text: t };
}
function paragraph(content: ProseMirrorNode[]): ProseMirrorNode {
  return { type: "paragraph", content };
}
function heading(level: number | undefined, content: ProseMirrorNode[]): ProseMirrorNode {
  return { type: "heading", ...(level != null ? { attrs: { level } } : {}), content };
}
function doc(content: ProseMirrorNode[]): ProseMirrorNode {
  return { type: "doc", content };
}

function b64(s: string): string {
  return Buffer.from(s, "utf8").toString("base64");
}
const PNG_DATA_URL = `data:image/png;base64,${b64("not-real-png-bytes-but-decodable")}`;

// A tiny but genuine baseline JPEG (16×12, red/blue halves) produced by a real
// encoder — the same fixture tests/pdf-stamp-appearance.test.ts uses — so the
// DCTDecode passthrough path (fromPdf.ts) is exercised against a file an
// actual tool could produce, not hand-crafted bytes.
const RED_BLUE_JPEG_B64 =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAMABADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAABgf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAB//EABkRAAIDAQAAAAAAAAAAAAAAAAAHRIPCw//aAAwDAQACEQMRAD8AhQiXCJRV02vYmOOBbzP/2Q==";
const JPEG_DATA_URL = `data:image/jpeg;base64,${RED_BLUE_JPEG_B64}`;
function jpegBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(RED_BLUE_JPEG_B64, "base64"));
}

/**
 * One document mixing a "human-like" bursty paragraph (irregular inline
 * emphasis: an italic word here, a bold word there, a hardBreak, a
 * one-off colour on the closing sentence) against an "AI-like" paragraph
 * carrying one blanket, perfectly uniform style and no inline emphasis at
 * all — the contrast a downstream style-consistency signal actually looks
 * for. Also covers headings, plain/nested list items, a blockquote, and
 * both image node shapes (`image` and `figure`).
 */
function fixtureDoc(): ProseMirrorNode {
  return doc([
    {
      type: "figure",
      attrs: { src: JPEG_DATA_URL, alt: "", align: "center", width: "60%" },
      content: [text("Légende photo")],
    },
    heading(1, [text("Rapport trimestriel")]),
    paragraph([
      text("Bon, "),
      text("franchement", [{ type: "italic" }]),
      text(", ce trimestre a été "),
      text("chaotique", [{ type: "bold" }]),
      text(" — ventes en berne en janvier, sursaut inattendu en mars."),
      { type: "hardBreak" },
      text("Bref, on verra bien.", [{ type: "textStyle", attrs: { color: "#b91c1c" } }]),
    ]),
    { type: "image", attrs: { src: PNG_DATA_URL, width: 200, height: 100 } },
    paragraph([
      text(
        "Par ailleurs, il convient de souligner que la présente section vise à fournir une vue d'ensemble structurée et exhaustive des éléments pertinents.",
        [{ type: "textStyle", attrs: { fontFamily: "Arial, sans-serif", fontSize: "16px" } }],
      ),
    ]),
    {
      type: "bulletList",
      content: [
        { type: "listItem", content: [paragraph([text("Premier point clé de l'analyse.")])] },
        { type: "listItem", content: [paragraph([text("Second point, plus détaillé et nuancé.")])] },
      ],
    },
    { type: "blockquote", content: [paragraph([text("Citation neutre, hors liste.")])] },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            paragraph([text("Point parent.")]),
            { type: "bulletList", content: [{ type: "listItem", content: [paragraph([text("Sous-point enfant.")])] }] },
          ],
        },
      ],
    },
  ]);
}

describe("documentModelFromProseMirrorDoc — structure", () => {
  it("walks paragraphs/headings/lists/blockquote in document order with the right flags", () => {
    const { paragraphs, images } = documentModelFromProseMirrorDoc(fixtureDoc(), "elium");

    expect(paragraphs.map((p) => p.index)).toEqual(paragraphs.map((_, i) => i));
    expect(paragraphs).toHaveLength(8);
    expect(images).toHaveLength(2);

    expect(paragraphs[0]).toMatchObject({ text: "Rapport trimestriel", heading: 1 });
    expect(paragraphs[0].listItem).toBeUndefined();

    expect(paragraphs[3].text).toBe("Premier point clé de l'analyse.");
    expect(paragraphs[3].listItem).toBe(true);
    expect(paragraphs[4].text).toBe("Second point, plus détaillé et nuancé.");
    expect(paragraphs[4].listItem).toBe(true);

    // A blockquote is not a list: its paragraph must not inherit listItem.
    expect(paragraphs[5].text).toBe("Citation neutre, hors liste.");
    expect(paragraphs[5].listItem).toBeUndefined();

    // listItem propagates through a nested list too.
    expect(paragraphs[6].text).toBe("Point parent.");
    expect(paragraphs[6].listItem).toBe(true);
    expect(paragraphs[7].text).toBe("Sous-point enfant.");
    expect(paragraphs[7].listItem).toBe(true);
  });

  it("is indifferent to sourceFormat: elium and docx trees of the same shape parse identically", () => {
    const fromElium = documentModelFromProseMirrorDoc(fixtureDoc(), "elium");
    const fromDocx = documentModelFromProseMirrorDoc(fixtureDoc(), "docx");
    expect(fromDocx).toEqual(fromElium);
  });

  it("defaults a heading's level to 1 when attrs.level is missing", () => {
    const { paragraphs } = documentModelFromProseMirrorDoc(doc([heading(undefined, [text("Sans attrs")])]), "elium");
    expect(paragraphs[0].heading).toBe(1);
  });
});

describe("documentModelFromProseMirrorDoc — run formatting", () => {
  it("captures a hardBreak as its own newline run", () => {
    const { paragraphs } = documentModelFromProseMirrorDoc(fixtureDoc(), "elium");
    const human = paragraphs[1];
    expect(human.text).toBe(
      "Bon, franchement, ce trimestre a été chaotique — ventes en berne en janvier, sursaut inattendu en mars.\nBref, on verra bien.",
    );
    const breakRun = human.runs.find((r) => r.text === "\n");
    expect(breakRun).toBeDefined();
  });

  it("marks bold/italic/textStyle-color per run without leaking them onto neighbours", () => {
    const { paragraphs } = documentModelFromProseMirrorDoc(fixtureDoc(), "elium");
    const human = paragraphs[1];
    const plainRun = human.runs.find((r) => r.text === "Bon, ");
    expect(plainRun?.bold).toBeFalsy();
    expect(plainRun?.italic).toBeFalsy();
    expect(human.runs.find((r) => r.text === "franchement")?.italic).toBe(true);
    expect(human.runs.find((r) => r.text === "chaotique")?.bold).toBe(true);
    expect(human.runs.find((r) => r.text === "Bref, on verra bien.")?.color).toBe("#b91c1c");
  });

  it("converts textStyle fontSize from CSS px to pt (×0.75) and trims the fontFamily fallback list", () => {
    const { paragraphs } = documentModelFromProseMirrorDoc(fixtureDoc(), "elium");
    const ai = paragraphs[2];
    expect(ai.runs).toHaveLength(1);
    expect(ai.runs[0].fontFamily).toBe("Arial");
    expect(ai.runs[0].fontSize).toBe(12); // 16px × 0.75
  });

  it("discriminates the bursty human paragraph from the uniformly-styled AI-like one by inline emphasis variety", () => {
    const { paragraphs } = documentModelFromProseMirrorDoc(fixtureDoc(), "elium");
    const human = paragraphs[1];
    const ai = paragraphs[2];
    const emphasisRuns = (runs: typeof human.runs) => runs.filter((r) => r.bold || r.italic || r.color).length;
    expect(emphasisRuns(human.runs)).toBeGreaterThan(0);
    expect(emphasisRuns(ai.runs)).toBe(0);
    expect(human.runs.length).toBeGreaterThan(ai.runs.length);
  });
});

describe("documentModelFromProseMirrorDoc — images", () => {
  it("decodes a figure's data: URL, ignores its non-numeric CSS width, and drops its caption text", () => {
    const { paragraphs, images } = documentModelFromProseMirrorDoc(fixtureDoc(), "elium");
    const figureImage = images[0];
    expect(figureImage.mime).toBe("image/jpeg");
    expect(figureImage.bytes).toEqual(jpegBytes());
    expect(figureImage.width).toBeUndefined(); // attrs.width was "60%", not numeric
    expect(figureImage.paragraphIndex).toBeUndefined(); // no paragraph precedes it
    expect(paragraphs.some((p) => p.text.includes("Légende photo"))).toBe(false);
  });

  it("decodes an image node, keeps numeric width/height, and attributes it to the nearest preceding paragraph", () => {
    const { images } = documentModelFromProseMirrorDoc(fixtureDoc(), "elium");
    const inlineImage = images[1];
    expect(inlineImage.mime).toBe("image/png");
    expect(inlineImage.width).toBe(200);
    expect(inlineImage.height).toBe(100);
    expect(inlineImage.paragraphIndex).toBe(1); // the "Bon, franchement…" paragraph
  });

  it("produces no image for a non-data-url src, and skips corrupt base64 without throwing", () => {
    const { images } = documentModelFromProseMirrorDoc(
      doc([
        { type: "image", attrs: { src: "https://example.com/pic.png" } },
        { type: "image", attrs: { src: "data:image/png;base64,%%%not-base64%%%" } },
      ]),
      "elium",
    );
    expect(images).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PDF fixtures
// ---------------------------------------------------------------------------

async function makeTextPdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Rapport trimestriel");
  pdf.setAuthor("Alice Dupont");
  pdf.setCreator("Elium Web Studio");
  pdf.setProducer("Elium PDF Engine");
  pdf.setCreationDate(new Date(Date.UTC(2024, 5, 15, 12, 0, 0)));
  pdf.setModificationDate(new Date(Date.UTC(2024, 5, 20, 9, 0, 0)));

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const page0 = pdf.addPage([595, 842]);
  page0.drawText("Synthese annuelle", { x: 60, y: 780, size: 24, font: bold, color: rgb(0, 0, 0) });
  page0.drawText("Ce document resume les resultats du dernier exercice fiscal.", {
    x: 60,
    y: 740,
    size: 11,
    font: regular,
    color: rgb(0, 0, 0),
  });

  const page1 = pdf.addPage([595, 842]);
  page1.drawText("Les ventes ont progresse de douze pour cent sur la periode.", {
    x: 60,
    y: 780,
    size: 11,
    font: regular,
    color: rgb(0, 0, 0),
  });

  return pdf.save();
}

describe("documentModelFromPdf — text", () => {
  it("extracts page text into ordered paragraphs tagged with pageIndex", async () => {
    const bytes = await makeTextPdf();
    const { paragraphs } = await documentModelFromPdf(bytes);

    expect(paragraphs.length).toBeGreaterThan(0);
    expect(paragraphs.map((p) => p.index)).toEqual(paragraphs.map((_, i) => i));
    expect(paragraphs.some((p) => p.pageIndex === 0 && p.text.includes("Synthese annuelle"))).toBe(true);
    expect(paragraphs.some((p) => p.pageIndex === 1 && p.text.includes("progresse de douze"))).toBe(true);
  });

  it("discriminates a large-size heading line from regular smaller body text by fontSize", async () => {
    // Bold is intentionally not asserted here: pdf.js derives TextRun.bold from
    // its own INTERNAL font resource id (e.g. "g_d0_f1"), not the font's real
    // PostScript name — for pdf-lib's non-embedded StandardFonts that id never
    // contains "bold" regardless of which standard font was actually used, so
    // there is no realistic fixture that exercises that branch honestly. Font
    // size, by contrast, is measured straight from the text matrix and is a
    // fully reliable signal — exactly what a heading/body split looks like.
    const bytes = await makeTextPdf();
    const { paragraphs } = await documentModelFromPdf(bytes);
    const headingBlock = paragraphs.find((p) => p.text.includes("Synthese annuelle"));
    const bodyBlock = paragraphs.find((p) => p.text.includes("Ce document resume"));
    expect(headingBlock).toBeDefined();
    expect(bodyBlock).toBeDefined();

    expect(headingBlock!.runs[0].fontSize).toBeCloseTo(24, 0);
    expect(bodyBlock!.runs[0].fontSize).toBeCloseTo(11, 0);
    expect(headingBlock!.runs[0].fontSize!).toBeGreaterThan(bodyBlock!.runs[0].fontSize!);
  });

  it("maps engine.info into metadata (creator/producer/title/author/dates/pageCount)", async () => {
    const bytes = await makeTextPdf();
    const { metadata } = await documentModelFromPdf(bytes);

    expect(metadata.sourceFormat).toBe("pdf");
    expect(metadata.pageCount).toBe(2);
    expect(metadata.title).toBe("Rapport trimestriel");
    expect(metadata.author).toBe("Alice Dupont");
    expect(metadata.creator).toBe("Elium Web Studio");
    expect(metadata.producer).toBe("Elium PDF Engine");
    expect(metadata.createdAt).toBeDefined();
    expect(new Date(metadata.createdAt!).getUTCFullYear()).toBe(2024);
    expect(metadata.modifiedAt).toBeDefined();
    expect(new Date(metadata.modifiedAt!).getUTCFullYear()).toBe(2024);
  });
});

describe("documentModelFromPdf — images", () => {
  it("returns no images for a picture-free PDF", async () => {
    const bytes = await makeTextPdf();
    const { images } = await documentModelFromPdf(bytes);
    expect(images).toEqual([]);
  });

  it("extracts a JPEG XObject's raw DCTDecode bytes byte-for-byte, with intrinsic width/height and pageIndex", async () => {
    const pdf = await PDFDocument.create();
    const jpeg = await pdf.embedJpg(jpegBytes());
    pdf.addPage([200, 200]).drawImage(jpeg, { x: 20, y: 20, width: 80, height: 60 }); // display size ≠ intrinsic size
    const bytes = await pdf.save();

    const { images } = await documentModelFromPdf(bytes);
    expect(images).toHaveLength(1);
    expect(images[0].mime).toBe("image/jpeg");
    expect(images[0].pageIndex).toBe(0);
    expect(images[0].width).toBe(16);
    expect(images[0].height).toBe(12);
    expect(images[0].bytes).toEqual(jpegBytes());
  });

  // Constat détecteur : une image PNG collée dans un PDF n'est jamais extraite
  // (seul le flux JPEG/DCTDecode l'est) et ne passe donc jamais par la
  // vérification C2PA — `skippedNonJpegImages` existe pour que le panneau
  // Images puisse avertir de ce cas plutôt que de rester silencieux.
  it("compte les images non-JPEG (PNG) ignorées dans metadata.skippedNonJpegImages", async () => {
    const tinyPngBytes = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const pdf = await PDFDocument.create();
    const jpeg = await pdf.embedJpg(jpegBytes());
    const png = await pdf.embedPng(tinyPngBytes);
    const page = pdf.addPage([200, 200]);
    page.drawImage(jpeg, { x: 0, y: 0, width: 80, height: 60 });
    page.drawImage(png, { x: 0, y: 100, width: 10, height: 10 });
    const bytes = await pdf.save();

    const { images, metadata } = await documentModelFromPdf(bytes);
    // Seul le JPEG est extrait ; le PNG est compté comme ignoré, pas silencieusement perdu.
    expect(images).toHaveLength(1);
    expect(images[0].mime).toBe("image/jpeg");
    expect(metadata.skippedNonJpegImages).toBe(1);
  });

  it("ne renseigne pas skippedNonJpegImages quand toutes les images sont du JPEG", async () => {
    const pdf = await PDFDocument.create();
    const jpeg = await pdf.embedJpg(jpegBytes());
    pdf.addPage([200, 200]).drawImage(jpeg, { x: 0, y: 0, width: 80, height: 60 });
    const bytes = await pdf.save();

    const { metadata } = await documentModelFromPdf(bytes);
    expect(metadata.skippedNonJpegImages).toBeUndefined();
  });
});

// L'extraction d'images (pdf-lib) s'est mesurée à largement plus de 30s sur un
// document réel volumineux en conditions dégradées, alors que l'extraction de
// texte (pdf.js) du même fichier prenait moins d'une seconde — sans qu'aucune
// page ne soit individuellement en cause (voir fromPdf.ts). withTimeout borne
// cette attente pour que l'analyse ne reste jamais bloquée indéfiniment.
describe("withTimeout — borne l'extraction d'images pour ne jamais bloquer l'analyse", () => {
  it("résout avec la valeur de la promesse quand elle se règle avant l'échéance", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000)).resolves.toBe("ok");
  });

  it("propage un vrai rejet de la promesse enveloppée avant l'échéance", async () => {
    await expect(withTimeout(Promise.reject(new Error("boom")), 1000)).rejects.toThrow("boom");
  });

  it("rejette une fois l'échéance atteinte, même si la promesse enveloppée ne se règle jamais", async () => {
    vi.useFakeTimers();
    try {
      const neverResolves = new Promise(() => {});
      const result = withTimeout(neverResolves, 5000);
      const assertion = expect(result).rejects.toThrow(/Délai dépassé/);
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("IMAGE_EXTRACTION_TIMEOUT_MS est un budget raisonnable et borné", () => {
    expect(IMAGE_EXTRACTION_TIMEOUT_MS).toBeGreaterThan(1000);
    expect(IMAGE_EXTRACTION_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});

describe("documentModelFromPdf — password-protected files", () => {
  async function makeProtectedPdf(): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    pdf.addPage([200, 200]).drawText("Contenu confidentiel", { x: 20, y: 150, size: 12, font, color: rgb(0, 0, 0) });
    return protectDocument(pdf, { userPassword: "s3cret" });
  }

  it("propagates PdfPasswordRequired uncaught when no password is given", async () => {
    const encrypted = await makeProtectedPdf();
    await expect(documentModelFromPdf(encrypted)).rejects.toBeInstanceOf(PdfPasswordRequired);
  });

  it("extracts text with the right password, and never throws even though pdf-lib can't walk encrypted image streams", async () => {
    const encrypted = await makeProtectedPdf();
    const result = await documentModelFromPdf(encrypted, "s3cret");
    expect(result.paragraphs.some((p) => p.text.includes("Contenu confidentiel"))).toBe(true);
    expect(Array.isArray(result.images)).toBe(true);
  });
});
