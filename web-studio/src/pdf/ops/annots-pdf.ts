/**
 * Writing Elium markup into a PDF.
 *
 * Two modes, both driven by the same painting code:
 *
 *  - **interactive** (default) — a real `/Annot` dictionary per item, with a
 *    generated `/AP` appearance stream. Acrobat, Preview and Firefox show them
 *    in their comment panes, the author and timestamps survive, and reply
 *    threads round-trip as `/IRT` annotations. This is what "exactly like
 *    Adobe" actually requires: markup you can still edit after export.
 *
 *  - **flattened** — the same appearance painted straight into the page's
 *    content stream, for when the file must render identically everywhere and
 *    must not be editable.
 */

import type { PDFDocument, PDFPage, PDFRef } from "pdf-lib";
import { PDFHexString, PDFName, PDFString } from "pdf-lib";
import type { Pt, Rect } from "../core/coords";
import { quadToPdfQuadPoints, rectOfPoints, round } from "../core/coords";
import type { Annot, MeasureScale } from "../model/types";
import { isTextMarkup } from "../model/types";
import type { FontBook } from "./fonts";
import { sanitiseForFont } from "./fonts";
import type { ImageBank } from "./images";
import { FormResources, PageResources, Painter, hexToRgb, measure, rgbToPdfArray, wrapText } from "./painter";

/** Maps this page's page-space coordinates into PDF user space. */
export interface PageFrame {
  /** Crop box in PDF user space. */
  box: { x: number; y: number; width: number; height: number };
  toPdf(p: Pt): Pt;
  /** Page-space rect → PDF rect whose `y` is the BOTTOM edge. */
  rectToPdf(r: Rect): { x: number; y: number; w: number; h: number };
  /** Page-space rect → `/Rect` array. */
  rectArray(r: Rect): number[];
}

export function pageFrame(page: PDFPage): PageFrame {
  const box = page.getCropBox();
  const toPdf = (p: Pt): Pt => ({ x: box.x + p.x, y: box.y + box.height - p.y });
  return {
    box,
    toPdf,
    rectToPdf: (r) => ({ x: box.x + r.x, y: box.y + box.height - r.y - r.h, w: r.w, h: r.h }),
    rectArray: (r) => {
      const q = { x: box.x + r.x, y: box.y + box.height - r.y - r.h, w: r.w, h: r.h };
      return [round(q.x), round(q.y), round(q.x + q.w), round(q.y + q.h)];
    },
  };
}

export interface PaintContext {
  doc: PDFDocument;
  frame: PageFrame;
  fonts: FontBook;
  images: ImageBank;
  measureScale: MeasureScale;
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

const DASH_FOR: Record<string, number[] | null> = { solid: null, dashed: [4, 3], cloudy: null };

function dashOf(a: Annot): number[] | null {
  if (a.dash?.length) return a.dash;
  return DASH_FOR[a.borderStyle ?? "solid"] ?? null;
}

/** Format a measurement caption from a raw length in points. */
export function formatMeasure(lengthPt: number, scale: MeasureScale): string {
  const v = lengthPt * scale.unitsPerPoint;
  return `${v.toFixed(scale.precision)} ${scale.unit}`;
}

/** Shoelace area of a polygon, in square points. */
export function polygonArea(points: readonly Pt[]): number {
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

export function pathLength(points: readonly Pt[], close = false): number {
  let sum = 0;
  for (let i = 1; i < points.length; i++)
    sum += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  if (close && points.length > 2) {
    const a = points[points.length - 1];
    const b = points[0];
    sum += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return sum;
}

/** Paint one annotation into `p`, in absolute PDF user-space coordinates. */
export async function paintAnnot(p: Painter, a: Annot, ctx: PaintContext): Promise<void> {
  if (a.hidden) return;
  const { frame } = ctx;
  const stroke = hexToRgb(a.color, { r: 0, g: 0, b: 0 });
  const fill = a.fill ? hexToRgb(a.fill) : null;
  const alpha = a.opacity ?? 1;

  p.save();

  if (isTextMarkup(a.kind)) {
    const quads = a.quads ?? [];
    if (a.kind === "highlight") {
      p.alpha({ fillAlpha: alpha, blend: "Multiply" }).fillColor(stroke);
      for (const q of quads) {
        p.polyline(q.map(frame.toPdf), true);
      }
      p.fill();
    } else {
      const w = Math.max(0.6, a.strokeWidth || 1.2);
      p.alpha({ strokeAlpha: alpha }).strokeColor(stroke).lineWidth(w).lineCap(0);
      for (const q of quads) {
        const [tl, tr, br, bl] = q.map(frame.toPdf);
        if (a.kind === "underline") {
          const y = bl.y + (tl.y - bl.y) * 0.08;
          p.moveTo({ x: bl.x, y })
            .lineTo({ x: br.x, y: y + (tr.y - br.y) * 0.08 })
            .stroke();
        } else if (a.kind === "strikeout") {
          const y0 = (tl.y + bl.y) / 2;
          const y1 = (tr.y + br.y) / 2;
          p.moveTo({ x: tl.x, y: y0 }).lineTo({ x: tr.x, y: y1 }).stroke();
        } else {
          // squiggly: a sawtooth hugging the baseline
          const y = bl.y + 1;
          const amp = Math.max(1.2, (tl.y - bl.y) * 0.12);
          const step = amp * 2;
          p.moveTo({ x: bl.x, y });
          let up = true;
          for (let x = bl.x + step; x < br.x; x += step) {
            p.lineTo({ x, y: up ? y + amp : y });
            up = !up;
          }
          p.stroke();
        }
      }
    }
    p.restore();
    return;
  }

  switch (a.kind) {
    case "whiteout": {
      const r = frame.rectToPdf(a.rect);
      p.alpha({ fillAlpha: alpha })
        .fillColor(fill ?? { r: 1, g: 1, b: 1 })
        .rect(r.x, r.y, r.w, r.h)
        .fill();
      break;
    }
    case "redact": {
      const r = frame.rectToPdf(a.rect);
      p.alpha({ fillAlpha: 1 })
        .fillColor(hexToRgb(a.redactFill ?? "#000000"))
        .rect(r.x, r.y, r.w, r.h)
        .fill();
      if (a.redactText) {
        const { font, unicode } = await ctx.fonts.standard(true);
        const label = sanitiseForFont(a.redactText, unicode);
        const size = Math.min(10, Math.max(5, r.h * 0.55));
        const w = measure(font, label, size);
        p.fillColor({ r: 1, g: 1, b: 1 }).text(
          font,
          size,
          { x: r.x + (r.w - w) / 2, y: r.y + (r.h - size * 0.7) / 2 },
          label,
        );
      }
      break;
    }
    case "square": {
      const r = frame.rectToPdf(a.rect);
      const inset = (a.strokeWidth || 0) / 2;
      p.alpha({ fillAlpha: alpha, strokeAlpha: alpha }).dash(dashOf(a)).lineWidth(a.strokeWidth);
      if (a.borderStyle === "cloudy") {
        const pts = [
          { x: r.x, y: r.y },
          { x: r.x + r.w, y: r.y },
          { x: r.x + r.w, y: r.y + r.h },
          { x: r.x, y: r.y + r.h },
        ];
        p.cloudyPath(pts, Math.max(4, a.strokeWidth * 3));
      } else {
        p.rect(r.x + inset, r.y + inset, Math.max(0, r.w - inset * 2), Math.max(0, r.h - inset * 2));
      }
      paintFillStroke(p, fill, stroke, a.strokeWidth);
      break;
    }
    case "circle": {
      const r = frame.rectToPdf(a.rect);
      const inset = (a.strokeWidth || 0) / 2;
      p.alpha({ fillAlpha: alpha, strokeAlpha: alpha }).dash(dashOf(a)).lineWidth(a.strokeWidth);
      p.ellipse(r.x + r.w / 2, r.y + r.h / 2, Math.max(0.1, r.w / 2 - inset), Math.max(0.1, r.h / 2 - inset));
      paintFillStroke(p, fill, stroke, a.strokeWidth);
      break;
    }
    case "polygon":
    case "cloud":
    case "area": {
      const pts = (a.paths?.[0] ?? []).map(frame.toPdf);
      if (pts.length < 2) break;
      p.alpha({ fillAlpha: alpha, strokeAlpha: alpha }).dash(dashOf(a)).lineWidth(a.strokeWidth).lineJoin(1);
      if (a.kind === "cloud" || a.borderStyle === "cloudy") p.cloudyPath(pts, Math.max(4, a.strokeWidth * 3));
      else p.polyline(pts, true);
      paintFillStroke(p, fill, stroke, a.strokeWidth);
      if (a.kind === "area") {
        const areaPt = polygonArea(a.paths?.[0] ?? []);
        const scale = a.measure ?? ctx.measureScale;
        const v = areaPt * scale.unitsPerPoint * scale.unitsPerPoint;
        await paintCaption(p, ctx, a, `${v.toFixed(scale.precision)} ${scale.unit}²`, centroid(pts));
      }
      break;
    }
    case "polyline":
    case "perimeter": {
      const raw = a.paths?.[0] ?? [];
      const pts = raw.map(frame.toPdf);
      if (pts.length < 2) break;
      p.alpha({ strokeAlpha: alpha }).dash(dashOf(a)).lineWidth(a.strokeWidth).lineJoin(1).lineCap(1);
      p.polyline(pts, a.kind === "perimeter").stroke();
      paintEndings(p, a, pts, stroke);
      if (a.kind === "perimeter") {
        const scale = a.measure ?? ctx.measureScale;
        await paintCaption(p, ctx, a, formatMeasure(pathLength(raw, true), scale), centroid(pts));
      }
      break;
    }
    case "ink": {
      p.alpha({ strokeAlpha: alpha })
        .strokeColor(stroke)
        .lineWidth(Math.max(0.4, a.strokeWidth))
        .lineCap(1)
        .lineJoin(1)
        .dash(dashOf(a));
      for (const path of a.paths ?? []) {
        if (path.length < 2) {
          // A dot: draw a filled disc so a tap still leaves a mark.
          const c = frame.toPdf(path[0] ?? { x: a.rect.x, y: a.rect.y });
          p.fillColor(stroke)
            .ellipse(c.x, c.y, a.strokeWidth / 2, a.strokeWidth / 2)
            .fill();
          continue;
        }
        p.smoothPath(path.map(frame.toPdf)).stroke();
      }
      break;
    }
    case "line":
    case "arrow":
    case "distance": {
      const raw = a.paths?.[0] ?? [
        { x: a.rect.x, y: a.rect.y },
        { x: a.rect.x + a.rect.w, y: a.rect.y + a.rect.h },
      ];
      const [s, e] = [frame.toPdf(raw[0]), frame.toPdf(raw[raw.length - 1])];
      p.alpha({ strokeAlpha: alpha, fillAlpha: alpha })
        .strokeColor(stroke)
        .fillColor(stroke)
        .lineWidth(a.strokeWidth)
        .lineCap(0)
        .dash(dashOf(a));
      p.moveTo(s).lineTo(e).stroke();
      p.dash(null);
      paintEndings(p, a, [s, e], stroke);
      if (a.kind === "distance") {
        const scale = a.measure ?? ctx.measureScale;
        const len = Math.hypot(raw[raw.length - 1].x - raw[0].x, raw[raw.length - 1].y - raw[0].y);
        await paintCaption(p, ctx, a, formatMeasure(len, scale), { x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 });
      }
      break;
    }
    case "note": {
      await paintNoteIcon(p, a, ctx);
      break;
    }
    case "freetext":
    case "typewriter":
    case "callout": {
      if (a.kind === "callout" && a.callout?.length) {
        const pts = a.callout.map(frame.toPdf);
        p.alpha({ strokeAlpha: alpha, fillAlpha: alpha })
          .strokeColor(stroke)
          .fillColor(stroke)
          .lineWidth(Math.max(1, a.strokeWidth))
          .lineCap(0);
        p.polyline(pts).stroke();
        if (pts.length >= 2) {
          const tip = pts[0];
          const next = pts[1];
          p.lineEnding(
            a.lineEnd ?? "arrow",
            tip,
            Math.atan2(tip.y - next.y, tip.x - next.x),
            a.strokeWidth || 1.5,
            true,
          );
        }
      }
      await paintTextBox(p, a, ctx);
      break;
    }
    case "stamp":
    case "signature":
    case "image": {
      const r = frame.rectToPdf(a.rect);
      p.alpha({ fillAlpha: alpha, strokeAlpha: alpha });
      if (a.rotation) p.rotateAbout(-a.rotation, { x: r.x + r.w / 2, y: r.y + r.h / 2 });
      if (a.src) {
        const img = await ctx.images.get(a.src);
        if (img) p.image(img, r.x, r.y, r.w, r.h);
      } else if (a.stampLabel) {
        await paintGeneratedStamp(p, a, ctx, r);
      }
      break;
    }
    case "link": {
      // The clickable area is the annotation; nothing is painted by default.
      break;
    }
  }

  p.restore();
}

function paintFillStroke(
  p: Painter,
  fill: { r: number; g: number; b: number } | null,
  stroke: { r: number; g: number; b: number },
  width: number,
): void {
  if (fill && width > 0) p.fillColor(fill).strokeColor(stroke).fillStroke();
  else if (fill) p.fillColor(fill).fill();
  else if (width > 0) p.strokeColor(stroke).stroke();
  else p.endPath();
}

function paintEndings(p: Painter, a: Annot, pts: Pt[], stroke: { r: number; g: number; b: number }): void {
  if (pts.length < 2) return;
  p.strokeColor(stroke).fillColor(stroke).dash(null);
  const first = pts[0];
  const second = pts[1];
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  if (a.lineStart && a.lineStart !== "none") {
    p.lineEnding(a.lineStart, first, Math.atan2(first.y - second.y, first.x - second.x), a.strokeWidth, true);
  }
  if (a.lineEnd && a.lineEnd !== "none") {
    p.lineEnding(a.lineEnd, last, Math.atan2(last.y - prev.y, last.x - prev.x), a.strokeWidth, true);
  }
}

function centroid(pts: readonly Pt[]): Pt {
  if (!pts.length) return { x: 0, y: 0 };
  const sx = pts.reduce((s, q) => s + q.x, 0);
  const sy = pts.reduce((s, q) => s + q.y, 0);
  return { x: sx / pts.length, y: sy / pts.length };
}

/** A measurement caption on a pill background, centred on `at`. */
async function paintCaption(p: Painter, ctx: PaintContext, a: Annot, label: string, at: Pt): Promise<void> {
  const { font, unicode } = await ctx.fonts.standard(true);
  const size = a.fontSize || 10;
  const text = sanitiseForFont(label, unicode);
  const w = measure(font, text, size);
  const padX = 3;
  const padY = 2;
  p.save();
  p.alpha({ fillAlpha: 0.92 }).fillColor({ r: 1, g: 1, b: 1 });
  p.roundRect(at.x - w / 2 - padX, at.y - size * 0.4 - padY, w + padX * 2, size + padY * 2, 2).fill();
  p.alpha({ fillAlpha: 1 }).fillColor(hexToRgb(a.color));
  p.text(font, size, { x: at.x - w / 2, y: at.y - size * 0.28 }, text);
  p.restore();
}

/** Acrobat's sticky-note icon: a rounded speech bubble with three rules. */
async function paintNoteIcon(p: Painter, a: Annot, ctx: PaintContext): Promise<void> {
  const r = ctx.frame.rectToPdf({ ...a.rect, w: NOTE_SIZE, h: NOTE_SIZE });
  const c = hexToRgb(a.color, { r: 0.98, g: 0.75, b: 0.14 });
  const s = Math.min(r.w, r.h);
  p.save();
  p.alpha({ fillAlpha: a.opacity ?? 1, strokeAlpha: 1 });
  p.fillColor(c).strokeColor({ r: 0.15, g: 0.15, b: 0.15 }).lineWidth(0.7);
  p.roundRect(r.x, r.y + s * 0.18, s, s * 0.72, s * 0.16).fillStroke();
  // The tail
  p.fillColor(c).strokeColor({ r: 0.15, g: 0.15, b: 0.15 });
  p.moveTo({ x: r.x + s * 0.24, y: r.y + s * 0.2 })
    .lineTo({ x: r.x + s * 0.2, y: r.y })
    .lineTo({ x: r.x + s * 0.46, y: r.y + s * 0.2 })
    .closePath()
    .fillStroke();
  p.strokeColor({ r: 0.15, g: 0.15, b: 0.15 }).lineWidth(0.6);
  for (let i = 0; i < 3; i++) {
    const y = r.y + s * (0.72 - i * 0.16);
    p.moveTo({ x: r.x + s * 0.16, y })
      .lineTo({ x: r.x + s * (i === 2 ? 0.62 : 0.84), y })
      .stroke();
  }
  p.restore();
}

/** On-page size of a sticky note, matching Acrobat's 20×20 pt icon. */
export const NOTE_SIZE = 20;

async function paintTextBox(p: Painter, a: Annot, ctx: PaintContext): Promise<void> {
  const r = ctx.frame.rectToPdf(a.rect);
  const size = a.fontSize || 12;
  const { font, unicode } = await ctx.fonts.get(a.fontFamily, a.bold, a.italic);
  const pad = 3;
  const alpha = a.opacity ?? 1;

  if (a.textBg) {
    p.alpha({ fillAlpha: alpha }).fillColor(hexToRgb(a.textBg)).rect(r.x, r.y, r.w, r.h).fill();
  }
  if (a.strokeWidth > 0 && a.kind !== "typewriter") {
    const inset = a.strokeWidth / 2;
    p.alpha({ strokeAlpha: alpha }).strokeColor(hexToRgb(a.color)).lineWidth(a.strokeWidth).dash(dashOf(a));
    p.rect(r.x + inset, r.y + inset, Math.max(0, r.w - a.strokeWidth), Math.max(0, r.h - a.strokeWidth)).stroke();
    p.dash(null);
  }

  const body = sanitiseForFont(a.text ?? "", unicode);
  if (!body) return;
  const lines = wrapText(font, body, size, Math.max(4, r.w - pad * 2));
  const lineH = size * 1.25;
  const blockH = lines.length * lineH;
  let top: number;
  if (a.vAlign === "middle") top = r.y + (r.h + blockH) / 2 - lineH + size * 0.22;
  else if (a.vAlign === "bottom") top = r.y + blockH - lineH + pad;
  else top = r.y + r.h - pad - size;

  p.alpha({ fillAlpha: alpha }).fillColor(hexToRgb(a.color, { r: 0, g: 0, b: 0 }));
  lines.forEach((line, i) => {
    if (!line) return;
    const w = measure(font, line, size);
    const x = a.align === "center" ? r.x + (r.w - w) / 2 : a.align === "right" ? r.x + r.w - pad - w : r.x + pad;
    const y = top - i * lineH;
    p.text(font, size, { x, y }, line);
    if (a.underline) {
      p.strokeColor(hexToRgb(a.color)).lineWidth(Math.max(0.4, size / 16));
      p.moveTo({ x, y: y - size * 0.13 })
        .lineTo({ x: x + w, y: y - size * 0.13 })
        .stroke();
    }
  });
}

const STAMP_TONES: Record<string, { fg: string; bg: string }> = {
  green: { fg: "#15803d", bg: "#dcfce7" },
  red: { fg: "#b91c1c", bg: "#fee2e2" },
  blue: { fg: "#1d4ed8", bg: "#dbeafe" },
  orange: { fg: "#b45309", bg: "#ffedd5" },
  neutral: { fg: "#334155", bg: "#f1f5f9" },
};

async function paintGeneratedStamp(
  p: Painter,
  a: Annot,
  ctx: PaintContext,
  r: { x: number; y: number; w: number; h: number },
): Promise<void> {
  const tone = STAMP_TONES[a.stampTone ?? "red"] ?? STAMP_TONES.red;
  const { font, unicode } = await ctx.fonts.standard(true);
  const label = sanitiseForFont(a.stampLabel ?? "", unicode).toUpperCase();
  const fg = hexToRgb(tone.fg);
  p.alpha({ fillAlpha: (a.opacity ?? 1) * 0.14 }).fillColor(hexToRgb(tone.bg));
  p.roundRect(r.x, r.y, r.w, r.h, Math.min(6, r.h / 4)).fill();
  p.alpha({ strokeAlpha: a.opacity ?? 1, fillAlpha: a.opacity ?? 1 })
    .strokeColor(fg)
    .lineWidth(Math.max(1.2, r.h * 0.05));
  p.roundRect(r.x + 1, r.y + 1, r.w - 2, r.h - 2, Math.min(6, r.h / 4)).stroke();
  let size = r.h * 0.5;
  if (label) {
    const maxW = r.w * 0.86;
    while (size > 4 && measure(font, label, size) > maxW) size -= 0.5;
    const w = measure(font, label, size);
    p.fillColor(fg).text(font, size, { x: r.x + (r.w - w) / 2, y: r.y + (r.h - size * 0.72) / 2 }, label);
  }
}

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

/** Paint annotations straight into the page content — they stop being editable. */
export async function flattenAnnots(page: PDFPage, annots: readonly Annot[], ctx: PaintContext): Promise<void> {
  if (!annots.length) return;
  const res = new PageResources(page);
  const p = new Painter(res);
  for (const a of annots) {
    try {
      await paintAnnot(p, a, ctx);
    } catch {
      /* one bad annotation must not sink the export */
    }
  }
  if (p.isEmpty) return;
  const stream = ctx.doc.context.stream(`q\n${p.toString()}\nQ\n`);
  page.node.addContentStream(ctx.doc.context.register(stream));
}

// ---------------------------------------------------------------------------
// Real PDF annotations
// ---------------------------------------------------------------------------

const SUBTYPE: Partial<Record<Annot["kind"], string>> = {
  highlight: "Highlight",
  underline: "Underline",
  strikeout: "StrikeOut",
  squiggly: "Squiggly",
  note: "Text",
  freetext: "FreeText",
  typewriter: "FreeText",
  callout: "FreeText",
  ink: "Ink",
  square: "Square",
  circle: "Circle",
  line: "Line",
  arrow: "Line",
  polygon: "Polygon",
  cloud: "Polygon",
  polyline: "PolyLine",
  stamp: "Stamp",
  image: "Stamp",
  signature: "Stamp",
  distance: "Line",
  perimeter: "PolyLine",
  area: "Polygon",
  link: "Link",
};

/** Kinds that must be baked into the content: they hide or replace content. */
export function mustFlatten(kind: Annot["kind"]): boolean {
  return kind === "whiteout" || kind === "redact";
}

const LE_NAME: Record<string, string> = {
  none: "None",
  arrow: "ClosedArrow",
  openArrow: "OpenArrow",
  circle: "Circle",
  square: "Square",
  diamond: "Diamond",
  butt: "Butt",
  slash: "Slash",
};

/** `D:YYYYMMDDHHmmSS+HH'mm'` — the PDF date syntax. */
export function pdfDate(iso: string): string {
  const d = new Date(iso);
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const off = -t.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const oh = p2(Math.floor(Math.abs(off) / 60));
  const om = p2(Math.abs(off) % 60);
  return `D:${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}${sign}${oh}'${om}'`;
}

/** Text values may be any Unicode: hex-encode as UTF-16BE the way readers expect. */
function textString(s: string) {
  return /^[\x20-\x7e\n\r\t]*$/.test(s) ? PDFString.of(s) : PDFHexString.fromText(s);
}

interface WriteOptions {
  /** Author shown when an annotation carries no explicit one. */
  defaultAuthor: string;
  /** 1-based page numbers of the output, for resolving internal links. */
  pageRefs: PDFRef[];
}

/**
 * Write annotations as real `/Annot` dictionaries with generated appearances.
 * Returns the ones that had to be flattened instead (whiteout, redaction).
 */
export async function writeAnnots(
  page: PDFPage,
  annots: readonly Annot[],
  ctx: PaintContext,
  opts: WriteOptions,
): Promise<Annot[]> {
  const flattenLater: Annot[] = [];
  const byId = new Map<string, PDFRef>();

  for (const a of annots) {
    if (mustFlatten(a.kind)) {
      flattenLater.push(a);
      continue;
    }
    const subtype = SUBTYPE[a.kind];
    if (!subtype) {
      flattenLater.push(a);
      continue;
    }
    try {
      const ref = await writeOne(page, a, ctx, opts, subtype);
      if (ref) byId.set(a.id, ref);
      else flattenLater.push(a);
    } catch {
      flattenLater.push(a);
    }
  }

  // Reply threads become real `/IRT` annotations so Acrobat shows the whole
  // conversation, not just the first comment.
  for (const a of annots) {
    const parent = byId.get(a.id);
    if (!parent || !a.replies?.length) continue;
    for (const reply of a.replies) {
      if (!reply.text) continue;
      try {
        const dict = ctx.doc.context.obj({
          Type: "Annot",
          Subtype: "Text",
          Rect: ctx.frame.rectArray({ x: a.rect.x, y: a.rect.y, w: NOTE_SIZE, h: NOTE_SIZE }),
          F: 2, // hidden: it is a thread entry, not a second icon on the page
          IRT: parent,
          RT: PDFName.of("R"),
          T: textString(reply.author || opts.defaultAuthor),
          Contents: textString(reply.text),
          CreationDate: PDFString.of(pdfDate(reply.createdAt)),
          M: PDFString.of(pdfDate(reply.createdAt)),
        });
        page.node.addAnnot(ctx.doc.context.register(dict));
      } catch {
        /* skip a malformed reply */
      }
    }
  }

  return flattenLater;
}

async function writeOne(
  page: PDFPage,
  a: Annot,
  ctx: PaintContext,
  opts: WriteOptions,
  subtype: string,
): Promise<PDFRef | null> {
  const { doc, frame } = ctx;
  const rect = a.kind === "note" ? { ...a.rect, w: NOTE_SIZE, h: NOTE_SIZE } : a.rect;

  const entries: Record<string, unknown> = {
    Type: "Annot",
    Subtype: subtype,
    Rect: frame.rectArray(rect),
    C: rgbToPdfArray(hexToRgb(a.color)),
    CA: round(a.opacity ?? 1, 3),
    T: textString(a.author || opts.defaultAuthor),
    M: PDFString.of(pdfDate(a.modifiedAt)),
    CreationDate: PDFString.of(pdfDate(a.createdAt)),
    NM: PDFString.of(a.id),
    // Print + (locked when asked). Bit 3 = Print, bit 8 = Locked.
    F: 4 | (a.locked ? 128 : 0) | (a.hidden ? 2 : 0),
  };

  const comment = a.contents ?? (a.kind === "note" ? a.text : undefined);
  if (comment) entries.Contents = textString(comment);
  if (a.subject) entries.Subj = textString(a.subject);
  if (a.status && a.status !== "none") entries.StateModel = textString("Review");

  // --- per-kind entries -----------------------------------------------------
  if (isTextMarkup(a.kind) && a.quads?.length) {
    const h = frame.box.height;
    entries.QuadPoints = a.quads.flatMap((q) =>
      quadToPdfQuadPoints(q, h).map((v, i) => round(i % 2 === 0 ? v + frame.box.x : v + frame.box.y)),
    );
  }

  if (a.kind === "note") {
    entries.Name = PDFName.of("Comment");
    entries.Open = false;
  }

  if (a.kind === "ink" && a.paths?.length) {
    entries.InkList = a.paths.map((path) =>
      path.flatMap((pt) => {
        const q = frame.toPdf(pt);
        return [round(q.x), round(q.y)];
      }),
    );
    entries.BS = { W: round(a.strokeWidth, 2), S: a.borderStyle === "dashed" ? "D" : "S" };
  }

  if (a.kind === "square" || a.kind === "circle") {
    if (a.fill) entries.IC = rgbToPdfArray(hexToRgb(a.fill));
    entries.BS = {
      W: round(a.strokeWidth, 2),
      S: a.borderStyle === "cloudy" ? "S" : a.borderStyle === "dashed" ? "D" : "S",
      ...(a.borderStyle === "dashed" ? { D: [4, 3] } : {}),
    };
    if (a.borderStyle === "cloudy") entries.BE = { S: "C", I: 1 };
  }

  if (a.kind === "line" || a.kind === "arrow" || a.kind === "distance") {
    const raw = a.paths?.[0] ?? [
      { x: a.rect.x, y: a.rect.y },
      { x: a.rect.x + a.rect.w, y: a.rect.y + a.rect.h },
    ];
    const s = frame.toPdf(raw[0]);
    const e = frame.toPdf(raw[raw.length - 1]);
    entries.L = [round(s.x), round(s.y), round(e.x), round(e.y)];
    entries.LE = [LE_NAME[a.lineStart ?? "none"], LE_NAME[a.lineEnd ?? "none"]].map((v) => PDFName.of(v));
    entries.BS = { W: round(a.strokeWidth, 2), S: a.borderStyle === "dashed" ? "D" : "S" };
    if (a.kind === "distance") {
      entries.IT = PDFName.of("LineDimension");
      entries.Measure = measureDict(a.measure ?? ctx.measureScale);
    }
  }

  if (
    a.kind === "polygon" ||
    a.kind === "polyline" ||
    a.kind === "cloud" ||
    a.kind === "perimeter" ||
    a.kind === "area"
  ) {
    const pts = a.paths?.[0] ?? [];
    entries.Vertices = pts.flatMap((pt) => {
      const q = frame.toPdf(pt);
      return [round(q.x), round(q.y)];
    });
    entries.BS = { W: round(a.strokeWidth, 2), S: a.borderStyle === "dashed" ? "D" : "S" };
    if (a.kind === "cloud" || a.borderStyle === "cloudy") entries.BE = { S: "C", I: 1 };
    if (a.fill && (a.kind === "polygon" || a.kind === "cloud" || a.kind === "area")) {
      entries.IC = rgbToPdfArray(hexToRgb(a.fill));
    }
    if (a.kind === "perimeter" || a.kind === "area") {
      entries.IT = PDFName.of(a.kind === "area" ? "PolygonDimension" : "PolyLineDimension");
      entries.Measure = measureDict(a.measure ?? ctx.measureScale);
    }
  }

  if (a.kind === "freetext" || a.kind === "typewriter" || a.kind === "callout") {
    const { font } = await ctx.fonts.get(a.fontFamily, a.bold, a.italic);
    const c = hexToRgb(a.color);
    entries.DA = PDFString.of(
      `${round(c.r, 3)} ${round(c.g, 3)} ${round(c.b, 3)} rg /${font.name} ${round(a.fontSize ?? 12, 2)} Tf`,
    );
    entries.Q = a.align === "center" ? 1 : a.align === "right" ? 2 : 0;
    entries.Contents = textString(a.text ?? a.contents ?? "");
    if (a.kind === "callout" && a.callout?.length) {
      entries.IT = PDFName.of("FreeTextCallout");
      entries.CL = a.callout.flatMap((pt) => {
        const q = frame.toPdf(pt);
        return [round(q.x), round(q.y)];
      });
      entries.LE = PDFName.of(LE_NAME[a.lineEnd ?? "arrow"]);
    }
  }

  if (a.kind === "stamp" || a.kind === "image" || a.kind === "signature") {
    entries.Name = PDFName.of("Draft");
    if (a.stampLabel) entries.Subj = textString(a.stampLabel);
  }

  if (a.kind === "link") {
    delete entries.C;
    delete entries.CA;
    entries.Border = [0, 0, 0];
    if (a.action?.type === "url") {
      entries.A = { Type: "Action", S: "URI", URI: PDFString.of(a.action.url) };
    } else if (a.action?.type === "page") {
      const target = opts.pageRefs[Math.max(0, Math.min(opts.pageRefs.length - 1, a.action.page - 1))];
      if (target) entries.Dest = [target, PDFName.of("Fit")];
    }
  }

  // --- appearance stream ----------------------------------------------------
  const res = new FormResources();
  const painter = new Painter(res);
  await paintAnnot(painter, a, ctx);
  if (!painter.isEmpty) {
    const bbox = frame.rectArray(inflateForStroke(rect, a));
    const apDict: Record<string, unknown> = {
      Type: "XObject",
      Subtype: "Form",
      FormType: 1,
      BBox: bbox,
      Matrix: [1, 0, 0, 1, 0, 0],
      Resources: res.toDict(),
    };
    const apRef = doc.context.register(doc.context.stream(painter.toString(), apDict as never));
    entries.AP = { N: apRef };
    // The `/Rect` must contain the appearance, or viewers clip it.
    entries.Rect = bbox;
  }

  const ref = doc.context.register(doc.context.obj(entries as never));
  page.node.addAnnot(ref);
  return ref;
}

/** Widen the box so strokes, arrow heads and cloud bumps are not clipped. */
function inflateForStroke(rect: Rect, a: Annot): Rect {
  let pad = (a.strokeWidth || 0) / 2 + 1;
  if (a.lineEnd !== "none" || a.lineStart !== "none") pad += Math.max(4, (a.strokeWidth || 1) * 3.2);
  if (a.borderStyle === "cloudy" || a.kind === "cloud") pad += Math.max(4, (a.strokeWidth || 1) * 3) * 2;
  if (a.kind === "callout" && a.callout?.length) {
    const all = [...a.callout, { x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y + rect.h }];
    const r = rectOfPoints(all);
    return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
  }
  if (a.paths?.length) {
    const r = rectOfPoints(a.paths.flat());
    const merged = {
      x: Math.min(r.x, rect.x),
      y: Math.min(r.y, rect.y),
      w: Math.max(r.x + r.w, rect.x + rect.w) - Math.min(r.x, rect.x),
      h: Math.max(r.y + r.h, rect.y + rect.h) - Math.min(r.y, rect.y),
    };
    return { x: merged.x - pad, y: merged.y - pad, w: merged.w + pad * 2, h: merged.h + pad * 2 };
  }
  return { x: rect.x - pad, y: rect.y - pad, w: rect.w + pad * 2, h: rect.h + pad * 2 };
}

function measureDict(scale: MeasureScale): Record<string, unknown> {
  const perUnit = round(scale.unitsPerPoint, 8);
  return {
    Type: "Measure",
    Subtype: "RL",
    R: PDFString.of(`1 pt = ${perUnit} ${scale.unit}`),
    X: [{ Type: "NumberFormat", U: PDFString.of(scale.unit), C: perUnit, D: 10 ** scale.precision }],
    D: [{ Type: "NumberFormat", U: PDFString.of(scale.unit), C: perUnit, D: 10 ** scale.precision }],
    A: [
      {
        Type: "NumberFormat",
        U: PDFString.of(`${scale.unit}²`),
        C: round(perUnit * perUnit, 10),
        D: 10 ** scale.precision,
      },
    ],
  };
}
