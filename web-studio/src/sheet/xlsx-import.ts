/**
 * XLSX (SpreadsheetML) importer — no new dependency. Unzips with fflate
 * (already used by the DOCX module) and parses the XML with the browser
 * DOMParser. Reads shared strings, cell values/formulas AND styles (numFmt,
 * font, fill, border), merged cells, column widths, frozen panes, conditional
 * formatting, data validation and native charts — the inverse of xlsx-export.ts,
 * so a workbook survives an export → re-import round trip, and reopening an
 * external .xlsx keeps its formatting instead of silently dropping it.
 */
import { unzipSync, strFromU8 } from "fflate";
import { parseRef } from "./formula";
import {
  emptySheet,
  newId,
  type SheetData,
  type Workbook,
  type CellStyle,
  type NumFmt,
  type CondRule,
  type CondOp,
  type DataValidation,
  type ValidationOp,
  type ValidationType,
  type MergeRect,
  type ChartSpec,
  type ChartType,
  type BorderSide,
  type BorderStyle,
} from "./model";

function parseXml(bytes: Uint8Array | undefined): Document | null {
  if (!bytes) return null;
  return new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
}

function textOf(el: Element): string {
  // Concatenate every <t> descendant (handles rich-text runs); else textContent.
  const ts = el.getElementsByTagName("t");
  if (ts.length) {
    let s = "";
    for (let i = 0; i < ts.length; i++) s += ts[i].textContent ?? "";
    return s;
  }
  return el.textContent ?? "";
}

function parseSharedStrings(zip: Record<string, Uint8Array>): string[] {
  const doc = parseXml(zip["xl/sharedStrings.xml"]);
  if (!doc) return [];
  const out: string[] = [];
  const sis = doc.getElementsByTagName("si");
  for (let i = 0; i < sis.length; i++) out.push(textOf(sis[i]));
  return out;
}

/** OPC relationships (Id → Target), read from an already-parsed .rels document. */
function relTargets(doc: Document | null): Record<string, string> {
  const map: Record<string, string> = {};
  if (!doc) return map;
  const rels = doc.getElementsByTagName("Relationship");
  for (let i = 0; i < rels.length; i++) {
    const id = rels[i].getAttribute("Id");
    const target = rels[i].getAttribute("Target");
    if (id && target) map[id] = target;
  }
  return map;
}

/** Resolve a (possibly relative, `../`-bearing) OPC relationship target against its source part's directory. */
function resolvePath(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const stack: string[] = [];
  for (const part of `${baseDir}/${target}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return stack.join("/");
}
const relsPathOf = (partPath: string): string => partPath.replace(/([^/]+)$/, "_rels/$1.rels");

/** "'Sheet 1'!$B$2:$B$5", "B2:B5" or a bare "sqref" range → 0-based rectangle. */
function parseRangeRef(ref: string): { c0: number; r0: number; c1: number; r1: number } | null {
  const bang = ref.lastIndexOf("!");
  const rangePart = (bang >= 0 ? ref.slice(bang + 1) : ref).trim();
  const [a, b] = rangePart.split(":");
  const pa = a ? parseRef(a.toUpperCase()) : null;
  const pb = b ? parseRef(b.toUpperCase()) : pa;
  if (!pa || !pb) return null;
  return {
    c0: Math.min(pa.col, pb.col),
    c1: Math.max(pa.col, pb.col),
    r0: Math.min(pa.row, pb.row),
    r1: Math.max(pa.row, pb.row),
  };
}
/** A `sqref` attribute can list several space-separated ranges; our own export always writes exactly one. */
const parseSqrefFirst = (sqref: string) => parseRangeRef(sqref.trim().split(/\s+/)[0] ?? "");

function argbToHex(rgb: string | null | undefined): string | undefined {
  if (!rgb) return undefined;
  const h = rgb.replace(/^#/, "");
  if (/^[0-9A-Fa-f]{8}$/.test(h)) return `#${h.slice(2).toLowerCase()}`;
  if (/^[0-9A-Fa-f]{6}$/.test(h)) return `#${h.toLowerCase()}`;
  return undefined;
}

// Excel/Sheets serial-date epoch (matches sheet/format.ts's rendering epoch and
// xlsx-export.ts's writer, so a validation bound round-trips to the same date).
const DATE_EPOCH = Date.UTC(1899, 11, 30);
function serialToIsoDate(serial: number): string {
  const d = new Date(DATE_EPOCH + Math.round(serial) * 86400000);
  return Number.isNaN(d.getTime()) ? String(serial) : d.toISOString().slice(0, 10);
}

// ── styles.xml : numFmt / font / fill / border / cellXfs / dxfs ────────────

interface ParsedFont {
  bold?: boolean;
  italic?: boolean;
  color?: string;
  name?: string;
  sz?: number;
}
interface ParsedBorder {
  top?: BorderSide;
  right?: BorderSide;
  bottom?: BorderSide;
  left?: BorderSide;
}
interface ParsedXf {
  numFmtId: number;
  fontId: number;
  fillId: number;
  borderId: number;
  align?: "center" | "right";
}
interface ParsedDxf {
  bold?: boolean;
  color?: string;
  fill?: string;
}
interface ParsedStyles {
  xfs: ParsedXf[];
  fonts: ParsedFont[];
  fills: (string | undefined)[];
  borders: ParsedBorder[];
  numFmts: Map<number, string>;
  dxfs: ParsedDxf[];
}

// The subset of ECMA-376 built-in numFmt codes (§18.8.30) common enough to
// affect our NumFmt classification (percent/date/datetime); ids we don't list
// fall back to "general" unless a matching custom <numFmt> is present.
const BUILTIN_NUMFMTS: Record<number, string> = {
  1: "0",
  2: "0.00",
  3: "#,##0",
  4: "#,##0.00",
  9: "0%",
  10: "0.00%",
  11: "0.00E+00",
  14: "mm-dd-yy",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "m/d/yy h:mm",
  37: "#,##0;(#,##0)",
  38: "#,##0;[Red](#,##0)",
  39: "#,##0.00;(#,##0.00)",
  40: "#,##0.00;[Red](#,##0.00)",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mmss.0",
  48: "##0.0E+0",
  49: "@",
};

// Exact codes xlsx-export.ts itself writes — matched first so our own round
// trip is lossless; everything else goes through the heuristic below.
const OURS_NUMFMT: Record<string, NumFmt> = {
  "0.00": "number",
  "0": "int",
  "#,##0.00\\ €": "currency",
  "0%": "percent",
  "yyyy\\-mm\\-dd": "date",
  "yyyy\\-mm\\-dd\\ hh:mm": "datetime",
};

/** Best-effort classification of an arbitrary Excel format code into our fixed NumFmt set. */
function classifyNumFmt(code: string): NumFmt {
  if (!code || code === "General" || code === "@") return "general";
  const ours = OURS_NUMFMT[code];
  if (ours) return ours;
  const bare = code.replace(/\[[^\]]*\]/g, ""); // strip [Red], [$€-407], …
  const hasDate = /[dy]/i.test(bare) && /m/i.test(bare);
  const hasTime = /[hs]/i.test(bare) && bare.includes(":");
  if (hasDate && hasTime) return "datetime";
  if (hasDate) return "date";
  if (bare.includes("%")) return "percent";
  if (/[$€£¥]/.test(bare) || code.includes("[$")) return "currency";
  if (/0\.0/.test(bare)) return "number";
  if (/^[#0]+$/.test(bare.replace(/[,; ]/g, ""))) return "int";
  return "general";
}
function numFmtIdToOurs(id: number, custom: Map<number, string>): NumFmt {
  if (!id) return "general";
  const code = custom.get(id) ?? BUILTIN_NUMFMTS[id];
  return code ? classifyNumFmt(code) : "general";
}

const BORDER_STYLE_MAP: Record<string, BorderStyle> = {
  thin: "thin",
  medium: "medium",
  thick: "thick",
  dashed: "dashed",
  dotted: "dotted",
  double: "double",
  hair: "dotted",
  mediumDashed: "dashed",
  dashDot: "dashed",
  mediumDashDot: "dashed",
  dashDotDot: "dashed",
  mediumDashDotDot: "dashed",
  slantDashDot: "dashed",
};
function parseSide(el: Element | undefined): BorderSide | undefined {
  const style = el?.getAttribute("style");
  if (!el || !style || style === "none") return undefined;
  const color = argbToHex(el.getElementsByTagName("color")[0]?.getAttribute("rgb"));
  return { style: BORDER_STYLE_MAP[style] ?? "thin", ...(color ? { color } : {}) };
}

function parseStylesXml(zip: Record<string, Uint8Array>): ParsedStyles {
  const doc = parseXml(zip["xl/styles.xml"]);

  const numFmts = new Map<number, string>();
  const numFmtEls = doc?.getElementsByTagName("numFmts")[0]?.getElementsByTagName("numFmt") ?? [];
  for (let i = 0; i < numFmtEls.length; i++) {
    const id = Number(numFmtEls[i].getAttribute("numFmtId") ?? "");
    const code = numFmtEls[i].getAttribute("formatCode");
    if (Number.isFinite(id) && code != null) numFmts.set(id, code);
  }

  const fonts: ParsedFont[] = [];
  const fontEls = doc?.getElementsByTagName("fonts")[0]?.getElementsByTagName("font") ?? [];
  for (let i = 0; i < fontEls.length; i++) {
    const f = fontEls[i];
    const sz = f.getElementsByTagName("sz")[0]?.getAttribute("val");
    fonts.push({
      bold: !!f.getElementsByTagName("b")[0],
      italic: !!f.getElementsByTagName("i")[0],
      color: argbToHex(f.getElementsByTagName("color")[0]?.getAttribute("rgb")),
      name: f.getElementsByTagName("name")[0]?.getAttribute("val") ?? undefined,
      sz: sz ? Number(sz) : undefined,
    });
  }

  const fills: (string | undefined)[] = [];
  const fillEls = doc?.getElementsByTagName("fills")[0]?.getElementsByTagName("fill") ?? [];
  for (let i = 0; i < fillEls.length; i++) {
    const pf = fillEls[i].getElementsByTagName("patternFill")[0];
    const type = pf?.getAttribute("patternType");
    if (!pf || !type || type === "none" || type === "gray125") {
      fills.push(undefined);
      continue;
    }
    const rgb =
      pf.getElementsByTagName("fgColor")[0]?.getAttribute("rgb") ??
      pf.getElementsByTagName("bgColor")[0]?.getAttribute("rgb");
    fills.push(argbToHex(rgb));
  }

  const borders: ParsedBorder[] = [];
  const borderEls = doc?.getElementsByTagName("borders")[0]?.getElementsByTagName("border") ?? [];
  for (let i = 0; i < borderEls.length; i++) {
    const b = borderEls[i];
    borders.push({
      left: parseSide(b.getElementsByTagName("left")[0]),
      right: parseSide(b.getElementsByTagName("right")[0]),
      top: parseSide(b.getElementsByTagName("top")[0]),
      bottom: parseSide(b.getElementsByTagName("bottom")[0]),
    });
  }

  const xfs: ParsedXf[] = [];
  const xfEls = doc?.getElementsByTagName("cellXfs")[0]?.getElementsByTagName("xf") ?? [];
  for (let i = 0; i < xfEls.length; i++) {
    const xf = xfEls[i];
    const h = xf.getElementsByTagName("alignment")[0]?.getAttribute("horizontal");
    xfs.push({
      numFmtId: Number(xf.getAttribute("numFmtId") ?? "0"),
      fontId: Number(xf.getAttribute("fontId") ?? "0"),
      fillId: Number(xf.getAttribute("fillId") ?? "0"),
      borderId: Number(xf.getAttribute("borderId") ?? "0"),
      align: h === "center" || h === "right" ? h : undefined,
    });
  }

  const dxfs: ParsedDxf[] = [];
  const dxfEls = doc?.getElementsByTagName("dxfs")[0]?.getElementsByTagName("dxf") ?? [];
  for (let i = 0; i < dxfEls.length; i++) {
    const dxf = dxfEls[i];
    const fontEl = dxf.getElementsByTagName("font")[0];
    const fillEl = dxf.getElementsByTagName("fill")[0];
    const fillRgb =
      fillEl?.getElementsByTagName("bgColor")[0]?.getAttribute("rgb") ??
      fillEl?.getElementsByTagName("fgColor")[0]?.getAttribute("rgb");
    dxfs.push({
      bold: !!fontEl?.getElementsByTagName("b")[0],
      color: argbToHex(fontEl?.getElementsByTagName("color")[0]?.getAttribute("rgb")),
      fill: argbToHex(fillRgb),
    });
  }

  return { xfs, fonts, fills, borders, numFmts, dxfs };
}

const DEFAULT_FONT_PT = 11; // matches xlsx-export.ts's own default (11pt when no fontSize style is set)

/** Rebuild the CellStyle a cell's `s` (style index) attribute represents; `{}` for the default style. */
function xfToCellStyle(xfIndex: number, ps: ParsedStyles): CellStyle {
  const xf = ps.xfs[xfIndex];
  if (!xf) return {};
  const st: CellStyle = {};
  const font = ps.fonts[xf.fontId];
  if (font?.bold) st.bold = true;
  if (font?.italic) st.italic = true;
  if (font?.color) st.color = font.color;
  if (font?.name && font.name.toLowerCase() !== "calibri") st.fontFamily = font.name;
  if (font?.sz && Math.round(font.sz) !== DEFAULT_FONT_PT) st.fontSize = Math.round((font.sz * 4) / 3); // pt → px
  const fill = ps.fills[xf.fillId];
  if (fill) st.fill = fill;
  const b = ps.borders[xf.borderId];
  if (b && (b.top || b.right || b.bottom || b.left)) {
    st.border = {
      ...(b.top ? { top: b.top } : {}),
      ...(b.right ? { right: b.right } : {}),
      ...(b.bottom ? { bottom: b.bottom } : {}),
      ...(b.left ? { left: b.left } : {}),
    };
  }
  if (xf.align) st.align = xf.align;
  const fmt = numFmtIdToOurs(xf.numFmtId, ps.numFmts);
  if (fmt !== "general") st.fmt = fmt;
  return st;
}

// ── merges / cols / freeze ──────────────────────────────────────────────────

function parseMerges(doc: Document): MergeRect[] {
  const out: MergeRect[] = [];
  const els = doc.getElementsByTagName("mergeCell");
  for (let i = 0; i < els.length; i++) {
    const ref = els[i].getAttribute("ref");
    const r = ref ? parseRangeRef(ref) : null;
    if (r) out.push(r);
  }
  return out;
}

/** Excel's "characters" width unit → px (inverse of xlsx-export.ts's `pxToCharWidth`, same 7px/char heuristic). */
const charWidthToPx = (w: number): number => Math.max(24, Math.round(w * 7 + 5));
function parseColWidths(doc: Document): Record<number, number> {
  const out: Record<number, number> = {};
  const els = doc.getElementsByTagName("col");
  for (let i = 0; i < els.length; i++) {
    const col = els[i];
    const wAttr = col.getAttribute("width");
    if (col.getAttribute("customWidth") !== "1" || !wAttr) continue;
    const min = Number(col.getAttribute("min") ?? "");
    const max = Number(col.getAttribute("max") ?? min);
    const w = Number(wAttr);
    if (!Number.isFinite(min) || !Number.isFinite(w)) continue;
    const last = Math.min(Number.isFinite(max) ? max : min, min + 200); // guard against absurd builtin ranges
    for (let c = min; c <= last; c++) out[c - 1] = charWidthToPx(w);
  }
  return out;
}

function parseFreeze(doc: Document): { rows: number; cols: number } | undefined {
  const pane = doc.getElementsByTagName("pane")[0];
  const state = pane?.getAttribute("state");
  if (!pane || (state !== "frozen" && state !== "frozenSplit")) return undefined;
  const cols = Math.max(0, Math.round(Number(pane.getAttribute("xSplit") ?? "0")));
  const rows = Math.max(0, Math.round(Number(pane.getAttribute("ySplit") ?? "0")));
  return rows > 0 || cols > 0 ? { rows, cols } : undefined;
}

// ── conditional formatting / data validation ────────────────────────────────

const CF_OP_REV: Record<string, CondOp> = {
  greaterThan: "gt",
  lessThan: "lt",
  greaterThanOrEqual: "ge",
  lessThanOrEqual: "le",
  equal: "eq",
  notEqual: "ne",
};
const unquote = (s: string): string => (/^".*"$/.test(s) ? s.slice(1, -1) : s);

function applyDxf(rule: CondRule, dxf: ParsedDxf | undefined): void {
  if (!dxf) return;
  if (dxf.bold) rule.bold = true;
  if (dxf.color) rule.color = dxf.color;
  if (dxf.fill) rule.fill = dxf.fill;
}

function parseCondFormats(doc: Document, ps: ParsedStyles): CondRule[] {
  const out: CondRule[] = [];
  const blocks = doc.getElementsByTagName("conditionalFormatting");
  for (let i = 0; i < blocks.length; i++) {
    const range = parseSqrefFirst(blocks[i].getAttribute("sqref") ?? "");
    if (!range) continue;
    const rules = blocks[i].getElementsByTagName("cfRule");
    for (let j = 0; j < rules.length; j++) {
      const el = rules[j];
      const type = el.getAttribute("type");
      const dxfIdAttr = el.getAttribute("dxfId");
      const dxf = dxfIdAttr != null ? ps.dxfs[Number(dxfIdAttr)] : undefined;
      const base = { id: newId("cf"), ...range };
      const formulas = [...el.getElementsByTagName("formula")].map((f) => f.textContent ?? "");

      if (type === "colorScale") {
        const colors = [...(el.getElementsByTagName("colorScale")[0]?.getElementsByTagName("color") ?? [])].map(
          (c) => argbToHex(c.getAttribute("rgb")) ?? "#ffffff",
        );
        if (colors.length >= 2) {
          const scale =
            colors.length >= 3
              ? { min: colors[0]!, mid: colors[1]!, max: colors[2]! }
              : { min: colors[0]!, max: colors[1]! };
          out.push({ ...base, op: "colorScale", scale });
        }
      } else if (type === "cellIs") {
        const op =
          CF_OP_REV[el.getAttribute("operator") ?? ""] ??
          (el.getAttribute("operator") === "between" ? "between" : undefined);
        if (!op) continue;
        const rule: CondRule = { ...base, op, v1: formulas[0] !== undefined ? unquote(formulas[0]) : undefined };
        if (op === "between") rule.v2 = formulas[1];
        applyDxf(rule, dxf);
        out.push(rule);
      } else if (type === "containsText") {
        const rule: CondRule = { ...base, op: "contains", v1: el.getAttribute("text") ?? "" };
        applyDxf(rule, dxf);
        out.push(rule);
      } else if (type === "containsBlanks") {
        const rule: CondRule = { ...base, op: "empty" };
        applyDxf(rule, dxf);
        out.push(rule);
      } else if (type === "notContainsBlanks") {
        const rule: CondRule = { ...base, op: "notEmpty" };
        applyDxf(rule, dxf);
        out.push(rule);
      }
      // Other rule types (expression, top10, duplicateValues, …) come from other
      // tools and have no equivalent in our model — skipped, degrade gracefully.
    }
  }
  return out;
}

const DV_OP_REV: Record<string, ValidationOp> = {
  between: "between",
  notBetween: "notBetween",
  greaterThan: "gt",
  lessThan: "lt",
  greaterThanOrEqual: "ge",
  lessThanOrEqual: "le",
  equal: "eq",
  notEqual: "ne",
};

function parseValidations(doc: Document): DataValidation[] {
  const out: DataValidation[] = [];
  const els = doc.getElementsByTagName("dataValidation");
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    const range = parseSqrefFirst(el.getAttribute("sqref") ?? "");
    if (!range) continue;
    const type = el.getAttribute("type");
    const allowBlank = el.getAttribute("allowBlank") !== "0";
    const f1 = el.getElementsByTagName("formula1")[0]?.textContent ?? undefined;
    const f2 = el.getElementsByTagName("formula2")[0]?.textContent ?? undefined;
    const base = { id: newId("dv"), ...range, allowBlank };

    if (type === "list") {
      const raw = f1 !== undefined ? unquote(f1) : "";
      const list = raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      out.push({ ...base, type: "list", list });
      continue;
    }
    const vType: ValidationType | undefined =
      type === "decimal" || type === "whole"
        ? "number"
        : type === "textLength"
          ? "textLength"
          : type === "date"
            ? "date"
            : undefined;
    if (!vType) continue; // custom/time/textList/other → no equivalent, skip
    const op = DV_OP_REV[el.getAttribute("operator") ?? "between"] ?? "between";
    const toStr = (raw: string | undefined): string | undefined => {
      if (raw === undefined) return undefined;
      if (vType !== "date") return raw;
      const n = Number(raw);
      return Number.isFinite(n) ? serialToIsoDate(n) : raw;
    };
    out.push({ ...base, type: vType, op, v1: toStr(f1), v2: toStr(f2) });
  }
  return out;
}

// ── native charts (DrawingML, via the sheet's drawing relationship) ────────

function firstFormulaRef(doc: Document, tag: "cat" | "val"): string | undefined {
  const el = doc.getElementsByTagName(`c:${tag}`)[0];
  const f = el?.getElementsByTagName("c:f")[0];
  return f?.textContent?.trim() || undefined;
}
function chartTitle(doc: Document): string | undefined {
  const title = doc.getElementsByTagName("c:title")[0];
  if (title) {
    let s = "";
    const runs = title.getElementsByTagName("a:t");
    for (let i = 0; i < runs.length; i++) s += runs[i].textContent ?? "";
    if (s.trim()) return s;
  }
  const v = doc.getElementsByTagName("c:tx")[0]?.getElementsByTagName("c:v")[0]?.textContent;
  return v?.trim() ? v : undefined;
}
function chartKind(doc: Document): ChartType {
  if (doc.getElementsByTagName("c:pieChart").length) return "pie";
  if (doc.getElementsByTagName("c:lineChart").length) return "line";
  return "bar";
}

/** Parse a `<c:chartSpace>` part back into a ChartSpec (inverse of xlsx-export.ts's `chartXml`). */
function parseChartSpec(doc: Document): ChartSpec | null {
  const catRef = firstFormulaRef(doc, "cat");
  const valRef = firstFormulaRef(doc, "val");
  const cat = catRef ? parseRangeRef(catRef) : null;
  const val = valRef ? parseRangeRef(valRef) : null;
  let rect: { c0: number; r0: number; c1: number; r1: number };
  if (val) {
    rect = { c0: cat ? cat.c0 : val.c0, r0: val.r0, c1: val.c0, r1: val.r1 };
  } else if (cat) {
    rect = { c0: cat.c0, r0: cat.r0, c1: cat.c0, r1: cat.r1 };
  } else {
    return null; // pure literal chart (no cell refs) — can't recover a source range
  }
  const title = chartTitle(doc);
  return { id: newId("chart"), type: chartKind(doc), ...rect, ...(title ? { title } : {}) };
}

/** Resolve a worksheet's drawing → chart parts into ChartSpecs (empty when the sheet has no drawing). */
function parseSheetCharts(zip: Record<string, Uint8Array>, sheetPath: string, sheetDoc: Document): ChartSpec[] {
  const drawingRid = sheetDoc.getElementsByTagName("drawing")[0]?.getAttribute("r:id");
  if (!drawingRid) return [];
  const sheetRels = relTargets(parseXml(zip[relsPathOf(sheetPath)]));
  const drawingTarget = sheetRels[drawingRid];
  if (!drawingTarget) return [];
  const drawingPath = resolvePath(sheetPath.replace(/\/[^/]+$/, ""), drawingTarget);
  const drawingDoc = parseXml(zip[drawingPath]);
  if (!drawingDoc) return [];
  const drawingRels = relTargets(parseXml(zip[relsPathOf(drawingPath)]));

  const out: ChartSpec[] = [];
  const chartRefs = drawingDoc.getElementsByTagName("c:chart");
  for (let i = 0; i < chartRefs.length; i++) {
    const rid = chartRefs[i].getAttribute("r:id");
    const target = rid ? drawingRels[rid] : undefined;
    if (!target) continue;
    const chartPath = resolvePath(drawingPath.replace(/\/[^/]+$/, ""), target);
    const chartDoc = parseXml(zip[chartPath]);
    const spec = chartDoc ? parseChartSpec(chartDoc) : null;
    if (spec) out.push(spec);
  }
  return out;
}

// ── worksheet ────────────────────────────────────────────────────────────

function parseSheet(doc: Document | null, shared: string[], name: string, ps: ParsedStyles): SheetData {
  const sh = emptySheet(name);
  if (!doc) return sh;
  let maxCol = 7;
  let maxRow = 19;
  const styles: Record<string, CellStyle> = {};
  const cells = doc.getElementsByTagName("c");
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const ref = c.getAttribute("r");
    if (!ref) continue;
    const upref = ref.toUpperCase();
    const pos = parseRef(upref);
    if (pos) {
      maxCol = Math.max(maxCol, pos.col);
      maxRow = Math.max(maxRow, pos.row);
    }
    const sAttr = c.getAttribute("s");
    if (sAttr) {
      const st = xfToCellStyle(Number(sAttr), ps);
      if (Object.keys(st).length) styles[upref] = st;
    }
    const f = c.getElementsByTagName("f")[0];
    if (f && f.textContent) {
      sh.cells[upref] = "=" + f.textContent;
      continue;
    }
    const t = c.getAttribute("t");
    if (t === "inlineStr") {
      // Inline strings carry their text in <is><t> and have NO <v> element —
      // must be handled before the <v> guard below (else they'd be dropped).
      const txt = textOf(c);
      if (txt) sh.cells[upref] = txt;
      continue;
    }
    const v = c.getElementsByTagName("v")[0];
    if (!v || v.textContent == null) continue;
    if (t === "s") {
      const idx = parseInt(v.textContent, 10);
      sh.cells[upref] = shared[idx] ?? "";
    } else if (t === "str") {
      sh.cells[upref] = textOf(c);
    } else {
      sh.cells[upref] = v.textContent;
    }
  }
  sh.cols = maxCol + 1;
  sh.rows = maxRow + 1;
  if (Object.keys(styles).length) sh.styles = styles;

  const merges = parseMerges(doc);
  if (merges.length) sh.merges = merges;
  const colWidths = parseColWidths(doc);
  if (Object.keys(colWidths).length) sh.colWidths = colWidths;
  const freeze = parseFreeze(doc);
  if (freeze) sh.freeze = freeze;
  const condFormats = parseCondFormats(doc, ps);
  if (condFormats.length) sh.condFormats = condFormats;
  const validations = parseValidations(doc);
  if (validations.length) sh.validations = validations;

  return sh;
}

export function importXlsx(bytes: Uint8Array): Workbook {
  const zip = unzipSync(bytes);
  const shared = parseSharedStrings(zip);
  const ps = parseStylesXml(zip);
  const rels = relTargets(parseXml(zip["xl/_rels/workbook.xml.rels"]));
  const wb = parseXml(zip["xl/workbook.xml"]);

  const withCharts = (path: string, sh: SheetData, doc: Document | null): SheetData => {
    if (!doc) return sh;
    const charts = parseSheetCharts(zip, path, doc);
    return charts.length ? { ...sh, charts } : sh;
  };

  const sheets: SheetData[] = [];
  if (wb) {
    const sheetEls = wb.getElementsByTagName("sheet");
    for (let i = 0; i < sheetEls.length; i++) {
      const name = sheetEls[i].getAttribute("name") || `Feuille ${i + 1}`;
      const rid = sheetEls[i].getAttribute("r:id") || sheetEls[i].getAttribute("id");
      const target = rid ? rels[rid] : undefined;
      const path = target ? resolvePath("xl", target) : `xl/worksheets/sheet${i + 1}.xml`;
      const doc = parseXml(zip[path]);
      sheets.push(withCharts(path, parseSheet(doc, shared, name, ps), doc));
    }
  }
  // Fallback: no workbook.xml mapping — read sheet files directly.
  if (sheets.length === 0) {
    const names = Object.keys(zip)
      .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
      .sort();
    names.forEach((k, i) => {
      const doc = parseXml(zip[k]);
      sheets.push(withCharts(k, parseSheet(doc, shared, `Feuille ${i + 1}`, ps), doc));
    });
  }
  if (sheets.length === 0) sheets.push(emptySheet("Feuille 1"));
  return { sheets, active: 0 };
}
