/**
 * The page's text as « Modifier le texte » edits it: paragraphs (soft line
 * breaks joined, hard ones kept), cut into styled stretches that carry what
 * only the content stream knows — the font resource each word is set in and
 * its colour — plus where each glyph of the page is, for the engine that
 * removes and re-lays out a paragraph (`textedit.ts`).
 *
 * Text drawn inside form XObjects is part of it: the walk goes into every
 * form the page draws, with the matrix and the state its caller leaves.
 */

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import type { ClipBox, ColorSpaceLike, Mat, Op, TextState } from "../core/contentstream";
import {
  IDENTITY,
  cmykToRgb,
  initialTextState,
  mul,
  parseContentStream,
  walkPaths,
  walkText,
} from "../core/contentstream";
import type { FontMetrics } from "../core/fontmetrics";
import { decodePDFRawStream, loadFontsFrom, widthFnFor, winAnsiToUnicode } from "../core/fontmetrics";
import type { PdfEngine } from "../core/engine";
import type { TextBlock, TextLine, TextRun } from "../core/text";
import { buildRuns, groupBlocks, groupLines, joinBlock, sameStyle, charRuns } from "../core/text";
import type { TextSpanStyle } from "../model/types";
import { glyphBoxes, readPageContentBytes } from "./content";
import { openCrypt } from "./security";

// ---------------------------------------------------------------------------
// The source document, parsed (and decrypted) once
// ---------------------------------------------------------------------------

const sources = new WeakMap<Uint8Array, Promise<PDFDocument>>();

/** `bytes` parsed with pdf-lib (decrypted with `password`), kept for as long as the bytes live. */
export function sourceDoc(bytes: Uint8Array, password: string | null | undefined): Promise<PDFDocument> {
  let p = sources.get(bytes);
  if (!p) {
    p = (async () => {
      const doc = await PDFDocument.load(bytes, {
        ignoreEncryption: true,
        throwOnInvalidObject: false,
        updateMetadata: false,
      });
      const crypt = openCrypt(doc, password ?? "");
      if (crypt) await crypt.decryptDocument(doc, bytes);
      return doc;
    })();
    p.catch(() => sources.delete(bytes));
    sources.set(bytes, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Scanning a page: every glyph, in page and form content
// ---------------------------------------------------------------------------

/** One content stream drawing text: the page's own, or a form XObject it draws (one per `Do`). */
export interface TextScope {
  /** "" for the page; else the XObject names leading to it ("Fm0", "Fm0/Fm1"). */
  path: string;
  /** XObject name in the parent's resources ("" for the page). */
  name: string;
  ops: Op[];
  fonts: Map<string, FontMetrics>;
  parent: TextScope | null;
  /** Index of the `Do` drawing it, in the parent's operators. */
  doIndex: number;
  children: TextScope[];
}

/** A glyph of the page, PDF user space of the page. */
export interface ScannedGlyph {
  scope: TextScope;
  opIndex: number;
  /** Index of the glyph among the operator's character codes. */
  index: number;
  code: number;
  text: string;
  /** Baseline start. */
  x: number;
  y: number;
  /** Advance (as drawn: spacing and TJ included only up to the glyph itself). */
  ax: number;
  ay: number;
  /** From the baseline to the em top (length: the em size). */
  ux: number;
  uy: number;
  size: number;
  /** Advance of the glyph from its font's widths alone (no Tc / Tw / TJ), points. */
  natural: number;
  /** The font resource, qualified by the forms leading to it ("F1", "Fm0/F1"). */
  fontKey: string | null;
  fill: string;
  renderMode: number;
}

/** A thin horizontal painted path (a rule under or through text). */
export interface ScannedRule {
  scope: TextScope;
  from: number;
  to: number;
  box: ClipBox;
}

export interface PageScan {
  root: TextScope;
  glyphs: ScannedGlyph[];
  rules: ScannedRule[];
}

const MAX_DEPTH = 8;

/** Decoded operators of a stream; null when unreadable. */
function streamOps(s: unknown): Op[] | null {
  try {
    if (s instanceof PDFRawStream) return parseContentStream(decodePDFRawStream(s).decode());
    if (s instanceof PDFStream)
      return parseContentStream((s as unknown as { getContents(): Uint8Array }).getContents());
  } catch {
    /* unreadable */
  }
  return null;
}

/** A form's /Matrix (identity when absent or malformed). */
export function formMatrix(d: PDFDict): Mat {
  const m = d.lookup(PDFName.of("Matrix"));
  if (!(m instanceof PDFArray) || m.size() !== 6) return IDENTITY;
  return [0, 1, 2, 3, 4, 5].map((i) => {
    const v = m.lookup(i);
    return v instanceof PDFNumber ? v.asNumber() : 0;
  }) as Mat;
}

const hex2 = (v: number) =>
  Math.max(0, Math.min(255, Math.round(v * 255)))
    .toString(16)
    .padStart(2, "0");

export function rgbHex(c: { r: number; g: number; b: number }): string {
  return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
}

const nums = (a: unknown): number[] =>
  a instanceof PDFArray
    ? Array.from({ length: a.size() }, (_, i) => {
        const v = a.lookup(i);
        return v instanceof PDFNumber ? v.asNumber() : 0;
      })
    : [];

/** A colour space resource (or name) as `walkText` uses it; null when it has no flat colour. */
function colorSpaceOf(cs: unknown, depth = 0): ColorSpaceLike | null {
  if (depth > 4) return null;
  const gray: ColorSpaceLike = { n: 1, toRgb: (c) => ({ r: c[0] ?? 0, g: c[0] ?? 0, b: c[0] ?? 0 }), initial: [0] };
  const rgb: ColorSpaceLike = {
    n: 3,
    toRgb: (c) => ({ r: c[0] ?? 0, g: c[1] ?? 0, b: c[2] ?? 0 }),
    initial: [0, 0, 0],
  };
  const cmyk: ColorSpaceLike = {
    n: 4,
    toRgb: (c) => cmykToRgb(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0, c[3] ?? 1),
    initial: [0, 0, 0, 1],
  };
  const byCount = (n: number) => (n === 1 ? gray : n === 4 ? cmyk : n === 3 ? rgb : null);
  if (cs instanceof PDFName) {
    const n = cs.asString().slice(1);
    if (n === "DeviceGray" || n === "G" || n === "CalGray") return gray;
    if (n === "DeviceRGB" || n === "RGB" || n === "CalRGB") return rgb;
    if (n === "DeviceCMYK" || n === "CMYK") return cmyk;
    return null;
  }
  if (!(cs instanceof PDFArray) || !cs.size()) return null;
  const kind = cs.lookup(0);
  const k = kind instanceof PDFName ? kind.asString().slice(1) : "";
  switch (k) {
    case "ICCBased": {
      const s = cs.lookup(1);
      const n = s instanceof PDFStream ? s.dict.lookup(PDFName.of("N")) : undefined;
      return byCount(n instanceof PDFNumber ? n.asNumber() : 3);
    }
    case "CalGray":
      return gray;
    case "CalRGB":
      return rgb;
    case "Lab":
      // L* alone, as a grey: good enough to tell dark text from light.
      return {
        n: 3,
        toRgb: (c) => ({ r: (c[0] ?? 0) / 100, g: (c[0] ?? 0) / 100, b: (c[0] ?? 0) / 100 }),
        initial: [0, 0, 0],
      };
    case "Separation":
    case "DeviceN": {
      const names = cs.lookup(1);
      const alt = colorSpaceOf(cs.lookup(2), depth + 1);
      const fn = cs.lookup(3);
      const fnDict = fn instanceof PDFStream ? fn.dict : fn instanceof PDFDict ? fn : null;
      const n = k === "Separation" ? 1 : names instanceof PDFArray ? names.size() : 1;
      const colorants =
        k === "Separation"
          ? [names instanceof PDFName ? names.asString().slice(1) : ""]
          : names instanceof PDFArray
            ? Array.from({ length: names.size() }, (_, i) => String(names.lookup(i)).slice(1))
            : [];
      const type = fnDict?.lookup(PDFName.of("FunctionType"));
      const toRgb = (c: readonly number[]) => {
        if (colorants[0] === "None") return { r: 1, g: 1, b: 1 };
        // An exponential tint transform (the usual spot colour): evaluated.
        if (n === 1 && alt && type instanceof PDFNumber && type.asNumber() === 2 && fnDict) {
          const c0 = nums(fnDict.lookup(PDFName.of("C0")));
          const c1 = nums(fnDict.lookup(PDFName.of("C1")));
          const e = fnDict.lookup(PDFName.of("N"));
          const t = Math.pow(Math.max(0, c[0] ?? 0), e instanceof PDFNumber ? e.asNumber() : 1);
          const from = c0.length ? c0 : Array(alt.n).fill(0);
          const to = c1.length ? c1 : Array(alt.n).fill(1);
          return alt.toRgb(from.map((v, i) => v + t * ((to[i] ?? 1) - v)));
        }
        // Process colorants by name.
        const proc = ["Cyan", "Magenta", "Yellow", "Black"];
        if (colorants.length && colorants.every((x) => proc.includes(x))) {
          const v = [0, 0, 0, 0];
          colorants.forEach((x, i) => (v[proc.indexOf(x)] = c[i] ?? 0));
          return cmykToRgb(v[0], v[1], v[2], v[3]);
        }
        // Anything else: as dark as the strongest ink.
        const t = Math.max(0, ...c.slice(0, n));
        return { r: 1 - t, g: 1 - t, b: 1 - t };
      };
      return { n, toRgb, initial: Array(n).fill(1) };
    }
    case "Indexed": {
      const base = colorSpaceOf(cs.lookup(1), depth + 1);
      const hival = cs.lookup(2);
      const lut = cs.lookup(3);
      let table: Uint8Array | null = null;
      if (lut instanceof PDFStream) {
        try {
          table = lut instanceof PDFRawStream ? decodePDFRawStream(lut).decode() : null;
        } catch {
          table = null;
        }
      } else if (lut && typeof (lut as { asBytes?: () => Uint8Array }).asBytes === "function") {
        table = (lut as unknown as { asBytes(): Uint8Array }).asBytes();
      }
      if (!base || !table) return null;
      const max = hival instanceof PDFNumber ? hival.asNumber() : 255;
      const t = table;
      return {
        n: 1,
        toRgb: (c) => {
          const i = Math.max(0, Math.min(max, Math.round(c[0] ?? 0)));
          return base.toRgb(Array.from({ length: base.n }, (_, j) => (t[i * base.n + j] ?? 0) / 255));
        },
        initial: [0],
      };
    }
    default:
      return null;
  }
}

function colorSpaces(resources: PDFDict | null): (name: string) => ColorSpaceLike | null {
  const dict = resources?.lookup(PDFName.of("ColorSpace"));
  const cache = new Map<string, ColorSpaceLike | null>();
  return (name) => {
    if (cache.has(name)) return cache.get(name)!;
    const cs = dict instanceof PDFDict ? colorSpaceOf(dict.lookup(PDFName.of(name))) : null;
    cache.set(name, cs);
    return cs;
  };
}

/** Character codes of a show operator and its TJ adjustments, by glyph index. */
export function analyseShow(op: Op, font: FontMetrics | undefined): { codes: number[]; tj: Map<number, number> } {
  const codes: number[] = [];
  const tj = new Map<number, number>();
  const push = (bytes: Uint8Array) => codes.push(...(font ? font.decode(bytes) : Array.from(bytes)));
  if (op.op === "TJ") {
    const arr = op.args[op.args.length - 1];
    if (arr?.t === "arr") {
      for (const el of arr.v) {
        if (el.t === "str" || el.t === "hex") push(el.v);
        else if (el.t === "num") tj.set(codes.length, (tj.get(codes.length) ?? 0) + el.v);
      }
    }
  } else {
    const s = op.args[op.args.length - 1];
    if (s && (s.t === "str" || s.t === "hex")) push(s.v);
  }
  return { codes, tj };
}

/** The resources a form draws with: its own, else its caller's. */
function formResources(xo: PDFRawStream | PDFStream, inherited: PDFDict | null): PDFDict | null {
  const own = xo.dict.lookup(PDFName.of("Resources"));
  return own instanceof PDFDict ? own : inherited;
}

/** A named XObject of a resource dictionary, with its reference. */
export function xobjectOf(
  resources: PDFDict | null,
  name: string,
): { stream: PDFRawStream; ref: PDFRef | null } | null {
  const dict = resources?.lookup(PDFName.of("XObject"));
  if (!(dict instanceof PDFDict)) return null;
  const raw = dict.get(PDFName.of(name));
  const stream = dict.lookup(PDFName.of(name));
  if (!(stream instanceof PDFRawStream)) return null;
  return { stream, ref: raw instanceof PDFRef ? raw : null };
}

const isForm = (s: PDFRawStream) => s.dict.lookup(PDFName.of("Subtype"))?.toString() === "/Form";

/** Every glyph the page draws (forms included), with its font, colour and place. Never throws. */
export async function scanPage(page: PDFPage): Promise<PageScan> {
  const resources = page.node.Resources() instanceof PDFDict ? (page.node.Resources() as PDFDict) : null;
  const root: TextScope = {
    path: "",
    name: "",
    ops: parseContentStream(readPageContentBytes(page)),
    fonts: await loadFontsFrom(resources),
    parent: null,
    doIndex: -1,
    children: [],
  };
  const glyphs: ScannedGlyph[] = [];
  const rules: ScannedRule[] = [];

  const visit = async (
    scope: TextScope,
    res: PDFDict | null,
    start: Mat,
    initial: TextState | undefined,
    seen: ReadonlySet<PDFRawStream>,
    depth: number,
  ) => {
    const forms: { name: string; at: number; ctm: Mat; state: TextState }[] = [];
    // One font under several names (pdf-lib names it anew at each drawText): one name for all.
    const alias = new Map<string, string>();
    const fontDict = res?.lookup(PDFName.of("Font"));
    if (fontDict instanceof PDFDict) {
      const firstOf = new Map<string, string>();
      for (const [k, v] of fontDict.entries()) {
        const name = k.asString().slice(1);
        if (!(v instanceof PDFRef)) continue;
        const first = firstOf.get(v.toString());
        if (first) alias.set(name, first);
        else firstOf.set(v.toString(), name);
      }
    }
    const shows = walkText(scope.ops, widthFnFor(scope.fonts), start, {
      colorSpace: colorSpaces(res),
      initial,
      onDo: (at, name, ctm, state) => forms.push({ name, at, ctm, state }),
    });
    for (const show of shows) {
      const font = show.state.font ? scope.fonts.get(show.state.font) : undefined;
      const { codes, tj } = analyseShow(scope.ops[show.opIndex], font);
      if (!codes.length) continue;
      const { size, hScale } = show.state;
      const boxes = glyphBoxes(
        codes,
        font,
        size,
        show.state.charSpacing,
        show.state.wordSpacing,
        hScale,
        show.state.rise,
        show.tm,
        show.ctm,
        tj,
      );
      const fill = rgbHex(show.state.fill);
      const fname = show.state.font ? (alias.get(show.state.font) ?? show.state.font) : null;
      const fontKey = fname ? (scope.path ? `${scope.path}/${fname}` : fname) : null;
      // Unit vectors of text space, scaled to the page (the glyph boxes span -0.22 … 0.84 em).
      for (const g of boxes) {
        const [bl, br, , tl] = g.corners;
        const k = 0.22 / 1.06;
        const ux = (tl.x - bl.x) / 1.06;
        const uy = (tl.y - bl.y) / 1.06;
        const x = bl.x + (tl.x - bl.x) * k;
        const y = bl.y + (tl.y - bl.y) * k;
        const em = Math.hypot(ux, uy);
        const w1000 = font ? font.widthOf(g.code) : 500;
        glyphs.push({
          scope,
          opIndex: show.opIndex,
          index: g.index,
          code: g.code,
          text: font ? font.toUnicode(g.code) : winAnsiToUnicode(g.code),
          x,
          y,
          ax: br.x - bl.x,
          ay: br.y - bl.y,
          ux,
          uy,
          size: em,
          natural: (w1000 / 1000) * em * hScale,
          fontKey,
          fill,
          renderMode: show.state.renderMode,
        });
      }
    }
    for (const p of walkPaths(scope.ops, start)) {
      const w = p.box.x1 - p.box.x0;
      const h = p.box.y1 - p.box.y0;
      if (w >= 2 && h <= 4 && w > h * 3) rules.push({ scope, from: p.from, to: p.to, box: p.box });
    }
    if (depth >= MAX_DEPTH) return;
    for (const f of forms) {
      const xo = xobjectOf(res, f.name);
      if (!xo || !isForm(xo.stream) || seen.has(xo.stream)) continue;
      const ops = streamOps(xo.stream);
      if (!ops) continue;
      const inner = formResources(xo.stream, res);
      const child: TextScope = {
        path: scope.path ? `${scope.path}/${f.name}` : f.name,
        name: f.name,
        ops,
        fonts: await loadFontsFrom(inner),
        parent: scope,
        doIndex: f.at,
        children: [],
      };
      scope.children.push(child);
      await visit(
        child,
        inner,
        mul(formMatrix(xo.stream.dict), f.ctm),
        f.state,
        new Set([...seen, xo.stream]),
        depth + 1,
      );
    }
  };

  try {
    await visit(root, resources, IDENTITY, initialTextState(), new Set(), 0);
  } catch {
    /* what was read so far stands */
  }
  return { root, glyphs, rules };
}

const scans = new WeakMap<PDFDocument, Map<number, Promise<PageScan>>>();

/** `scanPage` of a page of a document that is never modified (a parsed source), cached. */
export function cachedScan(doc: PDFDocument, pageIndex: number): Promise<PageScan> {
  let byPage = scans.get(doc);
  if (!byPage) {
    byPage = new Map();
    scans.set(doc, byPage);
  }
  let p = byPage.get(pageIndex);
  if (!p) {
    p = scanPage(doc.getPage(pageIndex));
    byPage.set(pageIndex, p);
  }
  return p;
}

// ---------------------------------------------------------------------------
// Blocks with styled spans
// ---------------------------------------------------------------------------

interface PageGlyph {
  g: ScannedGlyph;
  /** Baseline start, page space (y down). */
  x: number;
  y: number;
  /** Advance length, points. */
  adv: number;
}

/** What `readTextBlocks` knows of the font resources (BaseFont), by qualified key. */
function baseFontOf(scan: PageScan, key: string | null): string | undefined {
  if (!key) return undefined;
  const slash = key.lastIndexOf("/");
  const path = slash < 0 ? "" : key.slice(0, slash);
  const name = slash < 0 ? key : key.slice(slash + 1);
  const find = (s: TextScope): TextScope | null => {
    if (s.path === path) return s;
    for (const c of s.children) {
      const hit = find(c);
      if (hit) return hit;
    }
    return null;
  };
  const font = find(scan.root)?.fonts.get(name);
  return font?.baseFont ? font.baseFont.replace(/^[A-Z]{6}\+/, "") : undefined;
}

const NORM = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

/**
 * The style of every character of every line of `blocks`, from the content
 * stream's glyphs; the blocks are completed in place (spans, text, align).
 */
function styleBlocks(blocks: TextBlock[], scan: PageScan, toPage: (x: number, y: number) => { x: number; y: number }) {
  const pg: PageGlyph[] = scan.glyphs.map((g) => {
    const p = toPage(g.x, g.y);
    return { g, x: p.x, y: p.y, adv: Math.hypot(g.ax, g.ay) };
  });
  // Coarse rows (page y), for horizontal runs.
  const ROW = 6;
  const rows = new Map<number, PageGlyph[]>();
  for (const q of pg) {
    const k = Math.floor(q.y / ROW);
    let r = rows.get(k);
    if (!r) rows.set(k, (r = []));
    r.push(q);
  }
  const rules = scan.rules.map((r) => {
    const a = toPage(r.box.x0, r.box.y0);
    const b = toPage(r.box.x1, r.box.y1);
    return { x0: Math.min(a.x, b.x), x1: Math.max(a.x, b.x), y0: Math.min(a.y, b.y), y1: Math.max(a.y, b.y) };
  });
  const fontNames = new Map<string, string | undefined>();
  const nameOf = (key: string | null) => {
    if (!key) return undefined;
    if (!fontNames.has(key)) fontNames.set(key, baseFontOf(scan, key));
    return fontNames.get(key);
  };

  /** Glyphs of one pdf.js run, in writing order, with their offset along it. */
  const glyphsOf = (r: TextRun): { q: PageGlyph; t: number }[] => {
    const fs = r.fontSize || 10;
    const horizontal = Math.abs(r.dir.y) < 0.01 && r.dir.x > 0;
    const pool: PageGlyph[] = [];
    if (horizontal) {
      const lo = Math.floor((r.origin.y - fs * 0.4) / ROW);
      const hi = Math.floor((r.origin.y + fs * 0.4) / ROW);
      for (let k = lo; k <= hi; k++) pool.push(...(rows.get(k) ?? []));
    } else pool.push(...pg);
    const out: { q: PageGlyph; t: number }[] = [];
    for (const q of pool) {
      const dx = q.x - r.origin.x;
      const dy = q.y - r.origin.y;
      const perp = Math.abs(dx * r.up.x + dy * r.up.y);
      if (perp > fs * 0.35) continue;
      const t = dx * r.dir.x + dy * r.dir.y;
      if (t < -fs * 0.3 || t > r.width - fs * 0.05) continue;
      out.push({ q, t });
    }
    out.sort((a, b) => a.t - b.t);
    return out;
  };

  /** The glyph (or null) behind each character of a run. */
  const charGlyphs = (r: TextRun): (PageGlyph | null)[] => {
    const cands = glyphsOf(r);
    const res: (PageGlyph | null)[] = Array(r.str.length).fill(null);
    if (!cands.length) return res;
    const gchars: number[] = [];
    cands.forEach((c, i) => {
      for (let k = 0; k < NORM(c.q.g.text).length; k++) gchars.push(i);
    });
    const rchars: number[] = [];
    for (let k = 0; k < r.str.length; k++) {
      const n = NORM(r.str[k]).length;
      for (let j = 0; j < n; j++) rchars.push(k);
    }
    if (gchars.length === rchars.length) {
      rchars.forEach((k, j) => (res[k] = res[k] ?? cands[gchars[j]].q));
    } else {
      const per = r.width / Math.max(1, r.str.length);
      for (let k = 0; k < r.str.length; k++) {
        const pos = per * (k + 0.5);
        let best = cands[0];
        for (const c of cands) if (c.t <= pos) best = c;
        res[k] = best.q;
      }
    }
    // Blanks pdf.js put there take the style of what precedes them.
    for (let k = 0; k < r.str.length; k++) if (/\s/.test(r.str[k])) res[k] = null;
    return res;
  };

  for (const block of blocks) {
    const perLine = block.lines.map((line) => {
      const map = charRuns(line);
      const glyphsByRun = line.runs.map(charGlyphs);
      const styles: TextSpanStyle[] = [];
      let prev: TextSpanStyle | null = null;
      const pending: number[] = [];
      for (let k = 0; k < map.length; k++) {
        const { run: ri, at } = map[k];
        const run = line.runs[ri];
        const q = glyphsByRun[ri][at];
        if (!q) {
          pending.push(k);
          continue;
        }
        const g = q.g;
        const fs = run.fontSize || 10;
        let underline = false;
        let strike = false;
        if (Math.abs(run.dir.y) < 0.01) {
          const lx0 = line.rect.x - fs;
          const lx1 = line.rect.x + line.rect.w + fs;
          for (const u of rules) {
            // A rule running past the line is a border, not a text decoration.
            if (u.x0 < lx0 || u.x1 > lx1) continue;
            const ov = Math.min(u.x1, q.x + q.adv) - Math.max(u.x0, q.x);
            if (ov < q.adv * 0.5) continue;
            const mid = (u.y0 + u.y1) / 2;
            if (u.y1 - u.y0 > fs * 0.15 + 0.5) continue;
            if (mid > q.y && mid <= q.y + fs * 0.3) underline = true;
            else if (mid < q.y - fs * 0.12 && mid > q.y - fs * 0.45) strike = true;
          }
        }
        const fontName = nameOf(g.fontKey) ?? run.baseFont;
        const st: TextSpanStyle = {
          fontResource: g.fontKey,
          ...(fontName ? { fontName } : {}),
          fontFamily: run.fontFamily,
          bold: run.bold || g.renderMode === 2,
          italic: run.italic,
          fontSize: Math.round(fs * 100) / 100,
          color: g.fill,
          ...(underline ? { underline } : {}),
          ...(strike ? { strike } : {}),
        };
        const style: TextSpanStyle = prev && sameStyle(prev, st) ? prev : st;
        for (const p of pending) styles[p] = style;
        pending.length = 0;
        styles[k] = style;
        prev = style;
      }
      // A line with no glyph found: pdf.js' facts, black.
      const fallback =
        prev ??
        ({
          fontResource: null,
          ...(line.runs[0]?.baseFont ? { fontName: line.runs[0].baseFont } : {}),
          fontFamily: line.fontFamily,
          bold: line.bold,
          italic: line.italic,
          fontSize: Math.round(line.fontSize * 100) / 100,
          color: "#000000",
        } as TextSpanStyle);
      for (const p of pending) styles[p] = fallback;
      return styles;
    });
    const soft = block.soft ?? block.lines.slice(1).map(() => false);
    const { text, spans } = joinBlock(block.lines, soft, (li, k) => perLine[li][k], sameStyle);
    block.text = text;
    block.spans = spans;
    const level = Math.abs(block.lines[0].angle) < 0.01;
    if (level && (block.align === "left" || block.align === "justify")) {
      const wrapped = (block.soft ?? []).some(Boolean);
      const byGaps = wrapped ? justifiedByGaps(block, pg) : false;
      if (block.align === "justify" && byGaps === false) block.align = "left";
      else if (block.align === "left" && byGaps === true && flushRight(block)) block.align = "justify";
    }
  }
}

/**
 * How much the word gaps of each wrapped line are stretched: the mean gap
 * between words over the natural width of the space there (1 for text set
 * ragged, clearly more — and varying from line to line — for justified text).
 * null for a line where no gap could be measured.
 */
function gapStretch(block: TextBlock, pg: readonly PageGlyph[]): (number | null)[] {
  const soft = block.soft ?? [];
  const out: (number | null)[] = [];
  for (let i = 0; i < soft.length; i++) {
    if (!soft[i]) continue;
    const l: TextLine = block.lines[i];
    const fs = l.fontSize || 10;
    const inLine = pg
      .filter((q) => Math.abs(q.y - l.origin.y) < fs * 0.3 && q.x >= l.rect.x - 0.5 && q.x <= l.rect.x + l.rect.w + 0.5)
      .sort((a, b) => a.x - b.x);
    const ratios: number[] = [];
    let inkEnd = -Infinity;
    let spaceNatural = 0;
    let spaces = 0;
    for (const q of inLine) {
      if (!q.g.text.trim()) {
        spaceNatural += q.g.natural;
        spaces++;
        continue;
      }
      if (inkEnd > -Infinity) {
        const gap = q.x - inkEnd;
        if (spaces || gap > fs * 0.15) {
          const nat = spaceNatural > 0 ? spaceNatural : fs * 0.278 * Math.max(1, spaces);
          ratios.push(gap / nat);
        }
      }
      inkEnd = q.x + q.adv;
      spaceNatural = 0;
      spaces = 0;
    }
    out.push(ratios.length ? ratios.reduce((s, r) => s + r, 0) / ratios.length : null);
  }
  return out;
}

/**
 * Justified or not, from the word gaps: justified lines have stretched gaps
 * (more than 6 % off the natural space); a ragged paragraph whose wrapped
 * lines happen to end at the same place does not. `null`: cannot tell.
 */
function justifiedByGaps(block: TextBlock, pg: readonly PageGlyph[]): boolean | null {
  const stretch = gapStretch(block, pg).filter((r): r is number => r !== null);
  if (!stretch.length) return null;
  return stretch.some((r) => Math.abs(r - 1) > 0.06);
}

/** Every wrapped line ends at the paragraph's right edge. */
function flushRight(block: TextBlock): boolean {
  const soft = block.soft ?? [];
  const right = Math.max(...block.lines.map((l) => l.rect.x + l.rect.w));
  return soft.every((s, i) => {
    const l = block.lines[i];
    return !s || right - (l.rect.x + l.rect.w) <= Math.max(1, l.fontSize * 0.15);
  });
}

const blockCache = new WeakMap<Uint8Array, Map<number, Promise<TextBlock[]>>>();

/**
 * The editable paragraphs of page `pageIndex` (0-based) of the document `source`,
 * as « Modifier le texte » shows and edits them: soft line breaks joined, hard
 * ones kept as `\n`; `spans` carry each stretch's font resource, BaseFont,
 * family, weight, slant, size, colour (and underline / strike when drawn as
 * rules); `indent` the first-line / hanging indent. `blockKey`s are those of
 * `groupBlocks`. Cached per (source bytes, page). Never throws: when the
 * content stream cannot be read, the spans come from pdf.js alone (black).
 */
export function readTextBlocks(
  engine: PdfEngine,
  source: { bytes: Uint8Array; password?: string | null },
  pageIndex: number,
): Promise<TextBlock[]> {
  let byPage = blockCache.get(source.bytes);
  if (!byPage) {
    byPage = new Map();
    blockCache.set(source.bytes, byPage);
  }
  let p = byPage.get(pageIndex);
  if (!p) {
    p = computeBlocks(engine, source, pageIndex);
    const map = byPage;
    p.catch(() => map.delete(pageIndex));
    byPage.set(pageIndex, p);
  }
  return p;
}

async function computeBlocks(
  engine: PdfEngine,
  source: { bytes: Uint8Array; password?: string | null },
  pageIndex: number,
): Promise<TextBlock[]> {
  let blocks: TextBlock[] = [];
  let transform: number[] = [1, 0, 0, 1, 0, 0];
  try {
    const page = await engine.page(pageIndex);
    const vp = page.getViewport({ scale: 1, rotation: 0 });
    transform = vp.transform as unknown as number[];
    const [tc, fonts] = await Promise.all([engine.text(pageIndex), engine.fonts(pageIndex)]);
    blocks = groupBlocks(groupLines(buildRuns(tc, transform, fonts), tc.items));
  } catch {
    return [];
  }
  if (!blocks.length) return blocks;
  try {
    const doc = await sourceDoc(source.bytes, source.password);
    const scan = await cachedScan(doc, pageIndex);
    const [a, b, c, d, e, f] = transform;
    styleBlocks(blocks, scan, (x, y) => ({ x: a * x + c * y + e, y: b * x + d * y + f }));
  } catch {
    /* pdf.js' facts stand */
  }
  return blocks;
}
