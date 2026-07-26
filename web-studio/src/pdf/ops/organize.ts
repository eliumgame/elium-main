/**
 * Page-level document surgery: merge, extract, split, insert, crop and scale.
 * All of it is index maths plus pdf-lib `copyPages`, so it is easy to test and
 * hard to get subtly wrong.
 */

import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, degrees } from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import type { Page } from "../model/types";

// ---------------------------------------------------------------------------
// Page ranges
// ---------------------------------------------------------------------------

/**
 * Parse a page-range spec into ordered 0-based indices.
 * Understands `1-3, 5, 8-10`, `-4` (from the start), `7-` (to the end),
 * `impaires` / `paires` / `odd` / `even`, and `tout` / `all`.
 * Out-of-range tokens are clamped; a descending range expands descending.
 */
export function parsePageRange(spec: string, total: number): number[] {
  const out: number[] = [];
  if (total <= 0) return out;
  const text = spec.trim().toLowerCase();
  if (!text || text === "all" || text === "tout" || text === "toutes") {
    return Array.from({ length: total }, (_, i) => i);
  }
  if (text === "odd" || text === "impaires" || text === "impair") {
    for (let i = 0; i < total; i += 2) out.push(i);
    return out;
  }
  if (text === "even" || text === "paires" || text === "pair") {
    for (let i = 1; i < total; i += 2) out.push(i);
    return out;
  }
  for (const raw of text.split(/[,;]/)) {
    const tok = raw.trim();
    if (!tok) continue;
    const m = /^(\d*)\s*(?:-|–|à|to)\s*(\d*)$/.exec(tok);
    if (m && (m[1] || m[2])) {
      let a = m[1] ? Number(m[1]) : 1;
      let b = m[2] ? Number(m[2]) : total;
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

/** Render a set of 0-based indices back into a compact spec ("1-3, 7"). */
export function formatPageRange(indices: readonly number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  let start: number | null = null;
  let prev: number | null = null;
  const flush = () => {
    if (start === null || prev === null) return;
    parts.push(start === prev ? String(start + 1) : `${start + 1}-${prev + 1}`);
  };
  for (const i of sorted) {
    if (start === null) { start = i; prev = i; continue; }
    if (prev !== null && i === prev + 1) { prev = i; continue; }
    flush();
    start = i;
    prev = i;
  }
  flush();
  return parts.join(", ");
}

/** True when the spec resolves to at least one page. */
export function isValidRange(spec: string, total: number): boolean {
  return parsePageRange(spec, total).length > 0;
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

export interface MergeSource {
  name: string;
  bytes: Uint8Array;
  /** Optional subset, 0-based, in the order they should appear. */
  pages?: number[];
  password?: string;
}

export interface MergeResult {
  bytes: Uint8Array;
  /** Page count contributed by each source, in order. */
  counts: number[];
  /** Sources that could not be opened. */
  failed: string[];
}

/**
 * Concatenate documents. Bookmarks from each source are preserved as a
 * top-level entry per file so a merged dossier stays navigable.
 */
export async function mergeDocuments(sources: readonly MergeSource[], opts: { outline?: boolean } = {}): Promise<MergeResult> {
  const out = await PDFDocument.create();
  const counts: number[] = [];
  const failed: string[] = [];
  const marks: { title: string; page: number }[] = [];

  for (const src of sources) {
    try {
      const doc = await PDFDocument.load(src.bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
      const indices = src.pages?.length
        ? src.pages.filter((i) => i >= 0 && i < doc.getPageCount())
        : doc.getPageIndices();
      if (!indices.length) { counts.push(0); continue; }
      marks.push({ title: src.name.replace(/\.pdf$/i, ""), page: out.getPageCount() });
      const copied = await out.copyPages(doc, indices);
      for (const page of copied) out.addPage(page);
      counts.push(copied.length);
    } catch {
      failed.push(src.name);
      counts.push(0);
    }
  }

  if (opts.outline !== false && marks.length > 1) {
    writeOutline(out, marks.map((m) => ({ title: m.title, page: m.page, children: [] })));
  }
  return { bytes: await out.save(), counts, failed };
}

/** Build a new document from a subset of pages, in the given order. */
export async function extractPages(bytes: Uint8Array, indices: readonly number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
  const total = src.getPageCount();
  const valid = indices.filter((i) => Number.isInteger(i) && i >= 0 && i < total);
  if (!valid.length) throw new Error("Aucune page valide à extraire.");
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, [...valid]);
  for (const p of copied) out.addPage(p);
  return out.save();
}

export type SplitMode =
  | { kind: "everyN"; n: number }
  | { kind: "ranges"; spec: string }
  | { kind: "maxSize"; bytes: number }
  | { kind: "bookmarks"; level: number };

export interface SplitPart {
  name: string;
  bytes: Uint8Array;
  pages: number[];
}

/**
 * Split a document. `bookmarks` uses the source outline's top level (or the
 * requested depth) as the cut points — how legal and scanned dossiers are
 * usually broken up.
 */
export async function splitDocument(
  bytes: Uint8Array,
  mode: SplitMode,
  baseName: string,
  bookmarkStarts?: readonly { title: string; page: number }[],
): Promise<SplitPart[]> {
  const src = await PDFDocument.load(bytes, { ignoreEncryption: true, throwOnInvalidObject: false, updateMetadata: false });
  const total = src.getPageCount();
  const groups: { name: string; pages: number[] }[] = [];

  if (mode.kind === "everyN") {
    const n = Math.max(1, Math.floor(mode.n));
    for (let i = 0; i < total; i += n) {
      const pages = Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k);
      groups.push({ name: `${baseName}-${formatPageRange(pages)}`, pages });
    }
  } else if (mode.kind === "ranges") {
    for (const part of mode.spec.split(/[;\n]/)) {
      const pages = parsePageRange(part, total);
      if (pages.length) groups.push({ name: `${baseName}-${formatPageRange(pages)}`, pages });
    }
  } else if (mode.kind === "bookmarks") {
    const starts = (bookmarkStarts ?? []).filter((b) => b.page >= 1 && b.page <= total);
    if (!starts.length) {
      groups.push({ name: baseName, pages: Array.from({ length: total }, (_, i) => i) });
    } else {
      for (let i = 0; i < starts.length; i++) {
        const from = starts[i].page - 1;
        const to = i + 1 < starts.length ? starts[i + 1].page - 1 : total;
        const pages = Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
        if (pages.length) groups.push({ name: `${baseName}-${safeName(starts[i].title)}`, pages });
      }
    }
  } else {
    // maxSize: grow a part until adding the next page would exceed the budget.
    let current: number[] = [];
    let index = 1;
    for (let i = 0; i < total; i++) {
      current.push(i);
      const probe = await buildSubset(src, current);
      if (probe.length > mode.bytes && current.length > 1) {
        current.pop();
        groups.push({ name: `${baseName}-${index++}`, pages: [...current] });
        current = [i];
      }
    }
    if (current.length) groups.push({ name: `${baseName}-${index}`, pages: current });
  }

  const parts: SplitPart[] = [];
  for (const g of groups) {
    parts.push({ name: `${g.name}.pdf`, bytes: await buildSubset(src, g.pages), pages: g.pages });
  }
  return parts;
}

async function buildSubset(src: PDFDocument, pages: readonly number[]): Promise<Uint8Array> {
  const out = await PDFDocument.create();
  const copied = await out.copyPages(src, [...pages]);
  for (const p of copied) out.addPage(p);
  return out.save();
}

function safeName(s: string): string {
  return s.replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 48) || "section";
}

// ---------------------------------------------------------------------------
// Creating pages
// ---------------------------------------------------------------------------

export const PAGE_SIZES: Record<string, [number, number]> = {
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  Letter: [612, 792],
  Legal: [612, 1008],
  Tabloid: [792, 1224],
};

/** Build a PDF whose pages are the given images, one per page. */
export async function pdfFromImages(
  images: readonly { src: string; name?: string }[],
  opts: { pageSize?: [number, number] | "fit"; marginPt?: number } = {},
): Promise<Uint8Array> {
  const { ImageBank } = await import("./images");
  const doc = await PDFDocument.create();
  const bank = new ImageBank(doc);
  const margin = opts.marginPt ?? 0;
  for (const item of images) {
    const img = await bank.get(item.src);
    if (!img) continue;
    if (opts.pageSize === "fit" || !opts.pageSize) {
      const page = doc.addPage([img.width, img.height]);
      page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
    } else {
      const [w, h] = opts.pageSize;
      const page = doc.addPage([w, h]);
      const avW = w - margin * 2;
      const avH = h - margin * 2;
      const scale = Math.min(avW / img.width, avH / img.height, 1);
      const dw = img.width * scale;
      const dh = img.height * scale;
      page.drawImage(img, { x: (w - dw) / 2, y: (h - dh) / 2, width: dw, height: dh });
    }
  }
  if (!doc.getPageCount()) doc.addPage(PAGE_SIZES.A4);
  return doc.save();
}

/** Build a blank PDF, for "create a new document". */
export async function blankPdf(size: [number, number] = PAGE_SIZES.A4, pages = 1): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < Math.max(1, pages); i++) doc.addPage(size);
  return doc.save();
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Apply a crop inset (points from each edge) to a page's boxes. */
export function cropPage(page: PDFPage, crop: NonNullable<Page["crop"]>): void {
  const box = page.getCropBox();
  const x = box.x + Math.max(0, crop.left);
  const y = box.y + Math.max(0, crop.bottom);
  const w = Math.max(1, box.width - crop.left - crop.right);
  const h = Math.max(1, box.height - crop.top - crop.bottom);
  page.setCropBox(x, y, w, h);
  // Keep the trim/bleed boxes inside the new crop so printers stay happy.
  page.setBleedBox(x, y, w, h);
  page.setTrimBox(x, y, w, h);
}

/** Scale a page's content and boxes — Acrobat's "Resize pages". */
export function scalePage(page: PDFPage, factor: number): void {
  if (!(factor > 0) || Math.abs(factor - 1) < 1e-6) return;
  page.scaleContent(factor, factor);
  page.scaleAnnotations(factor, factor);
  const media = page.getMediaBox();
  page.setMediaBox(media.x * factor, media.y * factor, media.width * factor, media.height * factor);
  const crop = page.getCropBox();
  page.setCropBox(crop.x * factor, crop.y * factor, crop.width * factor, crop.height * factor);
}

/** Rotate a page by a further multiple of 90°. */
export function rotatePage(page: PDFPage, delta: number): void {
  page.setRotation(degrees((((page.getRotation().angle + delta) % 360) + 360) % 360));
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

export interface OutlineEntry {
  title: string;
  /** 0-based page index in the output document. */
  page: number;
  /** Points from the top of the page. */
  y?: number;
  bold?: boolean;
  italic?: boolean;
  color?: { r: number; g: number; b: number };
  children: OutlineEntry[];
  closed?: boolean;
}

/**
 * Write a bookmark tree into the document catalogue. pdf-lib has no outline
 * API, so the `/Outlines` dictionary is assembled by hand — which is also what
 * lets us keep bold/italic/colour and collapsed state.
 */
export function writeOutline(doc: PDFDocument, entries: readonly OutlineEntry[]): void {
  const ctx = doc.context;
  const pages = doc.getPages();
  if (!entries.length) {
    doc.catalog.delete(PDFName.of("Outlines"));
    return;
  }

  const rootRef = ctx.nextRef();

  interface Built {
    ref: ReturnType<typeof ctx.nextRef>;
    visible: number;
  }

  const build = (list: readonly OutlineEntry[], parentRef: ReturnType<typeof ctx.nextRef>): { first: Built | null; last: Built | null; count: number } => {
    const refs = list.map(() => ctx.nextRef());
    let openCount = 0;
    list.forEach((entry, i) => {
      const kids = build(entry.children, refs[i]);
      const target = pages[Math.max(0, Math.min(pages.length - 1, entry.page))];
      const dict: Record<string, unknown> = {
        Title: hexTitle(entry.title),
        Parent: parentRef,
      };
      if (target) {
        const top = entry.y != null ? target.getCropBox().height - entry.y : target.getCropBox().height;
        dict.Dest = [target.ref, PDFName.of("XYZ"), null, Math.round(top), null];
      }
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < refs.length - 1) dict.Next = refs[i + 1];
      if (kids.first) {
        dict.First = kids.first.ref;
        dict.Last = kids.last!.ref;
        dict.Count = entry.closed ? -kids.count : kids.count;
      }
      if (entry.bold || entry.italic) dict.F = (entry.italic ? 1 : 0) | (entry.bold ? 2 : 0);
      if (entry.color) dict.C = [entry.color.r, entry.color.g, entry.color.b];
      ctx.assign(refs[i], ctx.obj(dict as never));
      openCount += 1 + (entry.closed ? 0 : kids.count);
    });
    return {
      first: refs.length ? { ref: refs[0], visible: 0 } : null,
      last: refs.length ? { ref: refs[refs.length - 1], visible: 0 } : null,
      count: openCount,
    };
  };

  const top = build(entries, rootRef);
  ctx.assign(rootRef, ctx.obj({
    Type: "Outlines",
    ...(top.first ? { First: top.first.ref, Last: top.last!.ref } : {}),
    Count: top.count,
  } as never));
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseOutlines"));
}

function hexTitle(title: string) {
  return /^[\x20-\x7e]*$/.test(title) ? PDFString.of(title) : PDFHexString.fromText(title);
}

/** Write page labels (`/PageLabels`) so readers show "iv" instead of "4". */
export function writePageLabels(doc: PDFDocument, labels: readonly (string | undefined)[]): void {
  const ctx = doc.context;
  const nums: unknown[] = [];
  let last: string | null = null;
  labels.forEach((label, i) => {
    const prefix = label ?? "";
    if (prefix === last) return;
    last = prefix;
    nums.push(i, ctx.obj(prefix ? { P: hexTitle(prefix), S: PDFName.of("D"), St: 1 } as never : { S: PDFName.of("D"), St: i + 1 } as never));
  });
  if (!nums.length) {
    doc.catalog.delete(PDFName.of("PageLabels"));
    return;
  }
  doc.catalog.set(PDFName.of("PageLabels"), ctx.obj({ Nums: nums } as never));
}

export { PDFName, PDFNumber };
