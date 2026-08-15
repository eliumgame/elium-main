/**
 * Page decoration applied at export time: watermarks, backgrounds,
 * headers/footers and Bates numbering — Acrobat's "Edit → Page marks" family.
 *
 * All of it is painted into the page content (that is what these are: content,
 * not markup), and all of it honours a page range so a cover page can be left
 * clean.
 */

import type { PDFDocument, PDFPage } from "pdf-lib";
import type { Bates, HeaderFooter, Watermark } from "../model/types";
import type { PageFrame } from "./annots-pdf";
import type { FontBook } from "./fonts";
import { sanitiseForFont } from "./fonts";
import type { ImageBank } from "./images";
import { PageResources, Painter, hexToRgb, measure } from "./painter";
import { parsePageRange } from "./organize";

export interface DecorateContext {
  doc: PDFDocument;
  fonts: FontBook;
  images: ImageBank;
  /** Values available to header/footer tokens. */
  tokens: { title: string; author: string; filename: string; total: number };
}

/** Substitute `{page}`, `{date}` and friends in a header/footer field. */
export function expandTokens(
  template: string,
  ctx: { page: number; total: number; title: string; author: string; filename: string; bates?: string; date?: Date },
): string {
  const d = ctx.date ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return template
    .replace(/\{page\}/gi, String(ctx.page))
    .replace(/\{pages\}/gi, String(ctx.total))
    .replace(/\{date\}/gi, `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`)
    .replace(/\{time\}/gi, `${pad(d.getHours())}:${pad(d.getMinutes())}`)
    .replace(/\{title\}/gi, ctx.title)
    .replace(/\{author\}/gi, ctx.author)
    .replace(/\{filename\}/gi, ctx.filename)
    .replace(/\{bates\}/gi, ctx.bates ?? "");
}

/** Format one Bates number. */
export function batesLabel(bates: Bates, sequence: number): string {
  return `${bates.prefix}${String(bates.start + sequence).padStart(Math.max(1, bates.digits), "0")}${bates.suffix}`;
}

/** Should this page (0-based) be decorated, given a range spec? */
function inRange(spec: string, index: number, total: number): boolean {
  if (!spec.trim()) return true;
  return parsePageRange(spec, total).includes(index);
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

function anchorFor(position: Watermark["position"], w: number, h: number, cw: number, ch: number, margin: number) {
  const cx = (w - cw) / 2;
  const cy = (h - ch) / 2;
  switch (position) {
    case "top":
      return { x: cx, y: h - ch - margin };
    case "bottom":
      return { x: cx, y: margin };
    case "topLeft":
      return { x: margin, y: h - ch - margin };
    case "topRight":
      return { x: w - cw - margin, y: h - ch - margin };
    case "bottomLeft":
      return { x: margin, y: margin };
    case "bottomRight":
      return { x: w - cw - margin, y: margin };
    default:
      return { x: cx, y: cy };
  }
}

export async function applyWatermark(
  page: PDFPage,
  frame: PageFrame,
  wm: Watermark,
  ctx: DecorateContext,
  pageIndex: number,
  total: number,
): Promise<void> {
  if (!wm.enabled || !inRange(wm.pages, pageIndex, total)) return;
  const res = new PageResources(page);
  const p = new Painter(res);
  const { width: W, height: H, x: X, y: Y } = frame.box;
  const margin = 28;

  p.save();
  p.alpha({ fillAlpha: wm.opacity, strokeAlpha: wm.opacity, blend: "Multiply" });

  if (wm.mode === "image" && wm.src) {
    const img = await ctx.images.get(wm.src);
    if (img) {
      const base = Math.min((W * 0.6) / img.width, (H * 0.6) / img.height);
      const scale = base * (wm.scale || 1);
      const iw = img.width * scale;
      const ih = img.height * scale;
      const at = anchorFor(wm.position, W, H, iw, ih, margin);
      const cx = X + at.x + iw / 2;
      const cy = Y + at.y + ih / 2;
      if (wm.angle) p.rotateAbout(wm.angle, { x: cx, y: cy });
      p.image(img, X + at.x, Y + at.y, iw, ih);
    }
  } else if (wm.text) {
    const { font, unicode } = await ctx.fonts.get(wm.fontFamily, true, false);
    const text = sanitiseForFont(wm.text, unicode);
    let size = (wm.fontSize || 56) * (wm.scale || 1);
    // Shrink so a long watermark still fits across the diagonal.
    const diagonal = Math.hypot(W, H) * 0.9;
    while (size > 6 && measure(font, text, size) > diagonal) size -= 1;
    const tw = measure(font, text, size);
    const at = anchorFor(wm.position, W, H, tw, size, margin);
    const cx = X + at.x + tw / 2;
    const cy = Y + at.y + size / 2;
    p.fillColor(hexToRgb(wm.color));
    if (wm.angle) p.rotateAbout(wm.angle, { x: cx, y: cy });
    p.text(font, size, { x: X + at.x, y: Y + at.y }, text);
  }
  p.restore();

  if (p.isEmpty) return;
  const stream = ctx.doc.context.stream(`q\n${p.toString()}\nQ\n`);
  const ref = ctx.doc.context.register(stream);
  if (wm.behind) prependContent(ctx.doc, page, ref);
  else page.node.addContentStream(ref);
}

/** Put a content stream *before* the page's own content (backgrounds). */
function prependContent(_doc: PDFDocument, page: PDFPage, ref: ReturnType<PDFDocument["context"]["register"]>): void {
  // `normalize()` turns /Contents into an array; inserting at 0 draws first.
  page.node.addContentStream(ref);
  const contents = page.node.Contents();
  if (contents && "size" in contents && typeof contents.size === "function") {
    const arr = contents as unknown as { size(): number; remove(i: number): void; insert(i: number, v: unknown): void };
    const last = arr.size() - 1;
    if (last > 0) {
      arr.remove(last);
      arr.insert(0, ref);
    }
  }
}

// ---------------------------------------------------------------------------
// Headers, footers, Bates
// ---------------------------------------------------------------------------

export async function applyBand(
  page: PDFPage,
  frame: PageFrame,
  band: HeaderFooter,
  isHeader: boolean,
  ctx: DecorateContext,
  pageIndex: number,
  total: number,
  bates: string | undefined,
): Promise<void> {
  if (!band.enabled || !inRange(band.pages, pageIndex, total)) return;
  const values = {
    page: pageIndex + 1,
    total,
    title: ctx.tokens.title,
    author: ctx.tokens.author,
    filename: ctx.tokens.filename,
    bates,
  };
  const cells: [string, "left" | "center" | "right"][] = [
    [expandTokens(band.left, values), "left"],
    [expandTokens(band.center, values), "center"],
    [expandTokens(band.right, values), "right"],
  ];
  if (cells.every(([t]) => !t.trim())) return;

  const { font, unicode } = await ctx.fonts.get(band.fontFamily, false, false);
  const res = new PageResources(page);
  const p = new Painter(res);
  const { x: X, y: Y, width: W, height: H } = frame.box;
  const size = band.fontSize || 9;
  const y = isHeader ? Y + H - band.marginPt : Y + band.marginPt - size * 0.2;

  p.save().fillColor(hexToRgb(band.color));
  for (const [raw, align] of cells) {
    const text = sanitiseForFont(raw, unicode);
    if (!text.trim()) continue;
    const w = measure(font, text, size);
    const x = align === "center" ? X + (W - w) / 2 : align === "right" ? X + W - band.marginPt - w : X + band.marginPt;
    p.text(font, size, { x, y }, text);
  }
  p.restore();

  if (p.isEmpty) return;
  page.node.addContentStream(ctx.doc.context.register(ctx.doc.context.stream(`q\n${p.toString()}\nQ\n`)));
}

/**
 * Bates numbering as its own stamp in the bottom-right corner, for when the
 * user wants numbering without building a full footer.
 */
export async function applyBatesStamp(
  page: PDFPage,
  frame: PageFrame,
  bates: Bates,
  label: string,
  ctx: DecorateContext,
): Promise<void> {
  if (!bates.enabled) return;
  const { font, unicode } = await ctx.fonts.get(undefined, true, false);
  const res = new PageResources(page);
  const p = new Painter(res);
  const size = 9;
  const text = sanitiseForFont(label, unicode);
  const w = measure(font, text, size);
  const { x: X, y: Y, width: W } = frame.box;
  p.save().fillColor({ r: 0.15, g: 0.18, b: 0.24 });
  p.text(font, size, { x: X + W - 24 - w, y: Y + 18 }, text);
  p.restore();
  page.node.addContentStream(ctx.doc.context.register(ctx.doc.context.stream(`q\n${p.toString()}\nQ\n`)));
}
