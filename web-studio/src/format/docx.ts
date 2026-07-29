/**
 * DOCX (Office Open XML / WordprocessingML) import & export — dependency-free.
 *
 * The writer builds a valid .docx ZIP with fflate; the reader parses
 * `word/document.xml` with a small built-in XML parser so it works identically
 * in the browser and in Node (tests). Scope: paragraphs, headings, alignment,
 * indentation, bold/italic/underline/strike, hyperlinks, bullet/ordered lists
 * (including real multilevel schemes), blockquotes, code blocks, tables,
 * images/figures (embedded media), page breaks, section breaks, newspaper
 * columns, bookmarks, cross-references, index marks and mail-merge fields.
 * Comment annotations are dropped on export (the annotated text stays), matching
 * the HTML/Markdown exporters.
 *
 * Word-native constructs are emitted as real FIELDS rather than frozen text —
 * `REF`/`PAGEREF` for renvois, `XE` for index marks, `MERGEFIELD` for merge
 * fields, `w:numPr` + `numbering.xml` levels for multilevel lists — so Word
 * renumbers and updates them itself.
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import type { EliumFile, PageSettings, ProseMirrorNode } from "./types";
import { abstractNumXml, matchSchemeId, schemeById, type ListScheme } from "../editor/listSchemes";
import { collectTargetsJson, referenceLabel, type RefDisplay, type RefTarget } from "../editor/crossref";
import { buildIndexJson } from "../editor/indexing";
import { normalizeKind, splitSections, type SectionBreakKind } from "../editor/sections";
import { formatSizeMm } from "./pageSizes";
import { fontResources } from "./embedded-fonts";
import { mergeStyles, stylesXml } from "../editor/styles";
import { collectCaptionsJson, figureTableInstr, figureTableTitle, seqInstr } from "../editor/captions";
import { collectNotesJson, type NoteEntry, type NoteKind } from "../editor/notes";
import { normalizeStops, stopsFromAttrs, tabsXml } from "../editor/tabs";
import { dropCapXml, normalizeWatermark, watermarkVml } from "../editor/ornaments";
import { tablePrXml, vAlignXml } from "../editor/tableStyles";
import { textBoxShapeType, textBoxVml } from "../editor/textBox";
import {
  clampAdj, dashFromOoxml, defaultAdj, emuToMm, kindFromPrst, shapeDef, shapeXml,
} from "../editor/shapes";
import { gridSettingsXml } from "../editor/grid";
import {
  NOTE_PART, noteReferenceXml, noteStylesXml, notePrXml, notesContentTypeXml, notesPartXml,
  notesRelXml,
} from "./docx-notes";

// =========================================================================
// XML helpers
// =========================================================================

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlDecode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

interface XmlEl {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
type XmlNode = XmlEl | { text: string };

function isEl(n: XmlNode): n is XmlEl {
  return (n as XmlEl).name !== undefined;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = xmlDecode(m[2]);
  return out;
}

/** Minimal, tolerant XML parser sufficient for WordprocessingML. */
function parseXml(xml: string): XmlEl {
  xml = xml.replace(/<\?xml[^>]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const root: XmlEl = { name: "#root", attrs: {}, children: [] };
  const stack: XmlEl[] = [root];
  const tagRe = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    const between = xml.slice(last, m.index);
    if (between) {
      const txt = xmlDecode(between);
      stack[stack.length - 1].children.push({ text: txt });
    }
    last = tagRe.lastIndex;
    const [, closing, name, attrStr, selfClose] = m;
    if (closing) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
    } else {
      const el: XmlEl = { name, attrs: parseAttrs(attrStr), children: [] };
      stack[stack.length - 1].children.push(el);
      if (!selfClose) stack.push(el);
    }
  }
  return root;
}

function children(el: XmlEl, name: string): XmlEl[] {
  return el.children.filter((c): c is XmlEl => isEl(c) && c.name === name);
}
function firstChild(el: XmlEl, name: string): XmlEl | undefined {
  return children(el, name)[0];
}
function descendants(el: XmlEl, name: string): XmlEl[] {
  const out: XmlEl[] = [];
  const walk = (n: XmlEl) => {
    for (const c of n.children) {
      if (isEl(c)) {
        if (c.name === name) out.push(c);
        walk(c);
      }
    }
  };
  walk(el);
  return out;
}
function firstDescendant(el: XmlEl, name: string): XmlEl | undefined {
  return descendants(el, name)[0];
}

// =========================================================================
// base64 + image dimensions
// =========================================================================

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/** Probe intrinsic pixel size from PNG/JPEG/GIF bytes (fallback 480×320). */
function imageSize(bytes: Uint8Array): { w: number; h: number } {
  const fallback = { w: 480, h: 320 };
  try {
    // PNG: 8-byte signature, IHDR width/height at offset 16 (big-endian).
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset);
      return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }
    // GIF: logical screen descriptor (little-endian) at offset 6.
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return { w: bytes[6] | (bytes[7] << 8), h: bytes[8] | (bytes[9] << 8) };
    }
    // JPEG: scan for a SOF marker.
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i < bytes.length - 8) {
        if (bytes[i] !== 0xff) { i++; continue; }
        const marker = bytes[i + 1];
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const h = (bytes[i + 5] << 8) | bytes[i + 6];
          const w = (bytes[i + 7] << 8) | bytes[i + 8];
          return { w, h };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

// =========================================================================
// Constants
// =========================================================================

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" ' +
  // VML : indispensable pour les zones de texte et le filigrane. Sans ces deux
  // espaces de noms, Word refuse la partie qui les contient.
  'xmlns:v="urn:schemas-microsoft-com:vml" ' +
  'xmlns:o="urn:schemas-microsoft-com:office:office" ' +
  'xmlns:w10="urn:schemas-microsoft-com:office:word" ' +
  // Les formes voyagent en DrawingML `wps:wsp` avec un repli VML dans un
  // `mc:AlternateContent` : sans `mc` ni `wps`, Word rejette la partie. `wp14`
  // est déclaré parce que `mc:Ignorable` doit nommer des préfixes existants.
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" ' +
  'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" ' +
  'mc:Ignorable="wp14"';

const EMU_PER_PX = 9525;
const MAX_CONTENT_EMU = 6 * 914400; // ~6 inch content width

// =========================================================================
// Writer
// =========================================================================

interface WriteCtx {
  rels: string[]; // relationship XML fragments
  media: Record<string, Uint8Array>; // word/media/<file> -> bytes
  relCount: number;
  drawingId: number;
  changeId: number; // unique w:id per tracked-change (w:ins/w:del) element
  footnotes?: NoteEntry[]; // collectées pour la numérotation et footnotes.xml
  endnotes?: NoteEntry[]; // idem pour endnotes.xml
  /** Une zone de texte a été écrite : le `v:shapetype` doit être déclaré. */
  needsTextBoxType?: boolean;
  /** Identifiants uniques des formes de zone de texte. */
  textBoxSeq: number;
  /** Identifiants uniques des formes (`wp:docPr/@id` doit être unique dans le document). */
  shapeSeq: number;
  /** scheme id (or "#bullet" / "#ordered" for unstyled lists) -> w:numId */
  numIds: Map<string, number>;
  /** <w:abstractNum> fragments, in numbering.xml order */
  abstracts: string[];
  /** unique w:id for bookmarkStart/End pairs */
  bookmarkSeq: number;
  /** anchor id -> the Word bookmark name it was exported under */
  bookmarkNames: Map<string, string>;
  /** names already taken, so a sanitised label never collides */
  usedBookmarks: Set<string>;
  /** referenceable targets of the document, for renvoi label fallbacks */
  targets: RefTarget[];
  /** the document's index, computed once (marks live all over the document) */
  indexGroups: ReturnType<typeof buildIndexJson>;
  /** the document's captions, numbered once (numbers are derived, not stored) */
  captions: ReturnType<typeof collectCaptionsJson>;
}

/**
 * A list with no explicit scheme still needs per-level formats in Word, or every
 * nesting depth would render with the level-0 marker. These two schemes are the
 * app's own defaults — the same cascades the editor CSS shows on screen — so an
 * unstyled list looks identical in Elium and in Word.
 */
const DEFAULT_BULLET_SCHEME = schemeById("bullets")!;
const DEFAULT_ORDERED_SCHEME = schemeById("cascade")!;

/**
 * Allocate (once) the `w:numId` for a list and define its `abstractNum` levels
 * from the scheme table, so Word owns the numbering and renumbers it itself.
 */
function numIdFor(ctx: WriteCtx, scheme: ListScheme | null, kind: "bullet" | "ordered"): number {
  const effective = scheme ?? (kind === "bullet" ? DEFAULT_BULLET_SCHEME : DEFAULT_ORDERED_SCHEME);
  const existing = ctx.numIds.get(effective.id);
  if (existing != null) return existing;
  const id = ctx.numIds.size + 1;
  ctx.numIds.set(effective.id, id);
  ctx.abstracts.push(abstractNumXml(effective, id));
  return id;
}

/** `numbering.xml` for exactly the lists this document used. */
function numberingXml(ctx: WriteCtx): string {
  const nums = [...ctx.numIds.values()]
    .map((id) => `<w:num w:numId="${id}"><w:abstractNumId w:val="${id}"/></w:num>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${ctx.abstracts.join("")}${nums}</w:numbering>`;
}

/** Word bookmark names: ≤40 chars, word characters only, never digit-initial. */
function bookmarkNameFor(ctx: WriteCtx, anchorId: string, label?: string): string {
  const existing = ctx.bookmarkNames.get(anchorId);
  if (existing) return existing;
  let base = (label ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 34);
  if (!base || /^[0-9]/.test(base)) base = base ? `_${base}` : `_Ref${ctx.bookmarkNames.size + 1}`;
  let name = base;
  let n = 2;
  while (ctx.usedBookmarks.has(name)) name = `${base}_${n++}`;
  ctx.usedBookmarks.add(name);
  ctx.bookmarkNames.set(anchorId, name);
  return name;
}

/** A `w:bookmarkStart`/`w:bookmarkEnd` pair wrapping nothing (a point anchor). */
function bookmarkXml(ctx: WriteCtx, name: string): string {
  const id = ++ctx.bookmarkSeq;
  return `<w:bookmarkStart w:id="${id}" w:name="${xmlEsc(name)}"/><w:bookmarkEnd w:id="${id}"/>`;
}

/** A simple Word field with its cached result — `instr` drives the live update. */
function fieldXml(instr: string, cachedText: string, rPr = ""): string {
  const run = cachedText
    ? `<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(cachedText)}</w:t></w:r>`
    : "";
  return `<w:fldSimple w:instr="${xmlEsc(instr)}">${run}</w:fldSimple>`;
}

function addRel(ctx: WriteCtx, type: string, target: string, mode?: string): string {
  const id = `rId${ctx.relCount++}`;
  const ext = mode ? ` TargetMode="${mode}"` : "";
  ctx.rels.push(`<Relationship Id="${id}" Type="${type}" Target="${xmlEsc(target)}"${ext}/>`);
  return id;
}

const hex6 = (v: unknown): string | null => {
  const c = String(v ?? "").replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null;
};

function runProps(marks: { type: string; attrs?: Record<string, unknown> }[]): string {
  const p: string[] = [];
  const has = (t: string) => marks.some((m) => m.type === t);
  const mark = (t: string) => marks.find((m) => m.type === t);
  if (has("bold")) p.push("<w:b/>");
  if (has("italic")) p.push("<w:i/>");
  if (has("strike")) p.push("<w:strike/>");
  // Exposant / indice are Word's `w:vertAlign`.
  if (has("superscript")) p.push('<w:vertAlign w:val="superscript"/>');
  if (has("subscript")) p.push('<w:vertAlign w:val="subscript"/>');
  if (has("code")) p.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
  // textStyle → real colour / font / size (px → half-points = px * 1.5)
  const ts = mark("textStyle");
  // A named character style is referenced, not inlined — Word then shows it in
  // its own styles pane and re-applies it wholesale.
  const charStyleId = String(ts?.attrs?.styleId ?? "");
  if (charStyleId) p.push(`<w:rStyle w:val="${xmlEsc(charStyleId)}"/>`);
  const tsColor = ts ? hex6(ts.attrs?.color) : null;
  if (ts) {
    const a = ts.attrs ?? {};
    const fam = String(a.fontFamily ?? "").split(",")[0].replace(/['"]/g, "").trim();
    if (fam) p.push(`<w:rFonts w:ascii="${xmlEsc(fam)}" w:hAnsi="${xmlEsc(fam)}"/>`);
    const px = parseFloat(String(a.fontSize ?? ""));
    if (px) p.push(`<w:sz w:val="${Math.round(px * 1.5)}"/>`);
    // Word's own names for the rest of the Police dialog.
    if (a.smallCaps) p.push("<w:smallCaps/>");
    if (a.allCaps) p.push("<w:caps/>");
    if (a.doubleStrike) p.push("<w:dstrike/>");
    // Character spacing is in twentieths of a point: px → pt (×0.75) → ×20.
    const spacingPx = parseFloat(String(a.letterSpacing ?? ""));
    if (Number.isFinite(spacingPx) && spacingPx !== 0) p.push(`<w:spacing w:val="${Math.round(spacingPx * 15)}"/>`);
    // Raised/lowered position is in half-points.
    const posPx = parseFloat(String(a.textPosition ?? ""));
    if (Number.isFinite(posPx) && posPx !== 0) p.push(`<w:position w:val="${Math.round(posPx * 1.5)}"/>`);
  }
  // Underline: the style attribute refines it; a link is underlined by default.
  const underlineStyle = String(ts?.attrs?.underlineStyle ?? "");
  const DOCX_UNDERLINE: Record<string, string> = {
    single: "single", double: "double", dotted: "dotted", dashed: "dash", wavy: "wave",
  };
  if (has("underline") || has("link")) {
    p.push(`<w:u w:val="${DOCX_UNDERLINE[underlineStyle] ?? "single"}"/>`);
  }
  // highlight → preset name if no colour, else real fill via shading
  const hl = mark("highlight");
  if (hl) {
    const c = hex6(hl.attrs?.color);
    p.push(c ? `<w:shd w:val="clear" w:color="auto" w:fill="${c}"/>` : '<w:highlight w:val="yellow"/>');
  }
  // colour: textStyle wins; otherwise links are blue
  if (tsColor) p.push(`<w:color w:val="${tsColor}"/>`);
  else if (has("link")) p.push('<w:color w:val="1d4ed8"/>');
  return p.length ? `<w:rPr>${p.join("")}</w:rPr>` : "";
}

/** `w:id`/`w:author`/`w:date` attributes for a w:ins/w:del element. */
function trackAttrs(ctx: WriteCtx, m: { attrs?: Record<string, unknown> }): string {
  const author = String(m.attrs?.author || "Elium");
  const ts = String(m.attrs?.ts || "");
  return `w:id="${++ctx.changeId}" w:author="${xmlEsc(author)}"${ts ? ` w:date="${xmlEsc(ts)}"` : ""}`;
}

function runXml(
  text: string,
  marks: { type: string; attrs?: Record<string, unknown> }[],
  ctx: WriteCtx,
): string {
  if (!text) return "";
  const del = marks.find((m) => m.type === "deletion");
  const ins = marks.find((m) => m.type === "insertion");
  // insertion/deletion are w:ins/w:del WRAPPERS, not run properties.
  const body = marks.filter((m) => m.type !== "insertion" && m.type !== "deletion");
  if (del) {
    // Deleted text uses <w:delText> (not <w:t>) so plain readers that ignore
    // track-changes don't resurrect the removed text.
    const run = `<w:r>${runProps(body)}<w:delText xml:space="preserve">${xmlEsc(text)}</w:delText></w:r>`;
    return `<w:del ${trackAttrs(ctx, del)}>${run}</w:del>`;
  }
  const run = `<w:r>${runProps(body)}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
  return ins ? `<w:ins ${trackAttrs(ctx, ins)}>${run}</w:ins>` : run;
}

/** REF / PAGEREF instruction for a renvoi, per its display mode. */
function refInstr(name: string, display: RefDisplay): string {
  // \h = hyperlink to the bookmark; \p = "above/below" relative position;
  // \n = paragraph number only. These are Word's own switches, so the field
  // updates natively (F9) instead of staying frozen text.
  switch (display) {
    case "page": return ` PAGEREF ${name} \\h `;
    case "aboveBelow": return ` REF ${name} \\p \\h `;
    case "number": return ` REF ${name} \\n \\h `;
    case "full": return ` REF ${name} \\h `;
    case "text":
    default: return ` REF ${name} \\h `;
  }
}

function inlineRuns(node: ProseMirrorNode, ctx: WriteCtx): string {
  return (node.content ?? [])
    .map((c) => {
      if (c.type === "hardBreak") return "<w:r><w:br/></w:r>";
      // Une vraie tabulation Word : c'est `w:tabs` du paragraphe qui dit où elle
      // s'arrête, donc rien à calculer ici.
      if (c.type === "tab") return "<w:r><w:tab/></w:r>";
      // Un vrai appel de note Word, pas un « [1] » en exposant : Word les
      // renumérote, les place en bas de page ou en fin de document, et les
      // expose dans son propre gestionnaire de notes.
      if (c.type === "footnote" || c.type === "endnote") {
        const kind: NoteKind = c.type;
        const pool = (kind === "endnote" ? ctx.endnotes : ctx.footnotes) ?? [];
        const entry = pool.find((f) => f.id === String(c.attrs?.id));
        if (!entry) return "";
        return noteReferenceXml(kind, entry.number);
      }
      // A signet becomes a real Word bookmark (named after its label, so it
      // shows up usefully in Word's own bookmark list).
      if (c.type === "bookmark") {
        const id = String(c.attrs?.id ?? "");
        if (!id) return "";
        return bookmarkXml(ctx, bookmarkNameFor(ctx, id, String(c.attrs?.label ?? "")));
      }
      // A renvoi becomes a REF/PAGEREF field with its current text cached, so it
      // reads correctly before the first update and refreshes natively after.
      if (c.type === "crossReference") {
        const anchor = String(c.attrs?.targetId ?? "");
        if (!anchor) return "";
        const display = (String(c.attrs?.display ?? "text") || "text") as RefDisplay;
        const target = ctx.targets.find((t) => t.anchorId === anchor);
        const cached = String(c.attrs?.cached ?? "") || (target ? referenceLabel(target, display, null) : "");
        const name = bookmarkNameFor(ctx, anchor, target?.kind === "bookmark" ? target.text : "");
        return fieldXml(refInstr(name, display), cached);
      }
      // An index mark becomes an XE field: invisible in the text, and Word can
      // build its own index from it.
      if (c.type === "indexEntry") {
        const term = String(c.attrs?.term ?? "").trim();
        if (!term) return "";
        const sub = String(c.attrs?.sub ?? "").trim();
        // Word's XE syntax separates sub-entries with a colon.
        const entry = sub ? `${term}:${sub}` : term;
        return `<w:fldSimple w:instr="${xmlEsc(` XE "${entry.replace(/"/g, "'")}" `)}"/>`;
      }
      // A merge field becomes a real MERGEFIELD, so Word's own mail merge can
      // drive the document.
      if (c.type === "mergeField") {
        const field = String(c.attrs?.field ?? "").trim();
        if (!field) return "";
        return fieldXml(` MERGEFIELD ${field} \\* MERGEFORMAT `, `«${field}»`);
      }
      if (c.type === "text") {
        const marks = c.marks ?? [];
        const link = marks.find((m) => m.type === "link");
        if (link) {
          const href = String(link.attrs?.href ?? "#");
          const rId = addRel(
            ctx,
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
            href,
            "External",
          );
          return `<w:hyperlink r:id="${rId}">${runXml(c.text ?? "", marks, ctx)}</w:hyperlink>`;
        }
        return runXml(c.text ?? "", marks, ctx);
      }
      return "";
    })
    .join("");
}

/** Word paragraph properties, including the full Paragraphe dialog set. */
function paraProps(opts: {
  style?: string;
  align?: string;
  indent?: number;
  numId?: number;
  ilvl?: number;
  shade?: boolean;
  /** Attributes of the source paragraph/heading node, when there is one. */
  attrs?: Record<string, unknown>;
}): string {
  const p: string[] = [];
  const a = opts.attrs ?? {};
  const px = (v: unknown): number | null => {
    const n = parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : null;
  };
  /** px → twips (1px = 0.75pt = 15 twips). */
  const twips = (v: number) => Math.round(v * 15);

  if (opts.style) p.push(`<w:pStyle w:val="${opts.style}"/>`);
  if (opts.numId != null) p.push(`<w:numPr><w:ilvl w:val="${opts.ilvl ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>`);

  // Enchaînements — Word reads these before spacing/indent.
  if (a.keepNext) p.push("<w:keepNext/>");
  if (a.keepLines) p.push("<w:keepLines/>");
  if (a.pageBreakBefore) p.push("<w:pageBreakBefore/>");

  // Lettrine : `w:framePr` ouvre la séquence de `w:pPr` dans le schéma OOXML.
  const drop = dropCapXml(
    a.dropCap === "drop" || a.dropCap === "margin" ? a.dropCap : "none",
    Number(a.dropCapLines ?? 0),
  );
  if (drop) p.push(drop);

  // Taquets de tabulation : avant les bordures, dans l'ordre du schéma OOXML
  // (`w:tabs` précède `w:pBdr` dans la séquence de `w:pPr`), sans quoi Word
  // signale un document à réparer.
  const tabs = tabsXml(normalizeStops(a.tabStops));
  if (tabs) p.push(tabs);

  // Paragraph borders.
  const borders = a.borders as { top?: boolean; right?: boolean; bottom?: boolean; left?: boolean; color?: string; width?: number } | undefined;
  if (borders) {
    const color = hex6(borders.color) ?? "cbd5e1";
    // w:sz is in eighths of a point: px → pt (×0.75) → ×8.
    const sz = Math.max(2, Math.round((Number(borders.width) || 1) * 6));
    const sides = (["top", "left", "bottom", "right"] as const)
      .filter((s) => borders[s])
      .map((s) => `<w:${s} w:val="single" w:sz="${sz}" w:space="4" w:color="${color}"/>`)
      .join("");
    if (sides) p.push(`<w:pBdr>${sides}</w:pBdr>`);
  }

  // Shading: the code-block flag keeps its dark fill; otherwise the paragraph's.
  const shading = hex6(a.shading);
  if (opts.shade) p.push('<w:shd w:val="clear" w:color="auto" w:fill="0f172a"/>');
  else if (shading) p.push(`<w:shd w:val="clear" w:color="auto" w:fill="${shading}"/>`);

  // Spacing before/after.
  const before = px(a.spaceBefore);
  const after = px(a.spaceAfter);
  if (before != null || after != null) {
    p.push(
      `<w:spacing${before != null ? ` w:before="${twips(before)}"` : ""}${after != null ? ` w:after="${twips(after)}"` : ""}/>`,
    );
  }

  // Indents: level indent, plus first-line or hanging.
  const first = px(a.firstLineIndent);
  const left = opts.indent ? opts.indent * 480 : 0;
  const indentAttrs: string[] = [];
  if (left) indentAttrs.push(`w:left="${left}"`);
  if (first != null && first > 0) indentAttrs.push(`w:firstLine="${twips(first)}"`);
  if (first != null && first < 0) indentAttrs.push(`w:hanging="${twips(-first)}"`);
  if (indentAttrs.length) p.push(`<w:ind ${indentAttrs.join(" ")}/>`);

  if (opts.align && opts.align !== "left") {
    const jc = opts.align === "justify" ? "both" : opts.align;
    p.push(`<w:jc w:val="${jc}"/>`);
  }
  return p.length ? `<w:pPr>${p.join("")}</w:pPr>` : "";
}

function drawingXml(ctx: WriteCtx, src: string, alt: string): string {
  const m = /^data:([^;]+);base64,(.*)$/.exec(src.trim());
  if (!m) return ""; // only embedded (data URL) images are supported
  const mime = m[1].toLowerCase();
  const ext = MIME_EXT[mime] ?? "png";
  const bytes = base64ToBytes(m[2]);
  const idx = Object.keys(ctx.media).length + 1;
  const filename = `image${idx}.${ext}`;
  ctx.media[filename] = bytes;
  const rId = addRel(
    ctx,
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    `media/${filename}`,
  );
  const { w, h } = imageSize(bytes);
  let cx = w * EMU_PER_PX;
  let cy = h * EMU_PER_PX;
  if (cx > MAX_CONTENT_EMU) {
    cy = Math.round((cy * MAX_CONTENT_EMU) / cx);
    cx = MAX_CONTENT_EMU;
  }
  const did = ctx.drawingId++;
  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${did}" name="image${did}" descr="${xmlEsc(alt)}"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${did}" name="image${did}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

/** Where a block sits inside a list: which numbering, at which level, and the
 *  scheme inherited from the outermost list of the tree. */
interface ListCtx {
  numId: number;
  ilvl: number;
  scheme: ListScheme | null;
}

/** The bookmark a renvoi target needs, when one points at this block. */
function anchorXml(node: ProseMirrorNode, ctx: WriteCtx): string {
  const refId = String(node.attrs?.refId ?? "");
  if (!refId) return "";
  return bookmarkXml(ctx, bookmarkNameFor(ctx, refId));
}

function blockXml(node: ProseMirrorNode, ctx: WriteCtx, headings: { level: number; text: string }[], list?: ListCtx): string {
  switch (node.type) {
    case "paragraph":
      return `<w:p>${paraProps({
        ...(node.attrs?.styleId ? { style: String(node.attrs.styleId) } : {}),
        align: String(node.attrs?.textAlign ?? ""),
        indent: Number(node.attrs?.indent) || 0,
        attrs: node.attrs,
        ...(list ? { numId: list.numId, ilvl: list.ilvl } : {}),
      })}${inlineRuns(node, ctx)}</w:p>`;
    case "heading": {
      const level = Math.min(4, Number(node.attrs?.level ?? 1));
      // The paragraph's own named style when it has one, else the built-in for
      // its level — so `w:pStyle` always points at a style styles.xml defines.
      const styleId = String(node.attrs?.styleId ?? "") || `Titre${level}`;
      return `<w:p>${paraProps({ style: styleId, align: String(node.attrs?.textAlign ?? ""), attrs: node.attrs })}${anchorXml(node, ctx)}${inlineRuns(node, ctx)}</w:p>`;
    }
    case "tableOfContents": {
      const items = headings
        .map((h) => `<w:p>${paraProps({ indent: h.level - 1 })}<w:r><w:t xml:space="preserve">${xmlEsc(h.text)}</w:t></w:r></w:p>`)
        .join("");
      return `<w:p>${paraProps({ style: "Heading1" })}<w:r><w:t>Table des matières</w:t></w:r></w:p>${items}`;
    }
    case "bulletList":
    case "orderedList": {
      const kind = node.type === "bulletList" ? "bullet" : "ordered";
      // The scheme lives on the outermost list and is inherited downwards — the
      // same rule the generated CSS follows, so screen and Word agree. It only
      // applies to its own kind: a bullet sublist inside a numbered outline
      // keeps plain bullets.
      const declared = schemeById(node.attrs?.listScheme) ?? list?.scheme ?? null;
      const scheme = declared && declared.kind === kind ? declared : null;
      const numId = numIdFor(ctx, scheme, kind);
      const ilvl = Math.min(8, list ? list.ilvl + 1 : 0);
      const childCtx: ListCtx = { numId, ilvl, scheme: declared };
      return (node.content ?? [])
        .map((li) =>
          (li.content ?? [])
            .map((child) =>
              // Paragraphs become items at this level; a nested list recurses
              // one level deeper. Anything else (a quote, a table…) is written
              // as an ordinary block so it is not numbered as an item.
              child.type === "paragraph" || child.type === "bulletList" || child.type === "orderedList"
                ? blockXml(child, ctx, headings, childCtx)
                : blockXml(child, ctx, headings),
            )
            .join(""),
        )
        .join("");
    }
    case "taskList":
      return (node.content ?? [])
        .map((li) => {
          const box = li.attrs?.checked ? "☒ " : "☐ ";
          const inner = (li.content ?? []).map((c) => inlineRuns(c, ctx)).join("");
          return `<w:p>${paraProps({ indent: 1 })}<w:r><w:t xml:space="preserve">${box}</w:t></w:r>${inner}</w:p>`;
        })
        .join("");
    case "blockquote":
      return (node.content ?? [])
        .map((c) => `<w:p>${paraProps({ indent: 1 })}${inlineRuns(c, ctx)}</w:p>`)
        .join("");
    case "codeBlock": {
      const raw = (node.content ?? []).map((c) => c.text ?? "").join("");
      return raw
        .split("\n")
        .map((line) => `<w:p>${paraProps({ shade: true })}<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:color w:val="e2e8f0"/></w:rPr><w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r></w:p>`)
        .join("");
    }
    case "horizontalRule":
      return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
    case "pageBreak":
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    case "image":
      return `<w:p>${drawingXml(ctx, String(node.attrs?.src ?? ""), String(node.attrs?.alt ?? ""))}</w:p>`;
    case "figure": {
      const align = String(node.attrs?.align ?? "center");
      const img = drawingXml(ctx, String(node.attrs?.src ?? ""), String(node.attrs?.alt ?? ""));
      const caption = (node.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
      const imgP = `<w:p>${paraProps({ align })}${anchorXml(node, ctx)}${img}</w:p>`;
      const capP = caption
        ? `<w:p>${paraProps({ align })}<w:r><w:rPr><w:i/><w:color w:val="64748b"/></w:rPr><w:t xml:space="preserve">${xmlEsc(caption)}</w:t></w:r></w:p>`
        : "";
      return imgP + capP;
    }
    case "table":
      // bookmarkStart/End are valid block-level siblings, so the anchor can sit
      // right before the table without inserting an empty paragraph.
      return anchorXml(node, ctx) + tableXml(node, ctx, headings);
    case "textBox": {
      // Word lit les zones de texte en VML (`v:shape` + `v:textbox`) : c'est un
      // dialecte hérité, mais c'est la forme que toutes les versions ouvrent sans
      // broncher, contrairement à DrawingML dont le support varie. Le contenu est
      // du XML de blocs ordinaire — une zone contient du document normal.
      ctx.needsTextBoxType = true;
      const inner = (node.content ?? []).map((c) => blockXml(c, ctx, headings)).join("");
      return textBoxVml(node.attrs, node.attrs, inner, `EliumTextBox${++ctx.textBoxSeq}`);
    }
    case "shape": {
      // Deux branches dans un `mc:AlternateContent` : DrawingML d'abord — c'est
      // ce qui fait arriver la forme dans Word comme une VRAIE forme préréglée,
      // éditable, et non comme un tracé mort — puis le VML pour les lecteurs qui
      // ignorent `wps`. Le contenu est du XML de blocs ordinaire.
      const inner = (node.content ?? []).map((c) => blockXml(c, ctx, headings)).join("");
      return shapeXml(node.attrs?.kind, node.attrs, node.attrs, inner, ++ctx.shapeSeq, node.attrs?.adj);
    }
    case "columnSection":
      // Columns are section properties in Word, and a `w:sectPr` is only valid
      // on a TOP-LEVEL paragraph — docToDocx handles those boundaries. Reached
      // here only for a nested column block (inside a table cell, say), which
      // Word cannot express at all: the content is written without columns
      // rather than emitting invalid markup.
      return (node.content ?? []).map((c) => blockXml(c, ctx, headings)).join("");
    case "indexBlock":
      return indexXml(ctx);
    case "caption": {
      // Word numbers captions with a SEQ field, so it renumbers them itself when
      // the document is edited there — the label and the text are plain runs.
      const label = String(node.attrs?.label ?? "Figure").replace(/\s+/g, " ").trim() || "Figure";
      const entry = ctx.captions.find((c) => c.label === label && c.text === (node.content ?? []).map((x) => x.text ?? "").join("").replace(/\s+/g, " ").trim());
      const number = entry?.number ?? 1;
      const anchor = anchorXml(node, ctx);
      return (
        `<w:p>${paraProps({ style: "Legende", align: "center", attrs: node.attrs })}${anchor}` +
        `<w:r><w:t xml:space="preserve">${xmlEsc(label)} </w:t></w:r>` +
        fieldXml(seqInstr(label), String(number)) +
        `<w:r><w:t xml:space="preserve"> — </w:t></w:r>` +
        inlineRuns(node, ctx) +
        `</w:p>`
      );
    }
    case "tableOfFigures": {
      // A real TOC field scoped to one caption family, with the rows Elium
      // already computed as its cached result.
      const label = String(node.attrs?.label ?? "");
      const rows = label ? ctx.captions.filter((c) => c.label === label) : ctx.captions;
      const title = figureTableTitle(label);
      const body = rows
        .map(
          (r) =>
            `<w:p>${paraProps({ indent: 1 })}<w:r><w:t xml:space="preserve">${xmlEsc(`${r.label} ${r.number} — ${r.text}`)}</w:t></w:r></w:p>`,
        )
        .join("");
      return (
        `<w:p>${paraProps({ style: "Titre2" })}<w:r><w:t xml:space="preserve">${xmlEsc(title)}</w:t></w:r></w:p>` +
        `<w:p>${fieldXml(figureTableInstr(label || null), "")}</w:p>` +
        body
      );
    }
    case "sectionBreak":
      // Emitted by docToDocx, which owns the section boundaries (a sectPr
      // describes the section it ENDS, so it cannot be produced in isolation).
      return "";
    default:
      return (node.content ?? []).map((c) => blockXml(c, ctx, headings, list)).join("");
  }
}

/** Marks the generated index so a re-import can fold it back into one node. */
const INDEX_BOOKMARK = "_EliumIndex";

/**
 * The generated index, written as ordinary Word paragraphs (letter headings,
 * entries, sub-entries, page numbers) fenced by a marker bookmark.
 *
 * The XE marks in the text are exported too, so a Word user can insert their own
 * INDEX field and let Word rebuild it; these paragraphs are the rendering Elium
 * already computed, so the exported file reads correctly as-is.
 */
function indexXml(ctx: WriteCtx): string {
  const groups = ctx.indexGroups;
  const parts: string[] = [];
  const id = ++ctx.bookmarkSeq;
  parts.push(`<w:bookmarkStart w:id="${id}" w:name="${INDEX_BOOKMARK}"/>`);
  parts.push(`<w:p>${paraProps({ style: "Heading1" })}<w:r><w:t>Index</w:t></w:r></w:p>`);
  for (const group of groups) {
    parts.push(
      `<w:p>${paraProps({ style: "Heading3" })}<w:r><w:t xml:space="preserve">${xmlEsc(group.letter)}</w:t></w:r></w:p>`,
    );
    for (const entry of group.entries) {
      const pages = entry.pages.length ? `\t${entry.pages.join(", ")}` : "";
      parts.push(
        `<w:p>${paraProps({ indent: 1 })}<w:r><w:t xml:space="preserve">${xmlEsc(entry.term + pages)}</w:t></w:r></w:p>`,
      );
      for (const sub of entry.subs) {
        const subPages = sub.pages.length ? `\t${sub.pages.join(", ")}` : "";
        parts.push(
          `<w:p>${paraProps({ indent: 2 })}<w:r><w:t xml:space="preserve">${xmlEsc(sub.term + subPages)}</w:t></w:r></w:p>`,
        );
      }
    }
  }
  parts.push(`<w:bookmarkEnd w:id="${id}"/>`);
  return parts.join("");
}

function tableXml(table: ProseMirrorNode, ctx: WriteCtx, headings: { level: number; text: string }[]): string {
  const rows = table.content ?? [];
  const cols = Math.max(1, ...rows.map((r) => (r.content ?? []).length));
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => '<w:gridCol w:w="2400"/>').join("")}</w:tblGrid>`;
  const body = rows
    .map((row) => {
      const cells = (row.content ?? [])
        .map((cell) => {
          const inner = (cell.content ?? []).map((c) => blockXml(c, ctx, headings)).join("") || "<w:p/>";
          const span = Number(cell.attrs?.colspan ?? 1);
          // L'alignement vertical de la cellule ; « top » est le défaut OOXML et
          // n'a donc pas besoin d'être écrit.
          const tcPr =
            `<w:tcPr><w:tcW w:w="2400" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}` +
            `${vAlignXml(cell.attrs?.vAlign)}</w:tcPr>`;
          return `<w:tc>${tcPr}${inner}</w:tc>`;
        })
        .join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");
  // Filets, ajustement et bandes viennent du style du tableau — et `w:tblLook`
  // avec eux, sans quoi un tableau à lignes alternées s'ouvre uniformément gris.
  const tblPr = tablePrXml(table.attrs?.tableStyle, table.attrs?.tableFit);
  return `<w:tbl>${tblPr}${grid}${body}</w:tbl>`;
}

function collectHeadings(doc: ProseMirrorNode): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  const walk = (n: ProseMirrorNode) => {
    if (n.type === "heading") {
      const level = Number(n.attrs?.level ?? 1);
      if (level <= 3) out.push({ level, text: (n.content ?? []).map((c) => c.text ?? "").join("").trim() || "Sans titre" });
    }
    (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
}

const tw = (mm: number) => Math.round(mm * 56.6929); // mm → twips

/**
 * `word/settings.xml` — les réglages du document.
 *
 * Nouvelle partie du paquet, introduite pour le **quadrillage** : Word garde la
 * grille de dessin dans les réglages, pas dans le corps. L'ordre des éléments est
 * imposé par le schéma (`CT_Settings` est une séquence) — le taquet par défaut et
 * le zoom encadrent la grille exactement là où Word les écrit, sinon la partie est
 * rejetée alors que chaque élément est valide isolément.
 */
function settingsXml(page: PageSettings | undefined): string {
  const grid = (page as { grid?: unknown } | undefined)?.grid;
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<w:settings ${NS}>` +
    '<w:zoom w:percent="100"/>' +
    '<w:defaultTabStop w:val="709"/>' +
    gridSettingsXml(grid) +
    '<w:characterSpacingControl w:val="compressPunctuation"/>' +
    "</w:settings>"
  );
}

/** `w:sectPr` body for one section: page size, margins and numbering restart. */
function sectPrBody(
  page: PageSettings,
  opts: {
    format?: PageSettings["format"];
    orientation?: "portrait" | "landscape";
    customWidthMm?: number;
    customHeightMm?: number;
    margins?: { top: number; right: number; bottom: number; left: number };
    type?: SectionBreakKind;
    restartAt?: number | null;
  } = {},
): string {
  // Real millimetres from the format table, so A3/A5/Legal/Tabloid and custom
  // sheets export at their true size instead of being coerced to A4 or Letter.
  const portrait = formatSizeMm(opts.format ?? page?.format ?? "A4", {
    widthMm: opts.customWidthMm ?? page?.customWidthMm,
    heightMm: opts.customHeightMm ?? page?.customHeightMm,
  });
  const landscape = (opts.orientation ?? page?.orientation) === "landscape";
  const pw = tw(landscape ? portrait.height : portrait.width);
  const ph = tw(landscape ? portrait.width : portrait.height);
  const mg = opts.margins ?? page?.margins ?? { top: 25, right: 20, bottom: 25, left: 20 };
  // The first section has no meaningful type; Word ignores it there anyway.
  const type = opts.type && opts.type !== "nextPage" ? `<w:type w:val="${opts.type}"/>` : "";
  const pgNum = opts.restartAt != null ? `<w:pgNumType w:start="${opts.restartAt}"/>` : "";
  return (
    type +
    `<w:pgSz w:w="${pw}" w:h="${ph}"${landscape ? ' w:orient="landscape"' : ""}/>` +
    `<w:pgMar w:top="${tw(mg.top)}" w:right="${tw(mg.right)}" w:bottom="${tw(mg.bottom)}" w:left="${tw(mg.left)}" w:header="709" w:footer="709" w:gutter="0"/>` +
    pgNum
  );
}

/** Serialize an Elium file to a .docx byte array. */
export function docToDocx(file: EliumFile): Uint8Array {
  const doc = file.document.doc;
  const ctx: WriteCtx = {
    rels: [],
    media: {},
    relCount: 100,
    drawingId: 1,
    changeId: 0,
    numIds: new Map(),
    abstracts: [],
    bookmarkSeq: 0,
    textBoxSeq: 0,
    shapeSeq: 0,
    bookmarkNames: new Map(),
    usedBookmarks: new Set([INDEX_BOOKMARK]),
    targets: collectTargetsJson(doc),
    indexGroups: buildIndexJson(doc),
    captions: collectCaptionsJson(doc),
  };
  const headings = collectHeadings(doc);

  // Les deux familles de notes passent par le collecteur partagé : leur
  // numérotation est ainsi exactement celle affichée à l'écran.
  const footnotes = collectNotesJson(doc, "footnote");
  const endnotes = collectNotesJson(doc, "endnote");
  ctx.footnotes = footnotes;
  ctx.endnotes = endnotes;

  const title = file.manifest.title?.trim();
  const titleP = title
    ? `<w:p>${paraProps({ style: "Heading1" })}<w:r><w:t xml:space="preserve">${xmlEsc(title)}</w:t></w:r></w:p>`
    : "";
  // Sections. In OOXML a `w:sectPr` describes the section it ENDS, and its
  // `w:type` says how THAT section began — so each boundary carries the type of
  // the section closing at it, not the one starting. `currentType` tracks that.
  //
  // Newspaper columns are section properties too: a column block closes the
  // running section as single-column, forms its own section, then closes that
  // one with the column count. Both boundaries are continuous, so nothing
  // page-breaks — including the section that follows, which is why its type has
  // to stay `continuous` as well.
  const page = file.document.page;
  const sections = splitSections(doc, page);
  const blocks = doc.content ?? [];
  const parts: string[] = [];
  let eliumIdx = 0; // index into `sections` (advanced only by real breaks)
  let currentType: SectionBreakKind = "nextPage";

  // Filigrane : Word ne lit pas un filigrane en SVG, il attend une forme VML
  // dans un EN-TÊTE. C'est ce qui le fait apparaître sur toutes les pages.
  const mark = normalizeWatermark(file.document.watermark);
  const markVml = watermarkVml(mark);
  const headerId = markVml ? `rId${ctx.relCount++}` : "";

  // Sans `w:headerReference`, la partie d'en-tête existe mais Word ne l'affiche
  // sur aucune page : le filigrane serait dans le fichier et invisible.
  const headerRef = headerId ? `<w:headerReference w:type="default" r:id="${headerId}"/>` : "";

  // Déclaré une fois : le format de numérotation de chaque famille présente,
  // pour que Word affiche les mêmes marqueurs que l'écran (romains minuscules
  // pour les notes de fin).
  const notePr =
    (footnotes.length ? notePrXml("footnote") : "") + (endnotes.length ? notePrXml("endnote") : "");

  const sectPrFor = (cols: string): string => {
    const setup = sections[eliumIdx]?.setup;
    return `<w:sectPr>${sectPrBody(page, {
      // Each section exports at ITS OWN sheet size and margins, not the
      // document's — that is what makes a landscape or A5 section real in Word.
      format: setup?.format,
      orientation: setup?.orientation,
      customWidthMm: setup?.customWidthMm,
      customHeightMm: setup?.customHeightMm,
      margins: setup?.margins,
      type: currentType,
      restartAt: setup?.restartNumbering ? setup.startAt : null,
    })}${headerRef}${notePr}${cols}</w:sectPr>`;
  };
  const boundary = (cols: string): string => `<w:p><w:pPr>${sectPrFor(cols)}</w:pPr></w:p>`;

  for (const block of blocks) {
    if (block.type === "sectionBreak") {
      parts.push(boundary(""));
      currentType = normalizeKind(block.attrs?.kind);
      eliumIdx += 1;
      continue;
    }
    if (block.type === "columnSection") {
      const count = Math.max(1, Math.min(4, Math.round(Number(block.attrs?.count) || 2)));
      const gapTw = tw(Number(block.attrs?.gapMm) || 8);
      const sep = block.attrs?.separator ? ' w:sep="true"' : "";
      parts.push(boundary('<w:cols w:num="1"/>'));
      currentType = "continuous";
      parts.push((block.content ?? []).map((n) => blockXml(n, ctx, headings)).join(""));
      parts.push(boundary(`<w:cols w:num="${count}" w:space="${gapTw}"${sep}/>`));
      currentType = "continuous";
      continue;
    }
    parts.push(blockXml(block, ctx, headings));
  }
  // Le `v:shapetype` de la zone de texte se déclare UNE fois : sans lui, Word
  // ouvre le fichier mais dessine des formes vides.
  const bodyInner = (ctx.needsTextBoxType ? textBoxShapeType() : "") + parts.join("");
  // Plus de section « Notes » factice dans le corps : les notes vivent dans
  // footnotes.xml / endnotes.xml, donc Word les rend lui-même au bon endroit.
  const notesXml = "";

  // Page setup of the LAST section (format/orientation/margins/numbering).
  const sectPr = sectPrFor("");
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>${titleP}${bodyInner}${notesXml}${sectPr}</w:body></w:document>`;

  // Les parties de notes sont déclarées avant les autres relations, pour que
  // leurs rId restent stables d'un export à l'autre.
  const headerRel = markVml
    ? `<Relationship Id="${headerId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>`
    : "";

  const noteRels =
    (footnotes.length ? notesRelXml("footnote", `rId${ctx.relCount++}`) : "") +
    (endnotes.length ? notesRelXml("endnote", `rId${ctx.relCount++}`) : "");

  const baseRels =
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>' +
    // La partie des réglages porte le quadrillage : sans la relation, Word
    // l'ignore purement et simplement.
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>';
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${baseRels}${headerRel}${noteRels}${ctx.rels.join("")}</Relationships>`;

  const mediaDefaults = Object.keys(ctx.media)
    .map((f) => f.split(".").pop() ?? "png")
    .filter((ext, i, a) => a.indexOf(ext) === i)
    .map((ext) => `<Default Extension="${ext}" ContentType="${EXT_MIME[ext] ?? "image/png"}"/>`)
    .join("");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>${mediaDefaults}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${footnotes.length ? notesContentTypeXml("footnote") : ""}${endnotes.length ? notesContentTypeXml("endnote") : ""}${markVml ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ""}
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${xmlEsc(title ?? "Document")}</dc:title><dc:creator>Elium</dc:creator></cp:coreProperties>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "docProps/core.xml": strToU8(coreXml),
    "word/document.xml": strToU8(documentXml),
    // Real <w:style> definitions, so Word shows the document's styles in ITS
    // own gallery instead of receiving formatting baked into every run.
    "word/styles.xml": strToU8(stylesXml(mergeStyles(file.document.styles as never), noteStylesXml())),
    "word/numbering.xml": strToU8(numberingXml(ctx)),
    // Les réglages : le quadrillage (pas, lignes affichées, origine) y vit.
    "word/settings.xml": strToU8(settingsXml(page)),
    "word/_rels/document.xml.rels": strToU8(documentRels),
  };
  if (markVml) {
    // Le VML vit dans son propre espace de noms : sans les déclarations `v:` et
    // `o:`, Word rejette la partie.
    files["word/header1.xml"] = strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        `<w:hdr ${NS}>` +
        `${markVml}</w:hdr>`,
    );
  }

  // Les vraies parties de notes : Word les renumérote et les place lui-même.
  if (footnotes.length) files[NOTE_PART.footnote] = strToU8(notesPartXml("footnote", footnotes));
  if (endnotes.length) files[NOTE_PART.endnote] = strToU8(notesPartXml("endnote", endnotes));

  for (const [name, bytes] of Object.entries(ctx.media)) files[`word/media/${name}`] = bytes;

  // Embedded typefaces: a real `fontTable.xml` plus one obfuscated font part per
  // family, so Word renders the document in its own fonts on a machine that does
  // not have them installed (previously only the font NAME travelled).
  const fonts = fontResources(file.resourceIndex)
    .map((meta) => ({ meta, bytes: file.resources.get(meta.id) }))
    .filter((f): f is { meta: (typeof f)["meta"]; bytes: Uint8Array } => !!f.bytes)
    // Word only reads `.odttf` (obfuscated TrueType/OpenType) font parts.
    .filter((f) => f.meta.ext === "ttf" || f.meta.ext === "otf");

  if (fonts.length) {
    const fontRels: string[] = [];
    const fontEntries: string[] = [];
    fonts.forEach((f, i) => {
      const guid = fontGuid(f.meta.id);
      const part = `font${i + 1}.odttf`;
      files[`word/fonts/${part}`] = obfuscateFont(f.bytes, guid);
      const rid = `rIdFont${i + 1}`;
      fontRels.push(
        `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/${part}"/>`,
      );
      fontEntries.push(
        `<w:font w:name="${xmlEsc(f.meta.family)}">` +
          `<w:embedRegular r:id="${rid}" w:fontKey="{${guid.toUpperCase()}}"/>` +
          `</w:font>`,
      );
    });
    files["word/fontTable.xml"] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
        `<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${fontEntries.join("")}</w:fonts>`,
    );
    // The font parts and the table hang off document.xml.rels.
    files["word/_rels/document.xml.rels"] = strToU8(
      documentRels.replace(
        "</Relationships>",
        `<Relationship Id="rIdFontTable" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>${fontRels.join("")}</Relationships>`,
      ),
    );
    files["[Content_Types].xml"] = strToU8(
      contentTypes.replace(
        "</Types>",
        `<Default Extension="odttf" ContentType="application/vnd.openxmlformats-officedocument.obfuscatedFont"/>` +
          `<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/></Types>`,
      ),
    );
  }

  return zipSync(files, { level: 6 });
}

/** A stable GUID for a font part, derived from its content hash. */
function fontGuid(resourceId: string): string {
  const hex = (resourceId.replace(/[^0-9a-f]/gi, "") + "0".repeat(32)).slice(0, 32).toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Word's font "obfuscation" (ECMA-376 §15.2.13): the first 32 bytes are XORed
 * with the GUID's bytes, taken in reverse order, twice. It is not encryption —
 * just the format Word insists on for embedded font parts.
 */
function obfuscateFont(bytes: Uint8Array, guid: string): Uint8Array {
  const hex = guid.replace(/-/g, "");
  const key = new Uint8Array(16);
  for (let i = 0; i < 16; i++) key[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  key.reverse();
  const out = new Uint8Array(bytes);
  const n = Math.min(32, out.length);
  for (let i = 0; i < n; i++) out[i] = out[i]! ^ key[i % 16]!;
  return out;
}

// =========================================================================
// Reader
// =========================================================================

const te = (n: XmlEl): string =>
  n.children.map((c) => (isEl(c) ? te(c) : c.text)).join("");

/** Concatenate w:t text of a run-bearing element, honoring w:tab/w:br. */
function runText(el: XmlEl): string {
  let out = "";
  const walk = (n: XmlEl) => {
    for (const c of n.children) {
      if (!isEl(c)) continue;
      if (c.name === "w:t") out += te(c);
      // Word writes tracked-change deletions with <w:delText> instead of
      // <w:t> precisely so plain readers won't resurrect the deleted text —
      // but Elium preserves it (see inlineFromParagraph's w:del handling).
      else if (c.name === "w:delText") out += te(c);
      else if (c.name === "w:tab") out += "\t";
      else if (c.name === "w:br" || c.name === "w:cr") out += "\n";
      else walk(c);
    }
  };
  walk(el);
  return out;
}

interface NumDef {
  kind: "bullet" | "ordered";
  /** The Elium multilevel scheme this numbering matches, when recognised. */
  scheme: string | null;
}
type NumFmtMap = Record<string, NumDef>;

function parseNumbering(zip: Record<string, Uint8Array>): NumFmtMap {
  const out: NumFmtMap = {};
  const raw = zip["word/numbering.xml"];
  if (!raw) return out;
  const root = parseXml(strFromU8(raw));
  const abstractDef: Record<string, NumDef> = {};
  for (const an of descendants(root, "w:abstractNum")) {
    const id = an.attrs["w:abstractNumId"];
    if (!id) continue;
    // Read every level, so a multilevel list authored in Word can be matched
    // back to the matching Elium scheme instead of degrading to a plain list.
    const levels = children(an, "w:lvl")
      .map((lvl) => ({
        ilvl: Number(lvl.attrs["w:ilvl"] ?? 0),
        fmt: firstChild(lvl, "w:numFmt")?.attrs["w:val"] ?? "bullet",
        text: firstChild(lvl, "w:lvlText")?.attrs["w:val"] ?? "",
      }))
      .sort((a, b) => a.ilvl - b.ilvl);
    const first = levels[0];
    abstractDef[id] = {
      kind: (first?.fmt ?? "bullet") === "bullet" ? "bullet" : "ordered",
      scheme: matchSchemeId(levels.map((l) => ({ fmt: l.fmt, text: l.text }))),
    };
  }
  for (const num of descendants(root, "w:num")) {
    const numId = num.attrs["w:numId"];
    const aId = firstChild(num, "w:abstractNumId")?.attrs["w:val"];
    if (numId) out[numId] = (aId != null ? abstractDef[aId] : undefined) ?? { kind: "bullet", scheme: null };
  }
  return out;
}

/** A Word field instruction mapped to the Elium inline node it becomes. */
function fieldNode(instr: string): ProseMirrorNode | null {
  const text = instr.trim();
  let m = /^(PAGEREF|REF)\s+(\S+)((?:\s+\\[a-zA-Z])*)/i.exec(text);
  if (m) {
    const switches = (m[3] ?? "").toLowerCase();
    const display: RefDisplay =
      m[1]!.toUpperCase() === "PAGEREF" ? "page" : switches.includes("\\p") ? "aboveBelow" : switches.includes("\\n") ? "number" : "text";
    return { type: "crossReference", attrs: { targetId: m[2]!, kind: "bookmark", display, cached: "" } };
  }
  m = /^MERGEFIELD\s+"?([^"\\]+?)"?\s*(\\|$)/i.exec(text);
  if (m) return { type: "mergeField", attrs: { field: m[1]!.trim() } };
  m = /^XE\s+"([^"]*)"/i.exec(text);
  if (m) {
    // Word separates an index sub-entry from its parent with a colon.
    const [term, ...rest] = m[1]!.split(":");
    return { type: "indexEntry", attrs: { term: (term ?? "").trim(), sub: rest.join(":").trim() } };
  }
  return null;
}

function relTargets(zip: Record<string, Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = zip["word/_rels/document.xml.rels"];
  if (!raw) return out;
  for (const r of descendants(parseXml(strFromU8(raw)), "Relationship")) {
    if (r.attrs.Id) out[r.attrs.Id] = r.attrs.Target;
  }
  return out;
}

/** Character formatting distilled from a <w:rPr> (inline or from a style). */
interface RunProps {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string; // "#rrggbb"
  fontFamily?: string;
  fontSizeHalf?: number; // raw w:sz value (half-points)
  highlight?: string; // "#rrggbb"
}

// Word's fixed named-highlight palette → approximate hex.
const HIGHLIGHT_HEX: Record<string, string> = {
  yellow: "#fff34d", green: "#4dff4d", cyan: "#4dffff", magenta: "#ff4dff",
  blue: "#4d4dff", red: "#ff4d4d", darkYellow: "#b3b300", darkGreen: "#008000",
  darkCyan: "#008080", darkBlue: "#000080", darkMagenta: "#800080", darkRed: "#800000",
  lightGray: "#c0c0c0", darkGray: "#808080", black: "#000000", white: "#ffffff",
};

/** Read a <w:rPr> element into RunProps (shared by inline runs and styles). */
function parseRunProps(rpr: XmlEl | undefined): RunProps {
  const props: RunProps = {};
  if (!rpr) return props;
  const toggle = (name: string): boolean | undefined => {
    const el = firstChild(rpr, name);
    if (!el) return undefined;
    const v = el.attrs["w:val"];
    return !(v === "false" || v === "0"); // present with no val ⇒ on
  };
  const b = toggle("w:b"); if (b !== undefined) props.bold = b;
  const i = toggle("w:i"); if (i !== undefined) props.italic = i;
  const u = firstChild(rpr, "w:u"); if (u) props.underline = u.attrs["w:val"] !== "none";
  const s = toggle("w:strike"); if (s !== undefined) props.strike = s;
  const color = firstChild(rpr, "w:color")?.attrs["w:val"];
  if (color && /^[0-9a-fA-F]{6}$/.test(color)) props.color = `#${color.toLowerCase()}`;
  const rFonts = firstChild(rpr, "w:rFonts");
  const fam = rFonts?.attrs["w:ascii"] || rFonts?.attrs["w:hAnsi"];
  if (fam) props.fontFamily = fam;
  const sz = Number(firstChild(rpr, "w:sz")?.attrs["w:val"]);
  if (Number.isFinite(sz) && sz > 0) props.fontSizeHalf = sz;
  const hl = firstChild(rpr, "w:highlight")?.attrs["w:val"];
  if (hl && hl !== "none") props.highlight = HIGHLIGHT_HEX[hl] ?? "#fff34d";
  const shdFill = firstChild(rpr, "w:shd")?.attrs["w:fill"];
  if (shdFill && /^[0-9a-fA-F]{6}$/.test(shdFill)) props.highlight = `#${shdFill.toLowerCase()}`;
  return props;
}

/** Later (higher-priority) props override earlier ones. */
function mergeProps(...list: RunProps[]): RunProps {
  const out: RunProps = {};
  for (const p of list)
    for (const k of Object.keys(p) as (keyof RunProps)[]) if (p[k] !== undefined) (out as Record<string, unknown>)[k] = p[k];
  return out;
}

function propsToMarks(p: RunProps): { type: string; attrs?: Record<string, unknown> }[] {
  const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
  if (p.bold) marks.push({ type: "bold" });
  if (p.italic) marks.push({ type: "italic" });
  if (p.underline) marks.push({ type: "underline" });
  if (p.strike) marks.push({ type: "strike" });
  const ts: Record<string, unknown> = {};
  if (p.color) ts.color = p.color;
  if (p.fontFamily) ts.fontFamily = p.fontFamily;
  // w:sz is half-points; the writer used px * 1.5, so invert with / 1.5.
  if (p.fontSizeHalf) ts.fontSize = `${Math.round(p.fontSizeHalf / 1.5)}px`;
  if (Object.keys(ts).length) marks.push({ type: "textStyle", attrs: ts });
  if (p.highlight) marks.push({ type: "highlight", attrs: { color: p.highlight } });
  return marks;
}

/** Resolves paragraph/character style ids to their effective run properties,
 *  following w:basedOn inheritance, over the document's rPr defaults. Real Word
 *  documents carry most colour/font/size on styles rather than inline — without
 *  this, that formatting is silently lost on import. */
interface StyleResolver {
  docDefaults: RunProps;
  styleProps: (styleId: string | undefined) => RunProps;
}

function buildStyleResolver(zip: Record<string, Uint8Array>): StyleResolver {
  const raw = zip["word/styles.xml"];
  const docDefaults: RunProps = {};
  const rprById = new Map<string, RunProps>();
  const basedOn = new Map<string, string>();
  if (raw) {
    const root = parseXml(strFromU8(raw));
    const dd = firstDescendant(root, "w:docDefaults");
    if (dd) Object.assign(docDefaults, parseRunProps(firstDescendant(dd, "w:rPr")));
    for (const st of descendants(root, "w:style")) {
      const id = st.attrs["w:styleId"];
      if (!id) continue;
      rprById.set(id, parseRunProps(firstChild(st, "w:rPr")));
      const base = firstChild(st, "w:basedOn")?.attrs["w:val"];
      if (base) basedOn.set(id, base);
    }
  }
  const cache = new Map<string, RunProps>();
  const resolve = (id: string, seen: Set<string>): RunProps => {
    const cached = cache.get(id);
    if (cached) return cached;
    if (seen.has(id)) return {};
    seen.add(id);
    const base = basedOn.get(id);
    const merged = mergeProps(base ? resolve(base, seen) : {}, rprById.get(id) ?? {});
    cache.set(id, merged);
    return merged;
  };
  return { docDefaults, styleProps: (id) => (id ? resolve(id, new Set()) : {}) };
}

function inlineFromParagraph(
  p: XmlEl,
  rels: Record<string, string>,
  zip: Record<string, Uint8Array>,
  sty: StyleResolver,
  baseProps: RunProps,
): { nodes: ProseMirrorNode[]; pageBreak: boolean; figure?: ProseMirrorNode } {
  // Effective run marks = paragraph base ⊕ the run's character style ⊕ inline
  // rPr (inline wins). This is what recovers colour/font/size set via styles.
  const runMarks = (r: XmlEl): { type: string; attrs?: Record<string, unknown> }[] => {
    const rpr = firstChild(r, "w:rPr");
    const rStyleId = rpr ? firstChild(rpr, "w:rStyle")?.attrs["w:val"] : undefined;
    return propsToMarks(mergeProps(baseProps, sty.styleProps(rStyleId), parseRunProps(rpr)));
  };
  const nodes: ProseMirrorNode[] = [];
  let pageBreak = false;
  let figure: ProseMirrorNode | undefined;

  const pushText = (text: string, marks: { type: string; attrs?: Record<string, unknown> }[]) => {
    if (!text) return;
    nodes.push(marks.length ? { type: "text", text, marks } : { type: "text", text });
  };

  const handleRun = (r: XmlEl, extra: { type: string; attrs?: Record<string, unknown> }[] = []) => {
    // page break?
    for (const br of descendants(r, "w:br")) {
      if (br.attrs["w:type"] === "page") pageBreak = true;
    }
    // Une tabulation devient le nœud `tab`, pas un caractère : sa largeur se
    // recalcule depuis les taquets du paragraphe. Word écrit presque toujours la
    // tabulation seule dans son run (`<w:r><w:tab/></w:r>`), donc la pousser
    // avant le texte du run respecte l'ordre du document.
    for (const _t of children(r, "w:tab")) nodes.push({ type: "tab" });
    // embedded image?
    const blip = firstDescendant(r, "a:blip");
    if (blip && !figure) {
      const embed = blip.attrs["r:embed"] || blip.attrs["r:link"];
      const target = embed ? rels[embed] : undefined;
      if (target) {
        const path = target.startsWith("media/") ? `word/${target}` : `word/${target.replace(/^\/?word\//, "")}`;
        const bytes = zip[path] ?? zip[`word/${target}`];
        if (bytes) {
          const ext = (target.split(".").pop() ?? "png").toLowerCase();
          const mime = EXT_MIME[ext] ?? "image/png";
          figure = {
            type: "figure",
            attrs: { src: `data:${mime};base64,${bytesToBase64(bytes)}`, alt: "", align: "center", width: "" },
            content: [],
          };
        }
      }
    }
    const text = runText(r);
    if (text) pushText(text, [...runMarks(r), ...extra]);
  };

  // Word fields come in two shapes: the self-contained <w:fldSimple>, and the
  // "complex" form spread over fldChar begin / instrText / separate / end runs.
  // Both are mapped to the matching Elium node; the field's cached result runs
  // are dropped, since the node recomputes its own text.
  let fieldDepth = 0;
  let fieldInstr = "";

  for (const c of p.children) {
    if (!isEl(c)) continue;
    if (c.name === "w:r") {
      const fldChar = firstChild(c, "w:fldChar")?.attrs["w:fldCharType"];
      if (fldChar === "begin") {
        fieldDepth += 1;
        if (fieldDepth === 1) fieldInstr = "";
        continue;
      }
      if (fldChar === "end") {
        fieldDepth = Math.max(0, fieldDepth - 1);
        if (fieldDepth === 0) {
          const node = fieldNode(fieldInstr);
          if (node) nodes.push(node);
          fieldInstr = "";
        }
        continue;
      }
      if (fieldDepth > 0) {
        const instr = firstChild(c, "w:instrText");
        if (instr) fieldInstr += te(instr);
        continue; // instruction and cached-result runs alike
      }
      handleRun(c);
    } else if (c.name === "w:fldSimple") {
      const node = fieldNode(c.attrs["w:instr"] ?? "");
      if (node) nodes.push(node);
      // Unknown field: keep its cached text so nothing is silently lost.
      else for (const r of children(c, "w:r")) handleRun(r);
    } else if (c.name === "w:bookmarkStart") {
      // Word litters documents with internal bookmarks (_GoBack, _Toc…) and
      // Elium's own anchors are underscore-prefixed too: only named,
      // user-visible signets are imported.
      const name = c.attrs["w:name"] ?? "";
      if (name && !name.startsWith("_")) {
        nodes.push({ type: "bookmark", attrs: { id: name, label: name } });
      }
    } else if (c.name === "w:hyperlink") {
      const rId = c.attrs["r:id"];
      const href = rId ? rels[rId] : undefined;
      const linkMark = href ? [{ type: "link", attrs: { href } }] : [];
      for (const r of children(c, "w:r")) handleRun(r, linkMark);
    } else if (c.name === "w:ins" || c.name === "w:del") {
      // Real Word documents with track-changes on wrap inserted/deleted runs
      // one level deeper, inside <w:ins>/<w:del> rather than as direct <w:r>
      // children of the paragraph — without this branch that text was never
      // read at all (silent data loss on import). Map to Elium's own
      // insertion/deletion marks (TrackChanges.ts) using the w:author/w:date
      // straight off the element, so track-changes state round-trips too.
      const trackMark = [
        {
          type: c.name === "w:ins" ? "insertion" : "deletion",
          attrs: { author: c.attrs["w:author"] ?? "", ts: c.attrs["w:date"] ?? "" },
        },
      ];
      for (const r of children(c, "w:r")) handleRun(r, trackMark);
      // A tracked change can itself wrap a hyperlink (nested one level further).
      for (const hl of children(c, "w:hyperlink")) {
        const rId = hl.attrs["r:id"];
        const href = rId ? rels[rId] : undefined;
        const linkMark = href ? [{ type: "link", attrs: { href } }] : [];
        for (const r of children(hl, "w:r")) handleRun(r, [...trackMark, ...linkMark]);
      }
    }
  }
  return { nodes, pageBreak, figure };
}

function alignFrom(p: XmlEl): string | undefined {
  const jc = firstDescendant(p, "w:jc")?.attrs["w:val"];
  if (!jc) return undefined;
  return jc === "both" ? "justify" : jc;
}

function paragraphNode(
  p: XmlEl,
  rels: Record<string, string>,
  zip: Record<string, Uint8Array>,
  sty: StyleResolver,
): ProseMirrorNode[] {
  // Une forme ou une zone de texte prend la place du paragraphe qui la porte.
  const floating = floatingFromParagraph(p, rels, zip, sty);
  if (floating) return [floating];

  const ppr = firstChild(p, "w:pPr");
  const style = ppr ? firstChild(ppr, "w:pStyle")?.attrs["w:val"] ?? "" : "";
  // Taquets du paragraphe : relus en millimètres, la même unité que la règle.
  const tabsEl = ppr ? firstChild(ppr, "w:tabs") : undefined;
  const tabStops = tabsEl
    ? stopsFromAttrs(
        children(tabsEl, "w:tab").map((t) => ({
          val: t.attrs["w:val"],
          pos: t.attrs["w:pos"],
          leader: t.attrs["w:leader"],
        })),
      )
    : [];
  const headingMatch = /^Heading(\d)$/i.exec(style) || /^Titre(\d)$/i.exec(style);
  // Base run props inherited by every run: doc defaults, plus the paragraph
  // style's rPr for BODY paragraphs only — headings render their own weight/size
  // via the heading node, so inheriting the heading style's bold/size as marks
  // would double up (inline rPr on a heading run is still honored).
  const baseProps = headingMatch ? sty.docDefaults : mergeProps(sty.docDefaults, sty.styleProps(style));
  const { nodes, pageBreak, figure } = inlineFromParagraph(p, rels, zip, sty, baseProps);
  const out: ProseMirrorNode[] = [];

  if (figure) {
    figure.content = nodes.length ? nodes : [];
    out.push(figure);
    if (pageBreak) out.push({ type: "pageBreak" });
    return out;
  }

  const align = alignFrom(p);
  const attrs: Record<string, unknown> = {};
  if (align) attrs.textAlign = align;
  if (tabStops.length) attrs.tabStops = tabStops;

  if (headingMatch) {
    out.push({ type: "heading", attrs: { level: Math.min(4, Number(headingMatch[1])), ...attrs }, content: nodes });
  } else {
    const ind = firstDescendant(p, "w:ind")?.attrs["w:left"];
    if (ind) {
      const lvl = Math.round(Number(ind) / 480);
      if (lvl > 0) attrs.indent = Math.min(8, lvl);
    }
    out.push(Object.keys(attrs).length || nodes.length ? { type: "paragraph", attrs, content: nodes } : { type: "paragraph" });
  }
  if (pageBreak) out.push({ type: "pageBreak" });
  return out;
}

// --- Relecture des objets flottants (formes, zones de texte) ---------------

/** Points en millimètres — l'unité de VML est le point typographique. */
function ptToMm(pt: unknown): number {
  const n = Number(String(pt ?? "").replace(/pt$/i, ""));
  return Number.isFinite(n) ? Math.round((n / 72) * 25.4 * 10) / 10 : 0;
}

/** Une propriété d'un attribut `style` de VML/CSS. */
function styleProp(style: string, name: string): string {
  const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, "i").exec(style);
  return m ? m[1]!.trim() : "";
}

/** L'habillage lu sur un objet flottant DrawingML. */
function wrapFromAnchor(anchor: XmlEl | undefined): { wrap: string; x: number; y: number } {
  if (!anchor) return { wrap: "inline", x: 0, y: 0 };
  const behind = anchor.attrs["behindDoc"] === "1";
  const square = !!firstChild(anchor, "wp:wrapSquare");
  const offset = (axis: "H" | "V"): number => {
    const pos = firstDescendant(anchor, `wp:position${axis}`);
    const off = pos ? firstChild(pos, "wp:posOffset") : undefined;
    return off ? emuToMm(te(off)) : 0;
  };
  return {
    wrap: square ? "square" : behind ? "behind" : "front",
    x: offset("H"),
    y: offset("V"),
  };
}

/** La première couleur d'un remplissage DrawingML (uni ou dégradé). */
function dmlFill(sp: XmlEl | undefined): { fill: string; fill2: string; gradient: "" | "linear" | "radial" } {
  if (!sp) return { fill: "", fill2: "", gradient: "" };
  if (firstChild(sp, "a:noFill")) return { fill: "", fill2: "", gradient: "" };
  const grad = firstChild(sp, "a:gradFill");
  if (grad) {
    const stops = descendants(grad, "a:srgbClr").map((c) => `#${c.attrs["val"] ?? ""}`);
    return {
      fill: /^#[0-9a-f]{6}$/i.test(stops[0] ?? "") ? stops[0]! : "",
      fill2: /^#[0-9a-f]{6}$/i.test(stops[1] ?? "") ? stops[1]! : "",
      gradient: firstDescendant(grad, "a:path") ? "radial" : "linear",
    };
  }
  const solid = firstChild(sp, "a:solidFill");
  const hex = solid ? `#${firstDescendant(solid, "a:srgbClr")?.attrs["val"] ?? ""}` : "";
  return { fill: /^#[0-9a-f]{6}$/i.test(hex) ? hex : "", fill2: "", gradient: "" };
}

/**
 * Une forme DrawingML (`wps:wsp`) relue en nœud `shape`.
 *
 * Sans cette relecture, une forme exportée puis réouverte revenait en rectangle
 * nu : la géométrie préréglée est justement ce qui permet de retrouver LA forme,
 * et pas seulement sa boîte. Un `txBox="1"` désigne une vraie zone de texte de
 * Word, pas une forme — c'est la distinction que fait Word lui-même, donc elle
 * décide ici du type de nœud produit.
 */
function shapeFromWsp(
  p: XmlEl,
  wsp: XmlEl,
  rels: Record<string, string>,
  zip: Record<string, Uint8Array>,
  sty: StyleResolver,
): ProseMirrorNode | null {
  const sp = firstChild(wsp, "wps:spPr");
  const prst = firstDescendant(wsp, "a:prstGeom")?.attrs["prst"] ?? "";
  const isTextBox = firstChild(wsp, "wps:cNvSpPr")?.attrs["txBox"] === "1";
  const kind = kindFromPrst(prst);
  const ext = firstDescendant(wsp, "a:ext");
  const widthMm = emuToMm(ext?.attrs["cx"]);
  const heightMm = emuToMm(ext?.attrs["cy"]);
  const rotRaw = Number(firstDescendant(wsp, "a:xfrm")?.attrs["rot"] ?? 0);
  const rotation = Number.isFinite(rotRaw) ? Math.round(rotRaw / 60000) % 360 : 0;
  const { wrap, x, y } = wrapFromAnchor(firstDescendant(p, "wp:anchor"));
  const txbx = firstDescendant(wsp, "w:txbxContent");
  const content = txbx ? children(txbx, "w:p").flatMap((q) => paragraphNode(q, rels, zip, sty)) : [];

  const { fill, fill2, gradient } = dmlFill(sp);
  const ln = sp ? firstChild(sp, "a:ln") : undefined;
  const noLine = !!(ln && firstChild(ln, "a:noFill"));
  const strokeHex = ln ? `#${firstDescendant(ln, "a:srgbClr")?.attrs["val"] ?? ""}` : "";
  const strokeEmu = Number(ln?.attrs["w"] ?? 0);
  const dash = dashFromOoxml(firstDescendant(ln ?? wsp, "a:prstDash")?.attrs["val"]);
  const geo = { x, y, widthMm: widthMm || 40, heightMm: heightMm || 25, wrap, rotation };

  // Une zone de texte de Word reste une zone de texte : elle a son propre nœud,
  // avec ses bordures et son remplissage.
  if (isTextBox && (!kind || kind === "rect" || kind === "roundRect")) {
    return {
      type: "textBox",
      attrs: {
        ...geo,
        borderWidth: noLine || !strokeEmu ? 0 : Math.max(1, Math.round((strokeEmu / 36000 / 25.4) * 96)),
        ...(/^#[0-9a-f]{6}$/i.test(strokeHex) ? { borderColor: strokeHex } : {}),
        fill,
      },
      content: content.length ? content : [{ type: "paragraph" }],
    };
  }
  if (!kind) return null;
  const def = shapeDef(kind);
  const adjRaw = firstDescendant(wsp, "a:gd")?.attrs["fmla"] ?? "";
  const adjVal = /val\s+(-?\d+)/.exec(adjRaw);
  return {
    type: "shape",
    attrs: {
      kind,
      adj: adjVal ? clampAdj(kind, Number(adjVal[1]) / 1000) : defaultAdj(kind),
      ...geo,
      fill,
      ...(fill2 ? { fill2 } : {}),
      gradient,
      ...(/^#[0-9a-f]{6}$/i.test(strokeHex) ? { strokeColor: strokeHex } : {}),
      strokeWidth: noLine ? 0 : strokeEmu ? Math.max(1, Math.round((strokeEmu / 36000 / 25.4) * 96)) : 1,
      dash,
      shadow: !!firstDescendant(wsp, "a:outerShdw"),
      vAlign:
        firstChild(wsp, "wps:bodyPr")?.attrs["anchor"] === "t"
          ? "top"
          : firstChild(wsp, "wps:bodyPr")?.attrs["anchor"] === "b"
            ? "bottom"
            : "middle",
    },
    content: def.line ? [] : content,
  };
}

/**
 * Une forme VML relue en nœud.
 *
 * Word écrit encore ses zones de texte en VML (`#_x0000_t202`), et c'est aussi
 * notre branche de repli. Un tracé VML quelconque ne peut PAS être ramené à une
 * forme préréglée — il revient donc en rectangle, en conservant taille, couleurs
 * et contenu plutôt que d'être perdu.
 */
function shapeFromVml(
  v: XmlEl,
  rels: Record<string, string>,
  zip: Record<string, Uint8Array>,
  sty: StyleResolver,
): ProseMirrorNode | null {
  const style = v.attrs["style"] ?? "";
  const wrapEl = firstDescendant(v, "w10:wrap")?.attrs["type"] ?? "";
  const zIndex = Number(styleProp(style, "z-index") || 0);
  const wrap =
    wrapEl === "inline"
      ? "inline"
      : wrapEl === "square"
        ? "square"
        : zIndex < 0
          ? "behind"
          : "front";
  const widthMm = ptToMm(styleProp(style, "width"));
  const heightMm = ptToMm(styleProp(style, "height"));
  const x = ptToMm(styleProp(style, "margin-left"));
  const y = ptToMm(styleProp(style, "margin-top"));
  const rotation = Math.round(Number(styleProp(style, "rotation") || 0)) % 360;
  const txbx = firstDescendant(v, "w:txbxContent");
  const content = txbx ? children(txbx, "w:p").flatMap((q) => paragraphNode(q, rels, zip, sty)) : [];
  const fillcolor = v.attrs["fillcolor"] ?? "";
  const strokecolor = v.attrs["strokecolor"] ?? "";
  const stroked = v.attrs["stroked"] !== "f";
  const weight = ptToMm(v.attrs["strokeweight"] ?? "");
  const geo = { x, y, widthMm: widthMm || 60, heightMm: heightMm || 0, wrap, rotation };
  const isTextBox = (v.attrs["type"] ?? "").includes("t202") || !!txbx;
  if (isTextBox) {
    return {
      type: "textBox",
      attrs: {
        ...geo,
        borderWidth: stroked ? Math.max(1, Math.round((weight / 25.4) * 96)) : 0,
        ...(/^#[0-9a-f]{6}$/i.test(strokecolor) ? { borderColor: strokecolor } : {}),
        fill: /^#[0-9a-f]{6}$/i.test(fillcolor) ? fillcolor : "",
      },
      content: content.length ? content : [{ type: "paragraph" }],
    };
  }
  return {
    type: "shape",
    attrs: {
      kind: "rect",
      adj: defaultAdj("rect"),
      ...geo,
      heightMm: heightMm || 25,
      fill: /^#[0-9a-f]{6}$/i.test(fillcolor) ? fillcolor : "",
      ...(/^#[0-9a-f]{6}$/i.test(strokecolor) ? { strokeColor: strokecolor } : {}),
      strokeWidth: stroked ? Math.max(1, Math.round((weight / 25.4) * 96)) : 0,
    },
    content: [],
  };
}

/**
 * L'objet flottant d'un paragraphe, s'il y en a un.
 *
 * Un paragraphe qui ne porte qu'une forme n'est PAS un paragraphe : le rendre
 * comme tel laisserait un paragraphe vide à sa place et perdrait la forme. Le
 * DrawingML est lu en premier — dans un `mc:AlternateContent` les deux branches
 * décrivent le même objet, et c'est la moderne qui porte la géométrie.
 */
function floatingFromParagraph(
  p: XmlEl,
  rels: Record<string, string>,
  zip: Record<string, Uint8Array>,
  sty: StyleResolver,
): ProseMirrorNode | null {
  const wsp = firstDescendant(p, "wps:wsp");
  if (wsp) return shapeFromWsp(p, wsp, rels, zip, sty);
  const v = firstDescendant(p, "v:shape") ?? firstDescendant(p, "v:rect");
  // Le `v:shapetype` déclaratif n'est pas une forme, et le filigrane vit dans un
  // en-tête : ni l'un ni l'autre n'arrive ici.
  if (v && v.name !== "v:shapetype") return shapeFromVml(v, rels, zip, sty);
  return null;
}

function tableNode(tbl: XmlEl, rels: Record<string, string>, zip: Record<string, Uint8Array>, sty: StyleResolver): ProseMirrorNode {
  const rows = children(tbl, "w:tr").map((tr, rowIdx) => ({
    type: "tableRow",
    content: children(tr, "w:tc").map((tc) => {
      const span = Number(firstDescendant(tc, "w:gridSpan")?.attrs["w:val"] ?? 1);
      const cellBlocks = children(tc, "w:p").flatMap((p) => paragraphNode(p, rels, zip, sty));
      return {
        type: rowIdx === 0 ? "tableHeader" : "tableCell",
        attrs: span > 1 ? { colspan: span } : {},
        content: cellBlocks.length ? cellBlocks : [{ type: "paragraph" }],
      } as ProseMirrorNode;
    }),
  }));
  return { type: "table", content: rows };
}

/**
 * Rebuilds nested lists from Word's flat paragraphs + `w:ilvl`.
 *
 * Word stores every list item as a top-level paragraph tagged with its numbering
 * id and level; the nesting is implicit. This keeps a stack of open lists so
 * `1 / 1.1 / 1.1.1` comes back as real nested `bulletList` / `orderedList`
 * nodes, and stamps the recognised multilevel scheme on the outermost one.
 */
class ListBuilder {
  private stack: { list: ProseMirrorNode; level: number; kind: "bullet" | "ordered" }[] = [];

  constructor(private readonly out: ProseMirrorNode[]) {}

  add(item: ProseMirrorNode, level: number, def: NumDef): void {
    const kind = def.kind;
    // Close any list deeper than this item.
    while (this.stack.length && this.stack[this.stack.length - 1]!.level > level) this.stack.pop();

    let top = this.stack[this.stack.length - 1];
    // Same level but a different marker kind ⇒ a sibling list, not a nesting.
    if (top && top.level === level && top.kind !== kind) {
      this.stack.pop();
      top = this.stack[this.stack.length - 1];
    }

    if (!top || top.level < level) {
      const list: ProseMirrorNode = {
        type: kind === "bullet" ? "bulletList" : "orderedList",
        ...(def.scheme && !top ? { attrs: { listScheme: def.scheme } } : {}),
        content: [],
      };
      if (!top) {
        this.out.push(list);
      } else {
        // Nest inside the last item of the enclosing list (Word's own model).
        const items = top.list.content ?? [];
        const last = items[items.length - 1];
        if (last) (last.content = last.content ?? []).push(list);
        else items.push({ type: "listItem", content: [list] });
      }
      this.stack.push({ list, level, kind });
      top = this.stack[this.stack.length - 1];
    }

    (top!.list.content = top!.list.content ?? []).push(item);
  }

  close(): void {
    this.stack = [];
  }
}

/** Section properties read off a `w:sectPr`. */
interface ReadSectPr {
  type: SectionBreakKind;
  orientation: "portrait" | "landscape";
  columns: number;
  gapMm: number;
  separator: boolean;
  restartAt: number | null;
}

function readSectPr(sectPr: XmlEl): ReadSectPr {
  const cols = firstChild(sectPr, "w:cols");
  const pgSz = firstChild(sectPr, "w:pgSz");
  const space = Number(cols?.attrs["w:space"] ?? 0);
  const start = firstChild(sectPr, "w:pgNumType")?.attrs["w:start"];
  return {
    type: normalizeKind(firstChild(sectPr, "w:type")?.attrs["w:val"] ?? "nextPage"),
    orientation: pgSz?.attrs["w:orient"] === "landscape" ? "landscape" : "portrait",
    columns: Math.max(1, Math.min(4, Math.round(Number(cols?.attrs["w:num"] ?? 1) || 1))),
    gapMm: space > 0 ? Math.round(space / 56.6929) : 8,
    separator: cols?.attrs["w:sep"] === "true" || cols?.attrs["w:sep"] === "1",
    restartAt: start != null && Number.isFinite(Number(start)) ? Math.max(1, Number(start)) : null,
  };
}

/** Parse a .docx byte array into a title + ProseMirror document node. */
export function docxToDoc(bytes: Uint8Array): { title: string; doc: ProseMirrorNode } {
  const zip = unzipSync(bytes);
  const docRaw = zip["word/document.xml"];
  if (!docRaw) throw new Error("Fichier .docx invalide : word/document.xml introuvable.");

  const rels = relTargets(zip);
  const numFmt = parseNumbering(zip);
  const sty = buildStyleResolver(zip);
  const root = parseXml(strFromU8(docRaw));
  const body = firstDescendant(root, "w:body");
  const content: ProseMirrorNode[] = [];

  // Blocks of the section currently being read; flushed into `content` when the
  // section's `w:sectPr` is met (a sectPr describes the section it ENDS).
  let section: ProseMirrorNode[] = [];
  let sectionIdx = 0;
  let prevOrientation: "portrait" | "landscape" = "portrait";
  let builder = new ListBuilder(section);

  const startSection = () => {
    section = [];
    builder = new ListBuilder(section);
  };

  const closeSection = (props: ReadSectPr) => {
    builder.close();
    let blocks = section;
    // Newspaper columns: the whole section becomes one column block.
    if (props.columns > 1 && blocks.length) {
      blocks = [
        {
          type: "columnSection",
          attrs: { count: props.columns, gapMm: props.gapMm, separator: props.separator },
          content: blocks,
        },
      ];
    }
    // A section boundary only becomes a visible break when the user would have
    // asked for one: a page-starting type, a different orientation, or a
    // numbering restart. The continuous, same-orientation sections that merely
    // delimit a column range carry no break of their own.
    const meaningful =
      props.type !== "continuous" || props.orientation !== prevOrientation || props.restartAt != null;
    if (sectionIdx > 0 && meaningful && props.columns <= 1) {
      content.push({
        type: "sectionBreak",
        attrs: {
          kind: props.type,
          orientation: props.orientation === prevOrientation ? "" : props.orientation,
          restartNumbering: props.restartAt != null,
          startAt: props.restartAt ?? 1,
          header: "",
          footer: "",
        },
      });
    }
    content.push(...blocks);
    prevOrientation = props.orientation;
    sectionIdx += 1;
    startSection();
  };

  if (body) {
    // The generated index is fenced by a marker bookmark so it folds back into
    // one node instead of the paragraphs it was rendered as.
    let indexFenceId: string | null = null;

    for (const c of body.children) {
      if (!isEl(c)) continue;

      if (c.name === "w:bookmarkStart" && c.attrs["w:name"] === INDEX_BOOKMARK) {
        indexFenceId = c.attrs["w:id"] ?? "";
        section.push({ type: "indexBlock" });
        continue;
      }
      if (indexFenceId != null) {
        if (c.name === "w:bookmarkEnd" && (c.attrs["w:id"] ?? "") === indexFenceId) indexFenceId = null;
        continue; // skip the rendered index paragraphs
      }

      if (c.name === "w:p") {
        const ppr = firstChild(c, "w:pPr");
        const sectPr = ppr ? firstChild(ppr, "w:sectPr") : undefined;
        const numPr = ppr ? firstChild(ppr, "w:numPr") : undefined;
        const numId = numPr ? firstChild(numPr, "w:numId")?.attrs["w:val"] : undefined;

        if (numId && numPr) {
          const def = numFmt[numId] ?? { kind: "bullet" as const, scheme: null };
          const level = Math.max(0, Math.min(8, Number(firstChild(numPr, "w:ilvl")?.attrs["w:val"] ?? 0) || 0));
          const para =
            paragraphNode(c, rels, zip, sty).find((n) => n.type === "paragraph" || n.type === "heading") ?? { type: "paragraph" };
          builder.add({ type: "listItem", content: [para] }, level, def);
          continue;
        }

        builder.close();
        // A paragraph holding only a sectPr is a pure boundary marker.
        const blocksHere = paragraphNode(c, rels, zip, sty);
        const isMarker = !!sectPr && blocksHere.every((n) => n.type === "paragraph" && !(n.content ?? []).length);
        if (!isMarker) section.push(...blocksHere);
        if (sectPr) closeSection(readSectPr(sectPr));
        continue;
      }

      if (c.name === "w:tbl") {
        builder.close();
        section.push(tableNode(c, rels, zip, sty));
        continue;
      }

      if (c.name === "w:sectPr") {
        // The body-level sectPr closes the last section.
        closeSection(readSectPr(c));
      }
    }
    // Anything left after the final sectPr (or a body with none at all).
    builder.close();
    content.push(...section);
  }

  // Title: prefer docProps/core.xml dc:title.
  let title = "";
  const core = zip["docProps/core.xml"];
  if (core) {
    title = (firstDescendant(parseXml(strFromU8(core)), "dc:title") && te(firstDescendant(parseXml(strFromU8(core)), "dc:title")!)) || "";
  }

  return { title, doc: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] } };
}
