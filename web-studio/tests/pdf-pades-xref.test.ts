import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import * as pdfjs from "pdfjs-dist";
import { diffRevisions, signPdfBytes, verifyPdfSignatures } from "../src/pdf/ops/pades";
import { readXrefTail } from "../src/pdf/ops/incremental";
import { xrefRevisionProblem } from "../src/pdf/ops/pades-xref";

pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;
const key = new Uint8Array(readFileSync(new URL("./fixtures/sig/rsa.p12", import.meta.url)));
const enc = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const concat = (...arrays: Uint8Array[]) => {
  const result = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let at = 0;
  for (const a of arrays) {
    result.set(a, at);
    at += a.length;
  }
  return result;
};

function shadowPdf() {
  let text = "%PDF-1.7\n";
  const offsets = new Map<number, number>();
  const object = (id: number, value: string) => {
    const at = text.length;
    offsets.set(id, at);
    text += `${id} 0 obj\n${value}\nendobj\n`;
    return at;
  };
  object(1, "<< /Type /Catalog /Pages 2 0 R >>");
  object(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  object(
    3,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
  );
  const stream = (amount: string) => {
    const data = `BT /F1 12 Tf 20 100 Td (Montant : ${amount} EUR) Tj ET`;
    return `<< /Length ${data.length} >>\nstream\n${data}\nendstream`;
  };
  const hidden = object(4, stream("900000"));
  object(4, stream("100"));
  object(5, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const xref = text.length;
  text += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) text += `${String(offsets.get(i)).padStart(10, "0")} 00000 n \n`;
  text += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return { bytes: enc(text), hidden, benign: stream("100"), malicious: stream("900000") };
}

function redirect(signed: Uint8Array, offset: number, kind: "table" | "stream" | "hybrid") {
  const tail = readXrefTail(signed)!;
  const at = signed.length + 1;
  const common = `/Size ${tail.size + 1} /Root 1 0 R /Prev ${tail.startxref}`;
  if (kind === "table")
    return concat(
      signed,
      enc(
        `\nxref\n4 1\n${String(offset).padStart(10, "0")} 00000 n \ntrailer\n<< ${common} >>\nstartxref\n${at}\n%%EOF\n`,
      ),
    );
  const row = new Uint8Array(7);
  row[0] = 1;
  new DataView(row.buffer).setUint32(1, offset);
  const body = concat(
    enc(`\n${tail.size} 0 obj\n<< /Type /XRef /W [1 4 2] /Index [4 1] /Length 7 ${common} >>\nstream\n`),
    row,
    enc("\nendstream\nendobj\n"),
  );
  if (kind === "stream") return concat(signed, body, enc(`startxref\n${at}\n%%EOF\n`));
  const tableAt = signed.length + body.length;
  return concat(
    signed,
    body,
    enc(`xref\n0 1\n0000000000 65535 f \ntrailer\n<< ${common} /XRefStm ${at} >>\nstartxref\n${tableAt}\n%%EOF\n`),
  );
}

async function visibleText(bytes: Uint8Array) {
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  try {
    const doc = await task.promise;
    const text = await (await doc.getPage(1)).getTextContent();
    return text.items.map((item) => ("str" in item ? item.str : "")).join(" ");
  } finally {
    await task.destroy();
  }
}

describe("PAdES xref shadow attacks", () => {
  it.each(["table", "stream", "hybrid"] as const)(
    "rejects an xref-only redirect (%s) despite identical pdf-lib views",
    async (kind) => {
      const prepared = shadowPdf();
      const signed = await signPdfBytes(prepared.bytes, key, "pw", { certify: 1 });
      const changed = redirect(signed, prepared.hidden, kind);
      expect(await visibleText(signed)).toContain("100 EUR");
      expect(await visibleText(changed)).toContain("900000 EUR");
      const before = await PDFDocument.load(signed, { updateMetadata: false });
      const after = await PDFDocument.load(changed, { updateMetadata: false });
      expect(diffRevisions(before, after)).toEqual([]);
      const [v] = await verifyPdfSignatures(changed);
      expect(v!.intact).toBe(true);
      expect(v!.modifications).toBe("disallowed");
      expect(v!.valid).toBe(false);
      expect(v!.changes.some((c) => /xref/.test(c.label))).toBe(true);
    },
  );

  it("fails closed when the new xref chain skips the signed revision or points nowhere", async () => {
    const { bytes } = shadowPdf();
    const signed = await signPdfBytes(bytes, key, "pw");
    const malformed = concat(signed, enc("\nstartxref\n1\n%%EOF\n"));
    expect(xrefRevisionProblem(malformed, signed.length)).toBeTruthy();
    const skipped = concat(
      signed,
      enc(
        `\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Root 1 0 R /Size 20 /Prev ${readXrefTail(bytes)!.startxref} >>\nstartxref\n${signed.length + 1}\n%%EOF\n`,
      ),
    );
    expect(xrefRevisionProblem(skipped, signed.length)).toContain("remplacée");
  });

  it("rejects conflicting definitions added after signing, even when the chosen offset is new", async () => {
    const prepared = shadowPdf();
    const signed = await signPdfBytes(prepared.bytes, key, "pw");
    const conflicting = concat(
      signed,
      enc(`\n4 0 obj\n${prepared.malicious}\nendobj\n4 0 obj\n${prepared.benign}\nendobj\n`),
    );
    const changed = redirect(conflicting, signed.length + 1, "table");
    expect(await visibleText(changed)).toContain("900000 EUR");
    expect(
      diffRevisions(
        await PDFDocument.load(signed, { updateMetadata: false }),
        await PDFDocument.load(changed, { updateMetadata: false }),
      ),
    ).toEqual([]);
    const [v] = await verifyPdfSignatures(changed);
    expect(v!.valid).toBe(false);
    expect(v!.modifications).toBe("disallowed");
  });
});
