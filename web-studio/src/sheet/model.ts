/** Spreadsheet workbook model (in-memory; persisted locally via sheet-store). */
export type NumFmt = "general" | "number" | "int" | "currency" | "percent" | "date" | "datetime";

export interface CellStyle {
  bold?: boolean;
  italic?: boolean;
  align?: "left" | "center" | "right";
  color?: string; // text color (hex)
  fill?: string; // background color (hex)
  fmt?: NumFmt;
  fontFamily?: string; // font name (shared registry)
  fontSize?: number;   // px
}

export type ChartType = "bar" | "line" | "pie";

export interface ChartSpec {
  id: string;
  type: ChartType;
  c0: number; r0: number; c1: number; r1: number; // source range
  title?: string;
}

export type CondOp =
  | "gt" | "lt" | "ge" | "le" | "eq" | "ne" | "between"
  | "contains" | "empty" | "notEmpty" | "colorScale";

/** A conditional-formatting rule applied over a rectangular range. */
export interface CondRule {
  id: string;
  c0: number; r0: number; c1: number; r1: number; // target range (inclusive)
  op: CondOp;
  v1?: string; // threshold / text / lower bound
  v2?: string; // upper bound (op="between")
  fill?: string; // background applied on match (non-scale ops)
  color?: string; // text colour applied on match
  bold?: boolean;
  scale?: { min: string; max: string; mid?: string }; // colour scale (op="colorScale")
}

export interface SheetData {
  name: string;
  rows: number;
  cols: number;
  cells: Record<string, string>; // "A1" -> raw content (literal or "=formula")
  styles?: Record<string, CellStyle>; // "A1" -> formatting
  charts?: ChartSpec[];
  condFormats?: CondRule[]; // conditional formatting rules
  filter?: { col: number; query: string }; // view filter (hides non-matching rows)
  colWidths?: Record<number, number>; // column index -> width px (default DEFAULT_COL_W)
  freeze?: { rows: number; cols: number }; // leading rows/columns frozen (sticky) while scrolling
}

export function newId(prefix: string): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return `${prefix}-${c.randomUUID()}`;
  return `${prefix}-${Math.abs(Date.now() ^ Math.floor(Math.random() * 1e9)).toString(36)}`;
}

export interface Workbook {
  sheets: SheetData[];
  active: number; // index into sheets
}

export function emptyWorkbook(): Workbook {
  return { sheets: [{ name: "Feuille 1", rows: 20, cols: 8, cells: {} }], active: 0 };
}

export function emptySheet(name: string): SheetData {
  return { name, rows: 20, cols: 8, cells: {} };
}
