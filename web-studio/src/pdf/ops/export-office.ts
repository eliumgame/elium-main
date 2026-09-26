/**
 * « Exporter un PDF » vers Word, Excel, PowerPoint et RTF — Acrobat's
 * Export PDF, entirely in the browser.
 *
 * The PDF is analysed once (export-office-model.ts: headings, paragraphs with
 * inline formatting, lists, tables, links, image placements, reading order)
 * and handed to the app's OWN writers rather than new ones:
 *
 * - Word: the model becomes an Elium document (ProseMirror JSON) written by
 *   `docToDocx` — real heading styles, numbering, tables, hyperlinks, images;
 * - Excel: every detected table becomes a sheet of `workbookToXlsx`, French and
 *   English numbers turned into real numeric cells;
 * - PowerPoint: one slide per page, at the page's size, through `deckToPptx`,
 *   with positioned text boxes over an optional page background;
 * - RTF: a small RTF 1.9 writer (export-rtf.ts).
 *
 * Everything is pure except the engine reads and the rasterisers the caller
 * injects (canvas lives in the browser: see export-office-raster.ts).
 */

import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { PdfEngine } from "../core/engine";
import type { Rect } from "../core/coords";
import type { EliumFile, PageSettings, ProseMirrorNode } from "../../format/types";
import { createDocumentModel, createEliumFile } from "../../format/document";
import { docToDocx } from "../../format/docx";
import { workbookToXlsx } from "../../sheet/xlsx-export";
import type { CellStyle, SheetData, Workbook } from "../../sheet/model";
import { deckToPptx } from "../../slides/pptx";
import type { Deck, Slide, SlideElement } from "../../slides/model";
import { newElementId, newSlideId } from "../../slides/model";
import { detectTables, type PageText } from "./export";
import {
  analyseLayout,
  collectPageMeta,
  runsText,
  splitOnGaps,
  textMargins,
  visualRows,
  type OfficeDocument,
  type OfficeImage,
  type OfficeItem,
  type OfficeRun,
} from "./export-office-model";
import { officeToRtf } from "./export-rtf";

export { analyseLayout, collectPageMeta, detectTableRegions } from "./export-office-model";
export type { OfficeDocument } from "./export-office-model";

/** Rasterises a region of a page (page space, points) to PNG or JPEG bytes. */
export type CropImage = (page: number, rect: Rect) => Promise<Uint8Array | null>;

export const OFFICE_MIME = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  rtf: "application/rtf",
} as const;

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const EMU_PER_PT = 12700;
const MM_PER_PT = 25.4 / 72;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const dataUrl = (bytes: Uint8Array) =>
  `data:${bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png"};base64,${bytesToBase64(bytes)}`;

/** Rasterise every image item of the model through the caller's crop callback. */
async function rasteriseImages(
  model: OfficeDocument,
  crop: CropImage | undefined,
): Promise<Map<OfficeImage, Uint8Array>> {
  const out = new Map<OfficeImage, Uint8Array>();
  if (!crop) return out;
  for (const page of model.pages) {
    for (const item of page.items) {
      if (item.kind !== "image") continue;
      try {
        const bytes = await crop(page.page, item.rect);
        if (bytes?.length) out.set(item, bytes);
      } catch {
        // A picture that cannot be rendered is left out; the text still exports.
      }
    }
  }
  return out;
}

async function analyse(
  engine: PdfEngine,
  layout: readonly PageText[],
  opts: { images: boolean; links: boolean },
): Promise<OfficeDocument> {
  const meta = await collectPageMeta(engine, layout, opts);
  return analyseLayout(layout, meta, { images: opts.images });
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

export interface DocxExportOptions {
  /** Picture crops (browser only). Without it, pictures are left out. */
  cropImage?: CropImage;
  /** Start each PDF page on a new Word page (default true). */
  pageBreaks?: boolean;
}

/** Export the PDF to Word (.docx). */
export async function exportDocx(
  engine: PdfEngine,
  layout: readonly PageText[],
  opts: DocxExportOptions = {},
): Promise<Uint8Array> {
  const model = await analyse(engine, layout, { images: !!opts.cropImage, links: true });
  const images = await rasteriseImages(model, opts.cropImage);
  return officeToDocx(model, images, opts);
}

const px = (pt: number) => Math.round((pt / 0.75) * 100) / 100;

function inlineNodes(runs: readonly OfficeRun[]): ProseMirrorNode[] {
  return runs.map((r) => {
    const marks: NonNullable<ProseMirrorNode["marks"]> = [];
    if (r.bold) marks.push({ type: "bold" });
    if (r.italic) marks.push({ type: "italic" });
    marks.push({
      type: "textStyle",
      attrs: { ...(r.fontFamily ? { fontFamily: r.fontFamily } : {}), fontSize: `${px(r.fontSize)}px` },
    });
    if (r.href) marks.push({ type: "link", attrs: { href: r.href } });
    return { type: "text", text: r.text, marks };
  });
}

const textAlign = (align: string) => (align === "left" ? {} : { textAlign: align });

function itemNodes(item: OfficeItem, images: ReadonlyMap<OfficeImage, Uint8Array>): ProseMirrorNode[] {
  switch (item.kind) {
    case "heading":
      return [
        { type: "heading", attrs: { level: item.level, ...textAlign(item.align) }, content: inlineNodes(item.runs) },
      ];
    case "paragraph": {
      const indent = item.indent > 12 ? Math.min(4, Math.max(1, Math.round(item.indent / 24))) : 0;
      return [
        {
          type: "paragraph",
          attrs: {
            ...textAlign(item.align),
            ...(indent ? { indent } : {}),
            ...(item.firstLine ? { firstLineIndent: px(item.firstLine) } : {}),
            spaceAfter: px(6),
          },
          content: inlineNodes(item.runs),
        },
      ];
    }
    case "list":
      return [
        {
          type: item.ordered ? "orderedList" : "bulletList",
          content: item.items.map((it) => ({
            type: "listItem",
            content: [{ type: "paragraph", content: inlineNodes(it.runs) }],
          })),
        },
      ];
    case "table":
      return [
        {
          type: "table",
          content: item.rows.map((row) => ({
            type: "tableRow",
            content: row.map((cell) => ({
              type: "tableCell",
              attrs: { colspan: 1, rowspan: 1 },
              content: [
                {
                  type: "paragraph",
                  content: cell.text
                    ? inlineNodes([{ text: cell.text, bold: cell.bold, italic: false, fontSize: item.fontSize }])
                    : [],
                },
              ],
            })),
          })),
        },
      ];
    case "image": {
      const bytes = images.get(item);
      return bytes ? [{ type: "image", attrs: { src: dataUrl(bytes), alt: "Image" } }] : [];
    }
  }
}

/** The page setup of the first PDF page: its exact size and the margins its text keeps. */
function pageSettings(model: OfficeDocument): PageSettings {
  const first = model.pages[0];
  const w = first?.w ?? 595.28;
  const h = first?.h ?? 841.89;
  const m = first ? textMargins(first) : { top: 70, right: 56, bottom: 70, left: 56 };
  const landscape = w > h;
  const mm = (pt: number) => Math.round(pt * MM_PER_PT * 10) / 10;
  return {
    format: "Custom",
    // A landscape sheet is its portrait size turned: Word then gets `w:orient`.
    orientation: landscape ? "landscape" : "portrait",
    customWidthMm: mm(landscape ? h : w),
    customHeightMm: mm(landscape ? w : h),
    margins: { top: mm(m.top), right: mm(m.right), bottom: mm(m.bottom), left: mm(m.left) },
  };
}

/** Build the .docx from an analysed document (pure). */
export async function officeToDocx(
  model: OfficeDocument,
  images: ReadonlyMap<OfficeImage, Uint8Array> = new Map(),
  opts: Pick<DocxExportOptions, "pageBreaks"> = {},
): Promise<Uint8Array> {
  const content: ProseMirrorNode[] = [];
  // Real sizes for the pictures, in document order (see below).
  const extents: { cx: number; cy: number }[] = [];
  const page = pageSettings(model);
  const contentPt = (page.orientation === "landscape" ? page.customHeightMm! : page.customWidthMm!) / MM_PER_PT;
  const usablePt = contentPt - (page.margins.left + page.margins.right) / MM_PER_PT;

  model.pages.forEach((p, i) => {
    if (i > 0 && opts.pageBreaks !== false) content.push({ type: "pageBreak" });
    for (const item of p.items) {
      const nodes = itemNodes(item, images);
      if (item.kind === "image" && nodes.length) {
        const k = Math.min(1, usablePt / item.rect.w);
        extents.push({ cx: Math.round(item.rect.w * k * EMU_PER_PT), cy: Math.round(item.rect.h * k * EMU_PER_PT) });
      }
      content.push(...nodes);
    }
  });
  if (!content.length) content.push({ type: "paragraph" });

  // An empty title: `docToDocx` would otherwise open the body with it as a heading.
  const file: EliumFile = await createEliumFile({ title: "", doc: { type: "doc", content } });
  file.document = createDocumentModel({ type: "doc", content }, page);
  const bytes = docToDocx(file);
  if (!extents.length) return bytes;

  // `docToDocx` sizes a picture from its pixels at 96 dpi; the crop was rendered
  // at whatever resolution the caller chose, so the size it had on the PDF page
  // is written back into each drawing (both extents), in order.
  const zip = unzipSync(bytes);
  let n = 0;
  const xml = strFromU8(zip["word/document.xml"]).replace(/<w:drawing>[\s\S]*?<\/w:drawing>/g, (d) => {
    const e = extents[n++];
    return e ? d.replace(/cx="\d+" cy="\d+"/g, `cx="${e.cx}" cy="${e.cy}"`) : d;
  });
  zip["word/document.xml"] = strToU8(xml);
  return zipSync(zip, { level: 6 });
}

// ---------------------------------------------------------------------------
// Excel
// ---------------------------------------------------------------------------

export interface ParsedNumber {
  value: number;
  kind: "integer" | "decimal" | "percent" | "currency";
  decimals: number;
}

const CURRENCY_RE = /^(€|EUR|\$|USD|£|GBP|CHF)\s*|\s*(€|EUR|\$|USD|£|GBP|CHF)$/i;

/**
 * A number as printed in a French or English document — « 1 234,50 »,
 * « 3500,00 », « 1,234.50 », « 12 % », « 42,00 € », « (15,00) » — or null when
 * the text is not one (codes with leading zeros, dates, phone numbers…).
 */
export function parseLocaleNumber(input: string): ParsedNumber | null {
  let s = input.replace(/[   ]/g, " ").trim();
  if (!s || s.length > 40) return null;
  let negative = false;
  let percent = false;
  let currency = false;
  const sign = () => {
    const m = /^[-−]\s*/.exec(s);
    if (m) {
      negative = !negative;
      s = s.slice(m[0].length);
    } else if (s.startsWith("+")) s = s.slice(1).trimStart();
  };
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  sign();
  const cur = CURRENCY_RE.exec(s);
  if (cur) {
    currency = true;
    s = (s.slice(0, cur.index) + s.slice(cur.index + cur[0].length)).trim();
    sign();
  }
  if (s.endsWith("%")) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  if (!/^\d/.test(s) || !/\d$/.test(s)) return null;

  let normal: string | null = null;
  if (/^\d{1,3}(?:[ '’]\d{3})+(?:[.,]\d+)?$/.test(s)) normal = s.replace(/[ '’]/g, "").replace(",", ".");
  else if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(s)) normal = s.replace(/\./g, "").replace(",", ".");
  else if (/^\d{1,3}(?:,\d{3})+\.\d+$/.test(s)) normal = s.replace(/,/g, "");
  else if (/^\d+[.,]\d+$/.test(s)) normal = s.replace(",", ".");
  else if (/^\d{1,3}(?:,\d{3}){2,}$/.test(s)) normal = s.replace(/,/g, "");
  else if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(s)) normal = s.replace(/\./g, "");
  else if (/^\d+$/.test(s) && s.length <= 15 && !(s.length > 1 && s.startsWith("0"))) normal = s;
  if (normal == null) return null;
  // « 0123,5 » is a code, not a number.
  if (/^0\d/.test(normal)) return null;

  const decimals = normal.includes(".") ? normal.split(".")[1].length : 0;
  let value = Number(normal);
  if (!Number.isFinite(value)) return null;
  if (percent) value = Number((value / 100).toPrecision(15));
  if (negative) value = -value;
  const kind = percent ? "percent" : currency ? "currency" : decimals ? "decimal" : "integer";
  return { value, kind, decimals };
}

/** A cell's raw content and style from the text printed in the PDF. */
function cellOf(text: string): { raw: string; style?: CellStyle } {
  const n = parseLocaleNumber(text);
  if (n) {
    const raw = String(n.value);
    if (n.kind === "percent") {
      return {
        raw,
        style: n.decimals ? { fmt: "custom", customFmt: `0.${"0".repeat(n.decimals)}%` } : { fmt: "percent" },
      };
    }
    if (n.kind === "currency") return { raw, style: { fmt: "currency" } };
    if (n.kind === "decimal") {
      return {
        raw,
        style: n.decimals === 2 ? { fmt: "number" } : { fmt: "custom", customFmt: `0.${"0".repeat(n.decimals)}` },
      };
    }
    return { raw };
  }
  // Text that starts with « = » would be read as a formula: write it as one returning the text.
  if (text.startsWith("=")) return { raw: `="${text.replace(/"/g, '""')}"` };
  return { raw: text };
}

function sheetOf(name: string, rows: readonly (readonly string[])[], header: boolean): SheetData {
  const cells: Record<string, string> = {};
  const styles: Record<string, CellStyle> = {};
  const widths: Record<number, number> = {};
  const cols = Math.max(1, ...rows.map((r) => r.length));
  rows.forEach((row, r) => {
    row.forEach((text, c) => {
      if (!text) return;
      const key = `${colName(c)}${r + 1}`;
      const cell = cellOf(text);
      cells[key] = cell.raw;
      const style = { ...cell.style, ...(header && r === 0 ? { bold: true } : {}) };
      if (Object.keys(style).length) styles[key] = style;
      widths[c] = Math.max(widths[c] ?? 64, Math.min(360, text.length * 7 + 16));
    });
  });
  return {
    name,
    rows: Math.max(rows.length, 1),
    cols,
    cells,
    ...(Object.keys(styles).length ? { styles } : {}),
    colWidths: widths,
    ...(header ? { freeze: { rows: 1, cols: 0 } } : {}),
  };
}

function colName(n: number): string {
  let s = "";
  let x = n + 1;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

/** A column label: text, or a year heading a column of figures (« 2024 »). */
const isLabel = (c: string) => !parseLocaleNumber(c) || /^(19|20)\d\d$/.test(c.trim());

/** A header row: labels only, at least one of them words, above rows that hold numbers. */
const isHeaderRow = (rows: readonly (readonly string[])[]) =>
  rows.length >= 2 &&
  rows[0].some((c) => c && !parseLocaleNumber(c)) &&
  rows[0].every((c) => !c || isLabel(c)) &&
  rows.slice(1).some((r) => r.some((c) => c && parseLocaleNumber(c)));

/**
 * Export the PDF's tables to Excel (.xlsx): one sheet per detected table,
 * « Page N — Tableau k ». Without any table, one sheet holds every text line
 * split on its column gaps.
 */
export function exportXlsx(layout: readonly PageText[]): Uint8Array {
  const tables = detectTables(layout);
  const sheets: SheetData[] = [];
  const perPage = new Map<number, number>();
  for (const t of tables) {
    const k = (perPage.get(t.page) ?? 0) + 1;
    perPage.set(t.page, k);
    sheets.push(sheetOf(`Page ${t.page + 1} — Tableau ${k}`, t.rows, isHeaderRow(t.rows)));
  }
  if (!sheets.length) {
    const rows: string[][] = [];
    layout.forEach((p, i) => {
      if (i > 0 && rows.length) rows.push([]);
      for (const row of visualRows(p.lines)) {
        const cells = splitOnGaps(row.line);
        if (cells.length) rows.push(cells);
      }
    });
    sheets.push(sheetOf("Texte", rows, false));
  }
  const wb: Workbook = { sheets, active: 0 };
  return workbookToXlsx(wb);
}

// ---------------------------------------------------------------------------
// PowerPoint
// ---------------------------------------------------------------------------

export interface PptxExportOptions {
  /**
   * The page's background as PNG/JPEG bytes (browser only), drawn under the
   * text boxes. It should NOT carry the text itself (see
   * export-office-raster.ts, which paints it out); without it slides hold the
   * text and tables only.
   */
  pageImage?: (page: number) => Promise<Uint8Array | null>;
}

/** The stage `deckToPptx` maps percentages onto (its 16:9 slide, in EMU). */
const STAGE_CX = 12192000;
const STAGE_CY = 6858000;
/** PowerPoint's slide size limits: 1 in to 56 in. */
const SLIDE_MIN = 914400;
const SLIDE_MAX = 51206400;

/** Export the PDF to PowerPoint (.pptx): one slide per page, at the page's size. */
export async function exportPptx(
  engine: PdfEngine,
  layout: readonly PageText[],
  opts: PptxExportOptions = {},
): Promise<Uint8Array> {
  const model = await analyse(engine, layout, { images: false, links: false });
  const backgrounds: (Uint8Array | null)[] = [];
  for (const p of model.pages) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = opts.pageImage ? await opts.pageImage(p.page) : null;
    } catch {
      bytes = null;
    }
    backgrounds.push(bytes?.length ? bytes : null);
  }
  return officeToPptx(model, backgrounds);
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const runsHtml = (runs: readonly OfficeRun[]) =>
  runs
    .map((r) => {
      let h = escHtml(r.text);
      if (r.italic) h = `<i>${h}</i>`;
      if (r.bold) h = `<b>${h}</b>`;
      return h;
    })
    .join("");

/** Build the .pptx from an analysed document (pure). `backgrounds[i]` goes under page i. */
export function officeToPptx(model: OfficeDocument, backgrounds: readonly (Uint8Array | null)[] = []): Uint8Array {
  const first = model.pages[0] ?? { w: 960, h: 540 };
  // The first page sets the slide size — its real size, within PowerPoint's limits.
  let k0 = Math.min(1, SLIDE_MAX / (Math.max(first.w, first.h) * EMU_PER_PT));
  k0 = Math.max(k0, SLIDE_MIN / (Math.min(first.w, first.h) * EMU_PER_PT));
  const slideW = Math.round(first.w * k0 * EMU_PER_PT);
  const slideH = Math.round(first.h * k0 * EMU_PER_PT);
  // deckToPptx maps x/w onto its 16:9 stage: percentages are pre-scaled so they
  // land on OUR slide size once presentation.xml carries it.
  const pctX = (emu: number) => (emu / STAGE_CX) * 100;
  const pctY = (emu: number) => (emu / STAGE_CY) * 100;
  const insetX = 91440; // the text box's default insets (0.1 in / 0.05 in)
  const insetY = 45720;

  const slides: Slide[] = model.pages.map((page, i) => {
    // A page of another size is fitted and centred.
    const k = Math.min(slideW / (page.w * EMU_PER_PT), slideH / (page.h * EMU_PER_PT));
    const ox = (slideW - page.w * EMU_PER_PT * k) / 2;
    const oy = (slideH - page.h * EMU_PER_PT * k) / 2;
    const X = (pt: number) => ox + pt * EMU_PER_PT * k;
    const Y = (pt: number) => oy + pt * EMU_PER_PT * k;
    const L = (pt: number) => pt * EMU_PER_PT * k;
    const elements: SlideElement[] = [];
    const bg = backgrounds[i];
    if (bg) {
      elements.push({
        id: newElementId(),
        type: "image",
        src: dataUrl(bg),
        x: pctX(ox),
        y: pctY(oy),
        w: pctX(L(page.w)),
        h: pctY(L(page.h)),
        locked: true,
      });
    }
    for (const item of page.items) {
      if (item.kind === "image") continue; // part of the background
      const r = item.rect;
      const fontSize = (item.fontSize * k) / 0.75; // px at the 720-px reference: 1 px = 0.75 pt
      if (item.kind === "table") {
        elements.push({
          id: newElementId(),
          type: "table",
          x: pctX(X(r.x)),
          y: pctY(Y(r.y)),
          w: pctX(L(r.w)),
          h: pctY(L(r.h)),
          fontSize,
          color: "#000000",
          table: {
            rows: item.rows.length,
            cols: Math.max(1, ...item.rows.map((row) => row.length)),
            cells: item.rows.map((row) => row.map((c) => c.text)),
          },
        });
        continue;
      }
      let html: string;
      if (item.kind === "list") {
        html = item.ordered
          ? item.items.map((it) => `<p>${escHtml(it.marker)} ${runsHtml(it.runs)}</p>`).join("")
          : `<ul>${item.items.map((it) => `<li>${runsHtml(it.runs)}</li>`).join("")}</ul>`;
      } else {
        html = `<p>${runsHtml(item.runs)}</p>`;
      }
      if (!html.replace(/<[^>]+>/g, "").trim()) continue;
      // Some slack on the width: the replacement font rarely sets as tight as the PDF's.
      const slack = Math.max(L(r.w) * 0.08, L(item.fontSize));
      elements.push({
        id: newElementId(),
        type: "text",
        x: pctX(X(r.x) - insetX),
        y: pctY(Y(r.y) - insetY),
        w: pctX(L(r.w) + slack + 2 * insetX),
        h: pctY(L(r.h) + L(item.fontSize) * 0.3 + 2 * insetY),
        html,
        fontSize,
        color: "#000000",
        align: item.kind !== "list" && (item.align === "center" || item.align === "right") ? item.align : "left",
        valign: "top",
      });
    }
    return { id: newSlideId(), title: "", body: "", layout: "blank", background: "#FFFFFF", elements };
  });

  const deck: Deck = { slides, active: 0, theme: "light", transition: "none" };
  const zip = unzipSync(deckToPptx(deck));
  zip["ppt/presentation.xml"] = strToU8(
    strFromU8(zip["ppt/presentation.xml"]).replace(
      /<p:sldSz cx="\d+" cy="\d+"\/>/,
      `<p:sldSz cx="${slideW}" cy="${slideH}"/>`,
    ),
  );
  return zipSync(zip, { level: 6 });
}

// ---------------------------------------------------------------------------
// RTF
// ---------------------------------------------------------------------------

export interface RtfExportOptions {
  /** Picture crops (browser only). Without it, pictures are left out. */
  cropImage?: CropImage;
  title?: string;
}

/** Export the PDF to RTF (an ASCII string: save it as `application/rtf`). */
export async function exportRtf(
  engine: PdfEngine,
  layout: readonly PageText[],
  opts: RtfExportOptions = {},
): Promise<string> {
  const model = await analyse(engine, layout, { images: !!opts.cropImage, links: true });
  const images = await rasteriseImages(model, opts.cropImage);
  return officeToRtf(model, images, opts.title ?? "");
}

/** Plain text of the analysed document, for diagnostics and tests. */
export function officeText(model: OfficeDocument): string {
  return model.pages
    .map((p) =>
      p.items
        .map((i) =>
          i.kind === "list"
            ? i.items.map((it) => `${it.marker} ${runsText(it.runs)}`).join("\n")
            : i.kind === "table"
              ? i.rows.map((r) => r.map((c) => c.text).join("\t")).join("\n")
              : i.kind === "image"
                ? "[image]"
                : runsText(i.runs),
        )
        .join("\n\n"),
    )
    .join("\n\f\n");
}
