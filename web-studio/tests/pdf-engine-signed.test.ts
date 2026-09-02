// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { PdfEngine } from "../src/pdf/core/engine";
import { createFields } from "../src/pdf/ops/forms";
import { signPdfBytes } from "../src/pdf/ops/pades";
import { generateSelfSignedP12 } from "../src/pdf/ops/self-cert";

// See tests/detector-ingest.test.ts for why this is needed under plain vitest
// (no running Vite dev/build to resolve `PdfEngine`'s `?url` worker import).
pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

async function plainPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([300, 200]);
  return doc.save();
}

/** A PDF whose only form field is a bare, never-signed `/FT /Sig` widget —
 * exactly what "Prepare form" (ops/forms.ts::addSignatureField) leaves behind
 * before anyone actually signs. */
async function pdfWithPreparedSignatureField(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([300, 200]);
  createFields(
    { doc, font },
    [{ id: "s1", pageId: "p1", name: "signature_1", kind: "signature", rect: { x: 40, y: 40, w: 150, h: 40 } }],
    () => ({ page, height: 200 }),
  );
  return doc.save();
}

describe("PdfEngine.info.signed", () => {
  it("is false for a plain PDF with no form fields at all", async () => {
    const engine = await PdfEngine.open(await plainPdf());
    expect(engine.info.signed).toBe(false);
    expect(engine.info.hasAcroForm).toBe(false);
    engine.destroy();
  });

  it("is NOT set by a merely PREPARED (never signed) signature field", async () => {
    // Regression: before requiring a real signature dictionary (/ByteRange),
    // this reported `signed: true` purely because a /FT /Sig widget existed —
    // even though it has never been signed (no /V at all). That false
    // positive drove the app's "already signed, sign again anyway?"
    // (confirmResign) warning for a document nobody ever signed.
    const bytes = await pdfWithPreparedSignatureField();
    const engine = await PdfEngine.open(bytes);
    expect(engine.info.hasAcroForm).toBe(true);
    expect(engine.info.signed).toBe(false);
    engine.destroy();
  }, 30000);

  it("is true once the field is actually signed (PAdES, real /V + /ByteRange)", async () => {
    const bytes = await pdfWithPreparedSignatureField();
    const p12 = generateSelfSignedP12("Alice", "pw");
    const signed = await signPdfBytes(bytes, p12, "pw", { fieldName: "signature_1" });

    const engine = await PdfEngine.open(signed);
    expect(engine.info.signed).toBe(true);
    engine.destroy();
  }, 30000);
});
