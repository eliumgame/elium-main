/**
 * Editing the PDF's own text — for real, the way Acrobat does it.
 *
 * The paragraph's original glyphs are removed from the content stream (also
 * inside the form XObjects that draw them), then the paragraph is laid out
 * again: soft line breaks reflow, hard ones stay, every styled stretch keeps
 * its own font resource, size and colour, a bold word stays bold, justified
 * text stays justified, first-line and hanging indents stay. A word the
 * original (subset) font cannot show is set in a substitute face — that word
 * only, never the whole paragraph.
 *
 * When the original text cannot be found where the edit says, nothing is
 * removed and nothing is drawn: the edit is reported `skipped` (no duplicate
 * text over the original).
 */

import { PDFArray, PDFDict, PDFName, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import type { PDFDocument, PDFFont, PDFPage } from "pdf-lib";
import type { Op, Operand, Placement, TextState } from "../core/contentstream";
import { walkText, writeContentStream } from "../core/contentstream";
import type { FontMetrics } from "../core/fontmetrics";
import type { Rect } from "../core/coords";
import { round } from "../core/coords";
import type { ContentEdit, TextSpan, TextSpanStyle } from "../model/types";
import { glyphBoxes, readPageContent, writePageContent } from "./content";
import type { PageFrame } from "./annots-pdf";
import type { FontBook } from "./fonts";
import { sanitiseForFont } from "./fonts";
import { PageResources, hexToRgb } from "./painter";
import type { PageScan, ScannedGlyph, ScannedRule, TextScope } from "./textblocks";
import { analyseShow, scanPage, xobjectOf } from "./textblocks";

export interface TextEditReport {
  /** Blocks rewritten using the document's own font(s) only. */
  native: number;
  /** Blocks where at least one word needed a substituted font. */
  substituted: number;
  /** Blocks whose original text could no longer be located (page changed): left as they are. */
  skipped: number;
  /** Characters no available font could show (dropped from the file). */
  missing: string[];
}

export interface ApplyTextOptions {
  /**
   * The page's scan when already known (`cachedScan` of the source the page
   * was copied from): the operators and fonts are then not read again.
   */
  scan?: PageScan;
}

/** Re-encode codes into show bytes for a font. */
function encodeCodes(codes: readonly number[], font: FontMetrics | undefined): Uint8Array {
  const wide = (font?.codeBytes ?? 1) === 2;
  const out = new Uint8Array(codes.length * (wide ? 2 : 1));
  codes.forEach((c, i) => {
    if (wide) {
      out[i * 2] = (c >> 8) & 0xff;
      out[i * 2 + 1] = c & 0xff;
    } else out[i] = c & 0xff;
  });
  return out;
}

/** What `'` and `"` do before showing text (a line move and `"`'s spacings), for the show replacing them. */
function lineMoveOf(op: Op): Op[] {
  if (op.op === "'") return [{ op: "T*", args: [] }];
  if (op.op === '"' && op.args.length >= 3)
    return [
      { op: "Tw", args: [op.args[0]] },
      { op: "Tc", args: [op.args[1]] },
      { op: "T*", args: [] },
    ];
  return [];
}

const NORM = (s: string) => s.normalize("NFKC").replace(/\s+/g, "");

/** Share of `a`'s characters found in `b` (as a multiset). */
function coverage(a: string, b: string): number {
  if (!a.length) return 1;
  const pool = new Map<string, number>();
  for (const ch of b) pool.set(ch, (pool.get(ch) ?? 0) + 1);
  let hit = 0;
  for (const ch of a) {
    const n = pool.get(ch) ?? 0;
    if (n > 0) {
      hit++;
      pool.set(ch, n - 1);
    }
  }
  return hit / a.length;
}

/** Glyphs whose text cannot be trusted (no ToUnicode, private use…). */
function unknownShare(gs: readonly ScannedGlyph[]): number {
  if (!gs.length) return 0;
  return gs.filter((g) => !g.text || /[-�\u0000-\u001F]/.test(g.text)).length / gs.length;
}

/** Unit vectors of a glyph's writing direction and of its "up". */
function axes(g: ScannedGlyph): { d: { x: number; y: number }; u: { x: number; y: number } } {
  const m = Math.hypot(g.ux, g.uy) || 1;
  const u = { x: g.ux / m, y: g.uy / m };
  return { d: { x: u.y, y: -u.x }, u };
}

/**
 * Glyphs grouped into visual lines (same direction and baseline), each cut
 * where words are further apart than an em — table cells, a date on the
 * right of an address line — top line first.
 */
function segments(glyphs: readonly ScannedGlyph[]): { line: number; glyphs: ScannedGlyph[] }[] {
  const lines: { d: { x: number; y: number }; u: { x: number; y: number }; base: number; gs: ScannedGlyph[] }[] = [];
  for (const g of glyphs) {
    const { d, u } = axes(g);
    const base = g.x * u.x + g.y * u.y;
    const line = lines.find(
      (l) => Math.abs(l.d.x - d.x) < 0.02 && Math.abs(l.d.y - d.y) < 0.02 && Math.abs(l.base - base) < g.size * 0.3,
    );
    if (line) line.gs.push(g);
    else lines.push({ d, u, base, gs: [g] });
  }
  lines.sort((a, b) => b.base - a.base);
  const out: { line: number; glyphs: ScannedGlyph[] }[] = [];
  lines.forEach((l, li) => {
    const along = (g: ScannedGlyph) => g.x * l.d.x + g.y * l.d.y;
    l.gs.sort((a, b) => along(a) - along(b));
    let seg: ScannedGlyph[] = [];
    let end = -Infinity;
    for (const g of l.gs) {
      const a = along(g);
      if (seg.length && a - end > g.size * 1.0) {
        out.push({ line: li, glyphs: seg });
        seg = [];
      }
      seg.push(g);
      end = Math.max(end, a + Math.hypot(g.ax, g.ay));
    }
    if (seg.length) out.push({ line: li, glyphs: seg });
  });
  return out;
}

/**
 * The glyphs of the paragraph an edit replaces: those whose middle lies in the
 * block's box, minus pieces of other text the box happens to cover (checked
 * against the text the block had). null when what is there is not that text.
 */
function locate(
  edit: ContentEdit,
  scan: PageScan,
  frame: PageFrame,
  taken: ReadonlySet<ScannedGlyph>,
): ScannedGlyph[] | null {
  const r = frame.rectToPdf(edit.rect);
  const hit = { x0: r.x - 1, y0: r.y - 1, x1: r.x + r.w + 1, y1: r.y + r.h + 1 };
  const cands = scan.glyphs.filter((g) => {
    if (taken.has(g)) return false;
    const cx = g.x + g.ax / 2 + g.ux * 0.3;
    const cy = g.y + g.ay / 2 + g.uy * 0.3;
    return cx >= hit.x0 && cx <= hit.x1 && cy >= hit.y0 && cy <= hit.y1;
  });
  if (!cands.length) return null;
  const orig = NORM(edit.original ?? "");
  const kept: ScannedGlyph[] = [];
  for (const seg of segments(cands)) {
    const text = NORM(seg.glyphs.map((g) => g.text).join(""));
    if (
      !orig ||
      !text ||
      orig.includes(text) ||
      unknownShare(seg.glyphs) > 0.3 ||
      coverage(text, orig) >= 0.8
    ) {
      kept.push(...seg.glyphs);
    }
  }
  if (!kept.length) return null;
  if (orig && unknownShare(kept) <= 0.3) {
    const got = NORM(kept.map((g) => g.text).join(""));
    if (coverage(orig, got) < 0.6) return null;
  }
  return kept;
}

/** The thin rules (underline, strike-through) drawn with these glyphs. */
function decorationsOf(glyphs: readonly ScannedGlyph[], rules: readonly ScannedRule[]): ScannedRule[] {
  const out: ScannedRule[] = [];
  for (const rule of rules) {
    const mid = (rule.box.y0 + rule.box.y1) / 2;
    const h = rule.box.y1 - rule.box.y0;
    let covered = 0;
    let width = 0;
    for (const g of glyphs) {
      if (Math.abs(g.ux) > 0.01 * g.size || g.uy <= 0) continue;
      const x0 = g.x;
      const x1 = g.x + g.ax;
      const ov = Math.min(rule.box.x1, x1) - Math.max(rule.box.x0, x0);
      if (ov <= 0) continue;
      if (h > g.size * 0.15 + 0.5) continue;
      const under = mid < g.y && mid >= g.y - g.size * 0.3;
      const through = mid > g.y + g.size * 0.12 && mid < g.y + g.size * 0.45;
      if (!under && !through) continue;
      covered += ov;
      width = Math.max(width, g.size);
    }
    const len = rule.box.x1 - rule.box.x0;
    // Mostly under / through this text, not a table border running past it.
    if (covered > 0 && covered >= len * 0.6 - width * 0.5) out.push(rule);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

type Face =
  | { native: true; font: FontMetrics; res: string; key: string }
  | { native: false; font: PDFFont; res: string; key: string };

interface Frag {
  text: string;
  bytes: Uint8Array;
  face: Face;
  size: number;
  color: string;
  underline: boolean;
  strike: boolean;
  width: number;
}

interface Tok {
  kind: "word" | "space" | "nl";
  frags: Frag[];
  width: number;
}

interface LaidRun {
  face: Face;
  size: number;
  color: string;
  underline: boolean;
  strike: boolean;
  x: number;
  y: number;
  width: number;
  bytes: Uint8Array[];
}

/** Width of a native string, from the font's own metrics. */
function nativeWidth(font: FontMetrics, bytes: Uint8Array, size: number): number {
  let w = 0;
  for (const c of font.decode(bytes)) w += (font.widthOf(c) / 1000) * size;
  return w;
}

function subWidth(font: PDFFont, text: string, size: number): number {
  try {
    return font.widthOfTextAtSize(text, size);
  } catch {
    return text.length * size * 0.5;
  }
}

function hexBytes(font: PDFFont, text: string): Uint8Array {
  try {
    const h = font.encodeText(text) as unknown as { asBytes(): Uint8Array };
    return h.asBytes();
  } catch {
    return new Uint8Array(0);
  }
}

interface LayoutBox {
  /** Left edge, local space. */
  x: number;
  /** Width lines are positioned in (alignment, justification). */
  w: number;
  /** Width lines wrap at (≥ w: what the original lines needed, measured as we measure). */
  wrap: number;
  /** First baseline, local space (y up). */
  baseline: number;
}

/**
 * Lay out a paragraph (tokens already measured) into positioned runs and
 * decorations: greedy wrap across style boundaries, hard breaks, first-line /
 * hanging indent, left / centre / right / justified lines.
 */
function layout(
  toks: readonly Tok[],
  box: LayoutBox,
  align: ContentEdit["align"],
  indent: { first: number; rest: number },
  leading: number,
): LaidRun[] {
  const EPS = 0.5;
  interface Line {
    items: Tok[];
    width: number;
    paraStart: boolean;
    paraEnd: boolean;
  }
  const lines: Line[] = [];
  let cur: Line = { items: [], width: 0, paraStart: true, paraEnd: false };
  let pending: Tok[] = [];
  const avail = (l: Line) => box.wrap - (l.paraStart ? indent.first : indent.rest);
  const hasWord = (l: Line) => l.items.some((t) => t.kind === "word");
  const close = (paraEnd: boolean) => {
    cur.paraEnd = paraEnd;
    lines.push(cur);
    cur = { items: [], width: 0, paraStart: paraEnd, paraEnd: false };
    pending = [];
  };
  const place = (t: Tok) => {
    for (const p of pending) {
      cur.items.push(p);
      cur.width += p.width;
    }
    pending = [];
    cur.items.push(t);
    cur.width += t.width;
  };
  for (const t of toks) {
    if (t.kind === "nl") {
      close(true);
      continue;
    }
    if (t.kind === "space") {
      if (hasWord(cur)) pending.push(t);
      else if (cur.paraStart) place(t); // spaces typed at the start of a paragraph
      continue;
    }
    const spaceW = pending.reduce((s, p) => s + p.width, 0);
    if (hasWord(cur) && cur.width + spaceW + t.width > avail(cur) + EPS) close(false);
    if (!hasWord(cur) && t.width > avail(cur) + EPS) {
      // A word wider than the column: cut it, character by character.
      for (const piece of splitWord(t, avail(cur))) {
        if (hasWord(cur)) close(false);
        place(piece);
      }
      continue;
    }
    place(t);
  }
  close(true);

  const out: LaidRun[] = [];
  lines.forEach((line, li) => {
    const ind = line.paraStart ? indent.first : indent.rest;
    let items = line.items;
    while (items.length && items[items.length - 1].kind === "space") items = items.slice(0, -1);
    const lw = items.reduce((s, t) => s + t.width, 0);
    const room = box.w - ind;
    let x =
      align === "center"
        ? box.x + ind + (room - lw) / 2
        : align === "right"
          ? box.x + box.w - lw
          : box.x + ind;
    let extra = 0;
    if (align === "justify" && !line.paraEnd) {
      const gaps = items.filter((t, i) => t.kind === "space" && i > 0).length;
      if (gaps > 0 && room > lw) extra = (room - lw) / gaps;
    }
    const y = box.baseline - li * leading;
    for (const t of items) {
      for (const f of t.frags) {
        const last = out[out.length - 1];
        const contiguous =
          last &&
          last.face.key === f.face.key &&
          Math.abs(last.size - f.size) < 1e-6 &&
          last.color === f.color &&
          last.underline === f.underline &&
          last.strike === f.strike &&
          Math.abs(last.y - y) < 1e-6 &&
          Math.abs(last.x + last.width - x) < 1e-6;
        if (contiguous) {
          last.bytes.push(f.bytes);
          last.width += f.width;
        } else {
          out.push({ ...f, x, y, bytes: [f.bytes] });
        }
        x += f.width;
      }
      if (t.kind === "space") x += extra;
    }
  });
  return out;
}

/** A word cut into pieces no wider than `max` (at least one character each). */
function splitWord(t: Tok, max: number): Tok[] {
  const out: Tok[] = [];
  let cur: Frag[] = [];
  let w = 0;
  for (const f of t.frags) {
    const chars = [...f.text];
    const per = f.width / Math.max(1, chars.length);
    // Proportional estimate per character: exact enough to cut an over-long word.
    let piece = "";
    let pieceW = 0;
    const flush = () => {
      if (!piece) return;
      cur.push({ ...f, text: piece, width: pieceW, bytes: sliceBytes(f, piece) });
      w += pieceW;
      piece = "";
      pieceW = 0;
    };
    for (const ch of chars) {
      if (w + pieceW + per > max && (cur.length || piece)) {
        flush();
        out.push({ kind: "word", frags: cur, width: w });
        cur = [];
        w = 0;
      }
      piece += ch;
      pieceW += per;
    }
    flush();
  }
  if (cur.length) out.push({ kind: "word", frags: cur, width: w });
  return out;
}

function sliceBytes(f: Frag, text: string): Uint8Array {
  if (f.face.native) return f.face.font.encode(text) ?? new Uint8Array(0);
  return hexBytes(f.face.font, text);
}

// ---------------------------------------------------------------------------
// Applying edits
// ---------------------------------------------------------------------------


function rgbOperands(hex: string): Operand[] {
  const c = hexToRgb(hex);
  return [c.r, c.g, c.b].map((v) => ({ t: "num", v: round(v, 4) }) as Operand);
}

/** Reference counts of every indirect object, to tell a form only this page draws. */
function refCounts(doc: PDFDocument): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (o: unknown) => {
    if (o instanceof PDFRef) {
      const k = o.toString();
      counts.set(k, (counts.get(k) ?? 0) + 1);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) visit(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) visit(o.get(i));
    } else if (o instanceof PDFStream) visit(o.dict);
  };
  for (const [, obj] of doc.context.enumerateIndirectObjects()) visit(obj);
  return counts;
}

/** A form stream with `ops` as its content (same dictionary otherwise). */
function formStream(doc: PDFDocument, of: PDFRawStream, ops: readonly Op[]): PDFRawStream {
  const dict: Record<string, unknown> = {};
  for (const [k, v] of of.dict.entries()) {
    const name = k.asString();
    if (name !== "/Length" && name !== "/Filter" && name !== "/DecodeParms") dict[name.slice(1)] = v;
  }
  return doc.context.flateStream(writeContentStream(ops), dict as never);
}

/** Put `ref` in a resource dictionary's /XObject under a fresh name. */
function addXObject(doc: PDFDocument, res: PDFDict, ref: PDFRef): string {
  let dict = res.lookup(PDFName.of("XObject"));
  if (!(dict instanceof PDFDict)) {
    dict = doc.context.obj({});
    res.set(PDFName.of("XObject"), dict as PDFDict);
  }
  const d = dict as PDFDict;
  let n = 1;
  while (d.get(PDFName.of(`FxE${n}`))) n++;
  d.set(PDFName.of(`FxE${n}`), ref);
  return `FxE${n}`;
}

/**
 * Apply every content edit belonging to `page`. Coordinates in the edits are
 * page space; `frame` converts them to the PDF user space the operators use.
 */
export async function applyTextEdits(
  doc: PDFDocument,
  page: PDFPage,
  edits: readonly ContentEdit[],
  frame: PageFrame,
  fontBook: FontBook,
  options: ApplyTextOptions = {},
): Promise<TextEditReport> {
  const report: TextEditReport = { native: 0, substituted: 0, skipped: 0, missing: [] };
  if (!edits.length) return report;

  let scan: PageScan;
  try {
    scan = options.scan ?? (await scanPage(page));
  } catch {
    report.skipped = edits.filter((e) => !e.isNew).length;
    return report;
  }

  // --- the target document's resources for each scope (the page may be a copy of the scanned one)
  const pageRes = page.node.Resources() instanceof PDFDict ? (page.node.Resources() as PDFDict) : null;
  const targets = new Map<TextScope, { res: PDFDict | null; stream: PDFRawStream | null; ref: PDFRef | null }>();
  const resolve = (s: TextScope): { res: PDFDict | null; stream: PDFRawStream | null; ref: PDFRef | null } | null => {
    if (targets.has(s)) return targets.get(s)!;
    let t: { res: PDFDict | null; stream: PDFRawStream | null; ref: PDFRef | null } | null = null;
    if (!s.parent) t = { res: pageRes, stream: null, ref: null };
    else {
      const up = resolve(s.parent);
      const xo = up ? xobjectOf(up.res, s.name) : null;
      if (xo) {
        const own = xo.stream.dict.lookup(PDFName.of("Resources"));
        t = { res: own instanceof PDFDict ? own : (up?.res ?? null), stream: xo.stream, ref: xo.ref };
      }
    }
    if (t) targets.set(s, t);
    return t;
  };

  // --- what each edit removes ------------------------------------------------
  const taken = new Set<ScannedGlyph>();
  const doomed = new Map<TextScope, Map<number, Set<number>>>();
  const doomedRules = new Map<TextScope, ScannedRule[]>();
  const plans: { edit: ContentEdit; glyphs: ScannedGlyph[] | null }[] = [];
  for (const edit of edits) {
    if (edit.isNew) {
      plans.push({ edit, glyphs: null });
      continue;
    }
    const found = locate(edit, scan, frame, taken);
    if (!found || found.some((g) => !resolve(g.scope))) {
      report.skipped++;
      continue;
    }
    for (const g of found) {
      taken.add(g);
      let byOp = doomed.get(g.scope);
      if (!byOp) doomed.set(g.scope, (byOp = new Map()));
      let set = byOp.get(g.opIndex);
      if (!set) byOp.set(g.opIndex, (set = new Set()));
      set.add(g.index);
    }
    for (const rule of decorationsOf(found, scan.rules)) {
      if (!resolve(rule.scope)) continue;
      const list = doomedRules.get(rule.scope) ?? [];
      if (!list.includes(rule)) list.push(rule);
      doomedRules.set(rule.scope, list);
    }
    plans.push({ edit, glyphs: found });
  }

  // --- the new text ------------------------------------------------------------
  const emitted: Op[] = [];
  const res = new PageResources(page);
  const nativeNames = new Map<string, string | null>();
  /** The page-level resource name a scanned font can be used under, or null. */
  const pageFontName = (key: string): string | null => {
    if (nativeNames.has(key)) return nativeNames.get(key)!;
    let name: string | null = null;
    const slash = key.lastIndexOf("/");
    if (slash < 0) name = key;
    else {
      const path = key.slice(0, slash);
      const fontName = key.slice(slash + 1);
      const scope = findScope(scan.root, path);
      const t = scope ? resolve(scope) : null;
      const fonts = t?.res?.lookup(PDFName.of("Font"));
      const raw = fonts instanceof PDFDict ? fonts.get(PDFName.of(fontName)) : undefined;
      try {
        const ref = raw instanceof PDFRef ? raw : raw instanceof PDFDict ? doc.context.register(raw) : null;
        if (ref) {
          const own = pageRes?.lookup(PDFName.of("Font"));
          if (own instanceof PDFDict) {
            for (const [k, v] of own.entries()) if (v instanceof PDFRef && v === ref) name = k.asString().slice(1);
          }
          name = name ?? page.node.newFontDictionary("FxF", ref).asString().replace(/^\//, "");
        }
      } catch {
        name = null;
      }
    }
    nativeNames.set(key, name);
    return name;
  };
  const metricsOf = (key: string): FontMetrics | undefined => {
    const slash = key.lastIndexOf("/");
    const scope = slash < 0 ? scan.root : findScope(scan.root, key.slice(0, slash));
    return scope?.fonts.get(slash < 0 ? key : key.slice(slash + 1));
  };

  for (const { edit, glyphs } of plans) {
    if (edit.deleted || !edit.text.trim()) continue;
    const top = glyphs?.length ? topLine(glyphs) : null;
    const first = top?.[0];
    const spans: TextSpan[] = edit.spans?.length
      ? edit.spans
      : [
          {
            text: edit.text,
            style: {
              fontResource: edit.isNew || edit.restyled ? null : (edit.fontResource ?? first?.fontKey ?? null),
              fontFamily: edit.fontFamily,
              bold: !!edit.bold,
              italic: !!edit.italic,
              fontSize: edit.fontSize > 0 ? edit.fontSize : first?.size || 11,
              color: edit.color ?? first?.fill ?? "#000000",
            },
          },
        ];

    // Tokens: words / spaces / hard breaks, each made of per-span pieces.
    interface Piece {
      text: string;
      span: number;
    }
    const rawToks: { kind: Tok["kind"]; pieces: Piece[] }[] = [];
    const chars: { ch: string; span: number }[] = [];
    spans.forEach((s, i) => {
      for (const ch of s.text) chars.push({ ch, span: i });
    });
    const kindOf = (ch: string): Tok["kind"] => (ch === "\n" ? "nl" : /\s/.test(ch) ? "space" : "word");
    for (let i = 0; i < chars.length; i++) {
      const { ch, span } = chars[i];
      const kind = kindOf(ch);
      const last = rawToks[rawToks.length - 1];
      const prevCh = i > 0 ? chars[i - 1].ch : "";
      // A word may break after its hyphen ("auto-" | "entrepreneur").
      const afterHyphen = kind === "word" && /[-‐]/.test(prevCh) && /\p{L}/u.test(ch) && i > 1 && /\p{L}/u.test(chars[i - 2].ch);
      if (last && last.kind === kind && kind !== "nl" && !afterHyphen) {
        const lp = last.pieces[last.pieces.length - 1];
        if (lp.span === span) lp.text += ch;
        else last.pieces.push({ text: ch, span });
      } else rawToks.push({ kind, pieces: [{ text: ch, span }] });
    }

    // Faces: the span's own font for every piece it can encode; a substitute for the others.
    const nativeOf = (st: TextSpanStyle): { font: FontMetrics; res: string; key: string } | null => {
      if (!st.fontResource) return null;
      const font = metricsOf(st.fontResource);
      if (!font) return null;
      const name = pageFontName(st.fontResource);
      return name ? { font, res: name, key: `n:${st.fontResource}` } : null;
    };
    const natives = spans.map((s) => nativeOf(s.style));
    const needSub = spans.map(() => "");
    for (const t of rawToks) {
      for (const p of t.pieces) {
        if (t.kind === "nl") continue;
        const nf = natives[p.span];
        if (!nf || nf.font.encode(p.text) === null) needSub[p.span] += p.text;
      }
    }
    const subs = await Promise.all(
      spans.map(async (s, i) => {
        if (!needSub[i]) return null;
        const got = await fontBook.forText(s.style.fontFamily ?? edit.fontFamily, !!s.style.bold, !!s.style.italic, needSub[i]);
        if (got.missing) report.missing.push(got.missing);
        return { font: got.font, unicode: got.unicode, res: res.fontName(got.font) };
      }),
    );
    let substituted = false;
    const toks: Tok[] = [];
    for (const t of rawToks) {
      if (t.kind === "nl") {
        toks.push({ kind: "nl", frags: [], width: 0 });
        continue;
      }
      const frags: Frag[] = [];
      for (const p of t.pieces) {
        const st = spans[p.span].style;
        const size = st.fontSize > 0 ? st.fontSize : 11;
        const common = { size, color: st.color || "#000000", underline: !!st.underline, strike: !!st.strike };
        const nf = natives[p.span];
        const bytes = nf ? nf.font.encode(p.text) : null;
        if (nf && bytes) {
          frags.push({
            ...common,
            text: p.text,
            bytes,
            face: { native: true, font: nf.font, res: nf.res, key: nf.key },
            width: nativeWidth(nf.font, bytes, size),
          });
          continue;
        }
        const sub = subs[p.span];
        if (!sub) continue;
        const text = sanitiseForFont(p.text, sub.unicode);
        if (!text) continue;
        substituted = true;
        frags.push({
          ...common,
          text,
          bytes: hexBytes(sub.font, text),
          face: { native: false, font: sub.font, res: sub.res, key: `s:${sub.res}` },
          width: subWidth(sub.font, text, size),
        });
      }
      if (frags.length) toks.push({ kind: t.kind, frags, width: frags.reduce((s, f) => s + f.width, 0) });
    }

    // Where: the frame of the original text (rotated text stays rotated), its box, its first baseline.
    const firstSize = Math.max(...spans.slice(0, 1).map((s) => s.style.fontSize || 11));
    let M: number[] | null = null;
    let box: LayoutBox;
    const rectPdf = frame.rectToPdf(edit.rect);
    const target = frame.rectToPdf(edit.placement ?? edit.rect);
    const resized = !!edit.placement && Math.abs(edit.placement.w - edit.rect.w) > 0.5;
    if (glyphs?.length && first) {
      const { d, u } = axes(first);
      const rotated = Math.abs(u.x) > 0.01 || u.y < 0;
      const loc = (x: number, y: number) => (rotated ? { x: x * d.x + y * d.y, y: x * u.x + y * u.y } : { x, y });
      const delta = loc(target.x - rectPdf.x, target.y + target.h - (rectPdf.y + rectPdf.h));
      let x0: number;
      let w: number;
      let topY: number;
      if (rotated) {
        M = [d.x, d.y, u.x, u.y, 0, 0];
        const pts = glyphs.map((g) => ({ a: loc(g.x, g.y), b: loc(g.x + g.ax, g.y + g.ay), s: g.size }));
        x0 = Math.min(...pts.map((p) => Math.min(p.a.x, p.b.x)));
        w = Math.max(...pts.map((p) => Math.max(p.a.x, p.b.x))) - x0;
        topY = Math.max(...pts.map((p) => p.a.y + p.s * 0.84));
        if (edit.placement) w = edit.placement.w;
      } else {
        x0 = rectPdf.x;
        w = target.w;
        topY = rectPdf.y + rectPdf.h;
      }
      const base0 = top!.reduce((s, g) => s + loc(g.x, g.y).y, 0) / top!.length;
      const size0 = top!.reduce((s, g) => s + g.size, 0) / top!.length;
      const ratio = size0 > 0 && Math.abs(firstSize - size0) > 0.05 ? firstSize / size0 : 1;
      const baseline = topY - (topY - base0) * ratio + delta.y;
      const natural = resized ? 0 : naturalWidth(glyphs, axes(first).d);
      box = { x: x0 + delta.x, w, wrap: Math.max(w, natural + 0.05), baseline };
    } else {
      box = { x: target.x, w: target.w, wrap: target.w, baseline: target.y + target.h - firstSize * 0.84 };
    }

    const leading = edit.leading > 0 ? edit.leading : firstSize * 1.2;
    const indent = edit.indent ?? { first: 0, rest: 0 };
    const runs = layout(toks, box, edit.align, indent, leading);
    if (!runs.length) continue;

    const invisible = !!glyphs?.length && glyphs.every((g) => g.renderMode === 3 || g.renderMode === 7);
    const ops: Op[] = [{ op: "q", args: [] }];
    if (M) ops.push({ op: "cm", args: M.map(num) });
    ops.push({ op: "BT", args: [] });
    if (invisible) ops.push({ op: "Tr", args: [num(3)] });
    let curFont = "";
    let curColor = "";
    for (const r of runs) {
      const fk = `${r.face.res}@${r.size}`;
      if (fk !== curFont) {
        ops.push({ op: "Tf", args: [{ t: "name", v: r.face.res }, num(r.size)] });
        curFont = fk;
      }
      if (r.color !== curColor) {
        ops.push({ op: "rg", args: rgbOperands(r.color) });
        curColor = r.color;
      }
      ops.push({ op: "Tm", args: [1, 0, 0, 1, r.x, r.y].map(num) });
      const total = r.bytes.reduce((s, b) => s + b.length, 0);
      const all = new Uint8Array(total);
      let at = 0;
      for (const b of r.bytes) {
        all.set(b, at);
        at += b.length;
      }
      ops.push({ op: "Tj", args: [{ t: "hex", v: all }] });
    }
    ops.push({ op: "ET", args: [] });
    for (const r of runs) {
      if (invisible || (!r.underline && !r.strike)) continue;
      const th = Math.max(0.4, r.size * 0.05);
      ops.push({ op: "rg", args: rgbOperands(r.color) });
      if (r.underline) ops.push({ op: "re", args: [r.x, r.y - r.size * 0.12 - th / 2, r.width, th].map(num) });
      if (r.strike) ops.push({ op: "re", args: [r.x, r.y + r.size * 0.28 - th / 2, r.width, th].map(num) });
      ops.push({ op: "f", args: [] });
    }
    ops.push({ op: "Q", args: [] });
    emitted.push(...ops);
    if (substituted) report.substituted++;
    else report.native++;
  }

  // --- rewrite the content: forms first (copied, or rewritten when only this page draws them)
  let counts: Map<string, number> | null = null;
  const exclusive = (s: TextScope): boolean => {
    const t = resolve(s);
    if (!s.parent || !t?.ref) return false;
    counts = counts ?? refCounts(doc);
    if ((counts.get(t.ref.toString()) ?? 0) !== 1) return false;
    // Drawn once by its parent, whose resources are its own…
    const draws = s.parent.ops.filter((o) => o.op === "Do" && o.args[0]?.t === "name" && o.args[0].v === s.name);
    if (draws.length !== 1) return false;
    const holder = s.parent.parent ? resolve(s.parent)?.stream?.dict : page.node;
    if (!holder || !ownedResources(holder, counts)) return false;
    // …and that parent is itself only this page's.
    return !s.parent.parent || exclusive(s.parent);
  };

  const rewritten = (s: TextScope): Op[] | null => {
    const reps = new Map<number, Op[] | null>();
    const byOp = doomed.get(s);
    if (byOp) {
      for (const [opIndex, set] of byOp) {
        const show = s.ops[opIndex];
        const showRep = removeGlyphs(s, opIndex, show, set);
        if (showRep) reps.set(opIndex, showRep);
      }
    }
    for (const rule of doomedRules.get(s) ?? []) for (let i = rule.from; i <= rule.to; i++) reps.set(i, null);
    for (const child of s.children) {
      const next = rewritten(child);
      if (!next) continue;
      const t = resolve(child);
      const up = resolve(s);
      if (!t?.stream || !up?.res) continue;
      const stream = formStream(doc, t.stream, next);
      if (t.ref && exclusive(child)) {
        doc.context.assign(t.ref, stream);
        targets.set(child, { ...t, stream });
      } else {
        const ref = doc.context.register(stream);
        const name = addXObject(doc, up.res, ref);
        reps.set(child.doIndex, [{ op: "Do", args: [{ t: "name", v: name }] }]);
        targets.set(child, { ...t, stream, ref });
      }
    }
    if (!reps.size) return null;
    const next: Op[] = [];
    for (let i = 0; i < s.ops.length; i++) {
      if (!reps.has(i)) {
        next.push(s.ops[i]);
        continue;
      }
      const rep = reps.get(i);
      if (rep) next.push(...rep);
    }
    return next;
  };

  const body = rewritten(scan.root);
  if (body || emitted.length) {
    const ops = body ?? scan.root.ops;
    const isolate = emitted.length > 0 && !leavesDefaultState(ops);
    writePageContent(doc, page, isolate ? [...isolated(ops), ...emitted] : [...ops, ...emitted]);
  }
  return report;
}

function findScope(s: TextScope, path: string): TextScope | null {
  if (s.path === path) return s;
  for (const c of s.children) {
    const hit = findScope(c, path);
    if (hit) return hit;
  }
  return null;
}

/** The top line's glyphs (highest baseline in the text's own direction). */
function topLine(glyphs: readonly ScannedGlyph[]): ScannedGlyph[] {
  const segs = segments(glyphs);
  const first = segs.filter((s) => s.line === 0).flatMap((s) => s.glyphs);
  return first.length ? first : glyphs.slice(0, 1);
}

/**
 * The widest original line as the layout measures it (font widths, no kerning
 * nor justification, one space per gap): wrapping at least that wide puts the
 * unchanged words back on the lines they were on.
 */
function naturalWidth(glyphs: readonly ScannedGlyph[], d: { x: number; y: number }): number {
  const byLine = new Map<number, ScannedGlyph[]>();
  for (const seg of segments(glyphs)) {
    const l = byLine.get(seg.line) ?? [];
    l.push(...seg.glyphs);
    byLine.set(seg.line, l);
  }
  let max = 0;
  for (const line of byLine.values()) {
    const along = (g: ScannedGlyph) => g.x * d.x + g.y * d.y;
    line.sort((a, b) => along(a) - along(b));
    let end = line.length;
    while (end > 0 && !line[end - 1].text.trim()) end--;
    let w = 0;
    for (let i = 0; i < end; i++) {
      const g = line[i];
      w += g.natural;
      if (i > 0) {
        const p = line[i - 1];
        const gap = along(g) - (along(p) + Math.hypot(p.ax, p.ay));
        // A word gap drawn by moving, not by a space glyph: the layout puts a space there.
        if (gap > g.size * 0.12 && p.text.trim() && g.text.trim()) w += g.size * 0.25;
      }
    }
    max = Math.max(max, w);
  }
  return max;
}

/** Does `holder` (a page or a form) have resources of its own, not shared with anything else? */
function ownedResources(holder: PDFDict, counts: Map<string, number>): boolean {
  const raw = holder.get(PDFName.of("Resources"));
  if (!raw) return false;
  let res: unknown = raw;
  if (raw instanceof PDFRef) {
    if ((counts.get(raw.toString()) ?? 0) !== 1) return false;
    res = holder.lookup(PDFName.of("Resources"));
  }
  if (!(res instanceof PDFDict)) return false;
  const xo = res.get(PDFName.of("XObject"));
  return !(xo instanceof PDFRef) || (counts.get(xo.toString()) ?? 0) === 1;
}

/** A show operator with some of its glyphs removed (the others stay exactly where they were). */
function removeGlyphs(s: TextScope, opIndex: number, op: Op, gone: ReadonlySet<number>): Op[] | null {
  const state = showState(s, opIndex);
  if (!state) return null;
  const font = state.font ? s.fonts.get(state.font) : undefined;
  const { codes, tj } = analyseShow(op, font);
  if (!codes.length) return null;
  const boxes = glyphBoxes(codes, font, state.size, state.charSpacing, state.wordSpacing, state.hScale, state.rise, [1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0], tj);
  const denom = state.size * state.hScale || 1;
  const items: Operand[] = [];
  let run: number[] = [];
  let skip = 0;
  const flushRun = () => {
    if (run.length) {
      items.push({ t: "hex", v: encodeCodes(run, font) });
      run = [];
    }
  };
  const flushSkip = () => {
    if (Math.abs(skip) < 1e-9) return;
    items.push({ t: "num", v: -(skip * 1000) / denom });
    skip = 0;
  };
  for (const g of boxes) {
    const adj = tj.get(g.index);
    if (adj) {
      flushRun();
      skip += (-adj / 1000) * state.size * state.hScale;
    }
    if (gone.has(g.index)) {
      flushRun();
      skip += g.advance;
    } else {
      flushSkip();
      run.push(g.code);
    }
  }
  // Trailing TJ adjustment after the last glyph.
  const tail = tj.get(codes.length);
  if (tail) skip += (-tail / 1000) * state.size * state.hScale;
  flushRun();
  flushSkip();
  return [...lineMoveOf(op), { op: "TJ", args: [{ t: "arr", v: items }] }];
}

const stateCache = new WeakMap<TextScope, Map<number, TextState>>();

/** The text state of each show of a scope (cached: a scan is reused across previews). */
function showState(s: TextScope, opIndex: number): TextState | undefined {
  let m = stateCache.get(s);
  if (!m) {
    m = new Map();
    for (const show of walkText(s.ops)) m.set(show.opIndex, show.state);
    stateCache.set(s, m);
  }
  return m.get(opIndex);
}

/**
 * True when the content ends as it began: no `q` left open, no `cm`, clip or
 * extended state still in force. Anything appended to such a stream is drawn in plain page space.
 */
export function leavesDefaultState(ops: readonly Op[]): boolean {
  // Operators whose effect outlives them and would move, clip or blend what follows.
  const LASTING = new Set(["cm", "W", "W*", "gs"]);
  let depth = 0;
  let dirty = false;
  for (const { op } of ops) {
    if (op === "q") depth++;
    else if (op === "Q") depth = Math.max(0, depth - 1);
    else if (depth === 0 && LASTING.has(op)) dirty = true;
  }
  return depth === 0 && !dirty;
}

/** `ops` inside `q … Q`, so what follows starts from the default state. */
export function isolated(ops: readonly Op[]): Op[] {
  return [{ op: "q", args: [] }, ...ops, { op: "Q", args: [] }];
}

/** An XObject placement of a page, as the image editor lists it (same order as `ImageEdit.occurrence`). */
export interface PagePlacement {
  occurrence: number;
  name: string;
  /** An image (not a form XObject: those are not edited as pictures). */
  isImage: boolean;
  /** Corners in PDF user space (unit square under the CTM). */
  corners: { x: number; y: number }[];
  /** Part of the picture the content's clip leaves visible (fractions, top-left), if cut. */
  crop?: Rect;
}

/** Every named XObject drawn by the page's own content, in draw order. */
export async function pagePlacements(page: PDFPage): Promise<PagePlacement[]> {
  const { ops } = await readPageContent(page);
  const { walkPlacements } = await import("../core/contentstream");
  const { PDFDict, PDFName, PDFStream } = await import("pdf-lib");
  const xobjects = page.node.Resources()?.lookup(PDFName.of("XObject"));
  return walkPlacements(ops)
    .filter((p) => p.name !== null)
    .map((p, occurrence) => {
      const x = xobjects instanceof PDFDict ? xobjects.lookup(PDFName.of(p.name!)) : undefined;
      const isImage = x instanceof PDFStream && x.dict.lookup(PDFName.of("Subtype"))?.toString() === "/Image";
      return { occurrence, name: p.name!, isImage, corners: p.corners, crop: clipCrop(p) };
    });
}

/** The bounding box of a placement, PDF user space. */
function boundsOfPlacement(p: Placement): Rect {
  const xs = p.corners.map((c) => c.x);
  const ys = p.corners.map((c) => c.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/**
 * What the clip in force leaves of a picture, as the editor's crop
 * (fractions of the frame, top-left origin); undefined when nothing is cut.
 */
export function clipCrop(p: Placement): Rect | undefined {
  if (!p.clip) return undefined;
  const f = boundsOfPlacement(p);
  if (f.w <= 0 || f.h <= 0) return undefined;
  const x0 = Math.max(f.x, p.clip.x0);
  const y0 = Math.max(f.y, p.clip.y0);
  const x1 = Math.min(f.x + f.w, p.clip.x1);
  const y1 = Math.min(f.y + f.h, p.clip.y1);
  if (x1 <= x0 || y1 <= y0) return { x: 0, y: 0, w: 0, h: 0 };
  const c = { x: (x0 - f.x) / f.w, y: (f.y + f.h - y1) / f.h, w: (x1 - x0) / f.w, h: (y1 - y0) / f.h };
  const tol = 0.5 / Math.max(f.w, f.h);
  return c.x < tol && c.y < tol && c.w > 1 - 2 * tol && c.h > 1 - 2 * tol ? undefined : c;
}

/** Operators that set lasting graphics or text state (replayed to rebuild a state). */
const STATE_OPS = new Set([
  "cm",
  "w",
  "J",
  "j",
  "M",
  "d",
  "ri",
  "i",
  "gs",
  "CS",
  "cs",
  "SC",
  "SCN",
  "sc",
  "scn",
  "G",
  "g",
  "RG",
  "rg",
  "K",
  "k",
  "Tc",
  "Tw",
  "Tz",
  "TL",
  "Tf",
  "Tr",
  "Ts",
]);
const PATH_BUILD = new Set(["m", "l", "c", "v", "y", "h", "re"]);
const PATH_END = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);

/**
 * The graphics state in force just before op `at`, as the operators that
 * rebuild it: one list per open `q` level, outermost (the top level) first.
 * Clips come back as their path + `W n`; closed `q … Q` blocks are left out,
 * their effect is gone.
 */
export function stateBefore(ops: readonly Op[], at: number): Op[][] {
  const levels: Op[][] = [[]];
  let path: Op[] = [];
  let clip: Op | null = null;
  for (let i = 0; i < at; i++) {
    const o = ops[i];
    if (o.op === "q") levels.push([]);
    else if (o.op === "Q") {
      if (levels.length > 1) levels.pop();
    } else if (PATH_BUILD.has(o.op)) path.push(o);
    else if (o.op === "W" || o.op === "W*") clip = o;
    else if (PATH_END.has(o.op)) {
      if (clip && path.length) levels[levels.length - 1].push(...path, clip, { op: "n", args: [] });
      path = [];
      clip = null;
    } else if (STATE_OPS.has(o.op)) {
      // Text state set inside BT … ET outlives the text object too.
      levels[levels.length - 1].push(o);
    }
  }
  return levels;
}

/** The affine map taking PDF rect `a` onto PDF rect `b` (a scale + a shift: orientation kept). */
function rectToRect(a: Rect, b: Rect): number[] {
  const sx = a.w ? b.w / a.w : 1;
  const sy = a.h ? b.h / a.h : 1;
  return [sx, 0, 0, sy, b.x - a.x * sx, b.y - a.y * sy];
}

const num = (v: number): Operand => ({ t: "num", v: round(v, 5) });

/**
 * Edit the page's own images, and add new ones to its content: delete (the
 * `Do` goes), replace (a new XObject drawn with the same matrix), move /
 * resize (the draw wrapped in `q M cm … Q`, M taking the old frame onto the
 * new one — a rotated or mirrored original stays so), add (drawn last, over
 * the page content).
 */
export async function applyImageEdits(
  doc: PDFDocument,
  page: PDFPage,
  edits: readonly {
    occurrence: number;
    action: "delete" | "replace" | "move" | "add";
    src?: string;
    rect?: Rect;
    crop?: Rect;
  }[],
  embed: (src: string) => Promise<{ ref: import("pdf-lib").PDFRef } | null>,
): Promise<number> {
  if (!edits.length) return 0;
  const { ops } = await readPageContent(page);
  const { walkPlacements } = await import("../core/contentstream");
  const { pageFrame } = await import("./annots-pdf");
  const frame = pageFrame(page);
  const places = walkPlacements(ops).filter((p) => p.name !== null);
  let changed = 0;
  const replacements = new Map<number, Op[]>();
  const appended: Op[] = [];
  /** A replacement closed the top level too: the content is wrapped in `q … Q` for it. */
  let wrapAll = false;

  for (const edit of edits) {
    if (edit.action === "add") {
      if (!edit.src || !edit.rect) continue;
      const embedded = await embed(edit.src);
      if (!embedded) continue;
      const name = page.node.newXObject("Image", embedded.ref).asString().replace(/^\//, "");
      const r = frame.rectToPdf(edit.rect);
      appended.push(
        { op: "q", args: [] },
        ...clipTo(r, edit.crop),
        { op: "cm", args: [r.w, 0, 0, r.h, r.x, r.y].map(num) },
        { op: "Do", args: [{ t: "name", v: name }] },
        { op: "Q", args: [] },
      );
      changed++;
      continue;
    }
    const place = places[edit.occurrence];
    if (!place) continue;
    if (edit.action === "delete") {
      replacements.set(place.opIndex, []);
      changed++;
      continue;
    }
    let name = place.name!;
    if (edit.action === "replace") {
      if (!edit.src) continue;
      const embedded = await embed(edit.src);
      if (!embedded) continue;
      name = page.node.newXObject("Image", embedded.ref).asString().replace(/^\//, "");
    }
    const draw: Op = { op: "Do", args: [{ t: "name", v: name }] };
    const crop = edit.crop ?? clipCrop(place);
    if (edit.rect || crop) {
      const from = boundsOfPlacement(place);
      const to = edit.rect ? frame.rectToPdf(edit.rect) : from;
      const m = rectToRect(from, to);
      // The clip in force at the Do would still cut the picture where it WAS:
      // close every open level, draw in the default state (same place in the
      // drawing order), then rebuild the state the following operators expect.
      const levels = stateBefore(ops, place.opIndex);
      const top = levels[0].length > 0;
      if (top) wrapAll = true;
      const close = levels.length - 1 + (top ? 1 : 0);
      const reopen: Op[] = [];
      if (top) reopen.push({ op: "q", args: [] }, ...levels[0]);
      for (const level of levels.slice(1)) reopen.push({ op: "q", args: [] }, ...level);
      replacements.set(place.opIndex, [
        ...Array.from({ length: close }, () => ({ op: "Q", args: [] }) as Op),
        { op: "q", args: [] },
        ...clipTo(to, crop),
        // The CTM is the identity here: M applies after the original matrix.
        { op: "cm", args: m.map(num) },
        { op: "cm", args: place.ctm.map(num) },
        draw,
        { op: "Q", args: [] },
        ...reopen,
      ]);
    } else {
      replacements.set(place.opIndex, [draw]);
    }
    changed++;
  }

  if (replacements.size || appended.length) {
    const next: Op[] = [];
    for (let i = 0; i < ops.length; i++) {
      const rep = replacements.get(i);
      if (rep) next.push(...rep);
      else next.push(ops[i]);
    }
    const all = wrapAll ? isolated(next) : next;
    // Added pictures are placed in page space, whatever state the content leaves.
    const body = appended.length && !leavesDefaultState(all) ? isolated(all) : all;
    writePageContent(doc, page, [...body, ...appended]);
  }
  return changed;
}

/**
 * A clip to the visible part of a picture drawn in PDF rect `r`: `crop` is in
 * fractions of the frame, top-left origin (the editor's), PDF's y goes up.
 */
function clipTo(r: Rect, crop: Rect | undefined): Op[] {
  if (!crop) return [];
  const x = r.x + crop.x * r.w;
  const y = r.y + r.h - (crop.y + crop.h) * r.h;
  return [
    { op: "re", args: [x, y, crop.w * r.w, crop.h * r.h].map(num) },
    { op: "W", args: [] },
    { op: "n", args: [] },
  ];
}
