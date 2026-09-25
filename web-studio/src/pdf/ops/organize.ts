/**
 * Page-level document surgery: merge, extract, split, insert, crop and scale.
 * All of it is index maths plus pdf-lib `copyPages`, so it is easy to test and
 * hard to get subtly wrong.
 */

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectCopier,
  PDFRef,
  PDFString,
  degrees,
} from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import type { BookmarkAction, DestFit, Page, PageLabelDef } from "../model/types";
import { round } from "../core/coords";
import { WrongPassword, openCrypt } from "./security";

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
    if (start === null) {
      start = i;
      prev = i;
      continue;
    }
    if (prev !== null && i === prev + 1) {
      prev = i;
      continue;
    }
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
}

export interface MergeResult {
  bytes: Uint8Array;
  /** Page count contributed by each source, in order. */
  counts: number[];
  /** Sources that could not be opened. */
  failed: string[];
  /** Why each of them failed, as `appendPdfPages` says. */
  reasons: { name: string; reason: string }[];
}

/** A PNG or JPEG file (the formats a PDF embeds as they are). */
export function imageKind(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

/**
 * The page a picture of `w × h` pixels is put on: its size at 96 dpi (as a
 * screen shows it), a large one brought down to fit A4 in its orientation.
 */
export function imagePageSize(w: number, h: number): { w: number; h: number } {
  let pw = (w * 72) / 96;
  let ph = (h * 72) / 96;
  const [a4w, a4h] = pw > ph ? [842, 595] : [595, 842];
  const k = Math.min(1, a4w / pw, a4h / ph);
  pw = Math.max(1, Math.round(pw * k));
  ph = Math.max(1, Math.round(ph * k));
  return { w: pw, h: ph };
}

/**
 * Append the pages of other PDFs to `doc` — the working document of a save
 * (`SaveInput.transform`). The document stays the same file: its objects keep
 * their numbers and the page tree is only extended, so the insertion is saved
 * like any other edit — incrementally, a signed revision left intact, new
 * objects encrypted with the file's own key. A protected file to insert is
 * decrypted first (owner-only protection opens freely; otherwise
 * `askPassword` is asked).
 */
export async function appendPdfPages(
  doc: PDFDocument,
  files: readonly { name: string; bytes: Uint8Array }[],
  askPassword?: (name: string, wrong: boolean) => Promise<string | null>,
  /** Where the pages go (0: before the first page); the end when absent. */
  at?: number,
  /** Only these pages of each file (0-based), and whether its bookmarks come along (yes). */
  opts: { pages?: readonly number[]; outline?: boolean } = {},
): Promise<{ inserted: number; failed: { name: string; reason: string }[] }> {
  let inserted = 0;
  let pos = at === undefined ? doc.getPageCount() : Math.max(0, Math.min(doc.getPageCount(), at));
  const failed: { name: string; reason: string }[] = [];
  for (const file of files) {
    let src: PDFDocument;
    try {
      src = await PDFDocument.load(file.bytes, {
        ignoreEncryption: true,
        throwOnInvalidObject: false,
        updateMetadata: false,
      });
    } catch {
      failed.push({ name: file.name, reason: "fichier illisible" });
      continue;
    }
    try {
      let crypt = null;
      let password = "";
      for (let attempt = 0; ; attempt++) {
        try {
          crypt = openCrypt(src, password);
          break;
        } catch (e) {
          if (!(e instanceof WrongPassword) || !askPassword) throw e;
          const next = await askPassword(file.name, attempt > 0);
          if (next == null) throw e;
          password = next;
        }
      }
      if (crypt) await crypt.decryptDocument(src);
    } catch (e) {
      failed.push({
        name: file.name,
        reason: e instanceof WrongPassword ? "protégé par mot de passe" : "chiffrement non pris en charge",
      });
      continue;
    }
    const all = src.getPageIndices();
    const indices = opts.pages ? opts.pages.filter((i) => i >= 0 && i < all.length) : all;
    if (!indices.length) {
      failed.push({ name: file.name, reason: "aucune page" });
      continue;
    }
    const copied = await doc.copyPages(src, indices);
    for (const page of copied) doc.insertPage(pos++, page);
    inserted += copied.length;
    // Its form joins this one (same name: the same field, as in Acrobat) and
    // its bookmarks come under one named after the file.
    try {
      adoptCopiedFields(doc, src, copied);
    } catch {
      /* the pages are in; their fields just stay inert */
    }
    try {
      if (opts.outline !== false) adoptOutline(doc, src, indices, copied, file.name.replace(/\.pdf$/i, ""));
    } catch {
      /* no bookmarks from that file */
    }
  }
  return { inserted, failed };
}

/**
 * Acrobat's « Combiner des fichiers »: the files one after the other in a new
 * document — PDFs (whole or a page selection, with their form fields and
 * bookmarks, a protected one opened with `askPassword`) and PNG/JPEG pictures
 * (one page each). With `outline` (default), one bookmark per file, the
 * file's own bookmarks under it, so the dossier stays navigable.
 */
export async function mergeDocuments(
  sources: readonly MergeSource[],
  opts: {
    outline?: boolean;
    askPassword?: (name: string, wrong: boolean) => Promise<string | null>;
    title?: string;
  } = {},
): Promise<MergeResult> {
  const out = await PDFDocument.create();
  if (opts.title) out.setTitle(opts.title);
  out.setProducer("Elium");
  const counts: number[] = [];
  const reasons: { name: string; reason: string }[] = [];
  for (const src of sources) {
    const kind = imageKind(src.bytes);
    if (kind) {
      try {
        const img = kind === "png" ? await out.embedPng(src.bytes) : await out.embedJpg(src.bytes);
        const size = imagePageSize(img.width, img.height);
        const page = out.addPage([size.w, size.h]);
        page.drawImage(img, { x: 0, y: 0, width: size.w, height: size.h });
        if (opts.outline !== false) {
          appendOutlineNodes(out, [{ title: src.name.replace(/\.[a-z0-9]+$/i, ""), page: page.ref, kids: [] }]);
        }
        counts.push(1);
      } catch {
        reasons.push({ name: src.name, reason: "image illisible" });
        counts.push(0);
      }
      continue;
    }
    const r = await appendPdfPages(out, [src], opts.askPassword, undefined, {
      pages: src.pages,
      outline: opts.outline,
    });
    reasons.push(...r.failed);
    counts.push(r.inserted);
  }
  return { bytes: await out.save(), counts, failed: reasons.map((r) => r.name), reasons };
}

/** Build a new document from a subset of pages, in the given order. */
export async function extractPages(bytes: Uint8Array, indices: readonly number[]): Promise<Uint8Array> {
  const src = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const total = src.getPageCount();
  const valid = indices.filter((i) => Number.isInteger(i) && i >= 0 && i < total);
  if (!valid.length) throw new Error("Aucune page valide à extraire.");
  return buildSubset(src, valid);
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
  const src = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
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
        if (!pages.length) continue;
        // Two sections with the same title must not overwrite each other.
        let name = `${baseName}-${safeName(starts[i].title)}`;
        for (let k = 2; groups.some((g) => g.name === name); k++)
          name = `${baseName}-${safeName(starts[i].title)} (${k})`;
        groups.push({ name, pages });
      }
    }
  } else {
    // maxSize: each page weighed once (alone, less an empty document's
    // weight), then parts filled up to the budget — not a rebuild per page.
    const empty = (await (await PDFDocument.create()).save()).length;
    const weights: number[] = [];
    for (let i = 0; i < total; i++) weights.push(Math.max(1, (await buildSubset(src, [i])).length - empty));
    let current: number[] = [];
    let size = empty;
    let index = 1;
    for (let i = 0; i < total; i++) {
      if (current.length && size + weights[i] > mode.bytes) {
        groups.push({ name: `${baseName}-${index++}`, pages: current });
        current = [];
        size = empty;
      }
      current.push(i);
      size += weights[i];
    }
    if (current.length) groups.push({ name: `${baseName}-${index}`, pages: current });
  }

  const parts: SplitPart[] = [];
  for (const g of groups) {
    parts.push({ name: `${g.name}.pdf`, bytes: await buildSubset(src, g.pages), pages: g.pages });
  }
  return parts;
}

/**
 * A document of `pages` of `src` that stands on its own: the pages with their
 * metadata, labels, fields and the bookmarks that fall in them — not links to
 * pages left out (nor the content of those pages, which a link would drag in).
 */
export async function buildSubset(src: PDFDocument, pages: readonly number[]): Promise<Uint8Array> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const copied = await out.copyPages(src, [...pages]);
  for (const p of copied) out.addPage(p);
  const infoDict = src.context.lookup(src.context.trailerInfo.Info);
  const info = (k: "Title" | "Author" | "Subject" | "Keywords" | "Creator" | "Producer") => {
    const v = infoDict instanceof PDFDict ? infoDict.lookup(PDFName.of(k)) : undefined;
    return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
  };
  const title = info("Title");
  if (title) out.setTitle(title);
  const author = info("Author");
  if (author) out.setAuthor(author);
  const subject = info("Subject");
  if (subject) out.setSubject(subject);
  const creator = info("Creator");
  if (creator) out.setCreator(creator);
  out.setProducer(info("Producer") ?? "Elium");
  try {
    const defs = readPageLabelDefs(src);
    if (defs)
      writePageLabels(
        out,
        pages.map((i) => defs[i]),
      );
  } catch {
    /* numbered from 1 */
  }
  try {
    adoptCopiedFields(out, src, copied);
  } catch {
    /* the pages without a working form */
  }
  try {
    const at = new Map(pages.map((p, k) => [p, copied[k]?.ref]));
    // Bookmarks into the part (a parent outside it stays for its children, without target).
    const keep = (nodes: OutlineNode[]): OutlineNode[] =>
      nodes.flatMap((n) => {
        const kids = keep(n.kids);
        return n.page || kids.length ? [{ ...n, kids }] : [];
      });
    appendOutlineNodes(out, keep(readOutlineNodes(src, (i) => at.get(i))));
  } catch {
    /* no bookmarks */
  }
  // Links to pages that are not in this part lead nowhere: they go.
  const inPart = new Set(out.getPages().map((p) => refKey(p.ref)));
  for (const p of out.getPages()) {
    const annots = p.node.Annots();
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookup(i);
      if (!(a instanceof PDFDict) || a.lookup(PDFName.of("Subtype"))?.toString() !== "/Link") continue;
      const act = a.lookup(PDFName.of("A"));
      const dest = a.get(PDFName.of("Dest")) ?? (act instanceof PDFDict ? act.get(PDFName.of("D")) : undefined);
      const arr = dest instanceof PDFRef ? out.context.lookup(dest) : dest;
      if (arr instanceof PDFArray && !inPart.has(refKey(arr.get(0)))) annots.remove(i);
    }
  }
  await out.flush();
  const { pruneUnreachable } = await import("./incremental");
  pruneUnreachable(out);
  return out.save();
}

function safeName(s: string): string {
  return (
    s
      .replace(/[^\p{L}\p{N} _-]/gu, "")
      .trim()
      .slice(0, 48) || "section"
  );
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

/**
 * « Redimensionner » : the page becomes `w` × `h` points as it is seen (its
 * /Rotate taken into account). With `fit`, its content (and annotations) is
 * scaled to fit and centred; without, only the paper changes around the
 * content, centred (margins added, or cut).
 */
export function resizePage(page: PDFPage, w: number, h: number, fit: boolean): void {
  const turned = page.getRotation().angle % 180 !== 0;
  const W = turned ? h : w;
  const H = turned ? w : h;
  const crop = page.getCropBox();
  let { x, y, width, height } = crop;
  if (fit && width > 0 && height > 0) {
    const f = Math.min(W / width, H / height);
    if (Math.abs(f - 1) > 1e-6) {
      page.scaleContent(f, f);
      page.scaleAnnotations(f, f);
      x *= f;
      y *= f;
      width *= f;
      height *= f;
    }
  }
  const ox = x - (W - width) / 2;
  const oy = y - (H - height) / 2;
  page.setMediaBox(ox, oy, W, H);
  page.setCropBox(ox, oy, W, H);
  // Other boxes would still describe the old sheet.
  for (const k of ["TrimBox", "BleedBox", "ArtBox"]) page.node.delete(PDFName.of(k));
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
  /** Points from the top of the page (crop box). */
  y?: number;
  /** Points from the left of the page (crop box). */
  x?: number;
  fit?: DestFit;
  zoom?: number;
  bold?: boolean;
  italic?: boolean;
  color?: { r: number; g: number; b: number };
  children: OutlineEntry[];
  closed?: boolean;
  /** Not a page (then `page` is ignored). */
  action?: BookmarkAction;
  /** The document's own item at this position of its outline ("0.2.1"), reused. */
  src?: string;
  /** Target set in Elium: the reused item's destination or action is replaced. */
  retargeted?: boolean;
}

/** The items of `doc`'s outline by position ("0", "0.1"…), as pdf.js numbers them. */
function outlineItems(doc: PDFDocument): Map<string, { ref: PDFRef; dict: PDFDict }> {
  const out = new Map<string, { ref: PDFRef; dict: PDFDict }>();
  const root = doc.catalog.lookup(PDFName.of("Outlines"));
  if (!(root instanceof PDFDict)) return out;
  const seen = new Set<string>();
  const walk = (first: unknown, prefix: string, depth: number) => {
    let ref = first;
    let i = 0;
    while (ref instanceof PDFRef && !seen.has(refKey(ref)) && depth < 64 && seen.size < 100000) {
      seen.add(refKey(ref));
      const dict = doc.context.lookup(ref);
      if (!(dict instanceof PDFDict)) break;
      const path = prefix ? `${prefix}.${i}` : String(i);
      out.set(path, { ref, dict });
      walk(dict.get(PDFName.of("First")), path, depth + 1);
      ref = dict.get(PDFName.of("Next"));
      i++;
    }
  };
  walk(root.get(PDFName.of("First")), "", 0);
  return out;
}

const isBlack = (c: { r: number; g: number; b: number } | undefined) => !c || (!c.r && !c.g && !c.b);

/** A destination array to `page` of `doc`, the entry's view (model space → PDF space). */
function destArray(doc: PDFDocument, entry: OutlineEntry): unknown[] | undefined {
  const pages = doc.getPages();
  const target = pages[Math.max(0, Math.min(pages.length - 1, entry.page))];
  if (!target) return undefined;
  const box = target.getCropBox();
  const top = entry.y != null ? round(box.y + box.height - entry.y) : null;
  const left = entry.x != null ? round(box.x + entry.x) : null;
  const name = PDFName.of;
  switch (entry.fit) {
    case "Fit":
    case "FitB":
      return [target.ref, name(entry.fit)];
    case "FitH":
    case "FitBH":
      return [target.ref, name(entry.fit), top];
    case "FitV":
    case "FitBV":
      return [target.ref, name(entry.fit), left];
    default:
      return [target.ref, name("XYZ"), left, top ?? round(box.y + box.height), entry.zoom ?? null];
  }
}

/**
 * Write a bookmark tree into the document catalogue. pdf-lib has no outline
 * API, so the `/Outlines` dictionary is assembled by hand.
 *
 * An entry that came from the document (`src`) reuses its item: only what the
 * model changed is written (links in the tree, open/closed count, title,
 * style), so its destination or action (URI, named, another file, a script,
 * its structure element…) stays exactly as the file had it — unless the
 * target was set in Elium (`retargeted`). The document's /PageMode is left
 * alone (it is the Initial View's).
 */
export function writeOutline(doc: PDFDocument, entries: readonly OutlineEntry[]): void {
  const ctx = doc.context;
  const existing = outlineItems(doc);
  if (!entries.length) {
    doc.catalog.delete(PDFName.of("Outlines"));
    return;
  }
  const oldRoot = doc.catalog.get(PDFName.of("Outlines"));
  const rootRef = oldRoot instanceof PDFRef && ctx.lookup(oldRoot) instanceof PDFDict ? oldRoot : ctx.nextRef();
  const used = new Set<string>();
  const STRUCTURE = ["Parent", "Prev", "Next", "First", "Last", "Count"].map((k) => PDFName.of(k));

  const build = (list: readonly OutlineEntry[], parentRef: PDFRef): { refs: PDFRef[]; count: number } => {
    const items = list.map((entry) => {
      const orig = entry.src ? existing.get(entry.src) : undefined;
      if (orig && !used.has(refKey(orig.ref))) {
        used.add(refKey(orig.ref));
        return { entry, ref: orig.ref, dict: orig.dict, reused: true };
      }
      const dict = ctx.obj({}) as PDFDict;
      return { entry, ref: ctx.register(dict), dict, reused: false };
    });
    let openCount = 0;
    items.forEach(({ entry, ref, dict, reused }, i) => {
      for (const k of STRUCTURE) dict.delete(k);
      const kids = build(entry.children, ref);
      dict.set(PDFName.of("Parent"), parentRef);
      if (i > 0) dict.set(PDFName.of("Prev"), items[i - 1].ref);
      if (i < items.length - 1) dict.set(PDFName.of("Next"), items[i + 1].ref);
      if (kids.refs.length) {
        dict.set(PDFName.of("First"), kids.refs[0]);
        dict.set(PDFName.of("Last"), kids.refs[kids.refs.length - 1]);
        dict.set(PDFName.of("Count"), ctx.obj(entry.closed ? -kids.count : kids.count));
      }
      // The title as the file wrote it, while unchanged.
      const t = dict.lookup(PDFName.of("Title"));
      const had = t instanceof PDFString || t instanceof PDFHexString ? t.decodeText().trim() || "(sans titre)" : null;
      if (had !== entry.title) dict.set(PDFName.of("Title"), hexTitle(entry.title));
      // Where it goes.
      if (!reused || entry.retargeted) {
        dict.delete(PDFName.of("Dest"));
        dict.delete(PDFName.of("A"));
        dict.delete(PDFName.of("SE"));
        const a = entry.action;
        if (a?.kind === "uri") dict.set(PDFName.of("A"), ctx.obj({ S: "URI", URI: PDFString.of(a.url) } as never));
        else if (a?.kind === "named") dict.set(PDFName.of("A"), ctx.obj({ S: "Named", N: a.name } as never));
        else if (!a) {
          const dest = destArray(doc, entry);
          if (dest) dict.set(PDFName.of("Dest"), ctx.obj(dest as never));
        }
      }
      // Style: written when set, removed when cleared (a black /C is the default).
      const f = (entry.italic ? 1 : 0) | (entry.bold ? 2 : 0);
      if (f) dict.set(PDFName.of("F"), ctx.obj(f));
      else dict.delete(PDFName.of("F"));
      if (!isBlack(entry.color)) {
        const c = entry.color!;
        dict.set(PDFName.of("C"), ctx.obj([c.r, c.g, c.b].map((v) => round(v, 4))));
      } else {
        const c = dict.lookup(PDFName.of("C"));
        const black = c instanceof PDFArray && c.asArray().every((v) => v instanceof PDFNumber && v.asNumber() === 0);
        if (!black) dict.delete(PDFName.of("C"));
      }
      if (!reused) ctx.assign(ref, dict);
      openCount += 1 + (entry.closed ? 0 : kids.count);
    });
    return { refs: items.map((it) => it.ref), count: openCount };
  };

  const top = build(entries, rootRef);
  const root = (ctx.lookup(rootRef) as PDFDict | undefined) ?? (ctx.obj({}) as PDFDict);
  root.set(PDFName.of("Type"), PDFName.of("Outlines"));
  root.set(PDFName.of("First"), top.refs[0]);
  root.set(PDFName.of("Last"), top.refs[top.refs.length - 1]);
  root.set(PDFName.of("Count"), ctx.obj(top.count));
  if (!ctx.lookup(rootRef)) ctx.assign(rootRef, root);
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
}

function hexTitle(title: string) {
  return /^[\x20-\x7e]*$/.test(title) ? PDFString.of(title) : PDFHexString.fromText(title);
}

const LABEL_STYLE: Record<PageLabelDef["style"], string | null> = {
  decimal: "D",
  roman: "r",
  ROMAN: "R",
  alpha: "a",
  ALPHA: "A",
  none: null,
};
const STYLE_OF: Record<string, PageLabelDef["style"]> = {
  D: "decimal",
  r: "roman",
  R: "ROMAN",
  a: "alpha",
  A: "ALPHA",
};

/**
 * The label of every page of `doc` from its /PageLabels number tree (null
 * when it has none): each range's style, prefix and start, spread on its pages.
 */
export function readPageLabelDefs(doc: PDFDocument): (PageLabelDef | undefined)[] | null {
  const root = doc.catalog.lookup(PDFName.of("PageLabels"));
  if (!(root instanceof PDFDict)) return null;
  const ranges: { at: number; dict: PDFDict }[] = [];
  const walk = (node: PDFDict, depth: number) => {
    if (depth > 32) return;
    const nums = node.lookup(PDFName.of("Nums"));
    if (nums instanceof PDFArray) {
      for (let i = 0; i + 1 < nums.size(); i += 2) {
        const at = nums.lookup(i);
        const dict = nums.lookup(i + 1);
        if (at instanceof PDFNumber && dict instanceof PDFDict) ranges.push({ at: at.asNumber(), dict });
      }
    }
    const kids = node.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) {
        const k = kids.lookup(i);
        if (k instanceof PDFDict) walk(k, depth + 1);
      }
    }
  };
  walk(root, 0);
  if (!ranges.length) return null;
  ranges.sort((x, y) => x.at - y.at);
  const count = doc.getPageCount();
  const out: (PageLabelDef | undefined)[] = new Array(count).fill(undefined);
  ranges.forEach((r, k) => {
    const end = k + 1 < ranges.length ? ranges[k + 1].at : count;
    const s = r.dict.lookup(PDFName.of("S"));
    const style = s instanceof PDFName ? (STYLE_OF[s.decodeText()] ?? "none") : "none";
    const p = r.dict.lookup(PDFName.of("P"));
    const prefix = p instanceof PDFString || p instanceof PDFHexString ? p.decodeText() : "";
    const st = r.dict.lookup(PDFName.of("St"));
    const start = st instanceof PDFNumber ? st.asNumber() : 1;
    for (let i = Math.max(0, r.at); i < Math.min(count, end); i++) out[i] = { style, prefix, num: start + (i - r.at) };
  });
  return out;
}

/**
 * Write /PageLabels for pages labelled `defs` (in output order): a range
 * starts wherever style or prefix changes or the numbering does not follow.
 * An unlabelled page among labelled ones reads as its position.
 */
export function writePageLabels(doc: PDFDocument, defs: readonly (PageLabelDef | undefined)[]): void {
  const ctx = doc.context;
  if (!defs.some(Boolean)) {
    doc.catalog.delete(PDFName.of("PageLabels"));
    return;
  }
  const nums: unknown[] = [];
  let prev: PageLabelDef | null = null;
  defs.forEach((raw, i) => {
    const def: PageLabelDef = raw ?? { style: "decimal", prefix: "", num: i + 1 };
    const follows =
      prev &&
      prev.style === def.style &&
      prev.prefix === def.prefix &&
      (def.style === "none" || def.num === prev.num + 1);
    prev = def;
    if (follows) return;
    const entry: Record<string, unknown> = {};
    const s = LABEL_STYLE[def.style];
    if (s) entry.S = PDFName.of(s);
    if (def.prefix) entry.P = hexTitle(def.prefix);
    if (s && def.num !== 1) entry.St = Math.max(1, Math.round(def.num));
    nums.push(i, ctx.obj(entry as never));
  });
  doc.catalog.set(PDFName.of("PageLabels"), ctx.obj({ Nums: nums } as never));
}

export { PDFName, PDFNumber };

// ---------------------------------------------------------------------------
// Pages removed or duplicated: the objects that pointed at them
// ---------------------------------------------------------------------------

const refKey = (r: unknown): string => (r instanceof PDFRef ? `${r.objectNumber} ${r.generationNumber}` : "");

/** Keys that belong to the field, not to its widget (ISO 32000 12.7.4, 12.7.5). */
const FIELD_KEYS = ["FT", "T", "TU", "TM", "Ff", "V", "DV", "Q", "DS", "RV", "Opt", "TI", "I", "MaxLen", "Lock", "SV"];

/**
 * A duplicated page's widgets join their original fields — Acrobat's
 * behaviour: the copy is another view of the same field (same name, same
 * value), not an orphan widget outside the form. A field whose single widget
 * was merged into it is split into a field and its two widgets.
 */
export function shareCopiedFields(doc: PDFDocument, pairs: readonly { original: PDFPage; copy: PDFPage }[]): void {
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict) || !pairs.length) return;
  const fields = acro.lookup(PDFName.of("Fields"));
  if (!(fields instanceof PDFArray)) return;
  const ctx = doc.context;
  for (const { original, copy } of pairs) {
    const origAnnots = original.node.Annots();
    const copyAnnots = copy.node.Annots();
    if (!(origAnnots instanceof PDFArray) || !(copyAnnots instanceof PDFArray)) continue;
    // Copies come in the same order as their originals.
    for (let i = 0; i < Math.min(origAnnots.size(), copyAnnots.size()); i++) {
      const oRef = origAnnots.get(i);
      const cRef = copyAnnots.get(i);
      const o = origAnnots.lookup(i);
      const c = copyAnnots.lookup(i);
      if (!(oRef instanceof PDFRef) || !(cRef instanceof PDFRef) || !(o instanceof PDFDict) || !(c instanceof PDFDict))
        continue;
      if (o.lookup(PDFName.of("Subtype"))?.toString() !== "/Widget") continue;
      c.set(PDFName.of("P"), copy.ref);
      const parentRef = o.get(PDFName.of("Parent"));
      if (parentRef instanceof PDFRef) {
        const parent = ctx.lookup(parentRef);
        if (!(parent instanceof PDFDict)) continue;
        c.set(PDFName.of("Parent"), parentRef);
        const kids = parent.lookup(PDFName.of("Kids"));
        if (kids instanceof PDFArray) kids.push(cRef);
        else parent.set(PDFName.of("Kids"), ctx.obj([oRef, cRef]));
        continue;
      }
      if (!o.get(PDFName.of("T"))) continue;
      // Merged field + widget: split it (a field with two widgets).
      const field = ctx.obj({}) as PDFDict;
      for (const k of FIELD_KEYS) {
        const v = o.get(PDFName.of(k));
        if (v !== undefined) {
          field.set(PDFName.of(k), v);
          o.delete(PDFName.of(k));
          c.delete(PDFName.of(k));
        }
      }
      const da = o.get(PDFName.of("DA"));
      if (da) field.set(PDFName.of("DA"), da);
      const fieldRef = ctx.register(field);
      field.set(PDFName.of("Kids"), ctx.obj([oRef, cRef]));
      o.set(PDFName.of("Parent"), fieldRef);
      c.set(PDFName.of("Parent"), fieldRef);
      const at = fields.indexOf(oRef);
      if (at !== undefined && at >= 0) fields.set(at, fieldRef);
      else fields.push(fieldRef);
    }
  }
}

/**
 * Pages taken out of the document must not stay in it through what pointed
 * at them (their content would still be in the file, and the form would keep
 * fields nobody can see): their widgets leave the form, bookmarks to them go
 * to the next page kept, named destinations and links to them are removed,
 * the opening action falls back to the first page, the structure tree lets go
 * of them.
 *
 * `order` is the source's pages in their original order, `kept` the refs
 * ("num gen") of those still in the document.
 */
export function purgeRemovedPages(doc: PDFDocument, order: readonly PDFPage[], kept: ReadonlySet<string>): void {
  const removed = new Set(order.map((p) => refKey(p.ref)).filter((k) => !kept.has(k)));
  if (!removed.size) return;
  const ctx = doc.context;
  const first = doc.getPages()[0]?.ref;
  const nextKept = (k: string): PDFRef | undefined => {
    const i = order.findIndex((p) => refKey(p.ref) === k);
    for (let j = i + 1; j < order.length; j++) if (kept.has(refKey(order[j].ref))) return order[j].ref;
    for (let j = i - 1; j >= 0; j--) if (kept.has(refKey(order[j].ref))) return order[j].ref;
    return first;
  };
  // A destination: [page …] (direct, or through a GoTo action).
  const destPage = (d: unknown): string => {
    const arr = d instanceof PDFRef ? ctx.lookup(d) : d;
    return arr instanceof PDFArray ? refKey(arr.get(0)) : "";
  };
  const goesToRemoved = (dict: PDFDict): { key: "Dest" | "A"; page: string } | null => {
    const dest = dict.get(PDFName.of("Dest"));
    if (dest && removed.has(destPage(dest))) return { key: "Dest", page: destPage(dest) };
    const a = dict.lookup(PDFName.of("A"));
    if (a instanceof PDFDict && a.lookup(PDFName.of("S"))?.toString() === "/GoTo") {
      const d = a.get(PDFName.of("D"));
      if (d && removed.has(destPage(d))) return { key: "A", page: destPage(d) };
    }
    return null;
  };

  // 1. The form: widgets of removed pages leave it; fields left without widgets go.
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  const fields = acro instanceof PDFDict ? acro.lookup(PDFName.of("Fields")) : undefined;
  if (fields instanceof PDFArray) {
    const onKept = new Set<string>();
    for (const p of doc.getPages()) {
      const annots = p.node.Annots();
      if (annots instanceof PDFArray) for (let i = 0; i < annots.size(); i++) onKept.add(refKey(annots.get(i)));
    }
    const isWidget = (d: PDFDict) =>
      !!d.get(PDFName.of("Rect")) || d.lookup(PDFName.of("Subtype"))?.toString() === "/Widget";
    // Returns whether the node still has a widget on a kept page.
    const prune = (ref: unknown, depth: number): boolean => {
      const node = ref instanceof PDFRef ? ctx.lookup(ref) : ref;
      if (!(node instanceof PDFDict) || depth > 32) return true;
      const kids = node.lookup(PDFName.of("Kids"));
      if (kids instanceof PDFArray) {
        for (let i = kids.size() - 1; i >= 0; i--) if (!prune(kids.get(i), depth + 1)) kids.remove(i);
        if (kids.size() > 0) return true;
        // No child left: gone, unless it is itself a widget on a kept page.
        return isWidget(node) && onKept.has(refKey(ref));
      }
      // A terminal: its widget(s) is itself.
      return !isWidget(node) || onKept.has(refKey(ref));
    };
    for (let i = fields.size() - 1; i >= 0; i--) if (!prune(fields.get(i), 0)) fields.remove(i);
  }

  // 2. Bookmarks: to the next page kept (the item stays).
  const outlines = doc.catalog.lookup(PDFName.of("Outlines"));
  const walk = (item: unknown, depth: number) => {
    let cur = item instanceof PDFRef ? ctx.lookup(item) : item;
    let guard = 0;
    while (cur instanceof PDFDict && guard++ < 100000 && depth < 64) {
      const hit = goesToRemoved(cur);
      if (hit) {
        const to = nextKept(hit.page);
        const dest = to ? ctx.obj([to, PDFName.of("Fit")]) : undefined;
        cur.delete(PDFName.of("A"));
        if (dest) cur.set(PDFName.of("Dest"), dest);
        else cur.delete(PDFName.of("Dest"));
      }
      const firstKid = cur.get(PDFName.of("First"));
      if (firstKid) walk(firstKid, depth + 1);
      const next = cur.get(PDFName.of("Next"));
      cur = next instanceof PDFRef ? ctx.lookup(next) : undefined;
    }
  };
  if (outlines instanceof PDFDict) walk(outlines.get(PDFName.of("First")), 0);

  // 3. Named destinations to removed pages.
  const dests = doc.catalog.lookup(PDFName.of("Dests"));
  if (dests instanceof PDFDict) {
    for (const [k, v] of dests.entries()) {
      const d = v instanceof PDFRef ? ctx.lookup(v) : v;
      const arr = d instanceof PDFDict ? d.get(PDFName.of("D")) : d;
      if (removed.has(destPage(arr))) dests.delete(k);
    }
  }
  const names = doc.catalog.lookup(PDFName.of("Names"));
  const destTree = names instanceof PDFDict ? names.lookup(PDFName.of("Dests")) : undefined;
  const pruneTree = (node: unknown, depth: number) => {
    const n = node instanceof PDFRef ? ctx.lookup(node) : node;
    if (!(n instanceof PDFDict) || depth > 32) return;
    const list = n.lookup(PDFName.of("Names"));
    if (list instanceof PDFArray) {
      for (let i = list.size() - 2; i >= 0; i -= 2) {
        const v = list.lookup(i + 1);
        const arr = v instanceof PDFDict ? v.get(PDFName.of("D")) : v;
        if (removed.has(destPage(arr))) {
          list.remove(i + 1);
          list.remove(i);
        }
      }
    }
    const kids = n.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) pruneTree(kids.get(i), depth + 1);
  };
  if (destTree) pruneTree(destTree, 0);

  // 4. Links on the pages kept that lead to removed pages.
  for (const p of doc.getPages()) {
    const annots = p.node.Annots();
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const a = annots.lookup(i);
      if (a instanceof PDFDict && a.lookup(PDFName.of("Subtype"))?.toString() === "/Link" && goesToRemoved(a)) {
        annots.remove(i);
      }
    }
  }

  // 5. Opening action.
  const open = doc.catalog.get(PDFName.of("OpenAction"));
  const openDest = open instanceof PDFArray || open instanceof PDFRef ? destPage(open) : "";
  const openDict = open instanceof PDFRef ? ctx.lookup(open) : open;
  const openGoTo = openDict instanceof PDFDict ? goesToRemoved(openDict) : null;
  if ((openDest && removed.has(openDest)) || openGoTo) {
    if (first) doc.catalog.set(PDFName.of("OpenAction"), ctx.obj([first, PDFName.of("Fit")]));
    else doc.catalog.delete(PDFName.of("OpenAction"));
  }

  // 6. Structure tree: its elements let go of the removed pages.
  const struct = doc.catalog.lookup(PDFName.of("StructTreeRoot"));
  if (struct instanceof PDFDict) {
    const seen = new Set<unknown>();
    const visit = (node: unknown, depth: number) => {
      const n = node instanceof PDFRef ? ctx.lookup(node) : node;
      if (!(n instanceof PDFDict) || seen.has(n) || depth > 256) return;
      seen.add(n);
      if (removed.has(refKey(n.get(PDFName.of("Pg"))))) n.delete(PDFName.of("Pg"));
      const k = n.get(PDFName.of("K"));
      const kids = k instanceof PDFRef ? ctx.lookup(k) : k;
      if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) visit(kids.get(i), depth + 1);
      else if (kids instanceof PDFDict) visit(kids, depth + 1);
    };
    visit(struct, 0);
  }
}

/**
 * The fields of pages copied from `src` into `doc`: their root fields (as
 * copied, found up the /Parent chain of each widget) are added to `doc`'s
 * /AcroForm, with the resources their appearances name (/DR fonts).
 */
function adoptCopiedFields(doc: PDFDocument, src: PDFDocument, copied: readonly PDFPage[]): void {
  const ctx = doc.context;
  const roots: PDFRef[] = [];
  const seen = new Set<string>();
  for (const page of copied) {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const first = annots.get(i);
      const widget = annots.lookup(i);
      if (!(first instanceof PDFRef) || !(widget instanceof PDFDict)) continue;
      if (widget.lookup(PDFName.of("Subtype"))?.toString() !== "/Widget") continue;
      widget.set(PDFName.of("P"), page.ref);
      let ref: PDFRef = first;
      let dict: PDFDict = widget;
      for (let guard = 0; guard < 32; guard++) {
        const parent: unknown = dict.get(PDFName.of("Parent"));
        const pd: unknown = parent instanceof PDFRef ? ctx.lookup(parent) : undefined;
        if (!(parent instanceof PDFRef) || !(pd instanceof PDFDict)) break;
        ref = parent;
        dict = pd;
      }
      const key = refKey(ref);
      if (!seen.has(key)) {
        seen.add(key);
        roots.push(ref);
      }
    }
  }
  if (!roots.length) return;
  let acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict)) {
    acro = ctx.obj({ Fields: [] }) as PDFDict;
    doc.catalog.set(PDFName.of("AcroForm"), ctx.register(acro as PDFDict));
  }
  const form = acro as PDFDict;
  let fields = form.lookup(PDFName.of("Fields"));
  if (!(fields instanceof PDFArray)) {
    fields = ctx.obj([]) as PDFArray;
    form.set(PDFName.of("Fields"), fields as PDFArray);
  }
  for (const r of roots) {
    // Same name as a field already there: the same field (Acrobat), one more view of it.
    if (!joinField(ctx, fields as PDFArray, r)) (fields as PDFArray).push(r);
  }
  // Fonts the copied appearances name, when this form lacks them.
  const srcAcro = src.catalog.lookup(PDFName.of("AcroForm"));
  const srcDr = srcAcro instanceof PDFDict ? srcAcro.lookup(PDFName.of("DR")) : undefined;
  const srcFonts = srcDr instanceof PDFDict ? srcDr.lookup(PDFName.of("Font")) : undefined;
  if (srcFonts instanceof PDFDict) {
    const copier = PDFObjectCopier.for(src.context, ctx);
    let dr = form.lookup(PDFName.of("DR"));
    if (!(dr instanceof PDFDict)) {
      dr = ctx.obj({}) as PDFDict;
      form.set(PDFName.of("DR"), dr as PDFDict);
    }
    let fonts = (dr as PDFDict).lookup(PDFName.of("Font"));
    if (!(fonts instanceof PDFDict)) {
      fonts = ctx.obj({}) as PDFDict;
      (dr as PDFDict).set(PDFName.of("Font"), fonts as PDFDict);
    }
    for (const [k, v] of srcFonts.entries()) {
      if (!(fonts as PDFDict).get(k)) (fonts as PDFDict).set(k, copier.copy(v));
    }
  }
  if (srcAcro instanceof PDFDict && srcAcro.lookup(PDFName.of("NeedAppearances"))?.toString() === "true") {
    form.set(PDFName.of("NeedAppearances"), ctx.obj(true));
  }
}

const partialName = (d: PDFDict): string | undefined => {
  const t = d.lookup(PDFName.of("T"));
  return t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : undefined;
};

/**
 * A field whose single widget is merged into it, split into the field and
 * that widget (the widget keeps the ref the page's /Annots holds). Returns
 * the field's ref.
 */
function splitMerged(ctx: PDFDocument["context"], ref: PDFRef, dict: PDFDict, siblings: PDFArray): PDFRef {
  if (dict.get(PDFName.of("Kids")) || dict.lookup(PDFName.of("Subtype"))?.toString() !== "/Widget") return ref;
  const field = ctx.obj({}) as PDFDict;
  for (const k of FIELD_KEYS) {
    const v = dict.get(PDFName.of(k));
    if (v !== undefined) {
      field.set(PDFName.of(k), v);
      dict.delete(PDFName.of(k));
    }
  }
  const da = dict.get(PDFName.of("DA"));
  if (da) field.set(PDFName.of("DA"), da);
  const parent = dict.get(PDFName.of("Parent"));
  if (parent) field.set(PDFName.of("Parent"), parent);
  const fieldRef = ctx.register(field);
  field.set(PDFName.of("Kids"), ctx.obj([ref]));
  dict.set(PDFName.of("Parent"), fieldRef);
  const at = siblings.indexOf(ref);
  if (at !== undefined && at >= 0) siblings.set(at, fieldRef);
  return fieldRef;
}

/**
 * Field `ref` (a copy) joins the field of the same name among `siblings`, if
 * there is one of the same type: its widgets become that field's, named
 * children are joined the same way one level down. The existing field's value
 * stays. False when there is no such field (the copy stays a field of its own).
 */
function joinField(ctx: PDFDocument["context"], siblings: PDFArray, ref: PDFRef, depth = 0): boolean {
  const copy = ctx.lookup(ref);
  if (!(copy instanceof PDFDict) || depth > 16) return false;
  const name = partialName(copy);
  if (name === undefined) return false;
  let targetRef: PDFRef | undefined;
  let target: PDFDict | undefined;
  for (let i = 0; i < siblings.size(); i++) {
    const r = siblings.get(i);
    const d = siblings.lookup(i);
    if (r instanceof PDFRef && d instanceof PDFDict && refKey(r) !== refKey(ref) && partialName(d) === name) {
      targetRef = r;
      target = d;
      break;
    }
  }
  if (!targetRef || !target) return false;
  const ft = (d: PDFDict) => d.lookup(PDFName.of("FT"))?.toString();
  if (ft(copy) && ft(target) && ft(copy) !== ft(target)) return false;

  const fieldRef = splitMerged(ctx, targetRef, target, siblings);
  const field = ctx.lookup(fieldRef, PDFDict);
  let kids = field.lookup(PDFName.of("Kids"));
  if (!(kids instanceof PDFArray)) {
    kids = ctx.obj([]) as PDFArray;
    field.set(PDFName.of("Kids"), kids as PDFArray);
  }
  const into = kids as PDFArray;
  const copyKids = copy.lookup(PDFName.of("Kids"));
  if (copyKids instanceof PDFArray) {
    for (let i = 0; i < copyKids.size(); i++) {
      const k = copyKids.get(i);
      const kd = copyKids.lookup(i);
      if (!(k instanceof PDFRef) || !(kd instanceof PDFDict)) continue;
      kd.set(PDFName.of("Parent"), fieldRef);
      if (partialName(kd) !== undefined && joinField(ctx, into, k, depth + 1)) continue;
      into.push(k);
    }
  } else {
    // The copy is a field and its widget in one: the widget alone joins.
    for (const k of FIELD_KEYS) copy.delete(PDFName.of(k));
    copy.set(PDFName.of("Parent"), fieldRef);
    into.push(ref);
  }
  return true;
}

/** A bookmark read from a file: its title, the page it goes to, its children. */
interface OutlineNode {
  title: string;
  page?: PDFRef;
  kids: OutlineNode[];
}

/** `src`'s bookmarks, their targets mapped by `target` (a page of `src` → its copy, or none). */
function readOutlineNodes(src: PDFDocument, target: (srcPageIndex: number) => PDFRef | undefined): OutlineNode[] {
  const srcPages = src.getPages().map((p) => refKey(p.ref));
  const resolve = (d: unknown): PDFRef | undefined => {
    let dest = d instanceof PDFRef ? src.context.lookup(d) : d;
    if (dest instanceof PDFString || dest instanceof PDFHexString || dest instanceof PDFName) {
      dest = namedDest(src, dest.decodeText());
    }
    if (dest instanceof PDFDict) dest = dest.lookup(PDFName.of("D"));
    if (!(dest instanceof PDFArray)) return undefined;
    const i = srcPages.indexOf(refKey(dest.get(0)));
    return i >= 0 ? target(i) : undefined;
  };
  const read = (first: unknown, depth: number): OutlineNode[] => {
    const out: OutlineNode[] = [];
    let cur = first instanceof PDFRef ? src.context.lookup(first) : first;
    let guard = 0;
    while (cur instanceof PDFDict && guard++ < 100000 && depth < 64) {
      const t = cur.lookup(PDFName.of("Title"));
      const a = cur.lookup(PDFName.of("A"));
      const page =
        resolve(cur.get(PDFName.of("Dest"))) ??
        (a instanceof PDFDict && a.lookup(PDFName.of("S"))?.toString() === "/GoTo"
          ? resolve(a.get(PDFName.of("D")))
          : undefined);
      out.push({
        title: t instanceof PDFString || t instanceof PDFHexString ? t.decodeText() : "",
        page,
        kids: read(cur.get(PDFName.of("First")), depth + 1),
      });
      const next = cur.get(PDFName.of("Next"));
      cur = next instanceof PDFRef ? src.context.lookup(next) : undefined;
    }
    return out;
  };
  const root = src.catalog.lookup(PDFName.of("Outlines"));
  return root instanceof PDFDict ? read(root.get(PDFName.of("First")), 0) : [];
}

/** Append `nodes` at the end of `doc`'s outline (created if needed). */
function appendOutlineNodes(doc: PDFDocument, nodes: readonly OutlineNode[]): void {
  if (!nodes.length) return;
  const ctx = doc.context;
  let root = doc.catalog.lookup(PDFName.of("Outlines"));
  let rootRef = doc.catalog.get(PDFName.of("Outlines"));
  if (!(root instanceof PDFDict) || !(rootRef instanceof PDFRef)) {
    root = ctx.obj({ Type: "Outlines", Count: 0 }) as PDFDict;
    rootRef = ctx.register(root as PDFDict);
    doc.catalog.set(PDFName.of("Outlines"), rootRef);
  }
  // Write `list` as the children of `parentRef`; returns [first, last, count].
  const write = (list: readonly OutlineNode[], parentRef: PDFRef): [PDFRef | null, PDFRef | null, number] => {
    const refs = list.map(() => ctx.nextRef());
    list.forEach((n, i) => {
      const [f, l, c] = write(n.kids, refs[i]);
      const dict: Record<string, unknown> = { Title: hexTitle(n.title), Parent: parentRef };
      if (n.page) dict.Dest = [n.page, PDFName.of("XYZ"), null, null, null];
      if (i > 0) dict.Prev = refs[i - 1];
      if (i < list.length - 1) dict.Next = refs[i + 1];
      if (f && l) {
        dict.First = f;
        dict.Last = l;
        dict.Count = -c; // closed
      }
      ctx.assign(refs[i], ctx.obj(dict as never));
    });
    return [refs[0] ?? null, refs[refs.length - 1] ?? null, list.length];
  };
  const r = root as PDFDict;
  const [first, lastNew, count] = write(nodes, rootRef as PDFRef);
  if (!first || !lastNew) return;
  const last = r.get(PDFName.of("Last"));
  if (last instanceof PDFRef) {
    const lastDict = ctx.lookup(last);
    if (lastDict instanceof PDFDict) lastDict.set(PDFName.of("Next"), first);
    (ctx.lookup(first) as PDFDict).set(PDFName.of("Prev"), last);
  } else {
    r.set(PDFName.of("First"), first);
  }
  r.set(PDFName.of("Last"), lastNew);
  const had = r.lookup(PDFName.of("Count"));
  r.set(PDFName.of("Count"), PDFNumber.of((had instanceof PDFNumber ? Math.abs(had.asNumber()) : 0) + count));
}

/**
 * `src`'s bookmarks, pointing at their copies in `doc`, under one bookmark
 * named `title` (to the first inserted page) at the end of `doc`'s outline.
 */
function adoptOutline(
  doc: PDFDocument,
  src: PDFDocument,
  indices: readonly number[],
  copied: readonly PDFPage[],
  title: string,
): void {
  if (!copied.length) return;
  // Only the bookmarks of the pages taken (`indices[k]` became `copied[k]`).
  const at = new Map(indices.map((i, k) => [i, copied[k]]));
  const kids = readOutlineNodes(src, (i) => at.get(i)?.ref);
  appendOutlineNodes(doc, [{ title, page: copied[0].ref, kids }]);
}

/** A named destination of `doc` (catalog /Dests or the /Names tree). */
function namedDest(doc: PDFDocument, name: string): unknown {
  const dests = doc.catalog.lookup(PDFName.of("Dests"));
  if (dests instanceof PDFDict) {
    const v = dests.lookup(PDFName.of(name));
    if (v) return v;
  }
  const names = doc.catalog.lookup(PDFName.of("Names"));
  const tree = names instanceof PDFDict ? names.lookup(PDFName.of("Dests")) : undefined;
  const find = (node: unknown, depth: number): unknown => {
    const n = node instanceof PDFRef ? doc.context.lookup(node) : node;
    if (!(n instanceof PDFDict) || depth > 32) return undefined;
    const list = n.lookup(PDFName.of("Names"));
    if (list instanceof PDFArray) {
      for (let i = 0; i + 1 < list.size(); i += 2) {
        const k = list.lookup(i);
        if ((k instanceof PDFString || k instanceof PDFHexString) && k.decodeText() === name) return list.lookup(i + 1);
      }
    }
    const kids = n.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) {
        const hit = find(kids.get(i), depth + 1);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return tree ? find(tree, 0) : undefined;
}

/**
 * Text as a PDF (Acrobat's « Créer à partir du presse-papiers » with text):
 * A4 pages, 11 pt, 56 pt margins, wrapped, as many pages as it takes.
 */
export async function textToPdf(text: string): Promise<Uint8Array> {
  const { FontBook, sanitiseForFont } = await import("./fonts");
  const { measure, wrapText } = await import("./painter");
  const doc = await PDFDocument.create();
  doc.setProducer("Elium");
  const clean = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  const face = await new FontBook(doc).forText("Helvetica", false, false, clean);
  const body = sanitiseForFont(clean, face.unicode);
  const [W, H] = PAGE_SIZES.A4;
  const margin = 56;
  const size = 11;
  const lead = size * 1.35;
  const lines = wrapText(face.font, body, size, W - 2 * margin);
  const perPage = Math.max(1, Math.floor((H - 2 * margin) / lead));
  for (let at = 0; at < Math.max(1, lines.length); at += perPage) {
    const page = doc.addPage([W, H]);
    lines.slice(at, at + perPage).forEach((line, k) => {
      if (!line || !measure(face.font, line, size)) return;
      page.drawText(line, { x: margin, y: H - margin - size - k * lead, size, font: face.font });
    });
  }
  return doc.save();
}
