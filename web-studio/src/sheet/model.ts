/** Spreadsheet workbook model (in-memory; persisted locally via sheet-store). */
// "custom" preserves an Excel format code our fixed categories can't represent
// (e.g. "mm:ss", a currency other than EUR, a custom accounting format): the
// RAW code round-trips (see CellStyle.customFmt) even though on-screen
// rendering falls back to a plain number (no code interpreter — see format.ts).
export type NumFmt = "general" | "number" | "int" | "currency" | "percent" | "date" | "datetime" | "custom";

/** One border edge: line style + colour. Mirrors OOXML's `<left>/<right>/<top>/<bottom>` border sides. */
export type BorderStyle = "thin" | "medium" | "thick" | "dashed" | "dotted" | "double";
export interface BorderSide {
  style: BorderStyle;
  color?: string; // hex; defaults to black on render/export when absent
}
export interface CellBorder {
  top?: BorderSide;
  right?: BorderSide;
  bottom?: BorderSide;
  left?: BorderSide;
}

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  color?: string; // text color (hex)
  fill?: string; // background color (hex)
  fmt?: NumFmt;
  customFmt?: string; // raw Excel format code, only meaningful when fmt === "custom"
  fontFamily?: string; // font name (shared registry)
  fontSize?: number; // px
  border?: CellBorder;
}

export type ChartType = "bar" | "line" | "pie";

export interface ChartSpec {
  id: string;
  type: ChartType;
  c0: number;
  r0: number;
  c1: number;
  r1: number; // source range
  title?: string;
}

export type CondOp =
  | "gt"
  | "lt"
  | "ge"
  | "le"
  | "eq"
  | "ne"
  | "between"
  | "contains"
  | "empty"
  | "notEmpty"
  | "colorScale"
  | "top10" // top/bottom N (or N%) values in the range (Excel type="top10")
  | "duplicate"; // values that occur more than once in the range (Excel type="duplicateValues")

/** A conditional-formatting rule applied over a rectangular range. */
export interface CondRule {
  id: string;
  c0: number;
  r0: number;
  c1: number;
  r1: number; // target range (inclusive)
  op: CondOp;
  v1?: string; // threshold / text / lower bound
  v2?: string; // upper bound (op="between")
  fill?: string; // background applied on match (non-scale ops)
  color?: string; // text colour applied on match
  bold?: boolean;
  scale?: { min: string; max: string; mid?: string }; // colour scale (op="colorScale")
  rank?: number; // op="top10": N (default 10)
  bottom?: boolean; // op="top10": bottom N instead of top N
  percent?: boolean; // op="top10": N% of the range instead of a fixed count
}

/** Data-validation kinds and numeric/length/date comparison operators. */
export type ValidationType = "list" | "number" | "textLength" | "date";
export type ValidationOp = "between" | "notBetween" | "gt" | "lt" | "ge" | "le" | "eq" | "ne";

/** A data-validation rule over a rectangular range. Invalid entries are flagged (soft, non-blocking). */
export interface DataValidation {
  id: string;
  c0: number;
  r0: number;
  c1: number;
  r1: number; // target range (inclusive)
  type: ValidationType;
  op?: ValidationOp; // number / textLength / date
  v1?: string; // threshold / lower bound
  v2?: string; // upper bound (between / notBetween)
  list?: string[]; // allowed values (type = "list")
  allowBlank?: boolean; // empty cells pass (default true)
}

/** A merged range: the top-left cell (c0,r0) spans the whole rectangle. */
export interface MergeRect {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}

export interface SheetData {
  name: string;
  rows: number;
  cols: number;
  cells: Record<string, string>; // "A1" -> raw content (literal or "=formula")
  styles?: Record<string, CellStyle>; // "A1" -> formatting
  charts?: ChartSpec[];
  condFormats?: CondRule[]; // conditional formatting rules
  validations?: DataValidation[]; // data-validation rules
  merges?: MergeRect[]; // merged cell ranges (top-left cell spans; others are hidden)
  filter?: { col: number; query: string }; // view filter (hides non-matching rows)
  colWidths?: Record<number, number>; // column index -> width px (default DEFAULT_COL_W)
  rowHeights?: Record<number, number>; // row index -> height px (default ROW_H)
  freeze?: { rows: number; cols: number }; // leading rows/columns frozen (sticky) while scrolling
}

export function newId(prefix: string): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `${prefix}-${c.randomUUID()}`;
  return `${prefix}-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

/** A workbook-scoped named range: `name` resolves to `ref` (e.g. "Feuille1!$A$1:$B$2") in formulas. */
export interface NamedRange {
  name: string;
  ref: string;
}

export interface Workbook {
  sheets: SheetData[];
  active: number; // index into sheets
  names?: NamedRange[]; // defined names usable in formulas
}

export function emptyWorkbook(): Workbook {
  return { sheets: [{ name: "Feuille 1", rows: 20, cols: 8, cells: {} }], active: 0 };
}

export function emptySheet(name: string): SheetData {
  return { name, rows: 20, cols: 8, cells: {} };
}

/**
 * Remove the sheet at `index` from the workbook. Sheets have no stable id in
 * this model (they're addressed by index, like renameSheet/switchSheet in
 * SheetView.tsx), so `index` doubles as the identifier.
 *
 * Guard: a workbook must always keep at least one sheet, so removing the
 * last remaining one is refused — returns `null` (same "refuse, don't touch
 * anything" pattern the caller already uses for a duplicate rename).
 */
export function removeSheet(wb: Workbook, index: number): Workbook | null {
  if (wb.sheets.length <= 1 || index < 0 || index >= wb.sheets.length) return null;
  const sheets = wb.sheets.filter((_, i) => i !== index);
  const active = Math.max(0, Math.min(wb.active > index ? wb.active - 1 : wb.active, sheets.length - 1));
  return { ...wb, sheets, active };
}
