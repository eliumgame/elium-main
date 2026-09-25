/**
 * Incremental saving — what Acrobat does on « Enregistrer ».
 *
 * A PDF can be updated by APPENDING to it: the objects that changed (or are
 * new) are written after the original `%%EOF`, followed by a new
 * cross-reference section and a trailer whose `/Prev` points at the previous
 * section. Every byte of the original stays where it was, which is what keeps
 * a digital signature valid (its `/ByteRange` covers the signed revision
 * only), keeps the file's structure (tags, XMP, attachments, layers, JavaScript
 * we do not understand…) untouched, and makes saving a 1 000-page file cost
 * what the edit costs, not what the file costs.
 *
 * Change detection compares every object of the edited pdf-lib document with a
 * plaintext serialisation of the objects already on disk (`Fingerprints`): an
 * object whose bytes are identical is not written. That catches every change,
 * whoever made it (our own ops, pdf-lib internals, pdf.js `saveDocument()`
 * output used as a base), without asking each op to report what it touched.
 *
 * Everything here is pure: bytes in, bytes out.
 */

import { PDFArray, PDFDict, PDFHexString, PDFRef, PDFStream, PDFString } from "pdf-lib";
import type { PDFDocument, PDFObject } from "pdf-lib";
import type { PdfCrypt } from "./security";

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

function ascii(s: string): Uint8Array {
  return enc.encode(s);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function lastIndexOf(hay: Uint8Array, needle: string, from = hay.length - needle.length): number {
  const n = needle.length;
  outer: for (let i = Math.min(from, hay.length - n); i >= 0; i--) {
    for (let j = 0; j < n; j++) if (hay[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

function latin1(bytes: Uint8Array, start: number, end: number): string {
  let s = "";
  const stop = Math.min(end, bytes.length);
  for (let i = start; i < stop; i += 0x2000) {
    s += String.fromCharCode(...bytes.subarray(i, Math.min(stop, i + 0x2000)));
  }
  return s;
}

function isWhite(b: number): boolean {
  return b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09 || b === 0x0c || b === 0x00;
}

// ---------------------------------------------------------------------------
// The end of a file: where its last cross-reference section is
// ---------------------------------------------------------------------------

export interface XrefTail {
  /** Byte offset of the last cross-reference section (the `startxref` value). */
  startxref: number;
  /** Classic `xref` table or cross-reference stream — an update must use the same kind. */
  kind: "table" | "stream";
  /** Trailer `/Size`: one more than the highest object number the file uses. */
  size: number;
}

/**
 * Locate the last cross-reference section. Returns null when the file's tail
 * is not trustworthy (no `startxref`, offset pointing nowhere): appending an
 * update to such a file would chain it to a broken section, so the caller
 * must fall back to a full rewrite (which also repairs the file).
 */
export function readXrefTail(bytes: Uint8Array): XrefTail | null {
  // Some producers pad the file after %%EOF; look in a generous window.
  const at = lastIndexOf(bytes, "startxref", bytes.length - 9);
  if (at < 0 || bytes.length - at > 64 * 1024) return null;
  const m = /^startxref\s+(\d+)/.exec(latin1(bytes, at, at + 40));
  if (!m) return null;
  const startxref = parseInt(m[1], 10);
  if (!(startxref > 0 && startxref < at)) return null;

  let p = startxref;
  while (p < bytes.length && isWhite(bytes[p])) p++;
  const head = latin1(bytes, p, p + 64);
  if (head.startsWith("xref")) {
    const trailerAt = findForward(bytes, "trailer", p, at);
    if (trailerAt < 0) return null;
    const dict = latin1(bytes, trailerAt, Math.min(at, trailerAt + 8192));
    const size = /\/Size\s+(\d+)/.exec(dict);
    if (!size) return null;
    return { startxref, kind: "table", size: parseInt(size[1], 10) };
  }
  if (/^\d+\s+\d+\s+obj/.test(head)) {
    const streamAt = findForward(bytes, "stream", p, Math.min(at, p + 16384));
    if (streamAt < 0) return null;
    const dict = latin1(bytes, p, streamAt);
    if (!/\/Type\s*\/XRef\b/.test(dict)) return null;
    const size = /\/Size\s+(\d+)/.exec(dict);
    if (!size) return null;
    return { startxref, kind: "stream", size: parseInt(size[1], 10) };
  }
  return null;
}

function findForward(hay: Uint8Array, needle: string, from: number, to: number): number {
  const n = needle.length;
  const stop = Math.min(to, hay.length) - n;
  outer: for (let i = from; i <= stop; i++) {
    for (let j = 0; j < n; j++) if (hay[i + j] !== needle.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------

/** Plaintext serialisation of every indirect object, keyed "num gen". */
export type Fingerprints = Map<string, Uint8Array>;

const refKey = (ref: PDFRef) => `${ref.objectNumber} ${ref.generationNumber}`;

/** The exact bytes pdf-lib writes for an object (a stream's dictionary `/Length` is refreshed). */
export function serializeObject(obj: PDFObject): Uint8Array {
  const out = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(out, 0);
  return out;
}

/** Fingerprint every object of a (plaintext) document. */
export function fingerprint(doc: PDFDocument): Fingerprints {
  const map: Fingerprints = new Map();
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) map.set(refKey(ref), serializeObject(obj));
  return map;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/**
 * The indirect objects reachable from the trailer (catalog, info, encrypt).
 * Objects nothing points at any more — a removed page's content, a deleted
 * annotation, the outline items a rewrite replaced — are left out of what we
 * write: an update carries only live objects, and a full rewrite must not
 * resurrect content the user removed.
 */
export function reachableRefs(doc: PDFDocument): Set<string> {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: PDFObject[] = [];
  const push = (o: PDFObject | undefined) => {
    if (o) stack.push(o);
  };
  push(ctx.trailerInfo.Root as PDFObject | undefined);
  push(ctx.trailerInfo.Info as PDFObject | undefined);
  push(ctx.trailerInfo.Encrypt as PDFObject | undefined);
  push(ctx.trailerInfo.ID as PDFObject | undefined);
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      const k = refKey(o);
      if (seen.has(k)) continue;
      seen.add(k);
      push(ctx.lookup(o));
    } else if (o instanceof PDFDict) {
      for (const v of o.values()) push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) push(o.get(i));
    } else if (o instanceof PDFStream) {
      push((o as unknown as { dict: PDFDict }).dict);
    }
  }
  return seen;
}

/** Drop every unreachable object from the document (before a full rewrite). */
export function pruneUnreachable(doc: PDFDocument): number {
  const live = reachableRefs(doc);
  let removed = 0;
  for (const [ref] of doc.context.enumerateIndirectObjects()) {
    if (!live.has(refKey(ref))) {
      doc.context.delete(ref);
      removed++;
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Writing an update
// ---------------------------------------------------------------------------

export interface IncrementalInput {
  /** The file as it is now (on disk): the update is appended to these bytes. */
  disk: Uint8Array;
  tail: XrefTail;
  /** The edited document, in plaintext. `flush()` must already have been awaited. */
  doc: PDFDocument;
  /** Plaintext serialisation of the objects of `disk`. */
  before: Fingerprints;
  /** The file's security handler: new objects are encrypted with the same key. */
  crypt?: PdfCrypt | null;
  /** The file's `/Encrypt` reference (kept in the new trailer). */
  encryptRef?: PDFRef | null;
  /** First element of the file's `/ID` (kept, a new second element is generated). */
  id0?: Uint8Array | null;
}

export interface IncrementalResult {
  bytes: Uint8Array;
  /** Objects written in the update (0 = nothing changed, `bytes` is `disk`). */
  written: number;
  /** Bytes appended. */
  added: number;
  /** Fingerprints of the file after this update, for the next one. */
  after: Fingerprints;
  tail: XrefTail;
}

function randomId(): Uint8Array {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return b;
}

function hex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, "0");
  return s;
}

function idBytes(o: PDFObject | undefined): Uint8Array | null {
  if (o instanceof PDFHexString || o instanceof PDFString) return o.asBytes();
  return null;
}

/** First element of a document's trailer /ID, if it has one. */
export function trailerId0(doc: PDFDocument): Uint8Array | null {
  let id = doc.context.trailerInfo.ID as PDFObject | undefined;
  if (id instanceof PDFRef) id = doc.context.lookup(id);
  if (!(id instanceof PDFArray) || id.size() < 1) return null;
  return idBytes(id.lookup(0));
}

/** Append the objects of `doc` that differ from `before` as one update of `disk`. */
export function writeIncrementalUpdate(input: IncrementalInput): IncrementalResult {
  const { disk, tail, doc, before, crypt } = input;
  const ctx = doc.context;
  const live = reachableRefs(doc);
  const after: Fingerprints = new Map(before);
  const changed: [PDFRef, PDFObject, Uint8Array][] = [];

  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    const key = refKey(ref);
    const bytes = serializeObject(obj);
    const old = before.get(key);
    if (old && bytesEqual(old, bytes)) continue;
    if (!live.has(key)) continue; // new or edited, but nothing points at it
    changed.push([ref, obj, bytes]);
    after.set(key, bytes);
  }
  if (!changed.length) return { bytes: disk, written: 0, added: 0, after: before, tail };
  changed.sort((a, b) => a[0].objectNumber - b[0].objectNumber);

  const parts: Uint8Array[] = [];
  let length = disk.length;
  const push = (b: Uint8Array) => {
    parts.push(b);
    length += b.length;
  };
  // The update must start on a fresh line after the previous %%EOF.
  const last = disk[disk.length - 1];
  if (last !== 0x0a && last !== 0x0d) push(ascii("\n"));

  const offsets = new Map<number, { offset: number; gen: number }>();
  let maxNum = 0;
  for (const [ref, obj, plain] of changed) {
    offsets.set(ref.objectNumber, { offset: length, gen: ref.generationNumber });
    maxNum = Math.max(maxNum, ref.objectNumber);
    push(ascii(`${ref.objectNumber} ${ref.generationNumber} obj\n`));
    push(crypt ? serializeObject(crypt.encryptObject(ref, obj)) : plain);
    push(ascii("\nendobj\n"));
  }

  const id0 = input.id0 ?? trailerId0(doc) ?? randomId();
  const idText = `[<${hex(id0)}> <${hex(randomId())}>]`;
  const root = ctx.trailerInfo.Root as PDFRef | undefined;
  const info = ctx.trailerInfo.Info as PDFRef | undefined;
  if (!(root instanceof PDFRef)) throw new Error("Catalogue introuvable : enregistrement incrémental impossible.");
  const common =
    `/Root ${root.toString()}` +
    (info instanceof PDFRef ? ` /Info ${info.toString()}` : "") +
    (input.encryptRef ? ` /Encrypt ${input.encryptRef.toString()}` : "") +
    ` /ID ${idText} /Prev ${tail.startxref}`;

  let size = Math.max(tail.size, maxNum + 1);
  const xrefAt = length;
  if (tail.kind === "table") {
    let table = "xref\n";
    for (const [start, nums] of runs([...offsets.keys()])) {
      table += `${start} ${nums.length}\n`;
      for (const n of nums) {
        const e = offsets.get(n)!;
        table += `${String(e.offset).padStart(10, "0")} ${String(e.gen).padStart(5, "0")} n\r\n`;
      }
    }
    push(ascii(`${table}trailer\n<< /Size ${size} ${common} >>\nstartxref\n${xrefAt}\n%%EOF\n`));
  } else {
    // The cross-reference stream is itself an object of the update.
    const selfNum = size;
    size += 1;
    offsets.set(selfNum, { offset: xrefAt, gen: 0 });
    const maxOffset = xrefAt;
    const w2 = maxOffset > 0xffffffff ? 8 : maxOffset > 0xffffff ? 4 : 3;
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const index: number[] = [];
    const rows: number[] = [];
    for (const [start, run] of runs(nums)) {
      index.push(start, run.length);
      rows.push(...run);
    }
    const data = new Uint8Array(rows.length * (1 + w2 + 2));
    let k = 0;
    for (const n of rows) {
      const e = offsets.get(n)!;
      data[k++] = 1;
      for (let b = w2 - 1; b >= 0; b--) data[k++] = Math.floor(e.offset / 2 ** (8 * b)) & 0xff;
      data[k++] = (e.gen >> 8) & 0xff;
      data[k++] = e.gen & 0xff;
    }
    push(
      ascii(
        `${selfNum} 0 obj\n<< /Type /XRef /Size ${size} /W [1 ${w2} 2] /Index [${index.join(" ")}] ${common} /Length ${data.length} >>\nstream\n`,
      ),
    );
    push(data);
    push(ascii(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`));
  }

  const out = new Uint8Array(length);
  out.set(disk, 0);
  let at = disk.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return {
    bytes: out,
    written: changed.length,
    added: out.length - disk.length,
    after,
    tail: { startxref: xrefAt, kind: tail.kind, size },
  };
}

/** Group sorted object numbers into consecutive runs (xref subsections). */
function runs(nums: number[]): [number, number[]][] {
  const sorted = [...nums].sort((a, b) => a - b);
  const out: [number, number[]][] = [];
  for (const n of sorted) {
    const cur = out[out.length - 1];
    if (cur && cur[1][cur[1].length - 1] === n - 1) cur[1].push(n);
    else out.push([n, [n]]);
  }
  return out;
}

/** Number of revisions (`%%EOF` markers) — informative. */
export function revisionCount(bytes: Uint8Array): number {
  let n = 0;
  let at = bytes.length;
  while ((at = lastIndexOf(bytes, "%%EOF", at - 1)) >= 0) n++;
  return n;
}

