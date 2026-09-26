/**
 * « Créer un PDF depuis un fichier » — Word, Excel, PowerPoint, HTML, texte,
 * Markdown and Elium documents made into a PDF, like Acrobat's « Créer ».
 *
 * Every source becomes standalone HTML first, with the app's own importers
 * (docx → document model → the HTML export, xlsx → workbook → tables, pptx →
 * deck → the slide renderer). The browser lays that HTML out at the page
 * width, splits it into pages without cutting lines, and draws each page as a
 * picture (`ui/htmlToPdf.ts`). The words it laid out are written back over the
 * picture as an invisible text layer — the one OCR writes — so the PDF is
 * searchable and copyable; links become Link annotations.
 *
 * This module holds what does not need a browser layout: turning each source
 * into HTML, planning page breaks from measured boxes, grouping measured words
 * into text lines and assembling the PDF. Plain text needs no layout at all and
 * is written as real text.
 */

import { PDFDocument, PDFName, PDFString, rgb } from "pdf-lib";
import type { PDFPage, PDFRef } from "pdf-lib";
import { docxToDoc } from "../../format/docx";
import { createDocumentModel, DEFAULT_PAGE } from "../../format/document";
import { markdownToDoc } from "../../format/importers";
import { pageSizeOf } from "../../format/pageSizes";
import type { EliumFile, PageSettings, ProseMirrorNode } from "../../format/types";
import { buildStandaloneHtml } from "../../export/exporters";
import type { SheetData, Workbook } from "../../sheet/model";
import { DEFAULT_COL_W } from "../../sheet/model";
import { createCalc, indexToCol, isError, type CellValue } from "../../sheet/formula";
import { formatValue } from "../../sheet/format";
import { FontBook, sanitiseForFont } from "./fonts";
import type { OcrLine } from "./ocr";
import { createSourceKind, type CreateSourceKind } from "./create-kinds";

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

export { CREATE_FROM_FILE_ACCEPT, createSourceKind, type CreateSourceKind } from "./create-kinds";

/** Each kind named in messages (« Impossible de lire cette présentation PowerPoint »). */
export const CREATE_SOURCE_LABELS: Record<CreateSourceKind, string> = {
  docx: "ce document Word",
  xlsx: "ce classeur Excel",
  pptx: "cette présentation PowerPoint",
  html: "cette page HTML",
  text: "ce fichier texte",
  markdown: "ce fichier Markdown",
  elium: "ce document Elium",
};

/** The file name without its extension (the default title). */
export function baseName(name: string): string {
  return (
    name
      .replace(/^.*[\\/]/, "")
      .replace(/\.[^.]+$/, "")
      .trim() || "Document"
  );
}

// ---------------------------------------------------------------------------
// Page geometry
// ---------------------------------------------------------------------------

export type CreateOrientation = "portrait" | "landscape";

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** A page: size and margins in points. */
export interface PageGeometry {
  width: number;
  height: number;
  margin: Margins;
}

export const A4_PT: [number, number] = [595.28, 841.89];
const MM = 72 / 25.4;
/** CSS pixels per point (96 dpi / 72). */
export const PX_PER_PT = 96 / 72;

const mmMargins = (m: Margins): Margins => ({
  top: m.top * MM,
  right: m.right * MM,
  bottom: m.bottom * MM,
  left: m.left * MM,
});

/** A4 in the given orientation with the same margin (millimetres) all round. */
export function a4Page(orientation: CreateOrientation = "portrait", marginMm = 20): PageGeometry {
  const [w, h] = A4_PT;
  const m = marginMm * MM;
  return {
    width: orientation === "landscape" ? h : w,
    height: orientation === "landscape" ? w : h,
    margin: { top: m, right: m, bottom: m, left: m },
  };
}

/** A document's page setup (format, orientation, margins) as a page geometry. */
export function pageFromSettings(page: PageSettings, orientation?: CreateOrientation): PageGeometry {
  const o = orientation ?? page.orientation ?? "portrait";
  const { width, height } = pageSizeOf({ ...page, orientation: o });
  return { width: width * MM, height: height * MM, margin: mmMargins(page.margins ?? DEFAULT_PAGE.margins) };
}

/** Content box of a page, in CSS pixels. */
export function contentBoxPx(page: PageGeometry): { width: number; height: number } {
  return {
    width: Math.max(40, (page.width - page.margin.left - page.margin.right) * PX_PER_PT),
    height: Math.max(40, (page.height - page.margin.top - page.margin.bottom) * PX_PER_PT),
  };
}

// ---------------------------------------------------------------------------
// HTML sources
// ---------------------------------------------------------------------------

/** Header, footer and page numbers written on every page (an Elium document's page setup). */
export interface PageDecorations {
  header?: string;
  footer?: string;
  pageNumbers?: boolean;
}

/**
 * A source made into standalone HTML: a style sheet and a body, nothing
 * external (pictures are data: URLs). `flow` content is split into pages of
 * `page`; `fixed` content is a series of `.elium-fixed-page` elements, one page
 * each, at the size of `page` (no margin).
 */
export interface HtmlSource {
  layout: "flow" | "fixed";
  title: string;
  lang: string;
  css: string;
  body: string;
  bodyClass?: string;
  page: PageGeometry;
  decorations?: PageDecorations;
  /** For the PDF's /Creator (« Elium — Word »). */
  creator: string;
}

/** Class of an element the renderer scales down (CSS zoom) when wider than the page. */
export const FIT_WIDTH_CLASS = "elium-fit-width";
/** Class of one fixed-size page of `fixed` content. */
export const FIXED_PAGE_CLASS = "elium-fixed-page";

/** Style and body out of `buildStandaloneHtml`'s output (whose shape this module controls). */
export function splitStandaloneHtml(html: string): { css: string; body: string; lang: string } {
  const css = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join("\n");
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
  const lang = /<html[^>]*\blang="([^"]*)"/.exec(html)?.[1] ?? "fr";
  return { css, body, lang };
}

/** Rules that turn the export's screen layout (a centred 760 px column) into the page's content box. */
const FLOW_PAGE_CSS = `html,body{margin:0!important;padding:0!important;max-width:none!important;min-height:0!important;background:transparent!important}
body{display:flow-root;width:auto!important;overflow-wrap:break-word}
img,svg,video,canvas{max-width:100%}
pre{white-space:pre-wrap!important;overflow:visible!important}`;

function documentSource(
  file: EliumFile,
  opts: { orientation?: CreateOrientation; keepTitle: boolean; creator: string; decorations?: PageDecorations },
): HtmlSource {
  const html = buildStandaloneHtml(opts.keepTitle ? file : { ...file, manifest: { ...file.manifest, title: "" } });
  const { css, body, lang } = splitStandaloneHtml(html);
  return {
    layout: "flow",
    title: file.manifest.title,
    lang,
    css: `${css}\n${FLOW_PAGE_CSS}`,
    // Without a title, the export's <h1> is empty: drop it.
    body: opts.keepTitle ? body : body.replace(/^\s*<h1><\/h1>/, ""),
    page: pageFromSettings(file.document.page, opts.orientation),
    decorations: opts.decorations,
    creator: opts.creator,
  };
}

/** A document model wrapped as the minimal file the HTML export reads. */
function modelFile(doc: ProseMirrorNode, title: string, page?: Partial<PageSettings>): EliumFile {
  return {
    manifest: { title, language: "fr" },
    document: createDocumentModel(doc, { showPageNumbers: false, ...page }),
    signatures: [],
    resources: new Map(),
    resourceIndex: [],
    journal: { events: [] },
  } as unknown as EliumFile;
}

/** A Word document through the app's importer and HTML export. */
export function docxSource(bytes: Uint8Array, name: string, orientation?: CreateOrientation): HtmlSource {
  const { title, doc } = docxToDoc(bytes);
  return documentSource(modelFile(doc, title.trim() || baseName(name)), {
    orientation,
    keepTitle: false,
    creator: "Elium — Word",
  });
}

/** A Markdown file through the app's importer and HTML export. */
export function markdownSource(text: string, name: string, orientation?: CreateOrientation): HtmlSource {
  const doc = markdownToDoc(text);
  const heading = doc.content?.find((n) => n.type === "heading");
  const title =
    (heading?.content ?? [])
      .map((n) => n.text ?? "")
      .join("")
      .trim() || baseName(name);
  return documentSource(modelFile(doc, title), { orientation, keepTitle: false, creator: "Elium — Markdown" });
}

/** An Elium document as the app exports it (title, signatures, header, footer, page numbers). */
export function eliumSource(file: EliumFile, orientation?: CreateOrientation): HtmlSource {
  const page = file.document.page ?? DEFAULT_PAGE;
  return documentSource(file, {
    orientation,
    keepTitle: true,
    creator: "Elium — Document",
    decorations: { header: page.header, footer: page.footer, pageNumbers: page.showPageNumbers },
  });
}

// --- HTML files --------------------------------------------------------------

const DROP_ELEMENTS =
  "style,script,noscript,template,iframe,frame,frameset,object,embed,applet,link,meta,base,audio,video,source,track,portal,dialog";

/** A CSS text without external references: `url(…)` other than data: and `@import` go. */
export function sanitiseCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q: string, url: string) => (/^data:/i.test(url) ? m : "none"))
    .replace(/expression\s*\(/gi, "(")
    .replace(/-moz-binding\s*:[^;}]*/gi, "");
}

const SAFE_HREF = /^(https?:|mailto:|tel:|#)/i;

/**
 * Where inline styles travel until they are set through the CSSOM. Parsing a
 * `style` attribute — even in a DOMParser document — is checked against the
 * page's CSP, which the desktop app's refuses (and reports).
 */
export const STYLE_ATTR = "data-elium-style";

/** `style="…"` attributes of HTML markup renamed to `STYLE_ATTR`, so parsing it applies no inline style. */
export function renameStyleAttributes(html: string): string {
  return html.replace(/<[a-zA-Z][^<>]*>/g, (tag) => tag.replace(/(\s)style(\s*=)/gi, `$1${STYLE_ATTR}$2`));
}

/** The `<style>` elements of HTML markup taken out (their text), before it is parsed. */
function takeStyleElements(html: string): { html: string; css: string[] } {
  const css: string[] = [];
  const rest = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, (_m, text: string) => {
    css.push(text);
    return "";
  });
  return { html: rest, css };
}

/**
 * An HTML page made safe to lay out inside the app: no script, frame, plugin,
 * event handler or `javascript:` link, and nothing fetched from outside —
 * pictures that are not data: URLs are dropped (the desktop CSP forbids them,
 * and the Drive must not call out to a third party either).
 */
export function sanitiseHtml(html: string): {
  css: string;
  body: string;
  title: string;
  lang: string;
  bodyClass: string;
} {
  const taken = takeStyleElements(html);
  const dom = new DOMParser().parseFromString(renameStyleAttributes(taken.html), "text/html");
  const title = dom.querySelector("title")?.textContent?.trim() ?? "";
  const lang = dom.documentElement.getAttribute("lang") ?? "fr";
  const css = taken.css.map(sanitiseCss).join("\n");
  dom.querySelectorAll(DROP_ELEMENTS).forEach((el) => el.remove());
  for (const el of [...dom.body.querySelectorAll("*"), dom.body]) {
    for (const attr of [...el.attributes]) {
      const n = attr.name.toLowerCase();
      const v = attr.value.trim();
      if (n.startsWith("on") || n === "srcset" || n === "formaction" || n === "action" || n === "ping") {
        el.removeAttribute(attr.name);
      } else if (n === STYLE_ATTR) {
        el.setAttribute(STYLE_ATTR, sanitiseCss(v));
      } else if (n === "href" || n === "xlink:href") {
        // SVG <use>/<image> references: only in-document or data: targets.
        if (el.namespaceURI === "http://www.w3.org/2000/svg" && !/^(#|data:image\/)/i.test(v))
          el.removeAttribute(attr.name);
        else if (el.localName === "a" && !SAFE_HREF.test(v)) el.removeAttribute(attr.name);
        else if (el.localName !== "a" && !/^(#|data:)/i.test(v)) el.removeAttribute(attr.name);
      } else if (n === "src" || n === "poster" || n === "background" || n === "data") {
        if (/^data:image\//i.test(v)) continue;
        if (el.localName === "img") {
          // A picture from elsewhere: its alternative text stands in for it.
          el.replaceWith(dom.createTextNode(el.getAttribute("alt") ?? ""));
          break;
        }
        el.removeAttribute(attr.name);
      }
    }
  }
  return { css, body: dom.body.innerHTML, title, lang, bodyClass: dom.body.getAttribute("class") ?? "" };
}

/** The base style of an HTML page with none of its own: the browser's, on white, in a readable size. */
const HTML_BASE_CSS = `body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;line-height:1.4;color:#000}
table{border-collapse:collapse} img{height:auto}`;

/** An HTML file, sanitised, laid out at the page width. */
export function htmlSource(html: string, name: string, orientation?: CreateOrientation): HtmlSource {
  const s = sanitiseHtml(html);
  return {
    layout: "flow",
    title: s.title || baseName(name),
    lang: s.lang,
    css: `${HTML_BASE_CSS}\n${s.css}\n${FLOW_PAGE_CSS}`,
    body: s.body,
    bodyClass: s.bodyClass,
    page: a4Page(orientation, 15),
    creator: "Elium — HTML",
  };
}

// --- Workbooks -----------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const cssColor = (c: string | undefined) =>
  c && /^#?[0-9a-f]{3,8}$/i.test(c) ? (c.startsWith("#") ? c : `#${c}`) : "";
const cssFont = (f: string) => f.replace(/[^\p{L}\p{N} _-]/gu, "");

/** Default row height of a printed sheet (Excel's 15 pt), in CSS pixels. */
const SHEET_ROW_PX = 20;

const cellRef = (c: number, r: number) => indexToCol(c) + (r + 1);

/** The used range of a sheet: every cell with a value, a fill or a border, and every merge. */
export function usedRange(sheet: SheetData): { cols: number; rows: number } | null {
  let cols = 0;
  let rows = 0;
  const grow = (ref: string) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) return;
    let c = 0;
    for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
    cols = Math.max(cols, c);
    rows = Math.max(rows, Number(m[2]));
  };
  for (const [ref, raw] of Object.entries(sheet.cells)) if (raw != null && raw !== "") grow(ref);
  for (const [ref, st] of Object.entries(sheet.styles ?? {})) if (st.fill || st.border) grow(ref);
  for (const m of sheet.merges ?? []) {
    cols = Math.max(cols, m.c1 + 1);
    rows = Math.max(rows, m.r1 + 1);
  }
  return cols && rows ? { cols, rows } : null;
}

const BORDER_CSS: Record<string, string> = {
  thin: "1px solid",
  medium: "2px solid",
  thick: "3px solid",
  dashed: "1px dashed",
  dotted: "1px dotted",
  double: "3px double",
};

/** One sheet's used range as an HTML table: column widths, row heights, merges, styles, values as displayed. */
export function sheetToHtml(wb: Workbook, index: number): { html: string; width: number } | null {
  const sheet = wb.sheets[index];
  if (!sheet) return null;
  const range = usedRange(sheet);
  if (!range) return null;
  const byName: Record<string, SheetData> = {};
  for (const s of wb.sheets) byName[s.name] = s;
  const names = new Map((wb.names ?? []).map((n) => [n.name.toUpperCase(), n.ref]));
  const calc = createCalc(
    (ref) => sheet.cells[ref],
    { getSheetRaw: (name, ref) => byName[name]?.cells[ref], hasSheet: (name) => name in byName },
    names.size ? (name: string) => names.get(name) : undefined,
  );
  const shown = (ref: string): { text: string; value: CellValue } => {
    if (sheet.cells[ref] == null || sheet.cells[ref] === "") return { text: "", value: "" };
    const value = calc.valueOf(ref);
    return { text: formatValue(value, sheet.styles?.[ref]?.fmt, calc.display(ref)), value };
  };
  const covered = new Set<string>();
  const spans = new Map<string, { cs: number; rs: number }>();
  for (const m of sheet.merges ?? []) {
    spans.set(cellRef(m.c0, m.r0), { cs: m.c1 - m.c0 + 1, rs: m.r1 - m.r0 + 1 });
    for (let r = m.r0; r <= m.r1; r++)
      for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(cellRef(c, r));
  }
  const widths = Array.from({ length: range.cols }, (_, c) => Math.max(8, sheet.colWidths?.[c] ?? DEFAULT_COL_W));
  const width = widths.reduce((a, b) => a + b, 0);
  const rows: string[] = [];
  for (let r = 0; r < range.rows; r++) {
    const h = sheet.rowHeights?.[r] ?? SHEET_ROW_PX;
    const cells: string[] = [];
    for (let c = 0; c < range.cols; c++) {
      const ref = cellRef(c, r);
      if (covered.has(ref)) continue;
      const st = sheet.styles?.[ref] ?? {};
      const { text, value } = shown(ref);
      const numeric = typeof value === "number";
      const css: string[] = [];
      const align = st.align ?? (isError(value) || typeof value === "boolean" ? "center" : numeric ? "right" : "");
      if (align) css.push(`text-align:${align}`);
      if (st.bold) css.push("font-weight:700");
      if (st.italic) css.push("font-style:italic");
      if (cssColor(st.color)) css.push(`color:${cssColor(st.color)}`);
      if (cssColor(st.fill)) css.push(`background:${cssColor(st.fill)}`);
      if (st.fontFamily) css.push(`font-family:'${cssFont(st.fontFamily)}',Calibri,Carlito,Arial,sans-serif`);
      if (st.fontSize) css.push(`font-size:${Math.max(4, Math.min(200, st.fontSize))}px`);
      for (const side of ["top", "right", "bottom", "left"] as const) {
        const b = st.border?.[side];
        if (b) css.push(`border-${side}:${BORDER_CSS[b.style] ?? "1px solid"} ${cssColor(b.color) || "#000"}`);
      }
      // Excel lets left-aligned text run over empty neighbours on its right.
      const next = cellRef(c + 1, r);
      const runsOver =
        text && !numeric && align !== "center" && align !== "right" && !spans.has(ref) && !sheet.cells[next];
      if (runsOver) css.push("overflow:visible");
      const span = spans.get(ref);
      const attrs = span
        ? `${span.cs > 1 ? ` colspan="${span.cs}"` : ""}${span.rs > 1 ? ` rowspan="${span.rs}"` : ""}`
        : "";
      cells.push(`<td${attrs}${css.length ? ` style="${esc(css.join(";"))}"` : ""}>${esc(text)}</td>`);
    }
    rows.push(`<tr style="height:${h}px">${cells.join("")}</tr>`);
  }
  const cols = widths.map((w) => `<col style="width:${w}px">`).join("");
  const html = `<table class="xs-t" style="width:${width}px"><colgroup>${cols}</colgroup><tbody>${rows.join("")}</tbody></table>`;
  return { html, width };
}

const SHEET_CSS = `body{font-family:Calibri,Carlito,Arial,sans-serif;font-size:11pt;color:#000}
.xs{margin:0 0 12px}
.xs + .xs{break-before:page}
.xs-name{font-size:9pt;font-weight:600;color:#475569;margin:0 0 6px}
.xs-t{border-collapse:collapse;table-layout:fixed}
.xs-t td{padding:1px 4px;white-space:nowrap;overflow:hidden;vertical-align:bottom;line-height:1.2}
.xs-empty{color:#64748b;font-style:italic}`;

/**
 * A workbook as HTML: one section per sheet with a used range (a new page
 * each), the sheet's name above its table. Wide sheets make the page
 * landscape when no orientation is asked for, and are scaled to the width.
 */
export function workbookSource(wb: Workbook, name: string, orientation?: CreateOrientation): HtmlSource {
  const sections: string[] = [];
  let widest = 0;
  wb.sheets.forEach((sheet, i) => {
    const t = sheetToHtml(wb, i);
    if (!t) return;
    widest = Math.max(widest, t.width);
    sections.push(
      `<section class="xs ${FIT_WIDTH_CLASS}" data-sheet="${esc(sheet.name)}"><h2 class="xs-name">${esc(sheet.name)}</h2>${t.html}</section>`,
    );
  });
  if (!sections.length) sections.push(`<p class="xs-empty">Classeur vide.</p>`);
  const portrait = a4Page("portrait", 12);
  const fitsPortrait = widest <= contentBoxPx(portrait).width;
  const page = a4Page(orientation ?? (fitsPortrait ? "portrait" : "landscape"), 12);
  return {
    layout: "flow",
    title: baseName(name),
    lang: "fr",
    css: `${SHEET_CSS}\n${FLOW_PAGE_CSS}`,
    body: sections.join(""),
    page,
    creator: "Elium — Excel",
  };
}

// ---------------------------------------------------------------------------
// Page breaks
// ---------------------------------------------------------------------------

/** A vertical extent (CSS pixels, from the top of the laid-out content). */
export interface VBox {
  top: number;
  bottom: number;
}

/**
 * Where to cut laid-out content into pages. `boxes` are what must not be cut
 * (text lines, pictures, table rows, blocks kept together), `forced` are page
 * breaks asked for. Each page ends at the top of the first box that would
 * cross its bottom; a box taller than a page is cut where the page ends.
 * Pages with no box at all (a break followed by a break) are dropped, but
 * there is always at least one page.
 */
export function planPageSlices(opts: {
  start?: number;
  end: number;
  pageHeight: number;
  boxes: readonly VBox[];
  forced?: readonly number[];
}): VBox[] {
  const start = opts.start ?? 0;
  const H = Math.max(1, opts.pageHeight);
  const boxes = opts.boxes.filter((b) => b.bottom > b.top).slice();
  boxes.sort((a, b) => a.top - b.top);
  const forced = [...new Set(opts.forced ?? [])]
    .filter((f) => f > start + 0.5 && f < opts.end - 0.5)
    .sort((a, b) => a - b);
  const slices: VBox[] = [];
  let s = start;
  let guard = 0;
  while (s < opts.end - 0.5 && guard++ < 100_000) {
    const limit = s + H;
    const brk = forced.find((f) => f > s + 0.5);
    let e: number;
    if (brk !== undefined && brk <= limit) {
      e = brk;
    } else if (limit >= opts.end) {
      e = opts.end;
    } else {
      e = limit;
      // Move the cut up to the top of whatever crosses it, until nothing does.
      for (;;) {
        let moved = false;
        for (const b of boxes) {
          if (b.top >= e) break;
          if (b.bottom > e + 0.5 && b.top > s + 0.5 && b.top < e) {
            e = b.top;
            moved = true;
          }
        }
        if (!moved) break;
      }
      // Nothing fits (a box taller than a page starts here): cut through it.
      if (e <= s + 0.5) e = limit;
    }
    const hasContent = boxes.some((b) => b.bottom > s + 0.5 && b.top < e - 0.5);
    if (hasContent) slices.push({ top: s, bottom: e });
    s = e;
  }
  if (!slices.length) slices.push({ top: start, bottom: Math.max(start + 1, Math.min(opts.end, start + H)) });
  return slices;
}

// ---------------------------------------------------------------------------
// Text layer and links
// ---------------------------------------------------------------------------

/** A laid-out word on a page: box in points from the page's top-left, and its font size (points). */
export interface WordBox {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
}

/**
 * Words (in reading order) grouped into text lines for the invisible layer:
 * a word joins the line before it when it sits on the same baseline, to its
 * right, in about the same size. The baseline is a fifth of the box above its
 * bottom (the font's descent); the line height gives the glyph size back.
 */
export function wordsToLines(words: readonly WordBox[]): OcrLine[] {
  const lines: OcrLine[] = [];
  let cur: { words: WordBox[]; base: number; size: number } | null = null;
  const flush = () => {
    if (!cur) return;
    const first = cur.words[0];
    const last = cur.words[cur.words.length - 1];
    lines.push({
      words: cur.words.map((w) => ({ text: w.text, confidence: 100, rect: { x: w.x, y: w.y, w: w.w, h: w.h } })),
      baseline: { x0: first.x, y0: cur.base, x1: last.x + last.w, y1: cur.base },
      // writeOcrLayer draws at 95 % of the line height.
      height: cur.size / 0.95,
    });
    cur = null;
  };
  for (const w of words) {
    if (!w.text.trim() || w.w <= 0 || w.h <= 0) continue;
    const base = w.y + w.h - w.h * 0.2;
    const size = w.fontSize > 0 ? w.fontSize : w.h / 1.15;
    const prev = cur?.words[cur.words.length - 1];
    const same =
      cur &&
      prev &&
      Math.abs(base - cur.base) <= Math.max(1.5, size * 0.25) &&
      w.x >= prev.x + prev.w - size * 0.3 &&
      Math.abs(size - cur.size) <= cur.size * 0.15;
    if (!same) {
      flush();
      cur = { words: [w], base, size };
    } else cur!.words.push(w);
  }
  flush();
  return lines;
}

/**
 * Write the invisible text layer of one page from its laid-out words — the
 * OCR layer's writer (render mode 3, each word stretched over its box), so
 * search, selection and copy follow the picture.
 */
export async function writeTextLayer(
  doc: PDFDocument,
  page: PDFPage,
  words: readonly WordBox[],
  fonts: FontBook,
): Promise<number> {
  const lines = wordsToLines(words);
  if (!lines.length) return 0;
  const { writeOcrLayer } = await import("./ocr");
  const { width, height } = page.getSize();
  return writeOcrLayer(doc, page, { lines, rotation: 0, size: { w: width, h: height } }, fonts);
}

/** A link on a page: its box (points, top-left origin) and where it goes. */
export interface LinkBox {
  x: number;
  y: number;
  w: number;
  h: number;
  uri?: string;
  /** Another place of the document: page index and height from its top (points). */
  dest?: { page: number; y: number };
}

function addLinks(doc: PDFDocument, pages: PDFPage[], index: number, links: readonly LinkBox[]): void {
  const page = pages[index];
  const { height } = page.getSize();
  const refs: PDFRef[] = [];
  for (const l of links) {
    if (l.w <= 0 || l.h <= 0) continue;
    const rect = [l.x, height - l.y - l.h, l.x + l.w, height - l.y];
    const entries: Record<string, unknown> = {
      Type: "Annot",
      Subtype: "Link",
      Rect: rect,
      Border: [0, 0, 0],
      F: 4,
    };
    if (l.uri) {
      entries.A = { Type: "Action", S: "URI", URI: PDFString.of(l.uri) };
    } else if (l.dest && pages[l.dest.page]) {
      const target = pages[l.dest.page];
      entries.Dest = [target.ref, PDFName.of("XYZ"), null, target.getSize().height - l.dest.y, null];
    } else continue;
    refs.push(doc.context.register(doc.context.obj(entries as never)));
  }
  if (!refs.length) return;
  const annots = page.node.Annots();
  if (annots) for (const r of refs) annots.push(r);
  else page.node.set(PDFName.of("Annots"), doc.context.obj(refs));
}

// ---------------------------------------------------------------------------
// Assembling
// ---------------------------------------------------------------------------

/** One page as the browser drew it. */
export interface RenderedPage {
  /** Points. */
  width: number;
  height: number;
  image: { bytes: Uint8Array; type: "png" | "jpeg" };
  words: WordBox[];
  links: LinkBox[];
}

export interface PdfMeta {
  title: string;
  lang?: string;
  creator?: string;
  decorations?: PageDecorations;
  /** Margins of the pages (points), for placing header, footer and page numbers. */
  margin?: Margins;
}

function expandTokens(tpl: string, title: string): string {
  return tpl.replace(/\{titre\}/gi, title).replace(/\{date\}/gi, new Date().toLocaleDateString("fr-FR"));
}

async function drawDecorations(page: PDFPage, n: number, total: number, meta: PdfMeta, fonts: FontBook): Promise<void> {
  const d = meta.decorations;
  if (!d || (!d.header && !d.footer && !d.pageNumbers)) return;
  const { width, height } = page.getSize();
  const m = meta.margin ?? { top: 56, right: 56, bottom: 56, left: 56 };
  const size = 9;
  const color = rgb(0x64 / 255, 0x74 / 255, 0x8b / 255);
  const draw = async (text: string, where: "center" | "right", y: number) => {
    const face = await fonts.forText("Helvetica", false, false, text);
    const t = sanitiseForFont(text, face.unicode);
    if (!t.trim()) return;
    const w = face.font.widthOfTextAtSize(t, size);
    const x = where === "center" ? (width - w) / 2 : width - m.right - w;
    page.drawText(t, { x, y, size, font: face.font, color });
  };
  const headerY = height - Math.max(size + 4, m.top / 2 + size / 2);
  const footerY = Math.max(6, m.bottom / 2 - size / 2);
  if (d.header) await draw(expandTokens(d.header, meta.title), "center", headerY);
  if (d.footer) await draw(expandTokens(d.footer, meta.title), "center", footerY);
  if (d.pageNumbers) await draw(`Page ${n} / ${total}`, "right", footerY);
}

/**
 * The PDF of rendered pages: each page's picture, its invisible text layer,
 * its links, and the document's title, language and creator.
 */
export async function assemblePdf(pages: readonly RenderedPage[], meta: PdfMeta): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(meta.title, { showInWindowTitleBar: true });
  doc.setCreator(meta.creator ?? "Elium");
  doc.setProducer("Elium (pdf-lib)");
  if (meta.lang) doc.setLanguage(meta.lang);
  const now = new Date();
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  const fonts = new FontBook(doc);
  const out: PDFPage[] = [];
  for (const p of pages) {
    const page = doc.addPage([p.width, p.height]);
    const img = p.image.type === "png" ? await doc.embedPng(p.image.bytes) : await doc.embedJpg(p.image.bytes);
    page.drawImage(img, { x: 0, y: 0, width: p.width, height: p.height });
    out.push(page);
  }
  for (let i = 0; i < pages.length; i++) {
    await writeTextLayer(doc, out[i], pages[i].words, fonts);
    await drawDecorations(out[i], i + 1, pages.length, meta, fonts);
    addLinks(doc, out, i, pages[i].links);
  }
  if (!out.length) doc.addPage(A4_PT);
  return doc.save();
}

// ---------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------

/** Text of a file read as UTF-8, or Windows-1252 when it is not valid UTF-8. */
export function decodeText(bytes: Uint8Array): string {
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return new TextDecoder("windows-1252").decode(body);
  }
}

/**
 * A plain-text file as real text (no picture needed): wrapped at the page
 * width, 10.5 pt, paginated by lines, form feeds starting a new page.
 */
export async function textToPdfDocument(
  text: string,
  title: string,
  orientation: CreateOrientation = "portrait",
): Promise<Uint8Array> {
  const { wrapText, measure } = await import("./painter");
  const doc = await PDFDocument.create();
  doc.setTitle(title, { showInWindowTitleBar: true });
  doc.setCreator("Elium — Texte");
  doc.setProducer("Elium (pdf-lib)");
  const clean = text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
  const face = await new FontBook(doc).forText("Helvetica", false, false, clean);
  const geo = a4Page(orientation, 20);
  const size = 10.5;
  const lead = size * 1.4;
  const maxW = geo.width - geo.margin.left - geo.margin.right;
  const perPage = Math.max(1, Math.floor((geo.height - geo.margin.top - geo.margin.bottom) / lead));
  const sheets = clean.split("\f").map((s) => sanitiseForFont(s, face.unicode));
  for (const sheet of sheets) {
    const lines = wrapText(face.font, sheet, size, maxW);
    for (let at = 0; at < Math.max(1, lines.length); at += perPage) {
      const page = doc.addPage([geo.width, geo.height]);
      lines.slice(at, at + perPage).forEach((line, k) => {
        if (!line || !measure(face.font, line, size)) return;
        page.drawText(line, {
          x: geo.margin.left,
          y: geo.height - geo.margin.top - size - k * lead,
          size,
          font: face.font,
        });
      });
    }
  }
  return doc.save();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export interface CreatePdfOptions {
  /** Page orientation; by default the source's own (A4 portrait, or landscape for wide sheets). */
  orientation?: CreateOrientation;
  /** Resolution of the page pictures (dots per inch). */
  dpi?: number;
  /** Password of an encrypted Elium document. */
  password?: string;
  onProgress?: (info: { done: number; total: number; stage: string }) => void;
  signal?: AbortSignal;
}

export interface CreatedPdf {
  bytes: Uint8Array;
  /** Suggested file name (« Rapport.pdf »). */
  name: string;
  title: string;
  pageCount: number;
}

/** The HTML of a source file (every kind but plain text, which is written directly). */
export async function sourceToHtml(
  kind: Exclude<CreateSourceKind, "text">,
  bytes: Uint8Array,
  name: string,
  opts: Pick<CreatePdfOptions, "orientation" | "password"> = {},
): Promise<HtmlSource> {
  switch (kind) {
    case "docx":
      return docxSource(bytes, name, opts.orientation);
    case "markdown":
      return markdownSource(decodeText(bytes), name, opts.orientation);
    case "html":
      return htmlSource(decodeText(bytes), name, opts.orientation);
    case "xlsx": {
      const { importXlsx } = await import("../../sheet/xlsx-import");
      return workbookSource(importXlsx(bytes), name, opts.orientation);
    }
    case "pptx": {
      const { deckSource } = await import("../ui/slidesHtml");
      const { importPptx } = await import("../../slides/pptx-import");
      return deckSource(importPptx(bytes), bytes, name);
    }
    case "elium": {
      const { readEliumPackage } = await import("../../format/elium-package");
      const { file } = await readEliumPackage(bytes, opts.password ? { password: opts.password } : {});
      return eliumSource(file, opts.orientation);
    }
  }
}

/**
 * Make a PDF of a Word, Excel, PowerPoint, HTML, text, Markdown or Elium file.
 * Runs in the browser (the pages are laid out and drawn by it). Throws with a
 * French message for a file it cannot read; an encrypted Elium document throws
 * `EliumPasswordRequired` until `password` is given.
 */
export async function createPdfFromFile(file: File, opts: CreatePdfOptions = {}): Promise<CreatedPdf> {
  const kind = createSourceKind(file.name);
  if (!kind) throw new Error(`Format non pris en charge : ${file.name}`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = `${baseName(file.name)}.pdf`;
  opts.onProgress?.({ done: 0, total: 1, stage: "Lecture du fichier…" });
  if (kind === "text") {
    const title = baseName(file.name);
    const pdf = await textToPdfDocument(decodeText(bytes), title, opts.orientation);
    const pageCount = (await PDFDocument.load(pdf, { updateMetadata: false })).getPageCount();
    return { bytes: pdf, name, title, pageCount };
  }
  let source: HtmlSource;
  try {
    source = await sourceToHtml(kind, bytes, file.name, opts);
  } catch (e) {
    // Password prompts and damaged packages carry their own message.
    const { EliumPackageError } = await import("../../format/elium-package");
    if (e instanceof EliumPackageError) throw e;
    const reason = e instanceof Error && e.message ? ` (${e.message})` : "";
    throw new Error(`Impossible de lire ${CREATE_SOURCE_LABELS[kind]}${reason}.`);
  }
  const { renderHtmlSource } = await import("../ui/htmlToPdf");
  const pages = await renderHtmlSource(source, {
    dpi: opts.dpi,
    signal: opts.signal,
    onProgress: (done, total) => opts.onProgress?.({ done, total, stage: "Mise en page…" }),
  });
  const pdf = await assemblePdf(pages, {
    title: source.title,
    lang: source.lang,
    creator: source.creator,
    decorations: source.decorations,
    margin: source.page.margin,
  });
  return { bytes: pdf, name, title: source.title, pageCount: pages.length };
}
