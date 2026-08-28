/**
 * `pdf/core/engine.ts` imports the full browser build of `pdfjs-dist`, whose
 * canvas backend does `const SCALE_MATRIX = new DOMMatrix();` at MODULE TOP
 * LEVEL — so merely importing `PdfEngine` throws under Node/jsdom (neither
 * defines `DOMMatrix`), even though text extraction never touches canvas
 * rendering. A minimal stub is enough: nothing in the text-extraction path
 * (`PdfEngine.open`/`.page`/`.text`) ever calls a method on it.
 *
 * Side-effect only: must be the FIRST import of any test file that reaches
 * `PdfEngine` (directly or via `detector/ingest/fromPdf.ts`), so this runs
 * before pdfjs-dist's module graph does.
 */
if (typeof (globalThis as { DOMMatrix?: unknown }).DOMMatrix === "undefined") {
  (globalThis as { DOMMatrix?: unknown }).DOMMatrix = class DOMMatrixStub {
    constructor(_init?: unknown) {
      void _init;
    }
  };
}

/**
 * Opening an AES-256/R6-encrypted PDF (what `pdf/ops/security.ts`'s
 * `protectDocument` produces) runs the ISO 32000-2 Annex A "hardened hash"
 * key derivation inside the pdf.js worker, which sums 16 bytes via
 * `Math.sumPrecise` — a very recent JS built-in this Node runtime doesn't
 * implement yet. A naive-sum polyfill is exact here regardless (small
 * integer byte values never hit the floating-point precision pdfjs-dist's
 * "precise" variant exists to protect against).
 */
type MathWithSumPrecise = typeof Math & { sumPrecise?: (values: readonly number[]) => number };
const mathWithSumPrecise = Math as MathWithSumPrecise;
if (typeof mathWithSumPrecise.sumPrecise !== "function") {
  mathWithSumPrecise.sumPrecise = (values) => values.reduce((sum, v) => sum + v, 0);
}
