/**
 * A tiny PDF content-operator builder.
 *
 * Everything Elium draws into a PDF — annotation appearances, watermarks,
 * headers, redaction boxes, form-field appearances, re-laid-out edited text —
 * goes through this. Emitting operators directly (instead of pdf-lib's
 * `page.drawX` helpers) is what makes dash patterns, real transparency groups,
 * multiply-blended highlights, arrow heads and cloudy borders possible.
 *
 * The same operator string can be appended to a page's content stream
 * (flattening) or wrapped in a Form XObject and used as an annotation's `/AP`
 * (staying interactive), because both are written in absolute page
 * coordinates — see `annots-pdf.ts`.
 */

import type { PDFDict, PDFFont, PDFImage, PDFPage } from "pdf-lib";
import { PDFName, PDFNumber, PDFRef } from "pdf-lib";
import type { Pt } from "../core/coords";
import { round } from "../core/coords";

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function hexToRgb(hex: string | null | undefined, fallback: Rgb = { r: 0, g: 0, b: 0 }): Rgb {
  if (!hex) return fallback;
  const h = hex.replace("#", "").trim();
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return fallback;
  const n = parseInt(s, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

export function rgbToPdfArray(c: Rgb): number[] {
  return [round(c.r, 4), round(c.g, 4), round(c.b, 4)];
}

// ---------------------------------------------------------------------------
// Resource sinks
// ---------------------------------------------------------------------------

export interface AlphaState {
  fillAlpha?: number;
  strokeAlpha?: number;
  blend?: "Normal" | "Multiply" | "Darken" | "Screen";
}

/** Where a painter registers the fonts / images / graphics states it needs. */
export interface ResourceSink {
  fontName(font: PDFFont): string;
  imageName(image: PDFImage): string;
  alphaName(state: AlphaState): string;
}

/** Registers resources straight into a page's own resource dictionary. */
export class PageResources implements ResourceSink {
  private fonts = new Map<string, string>();
  private images = new Map<string, string>();
  private alphas = new Map<string, string>();

  constructor(private readonly page: PDFPage) {}

  fontName(font: PDFFont): string {
    const key = String(font.ref);
    let name = this.fonts.get(key);
    if (!name) {
      name = this.page.node.newFontDictionary(font.name, font.ref).asString().replace(/^\//, "");
      this.fonts.set(key, name);
    }
    return name;
  }

  imageName(image: PDFImage): string {
    const key = String(image.ref);
    let name = this.images.get(key);
    if (!name) {
      name = this.page.node.newXObject("Image", image.ref).asString().replace(/^\//, "");
      this.images.set(key, name);
    }
    return name;
  }

  alphaName(state: AlphaState): string {
    const key = alphaKey(state);
    let name = this.alphas.get(key);
    if (!name) {
      const dict = this.page.doc.context.obj(alphaDict(state) as never) as unknown as PDFDict;
      name = this.page.node.newExtGState("GS", dict).asString().replace(/^\//, "");
      this.alphas.set(key, name);
    }
    return name;
  }
}

/** Collects resources into a standalone dictionary, for a Form XObject `/AP`. */
export class FormResources implements ResourceSink {
  readonly fonts = new Map<string, PDFRef>();
  readonly images = new Map<string, PDFRef>();
  readonly alphas = new Map<string, Record<string, unknown>>();
  private n = 0;

  private key(prefix: string): string {
    return `${prefix}${++this.n}`;
  }

  fontName(font: PDFFont): string {
    for (const [name, ref] of this.fonts) if (String(ref) === String(font.ref)) return name;
    const name = this.key("F");
    this.fonts.set(name, font.ref);
    return name;
  }

  imageName(image: PDFImage): string {
    for (const [name, ref] of this.images) if (String(ref) === String(image.ref)) return name;
    const name = this.key("X");
    this.images.set(name, image.ref);
    return name;
  }

  alphaName(state: AlphaState): string {
    const dict = alphaDict(state);
    const serialised = alphaKey(state);
    for (const [name, d] of this.alphas) if (alphaKeyOf(d) === serialised) return name;
    const name = this.key("G");
    this.alphas.set(name, dict);
    return name;
  }

  /** Build the `/Resources` literal for the Form XObject. */
  toDict(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.fonts.size) out.Font = Object.fromEntries(this.fonts);
    if (this.images.size) out.XObject = Object.fromEntries(this.images);
    if (this.alphas.size) out.ExtGState = Object.fromEntries(this.alphas);
    return out;
  }
}

function alphaDict(s: AlphaState): Record<string, unknown> {
  const d: Record<string, unknown> = { Type: "ExtGState" };
  if (s.fillAlpha !== undefined) d.ca = round(s.fillAlpha, 3);
  if (s.strokeAlpha !== undefined) d.CA = round(s.strokeAlpha, 3);
  if (s.blend && s.blend !== "Normal") d.BM = s.blend;
  return d;
}

function alphaKey(s: AlphaState): string {
  return `${s.fillAlpha ?? 1}|${s.strokeAlpha ?? 1}|${s.blend ?? "Normal"}`;
}

function alphaKeyOf(d: Record<string, unknown>): string {
  return `${d.ca ?? 1}|${d.CA ?? 1}|${d.BM ?? "Normal"}`;
}

// ---------------------------------------------------------------------------
// Painter
// ---------------------------------------------------------------------------

const n = (v: number) => String(round(v, 3));

/**
 * Builds a content-operator string. All coordinates are PDF user space
 * (bottom-left origin) — callers convert from page space first.
 */
export class Painter {
  private out: string[] = [];

  constructor(private readonly res: ResourceSink) {}

  get isEmpty(): boolean {
    return this.out.length === 0;
  }

  toString(): string {
    return this.out.join("\n");
  }

  raw(op: string): this {
    this.out.push(op);
    return this;
  }

  save(): this {
    return this.raw("q");
  }

  restore(): this {
    return this.raw("Q");
  }

  /** Concatenate a transformation matrix. */
  transform(a: number, b: number, c: number, d: number, e: number, f: number): this {
    return this.raw(`${n(a)} ${n(b)} ${n(c)} ${n(d)} ${n(e)} ${n(f)} cm`);
  }

  /** Rotate `deg` degrees counter-clockwise around `about`. */
  rotateAbout(deg: number, about: Pt): this {
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    this.transform(1, 0, 0, 1, about.x, about.y);
    this.transform(cos, sin, -sin, cos, 0, 0);
    this.transform(1, 0, 0, 1, -about.x, -about.y);
    return this;
  }

  fillColor(c: Rgb): this {
    return this.raw(`${n(c.r)} ${n(c.g)} ${n(c.b)} rg`);
  }

  strokeColor(c: Rgb): this {
    return this.raw(`${n(c.r)} ${n(c.g)} ${n(c.b)} RG`);
  }

  lineWidth(w: number): this {
    return this.raw(`${n(Math.max(0, w))} w`);
  }

  /** 0 butt, 1 round, 2 square. */
  lineCap(style: 0 | 1 | 2): this {
    return this.raw(`${style} J`);
  }

  lineJoin(style: 0 | 1 | 2): this {
    return this.raw(`${style} j`);
  }

  dash(pattern: readonly number[] | null | undefined, phase = 0): this {
    if (!pattern || !pattern.length) return this.raw("[] 0 d");
    return this.raw(`[${pattern.map(n).join(" ")}] ${n(phase)} d`);
  }

  alpha(state: AlphaState): this {
    if (state.fillAlpha === undefined && state.strokeAlpha === undefined && !state.blend) return this;
    return this.raw(`/${this.res.alphaName(state)} gs`);
  }

  moveTo(p: Pt): this {
    return this.raw(`${n(p.x)} ${n(p.y)} m`);
  }

  lineTo(p: Pt): this {
    return this.raw(`${n(p.x)} ${n(p.y)} l`);
  }

  curveTo(c1: Pt, c2: Pt, to: Pt): this {
    return this.raw(`${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(to.x)} ${n(to.y)} c`);
  }

  closePath(): this {
    return this.raw("h");
  }

  rect(x: number, y: number, w: number, h: number): this {
    return this.raw(`${n(x)} ${n(y)} ${n(w)} ${n(h)} re`);
  }

  /** Rounded rectangle, for text-box backgrounds and stamps. */
  roundRect(x: number, y: number, w: number, h: number, r: number): this {
    const rad = Math.min(r, w / 2, h / 2);
    if (rad <= 0.01) return this.rect(x, y, w, h);
    const k = rad * 0.5523;
    this.moveTo({ x: x + rad, y });
    this.lineTo({ x: x + w - rad, y });
    this.curveTo({ x: x + w - rad + k, y }, { x: x + w, y: y + rad - k }, { x: x + w, y: y + rad });
    this.lineTo({ x: x + w, y: y + h - rad });
    this.curveTo({ x: x + w, y: y + h - rad + k }, { x: x + w - rad + k, y: y + h }, { x: x + w - rad, y: y + h });
    this.lineTo({ x: x + rad, y: y + h });
    this.curveTo({ x: x + rad - k, y: y + h }, { x, y: y + h - rad + k }, { x, y: y + h - rad });
    this.lineTo({ x, y: y + rad });
    this.curveTo({ x, y: y + rad - k }, { x: x + rad - k, y }, { x: x + rad, y });
    return this.closePath();
  }

  ellipse(cx: number, cy: number, rx: number, ry: number): this {
    const k = 0.5523;
    this.moveTo({ x: cx - rx, y: cy });
    this.curveTo({ x: cx - rx, y: cy + ry * k }, { x: cx - rx * k, y: cy + ry }, { x: cx, y: cy + ry });
    this.curveTo({ x: cx + rx * k, y: cy + ry }, { x: cx + rx, y: cy + ry * k }, { x: cx + rx, y: cy });
    this.curveTo({ x: cx + rx, y: cy - ry * k }, { x: cx + rx * k, y: cy - ry }, { x: cx, y: cy - ry });
    this.curveTo({ x: cx - rx * k, y: cy - ry }, { x: cx - rx, y: cy - ry * k }, { x: cx - rx, y: cy });
    return this.closePath();
  }

  polyline(points: readonly Pt[], close = false): this {
    if (!points.length) return this;
    this.moveTo(points[0]);
    for (let i = 1; i < points.length; i++) this.lineTo(points[i]);
    if (close) this.closePath();
    return this;
  }

  /** A smoothed freehand path (Catmull-Rom → cubic Bézier). */
  smoothPath(points: readonly Pt[]): this {
    if (points.length < 2) return this;
    if (points.length === 2) return this.polyline(points);
    this.moveTo(points[0]);
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] ?? points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] ?? p2;
      this.curveTo(
        { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
        { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
        p2,
      );
    }
    return this;
  }

  /**
   * A "cloudy" border (Acrobat's cloud style): scalloped arcs along the path.
   * `intensity` is the cloud radius in points.
   */
  cloudyPath(points: readonly Pt[], intensity: number): this {
    const r = Math.max(3, intensity);
    const pts = points.slice();
    if (pts.length < 2) return this;
    if (pts[0].x !== pts[pts.length - 1].x || pts[0].y !== pts[pts.length - 1].y) pts.push(pts[0]);
    let started = false;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.01) continue;
      const steps = Math.max(1, Math.round(len / (r * 1.6)));
      const ux = (b.x - a.x) / steps;
      const uy = (b.y - a.y) / steps;
      // Normal pointing outward (left of travel) so bumps sit outside the shape.
      const nx = -uy / Math.hypot(ux, uy) || 0;
      const ny = ux / Math.hypot(ux, uy) || 0;
      for (let s = 0; s < steps; s++) {
        const from = { x: a.x + ux * s, y: a.y + uy * s };
        const to = { x: a.x + ux * (s + 1), y: a.y + uy * (s + 1) };
        if (!started) { this.moveTo(from); started = true; }
        const mid = { x: (from.x + to.x) / 2 + nx * r * 0.9, y: (from.y + to.y) / 2 + ny * r * 0.9 };
        this.curveTo(
          { x: from.x + (mid.x - from.x) * 1.15, y: from.y + (mid.y - from.y) * 1.15 },
          { x: to.x + (mid.x - to.x) * 1.15, y: to.y + (mid.y - to.y) * 1.15 },
          to,
        );
      }
    }
    return this;
  }

  stroke(): this {
    return this.raw("S");
  }

  fill(): this {
    return this.raw("f");
  }

  fillStroke(): this {
    return this.raw("B");
  }

  closeStroke(): this {
    return this.raw("s");
  }

  clip(): this {
    return this.raw("W n");
  }

  endPath(): this {
    return this.raw("n");
  }

  /** Draw one line of text with an embedded font. */
  text(font: PDFFont, size: number, at: Pt, str: string, opts: { charSpacing?: number; rise?: number } = {}): this {
    if (!str) return this;
    const name = this.res.fontName(font);
    this.raw("BT");
    this.raw(`/${name} ${n(size)} Tf`);
    if (opts.charSpacing) this.raw(`${n(opts.charSpacing)} Tc`);
    if (opts.rise) this.raw(`${n(opts.rise)} Ts`);
    this.raw(`1 0 0 1 ${n(at.x)} ${n(at.y)} Tm`);
    this.raw(`${encodeFontText(font, str)} Tj`);
    this.raw("ET");
    return this;
  }

  /** Text rotated `deg` degrees counter-clockwise about its own origin. */
  rotatedText(font: PDFFont, size: number, at: Pt, deg: number, str: string): this {
    if (!str) return this;
    const name = this.res.fontName(font);
    const r = (deg * Math.PI) / 180;
    const cos = Math.cos(r);
    const sin = Math.sin(r);
    this.raw("BT");
    this.raw(`/${name} ${n(size)} Tf`);
    this.raw(`${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} ${n(at.x)} ${n(at.y)} Tm`);
    this.raw(`${encodeFontText(font, str)} Tj`);
    this.raw("ET");
    return this;
  }

  image(image: PDFImage, x: number, y: number, w: number, h: number): this {
    const name = this.res.imageName(image);
    this.save();
    this.transform(w, 0, 0, h, x, y);
    this.raw(`/${name} Do`);
    this.restore();
    return this;
  }

  /**
   * A line ending (arrow head, dot, square…) at `at`, pointing along `angle`
   * radians. Sized from the stroke width the way Acrobat does.
   */
  lineEnding(
    kind: "none" | "arrow" | "openArrow" | "circle" | "square" | "diamond" | "butt" | "slash",
    at: Pt,
    angle: number,
    strokeWidth: number,
    filled: boolean,
  ): this {
    if (kind === "none") return this;
    const s = Math.max(4, strokeWidth * 3.2);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const rot = (p: Pt): Pt => ({ x: at.x + p.x * cos - p.y * sin, y: at.y + p.x * sin + p.y * cos });
    switch (kind) {
      case "arrow":
      case "openArrow": {
        const tip = rot({ x: 0, y: 0 });
        const a = rot({ x: -s, y: s * 0.42 });
        const b = rot({ x: -s, y: -s * 0.42 });
        this.moveTo(a).lineTo(tip).lineTo(b);
        if (kind === "arrow" && filled) { this.closePath().fillStroke(); } else { this.stroke(); }
        break;
      }
      case "circle":
        this.ellipse(at.x, at.y, s * 0.45, s * 0.45);
        if (filled) this.fillStroke(); else this.stroke();
        break;
      case "square": {
        const h = s * 0.42;
        this.polyline([rot({ x: -h, y: -h }), rot({ x: h, y: -h }), rot({ x: h, y: h }), rot({ x: -h, y: h })], true);
        if (filled) this.fillStroke(); else this.stroke();
        break;
      }
      case "diamond": {
        const h = s * 0.5;
        this.polyline([rot({ x: -h, y: 0 }), rot({ x: 0, y: -h }), rot({ x: h, y: 0 }), rot({ x: 0, y: h })], true);
        if (filled) this.fillStroke(); else this.stroke();
        break;
      }
      case "butt": {
        const h = s * 0.5;
        this.moveTo(rot({ x: 0, y: -h })).lineTo(rot({ x: 0, y: h })).stroke();
        break;
      }
      case "slash": {
        const h = s * 0.55;
        this.moveTo(rot({ x: -h * 0.5, y: -h })).lineTo(rot({ x: h * 0.5, y: h })).stroke();
        break;
      }
    }
    return this;
  }
}

/**
 * Encode a string for a `Tj` operator with the given font, dropping characters
 * the font cannot represent rather than throwing — one stray glyph must never
 * abort a whole export.
 */
export function encodeFontText(font: PDFFont, str: string): string {
  try {
    return font.encodeText(str).toString();
  } catch {
    const safe = [...str].filter((ch) => {
      try { font.encodeText(ch); return true; } catch { return false; }
    }).join("");
    try {
      return font.encodeText(safe).toString();
    } catch {
      return "()";
    }
  }
}

/** Width of `str`, falling back to a rough estimate for unencodable text. */
export function measure(font: PDFFont, str: string, size: number): number {
  try {
    return font.widthOfTextAtSize(str, size);
  } catch {
    return str.length * size * 0.5;
  }
}

/**
 * Greedy word wrap. Returns the laid-out lines; explicit `\n` always breaks,
 * and a word longer than the column is split so nothing overflows silently.
 */
export function wrapText(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  const width = maxWidth > 1 ? maxWidth : 1;
  for (const para of text.split("\n")) {
    if (!para) { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/(\s+)/)) {
      if (!word) continue;
      const candidate = line + word;
      if (measure(font, candidate, size) <= width || !line.trim()) {
        if (measure(font, candidate, size) > width && !line) {
          // A single word wider than the column: hard-split it.
          let chunk = "";
          for (const ch of word) {
            if (measure(font, chunk + ch, size) > width && chunk) { out.push(chunk); chunk = ch; }
            else chunk += ch;
          }
          line = chunk;
          continue;
        }
        line = candidate;
      } else {
        out.push(line.replace(/\s+$/, ""));
        line = word.trimStart();
      }
    }
    out.push(line.replace(/\s+$/, ""));
  }
  return out;
}

/** Read a page's existing `/Resources` so a flattening painter can extend it. */
export function pageResourcesDict(page: PDFPage): PDFDict | undefined {
  const r = page.node.Resources();
  return r;
}

export { PDFName, PDFNumber, PDFRef };
