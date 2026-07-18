/**
 * PDF merge & split (pdf-lib copyPages). Merging concatenates whole documents in
 * order — crucially keeping the first document's pages at indices 0..N-1, so the
 * editor can extend its existing page order against the combined source without
 * remapping. Splitting extracts a set of 0-based page indices into a fresh PDF.
 */
import { PDFDocument } from "pdf-lib";

/**
 * Parse a page-range spec ("1-3, 5, 8-10") against a 1-based page count into
 * ordered, 0-based indices. Tokens out of range or malformed are skipped;
 * descending ranges ("3-1") expand descending. Duplicates are preserved (a user
 * may intentionally repeat a page).
 */
export function parsePageRange(spec: string, total: number): number[] {
  const out: number[] = [];
  if (total <= 0) return out;
  for (const raw of spec.split(",")) {
    const tok = raw.trim();
    if (!tok) continue;
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(tok);
    if (m) {
      let a = Number(m[1]), b = Number(m[2]);
      a = Math.max(1, Math.min(total, a));
      b = Math.max(1, Math.min(total, b));
      const step = a <= b ? 1 : -1;
      for (let n = a; step > 0 ? n <= b : n >= b; n += step) out.push(n - 1);
      continue;
    }
    if (/^\d+$/.test(tok)) {
      const n = Number(tok);
      if (n >= 1 && n <= total) out.push(n - 1);
    }
  }
  return out;
}

/** Concatenate several PDFs into one. Returns the bytes and the total page count. */
export async function mergePdfs(sources: Uint8Array[]): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const out = await PDFDocument.create();
  for (const bytes of sources) {
    const src = await PDFDocument.load(bytes);
    const copied = await out.copyPages(src, src.getPageIndices());
    for (const p of copied) out.addPage(p);
  }
  const saved = await out.save();
  return { bytes: saved, pageCount: out.getPageCount() };
}

/** Build a new PDF containing only `indices` (0-based) from `bytes`, in the given order. */
export async function extractPages(bytes: Uint8Array, indices: number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes);
  const total = src.getPageCount();
  const valid = indices.filter((i) => Number.isInteger(i) && i >= 0 && i < total);
  if (!valid.length) throw new Error("Aucune page valide à extraire.");
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, valid);
  for (const p of copied) out.addPage(p);
  return out.save();
}
