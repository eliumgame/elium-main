/**
 * XLSX export — the inverse of xlsx-import.ts. Produces a valid SpreadsheetML
 * (OPC) package: a workbook, one worksheet per sheet, a styles part, and
 * (when present) merged cells, conditional formatting, data validation,
 * column widths, row heights, frozen panes and native charts.
 *
 * - numbers        → numeric cells (`<v>`)
 * - text           → inline strings (`t="inlineStr"`) so no shared-strings part
 *                    is needed
 * - formulas (`=`) → `<f>` without a cached value; `fullCalcOnLoad` makes Excel
 *                    and LibreOffice recompute on open (keeps us decoupled from
 *                    the formula engine — chart series read the SAME recomputed
 *                    cells, via `<c:f>` range refs rather than baked-in caches)
 * - cell styles    → a deduplicated numFmt/font/fill/border/xf table (number
 *                    format, bold/italic, text colour, fill, borders, alignment)
 * - condFormats    → native `cellIs` / `containsText` / `containsBlanks` /
 *                    `colorScale` rules, non-scale ones via a `<dxfs>` entry
 * - validations    → native `<dataValidation>` (list/decimal/textLength/date)
 * - charts         → a `<c:chart>` DrawingML part per chart, anchored below the
 *                    grid, wired through a per-sheet drawing part + rels — the
 *                    same pattern `slides/pptx.ts` uses for PPTX charts, adapted
 *                    to reference live cell ranges instead of literal data
 */
import { zipSync, strToU8 } from "fflate";
import { quoteSheetName } from "./formula";
import type {
  Workbook,
  SheetData,
  CellStyle,
  NumFmt,
  CondRule,
  DataValidation,
  MergeRect,
  ChartSpec,
  BorderSide,
  CellBorder,
  NamedRange,
} from "./model";

const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"; // rel types base
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const XDR_NS = "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing";

const xe = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 0-based column index → spreadsheet letters (0→"A", 26→"AA"). */
export function colLetters(n: number): string {
  let s = "";
  let x = n + 1;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}
const a1 = (c: number, r: number): string => `${colLetters(c)}${r + 1}`;
const rangeRef = (c0: number, r0: number, c1: number, r1: number): string => `${a1(c0, r0)}:${a1(c1, r1)}`;

function parseKey(key: string): { col: number; row: number } | null {
  const m = /^([A-Z]+)(\d+)$/.exec(key);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2]!, 10) };
}

const isNumeric = (s: string): boolean => /^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim());

function hex6(c: string | undefined): string | null {
  if (!c) return null;
  let h = c.replace(/^#/, "").trim();
  if (/^[0-9a-fA-F]{3}$/.test(h))
    h = h
      .split("")
      .map((x) => x + x)
      .join("");
  return /^[0-9a-fA-F]{6}$/.test(h) ? h.toUpperCase() : null;
}

// Excel/Sheets serial-date epoch (matches sheet/format.ts's rendering epoch, so a
// validation bound round-trips to the exact same date after import).
const DATE_EPOCH = Date.UTC(1899, 11, 30);
function dateStrToSerial(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s.trim());
  return Number.isNaN(t) ? null : Math.round((t - DATE_EPOCH) / 86400000);
}

// Custom number-format codes (built-in id 0 = "General" needs no numFmt entry).
// "custom" has no fixed code here — it writes back CellStyle.customFmt instead
// (the raw code an import couldn't fit into any other category).
const NUMFMT_CODE: Record<Exclude<NumFmt, "general" | "custom">, string> = {
  number: "0.00",
  int: "0",
  currency: "#,##0.00\\ €",
  percent: "0%",
  date: "yyyy\\-mm\\-dd",
  datetime: "yyyy\\-mm\\-dd\\ hh:mm",
};

/** Accumulates the numFmt/font/fill/border/xf/dxf tables while cells & rules are serialized. */
function createStyleTable() {
  const numFmts = new Map<string, number>(); // code → id (≥164)
  let nextFmtId = 164;
  const fmtId = (fmt?: NumFmt, customFmt?: string): number => {
    if (!fmt || fmt === "general") return 0;
    const code = fmt === "custom" ? customFmt || "General" : NUMFMT_CODE[fmt];
    if (!numFmts.has(code)) numFmts.set(code, nextFmtId++);
    return numFmts.get(code)!;
  };

  const fonts: string[] = ['<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>'];
  const fontKey = new Map<string, number>();
  const fontId = (st?: CellStyle): number => {
    if (!st || (!st.bold && !st.italic && !st.color && !st.fontFamily && !st.fontSize)) return 0;
    const name = st.fontFamily?.split(",")[0]!.replace(/['"]/g, "").trim() || "Calibri";
    const sz = st.fontSize ? Math.max(1, Math.round(st.fontSize * 0.75)) : 11; // px → pt
    const col = hex6(st.color);
    const key = `${st.bold ? 1 : 0}|${st.italic ? 1 : 0}|${col ?? ""}|${name}|${sz}`;
    const found = fontKey.get(key);
    if (found !== undefined) return found;
    const parts = [`<sz val="${sz}"/>`];
    if (st.bold) parts.push("<b/>");
    if (st.italic) parts.push("<i/>");
    parts.push(col ? `<color rgb="FF${col}"/>` : '<color theme="1"/>');
    parts.push(`<name val="${xe(name)}"/>`);
    fonts.push(`<font>${parts.join("")}</font>`);
    const id = fonts.length - 1;
    fontKey.set(key, id);
    return id;
  };

  // Index 0 = none and 1 = gray125 are RESERVED by the spec; solids start at 2.
  const fills: string[] = [
    '<fill><patternFill patternType="none"/></fill>',
    '<fill><patternFill patternType="gray125"/></fill>',
  ];
  const fillKey = new Map<string, number>();
  const fillId = (st?: CellStyle): number => {
    const c = hex6(st?.fill);
    if (!c) return 0;
    const found = fillKey.get(c);
    if (found !== undefined) return found;
    fills.push(
      `<fill><patternFill patternType="solid"><fgColor rgb="FF${c}"/><bgColor indexed="64"/></patternFill></fill>`,
    );
    const id = fills.length - 1;
    fillKey.set(c, id);
    return id;
  };

  // Border id 0 = no border on any side (matches the pre-existing default xf).
  const borders: string[] = ["<border/>"];
  const borderKey = new Map<string, number>();
  const sideKey = (s?: BorderSide) => (s ? `${s.style}:${hex6(s.color) ?? "000000"}` : "");
  const sideXml = (tag: string, s?: BorderSide) =>
    s ? `<${tag} style="${s.style}"><color rgb="FF${hex6(s.color) ?? "000000"}"/></${tag}>` : `<${tag}/>`;
  const borderId = (b?: CellBorder): number => {
    if (!b || (!b.top && !b.right && !b.bottom && !b.left)) return 0;
    const key = `${sideKey(b.left)}|${sideKey(b.right)}|${sideKey(b.top)}|${sideKey(b.bottom)}`;
    const found = borderKey.get(key);
    if (found !== undefined) return found;
    borders.push(
      `<border>${sideXml("left", b.left)}${sideXml("right", b.right)}${sideXml("top", b.top)}${sideXml("bottom", b.bottom)}<diagonal/></border>`,
    );
    const id = borders.length - 1;
    borderKey.set(key, id);
    return id;
  };

  const xfs: string[] = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const xfKey = new Map<string, number>();
  const xfIndexOf = (st?: CellStyle): number => {
    if (!st) return 0;
    const nf = fmtId(st.fmt, st.customFmt);
    const fo = fontId(st);
    const fi = fillId(st);
    const bo = borderId(st.border);
    const al = st.align && st.align !== "left" ? st.align : undefined;
    if (!nf && !fo && !fi && !bo && !al) return 0;
    const key = `${nf}|${fo}|${fi}|${bo}|${al ?? ""}`;
    const found = xfKey.get(key);
    if (found !== undefined) return found;
    const attrs =
      `numFmtId="${nf}" fontId="${fo}" fillId="${fi}" borderId="${bo}" xfId="0"` +
      (nf ? ' applyNumberFormat="1"' : "") +
      (fo ? ' applyFont="1"' : "") +
      (fi ? ' applyFill="1"' : "") +
      (bo ? ' applyBorder="1"' : "") +
      (al ? ' applyAlignment="1"' : "");
    xfs.push(al ? `<xf ${attrs}><alignment horizontal="${al}"/></xf>` : `<xf ${attrs}/>`);
    const id = xfs.length - 1;
    xfKey.set(key, id);
    return id;
  };

  // Differential formats (dxf) for conditional-formatting rules that paint a
  // fill/colour/bold (colour-scale rules carry their colours inline instead).
  const dxfs: string[] = [];
  const dxfIndexOfCond = (rule: CondRule): number | undefined => {
    if (rule.op === "colorScale" || (!rule.fill && !rule.color && !rule.bold)) return undefined;
    const parts: string[] = [];
    const col = hex6(rule.color);
    if (rule.bold || col) parts.push(`<font>${rule.bold ? "<b/>" : ""}${col ? `<color rgb="FF${col}"/>` : ""}</font>`);
    const fillCol = hex6(rule.fill);
    if (fillCol) parts.push(`<fill><patternFill><bgColor rgb="FF${fillCol}"/></patternFill></fill>`);
    dxfs.push(`<dxf>${parts.join("")}</dxf>`);
    return dxfs.length - 1;
  };

  const toXml = (): string => {
    const numFmtEls = [...numFmts.entries()].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${xe(code)}"/>`);
    const numFmtsBlock = numFmtEls.length ? `<numFmts count="${numFmtEls.length}">${numFmtEls.join("")}</numFmts>` : "";
    return (
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<styleSheet xmlns="${NS}">` +
      numFmtsBlock +
      `<fonts count="${fonts.length}">${fonts.join("")}</fonts>` +
      `<fills count="${fills.length}">${fills.join("")}</fills>` +
      `<borders count="${borders.length}">${borders.join("")}</borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      (dxfs.length ? `<dxfs count="${dxfs.length}">${dxfs.join("")}</dxfs>` : `<dxfs count="0"/>`) +
      `</styleSheet>`
    );
  };

  return { xfIndexOf, dxfIndexOfCond, toXml };
}
type StyleTable = ReturnType<typeof createStyleTable>;

function cellXml(key: string, raw: string, s: number): string {
  const sAttr = s ? ` s="${s}"` : "";
  if (raw.startsWith("=")) {
    return `<c r="${key}"${sAttr}><f>${xe(raw.slice(1))}</f></c>`;
  }
  if (isNumeric(raw)) {
    return `<c r="${key}"${sAttr}><v>${xe(raw.trim())}</v></c>`;
  }
  return `<c r="${key}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${xe(raw)}</t></is></c>`;
}

/** mergeCells — one <mergeCell> per merged rectangle (§18.3.1.55). */
function mergeCellsXml(merges: MergeRect[] | undefined): string {
  if (!merges || !merges.length) return "";
  const cells = merges.map((m) => `<mergeCell ref="${rangeRef(m.c0, m.r0, m.c1, m.r1)}"/>`).join("");
  return `<mergeCells count="${merges.length}">${cells}</mergeCells>`;
}

/** Column widths: px → Excel's "characters" width unit (Calibri 11 heuristic, the widely-used 7px/char approximation). */
const pxToCharWidth = (px: number): number => Math.max(0, Math.round(((px - 5) / 7) * 100) / 100);
function colsXml(colWidths: Record<number, number> | undefined): string {
  const entries = Object.entries(colWidths ?? {});
  if (!entries.length) return "";
  const cols = entries
    .map(([k, px]) => ({ idx: Number(k), w: pxToCharWidth(px) }))
    .filter((e) => Number.isFinite(e.idx) && e.idx >= 0)
    .sort((a, b) => a.idx - b.idx)
    .map((e) => `<col min="${e.idx + 1}" max="${e.idx + 1}" width="${e.w}" customWidth="1"/>`)
    .join("");
  return cols ? `<cols>${cols}</cols>` : "";
}

/** sheetViews/pane — frozen leading rows/cols (§18.3.1.87). Omitted when no freeze is set. */
function sheetViewsXml(freeze: SheetData["freeze"]): string {
  if (!freeze || (freeze.rows <= 0 && freeze.cols <= 0)) return "";
  const { rows, cols } = freeze;
  const topLeft = a1(cols, rows);
  const activePane = cols > 0 && rows > 0 ? "bottomRight" : cols > 0 ? "topRight" : "bottomLeft";
  return (
    `<sheetViews><sheetView workbookViewId="0">` +
    `<pane xSplit="${cols}" ySplit="${rows}" topLeftCell="${topLeft}" activePane="${activePane}" state="frozen"/>` +
    `<selection pane="${activePane}" activeCell="${topLeft}" sqref="${topLeft}"/>` +
    `</sheetView></sheetViews>`
  );
}

const CF_OP_XML: Record<string, string> = {
  gt: "greaterThan",
  lt: "lessThan",
  ge: "greaterThanOrEqual",
  le: "lessThanOrEqual",
  eq: "equal",
  ne: "notEqual",
};

/** A numeric-or-text formula operand for a cellIs rule (quoted when not a bare number). */
const cfOperand = (v: string | undefined): string => {
  const n = Number(v ?? "");
  return v !== undefined && v.trim() !== "" && !Number.isNaN(n) ? xe(v) : `"${xe(v ?? "")}"`;
};

/** Conditional formatting: one <conditionalFormatting sqref> block per rule (§18.3.1.18). */
function condFormattingXml(rules: CondRule[] | undefined, styles: StyleTable): string {
  if (!rules || !rules.length) return "";
  return rules
    .map((rule, i) => {
      const sqref = rangeRef(rule.c0, rule.r0, rule.c1, rule.r1);
      const priority = i + 1;
      const anchor = a1(rule.c0, rule.r0);
      if (rule.op === "colorScale") {
        const sc = rule.scale;
        if (!sc) return "";
        const minC = hex6(sc.min) ?? "FFFFFF";
        const maxC = hex6(sc.max) ?? "FFFFFF";
        const stops = sc.mid
          ? `<cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/>` +
            `<color rgb="FF${minC}"/><color rgb="FF${hex6(sc.mid) ?? "FFFFFF"}"/><color rgb="FF${maxC}"/>`
          : `<cfvo type="min"/><cfvo type="max"/><color rgb="FF${minC}"/><color rgb="FF${maxC}"/>`;
        return `<conditionalFormatting sqref="${sqref}"><cfRule type="colorScale" priority="${priority}"><colorScale>${stops}</colorScale></cfRule></conditionalFormatting>`;
      }
      const dxfId = styles.dxfIndexOfCond(rule);
      const dxfAttr = dxfId !== undefined ? ` dxfId="${dxfId}"` : "";
      switch (rule.op) {
        case "gt":
        case "lt":
        case "ge":
        case "le":
        case "eq":
        case "ne":
          return (
            `<conditionalFormatting sqref="${sqref}"><cfRule type="cellIs" operator="${CF_OP_XML[rule.op]}" priority="${priority}"${dxfAttr}>` +
            `<formula>${cfOperand(rule.v1)}</formula></cfRule></conditionalFormatting>`
          );
        case "between": {
          const n1 = Number(rule.v1 ?? ""),
            n2 = Number(rule.v2 ?? "");
          const lo = Math.min(n1, n2),
            hi = Math.max(n1, n2);
          return (
            `<conditionalFormatting sqref="${sqref}"><cfRule type="cellIs" operator="between" priority="${priority}"${dxfAttr}>` +
            `<formula>${Number.isFinite(lo) ? lo : 0}</formula><formula>${Number.isFinite(hi) ? hi : 0}</formula></cfRule></conditionalFormatting>`
          );
        }
        case "contains": {
          const txt = rule.v1 ?? "";
          return (
            `<conditionalFormatting sqref="${sqref}"><cfRule type="containsText" operator="containsText" text="${xe(txt)}" priority="${priority}"${dxfAttr}>` +
            `<formula>NOT(ISERROR(SEARCH("${xe(txt)}",${anchor})))</formula></cfRule></conditionalFormatting>`
          );
        }
        case "empty":
          return (
            `<conditionalFormatting sqref="${sqref}"><cfRule type="containsBlanks" priority="${priority}"${dxfAttr}>` +
            `<formula>LEN(TRIM(${anchor}))=0</formula></cfRule></conditionalFormatting>`
          );
        case "notEmpty":
          return (
            `<conditionalFormatting sqref="${sqref}"><cfRule type="notContainsBlanks" priority="${priority}"${dxfAttr}>` +
            `<formula>LEN(TRIM(${anchor}))&gt;0</formula></cfRule></conditionalFormatting>`
          );
        case "top10": {
          const rank = Math.max(1, Math.round(rule.rank ?? 10));
          const bottomAttr = rule.bottom ? ` bottom="1"` : "";
          const percentAttr = rule.percent ? ` percent="1"` : "";
          return (
            `<conditionalFormatting sqref="${sqref}"><cfRule type="top10" rank="${rank}"${bottomAttr}${percentAttr} priority="${priority}"${dxfAttr}/></conditionalFormatting>`
          );
        }
        case "duplicate":
          return `<conditionalFormatting sqref="${sqref}"><cfRule type="duplicateValues" priority="${priority}"${dxfAttr}/></conditionalFormatting>`;
        default:
          return "";
      }
    })
    .join("");
}

const DV_OP_XML: Record<string, string> = {
  between: "between",
  notBetween: "notBetween",
  gt: "greaterThan",
  lt: "lessThan",
  ge: "greaterThanOrEqual",
  le: "lessThanOrEqual",
  eq: "equal",
  ne: "notEqual",
};

/** Data validation: native <dataValidation> (§18.3.1.32); soft in our model, so errors don't block entry. */
function dataValidationXml(rules: DataValidation[] | undefined): string {
  if (!rules || !rules.length) return "";
  const body = rules
    .map((v) => {
      const sqref = rangeRef(v.c0, v.r0, v.c1, v.r1);
      const allowBlank = v.allowBlank === false ? 0 : 1;
      if (v.type === "list") {
        const items = (v.list ?? []).map((s) => s.replace(/"/g, "'")).join(",");
        return (
          `<dataValidation type="list" allowBlank="${allowBlank}" showInputMessage="1" showErrorMessage="1" sqref="${sqref}">` +
          `<formula1>"${xe(items)}"</formula1></dataValidation>`
        );
      }
      const typeXml = v.type === "number" ? "decimal" : v.type === "textLength" ? "textLength" : "date";
      const operand = (s: string | undefined): string => {
        if (v.type === "date") {
          const serial = dateStrToSerial(s);
          return serial != null ? String(serial) : "0";
        }
        const n = Number(s ?? "");
        return Number.isFinite(n) ? String(n) : "0";
      };
      const opXml = DV_OP_XML[v.op ?? "between"] ?? "between";
      const needs2 = v.op === "between" || v.op === "notBetween";
      const f1 = `<formula1>${operand(v.v1)}</formula1>`;
      const f2 = needs2 ? `<formula2>${operand(v.v2)}</formula2>` : "";
      return (
        `<dataValidation type="${typeXml}" operator="${opXml}" allowBlank="${allowBlank}" showInputMessage="1" showErrorMessage="1" sqref="${sqref}">` +
        `${f1}${f2}</dataValidation>`
      );
    })
    .join("");
  return `<dataValidations count="${rules.length}">${body}</dataValidations>`;
}

/**
 * A self-contained DrawingML chart part whose series reference the sheet's own
 * cells (`<c:f>`), mirroring how the grid gets its data — Excel recalculates the
 * range on open (fullCalcOnLoad) and the chart follows. No cache is written:
 * this exporter never runs the formula engine, same rationale as `<f>` cells.
 * Mirrors slides/pptx.ts's `chartXml`, adapted from literal to range data.
 */
const absA1 = (c: number, r: number): string => `$${colLetters(c)}$${r + 1}`;
const absRangeRef = (c: number, r0: number, r1: number): string => `${absA1(c, r0)}:${absA1(c, r1)}`;

/**
 * The value columns charted for a source rectangle: a single column (c0===c1)
 * is one unnamed series with no category axis; a wider rectangle treats column
 * c0 as the shared category axis and EVERY remaining column as its own series
 * — one `<c:ser>` per column, not just the first (multi-series charts).
 */
function chartValueCols(chart: ChartSpec): number[] {
  if (chart.c0 === chart.c1) return [chart.c0];
  const cols: number[] = [];
  for (let c = chart.c0 + 1; c <= chart.c1; c++) cols.push(c);
  return cols;
}

function chartXml(chart: ChartSpec, sheetNameQuoted: string): string {
  const oneCol = chart.c0 === chart.c1;
  const valCols = chartValueCols(chart);
  const catRef = oneCol ? null : `${sheetNameQuoted}!${absRangeRef(chart.c0, chart.r0, chart.r1)}`;
  const catXml = catRef ? `<c:cat><c:strRef><c:f>${xe(catRef)}</c:f></c:strRef></c:cat>` : "";
  const AX_CAT = 111111111,
    AX_VAL = 222222222;

  /** One `<c:ser>` per value column — series 0 is named after the chart title
   * (kept exactly as before for the single-series case), later ones after
   * their column letter, so the legend can tell them apart. */
  const seriesXml = (lineMarkers: boolean): string =>
    valCols
      .map((col, i) => {
        const valRef = `${sheetNameQuoted}!${absRangeRef(col, chart.r0, chart.r1)}`;
        const valXml = `<c:val><c:numRef><c:f>${xe(valRef)}</c:f></c:numRef></c:val>`;
        const name = i === 0 ? chart.title : `Colonne ${colLetters(col)}`;
        const head = `<c:idx val="${i}"/><c:order val="${i}"/>${name ? `<c:tx><c:v>${xe(name)}</c:v></c:tx>` : ""}`;
        const marker = lineMarkers ? `<c:marker><c:symbol val="circle"/></c:marker>` : "";
        const smooth = lineMarkers ? `<c:smooth val="0"/>` : "";
        return `<c:ser>${head}${marker}${catXml}${valXml}${smooth}</c:ser>`;
      })
      .join("");

  const axes =
    `<c:catAx><c:axId val="${AX_CAT}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="${AX_VAL}"/></c:catAx>` +
    `<c:valAx><c:axId val="${AX_VAL}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="${AX_CAT}"/></c:valAx>`;

  let plot: string;
  if (chart.type === "pie") {
    // Pie charts vary colour BY POINT, not by series, and Excel doesn't give
    // multiple pie series a meaningful rendering — only the first value column
    // is charted (unchanged single-series behaviour for this chart type).
    const valRef = `${sheetNameQuoted}!${absRangeRef(valCols[0]!, chart.r0, chart.r1)}`;
    const valXml = `<c:val><c:numRef><c:f>${xe(valRef)}</c:f></c:numRef></c:val>`;
    const head = `<c:idx val="0"/><c:order val="0"/>${chart.title ? `<c:tx><c:v>${xe(chart.title)}</c:v></c:tx>` : ""}`;
    plot = `<c:pieChart><c:varyColors val="1"/><c:ser>${head}${catXml}${valXml}</c:ser></c:pieChart>`;
  } else if (chart.type === "line") {
    plot =
      `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${seriesXml(true)}` +
      `<c:marker val="1"/><c:axId val="${AX_CAT}"/><c:axId val="${AX_VAL}"/></c:lineChart>${axes}`;
  } else {
    plot =
      `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${seriesXml(false)}` +
      `<c:axId val="${AX_CAT}"/><c:axId val="${AX_VAL}"/></c:barChart>${axes}`;
  }

  const title = chart.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xe(chart.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : `<c:autoTitleDeleted val="1"/>`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
    `<c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea>` +
    `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`
  );
}

/** xl/drawings/drawingN.xml — one graphicFrame per chart, stacked below `baseRow`. */
function sheetDrawingXml(chartRIds: string[], baseRow: number): string {
  const ANCHOR_ROWS = 16,
    ANCHOR_COLS = 8;
  const anchors = chartRIds
    .map((rId, i) => {
      const top = baseRow + i * ANCHOR_ROWS;
      const bottom = top + ANCHOR_ROWS - 1;
      return (
        `<xdr:twoCellAnchor editAs="oneCell">` +
        `<xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${top}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
        `<xdr:to><xdr:col>${ANCHOR_COLS}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${bottom}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
        `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Graphique ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
        `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
        `<a:graphic><a:graphicData uri="${C_NS}"><c:chart xmlns:c="${C_NS}" xmlns:r="${R_NS}" r:id="${rId}"/></a:graphicData></a:graphic>` +
        `</xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`
      );
    })
    .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<xdr:wsDr xmlns:xdr="${XDR_NS}" xmlns:a="${A_NS}">${anchors}</xdr:wsDr>`
  );
}

/** Row height: px → Excel's "points" unit (96dpi heuristic, inverse of xlsx-import.ts's `ptToPx`). */
const pxToPt = (px: number): number => Math.max(0, Math.round(px * 0.75 * 100) / 100);

function sheetXml(sheet: SheetData, styles: StyleTable, hasDrawing: boolean): string {
  // Group non-empty cells by row.
  const byRow = new Map<number, { key: string; col: number; raw: string; s: number }[]>();
  let maxCol = Math.max(0, sheet.cols - 1);
  let maxRow = Math.max(1, sheet.rows);
  for (const [key, raw] of Object.entries(sheet.cells)) {
    if (raw === "" || raw == null) continue;
    const pos = parseKey(key);
    if (!pos) continue;
    const s = styles.xfIndexOf(sheet.styles?.[key]);
    if (!byRow.has(pos.row)) byRow.set(pos.row, []);
    byRow.get(pos.row)!.push({ key, col: pos.col, raw, s });
    maxCol = Math.max(maxCol, pos.col);
    maxRow = Math.max(maxRow, pos.row);
  }
  // A row present ONLY as a custom height (no cell content) still needs its own
  // <row> element — else the height has nowhere to be written. `byRow` keys are
  // already 1-based (straight from `parseKey`'s A1-style parsing); `rowHeights`
  // keys are 0-based (row index, like `colWidths`), hence the +1/-1 below.
  const rowKeys = new Set<number>(byRow.keys());
  for (const k of Object.keys(sheet.rowHeights ?? {})) rowKeys.add(Number(k) + 1);
  const rows = [...rowKeys]
    .sort((a, b) => a - b)
    .map((r) => {
      const list = byRow.get(r) ?? [];
      const cells = list
        .sort((a, b) => a.col - b.col)
        .map((c) => cellXml(c.key, c.raw, c.s))
        .join("");
      const customH = sheet.rowHeights?.[r - 1];
      const htAttr = customH != null ? ` ht="${pxToPt(customH)}" customHeight="1"` : "";
      return `<row r="${r}"${htAttr}>${cells}</row>`;
    })
    .join("");
  const dim = `A1:${colLetters(maxCol)}${maxRow}`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="${NS}" xmlns:r="${R_NS}">` +
    `<dimension ref="${dim}"/>` +
    sheetViewsXml(sheet.freeze) +
    colsXml(sheet.colWidths) +
    `<sheetData>${rows}</sheetData>` +
    mergeCellsXml(sheet.merges) +
    condFormattingXml(sheet.condFormats, styles) +
    dataValidationXml(sheet.validations) +
    (hasDrawing ? `<drawing r:id="rId1"/>` : "") +
    `</worksheet>`
  );
}

/** Excel sheet-name rules: ≤31 chars, none of []:*?/\, non-empty, unique. */
function sanitizeNames(sheets: SheetData[]): string[] {
  const seen = new Set<string>();
  return sheets.map((sh, i) => {
    const name =
      (sh.name || `Feuille ${i + 1}`)
        .replace(/[[\]:*?/\\]/g, " ")
        .slice(0, 31)
        .trim() || `Feuille ${i + 1}`;
    let n = name;
    let k = 2;
    while (seen.has(n.toLowerCase())) n = `${name.slice(0, 28)} ${k++}`;
    seen.add(n.toLowerCase());
    return n;
  });
}

/** <definedNames> (§18.2.6) — one <definedName> per workbook-scoped named range; omitted when there are none. */
function definedNamesBlock(names: NamedRange[] | undefined): string {
  if (!names || !names.length) return "";
  const body = names
    .map((n) => `<definedName name="${xe(n.name)}">${xe(n.ref)}</definedName>`)
    .join("");
  return `<definedNames>${body}</definedNames>`;
}

const RELS = (rels: { id: string; type: string; target: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}s">` +
  rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join("") +
  `</Relationships>`;

const T = {
  drawing: `${REL}/drawing`,
  chart: `${REL}/chart`,
};

export function workbookToXlsx(wb: Workbook): Uint8Array {
  const styles = createStyleTable();
  const names = sanitizeNames(wb.sheets);
  const files: Record<string, Uint8Array> = {};
  let chartCounter = 0;

  // Worksheets (+ per-sheet drawing/chart parts). Serialize sheets first so the
  // shared style table (fonts/fills/borders/dxfs) is fully populated before toXml().
  wb.sheets.forEach((sheet, i) => {
    const charts = sheet.charts ?? [];
    const sheetNameQ = quoteSheetName(names[i]!);
    const chartRIds = charts.map((_, ci) => `rId${ci + 1}`);
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(sheet, styles, charts.length > 0));

    if (charts.length) {
      const chartNames = charts.map(() => `chart${++chartCounter}.xml`);
      files[`xl/worksheets/_rels/sheet${i + 1}.xml.rels`] = strToU8(
        RELS([{ id: "rId1", type: T.drawing, target: `../drawings/drawing${i + 1}.xml` }]),
      );
      files[`xl/drawings/drawing${i + 1}.xml`] = strToU8(sheetDrawingXml(chartRIds, sheet.rows + 2));
      files[`xl/drawings/_rels/drawing${i + 1}.xml.rels`] = strToU8(
        RELS(charts.map((_, ci) => ({ id: chartRIds[ci]!, type: T.chart, target: `../charts/${chartNames[ci]!}` }))),
      );
      charts.forEach((chart, ci) => {
        files[`xl/charts/${chartNames[ci]!}`] = strToU8(chartXml(chart, sheetNameQ));
      });
    }
  });
  files["xl/styles.xml"] = strToU8(styles.toXml());

  // Workbook + its relationships.
  const sheetTags = names
    .map((name, i) => `<sheet name="${xe(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("");
  const definedNamesXml = definedNamesBlock(wb.names);
  files["xl/workbook.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="${NS}" xmlns:r="${R_NS}">` +
      `<sheets>${sheetTags}</sheets>` +
      definedNamesXml +
      `<calcPr fullCalcOnLoad="1"/>` +
      `</workbook>`,
  );
  const n = wb.sheets.length;
  const wbRels =
    names
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join("") + `<Relationship Id="rId${n + 1}" Type="${REL}/styles" Target="styles.xml"/>`;
  files["xl/_rels/workbook.xml.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}s">${wbRels}</Relationships>`,
  );

  // Package relationships + content types.
  files["_rels/.rels"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}s">` +
      `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
  );
  const drawingOverrides = wb.sheets
    .map((sheet, i) => (sheet.charts?.length ? i : -1))
    .filter((i) => i >= 0)
    .map(
      (i) =>
        `<Override PartName="/xl/drawings/drawing${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`,
    )
    .join("");
  const chartOverrides = Array.from(
    { length: chartCounter },
    (_, i) =>
      `<Override PartName="/xl/charts/chart${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`,
  ).join("");
  const overrides =
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    wb.sheets
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join("") +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    drawingOverrides +
    chartOverrides;
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CT_NS}">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      overrides +
      `</Types>`,
  );

  return zipSync(files, { level: 6 });
}
