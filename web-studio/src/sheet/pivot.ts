/**
 * Pivot tables (tableaux croisés dynamiques) — pure aggregation over a data
 * range. Given a range whose first row is field headers, group the remaining
 * rows by one field (rows) and optionally a second (columns), and aggregate a
 * value field with sum/count/avg/min/max. Kept pure and side-effect-free so it
 * is unit-testable; SheetView resolves the range to values and renders the
 * result into a fresh sheet.
 */
import { indexToCol } from "./formula";
import { emptySheet, type SheetData } from "./model";

export type PivotAgg = "sum" | "count" | "avg" | "min" | "max";

export interface PivotConfig {
  rowField: number; // index into headers — the row-grouping field
  colField: number | null; // index into headers, or null for no column grouping
  valueField: number; // index into headers — the field to aggregate
  agg: PivotAgg;
}

export interface PivotInput {
  headers: string[];
  rows: (string | number | boolean | null)[][];
}

export interface PivotResult {
  corner: string; // top-left label, e.g. "Somme de Ventes"
  colLabels: string[]; // column-group labels (empty when colField is null)
  rowLabels: string[];
  matrix: number[][]; // matrix[rowIdx][colIdx]
  rowTotals: number[];
  colTotals: number[];
  grandTotal: number;
  hasCols: boolean;
}

export const PIVOT_AGGS: { value: PivotAgg; label: string }[] = [
  { value: "sum", label: "Somme" },
  { value: "count", label: "Nombre" },
  { value: "avg", label: "Moyenne" },
  { value: "min", label: "Minimum" },
  { value: "max", label: "Maximum" },
];

function aggPrefix(agg: PivotAgg): string {
  switch (agg) {
    case "sum": return "Somme de";
    case "count": return "Nombre de";
    case "avg": return "Moyenne de";
    case "min": return "Min de";
    case "max": return "Max de";
  }
}

function toNum(v: string | number | boolean | null | undefined): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v == null) return null;
  const s = String(v).trim();
  if (s === "") return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

const label = (v: string | number | boolean | null | undefined): string =>
  v == null ? "" : String(v);

/** Aggregate a set of numeric values (and a non-empty count) per the chosen op. */
function aggregate(agg: PivotAgg, values: number[], count: number): number {
  if (agg === "count") return count;
  if (values.length === 0) return 0;
  switch (agg) {
    case "sum": return values.reduce((a, b) => a + b, 0);
    case "avg": return values.reduce((a, b) => a + b, 0) / values.length;
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
  }
}

const round10 = (n: number): number => Math.round(n * 1e10) / 1e10;

export function computePivot(input: PivotInput, cfg: PivotConfig): PivotResult {
  const hasCols = cfg.colField !== null && cfg.colField >= 0;

  const rowKeys: string[] = [];
  const rowIndex = new Map<string, number>();
  const colKeys: string[] = [];
  const colIndex = new Map<string, number>();

  // Numeric values + non-empty counts, accumulated at three granularities so
  // that totals (esp. avg/min/max) are computed over the raw group, not over
  // already-aggregated cells.
  const cellNums = new Map<string, number[]>();
  const cellCnt = new Map<string, number>();
  const rowNums = new Map<number, number[]>();
  const rowCnt = new Map<number, number>();
  const colNums = new Map<number, number[]>();
  const colCnt = new Map<number, number>();
  const grandNums: number[] = [];
  let grandCnt = 0;

  const push = (m: Map<string | number, number[]>, k: string | number, n: number) => {
    const a = m.get(k); if (a) a.push(n); else m.set(k, [n]);
  };
  const bump = (m: Map<string | number, number>, k: string | number) => m.set(k, (m.get(k) ?? 0) + 1);

  for (const row of input.rows) {
    const rk = label(row[cfg.rowField]);
    if (!rowIndex.has(rk)) { rowIndex.set(rk, rowKeys.length); rowKeys.push(rk); }
    const ri = rowIndex.get(rk)!;

    let ci = 0;
    if (hasCols) {
      const ck = label(row[cfg.colField!]);
      if (!colIndex.has(ck)) { colIndex.set(ck, colKeys.length); colKeys.push(ck); }
      ci = colIndex.get(ck)!;
    }

    const raw = row[cfg.valueField];
    const isEmpty = raw == null || (typeof raw === "string" && raw.trim() === "");
    const n = toNum(raw);
    const cellKey = ri + "|" + ci;

    if (!isEmpty) {
      cellCnt.set(cellKey, (cellCnt.get(cellKey) ?? 0) + 1);
      bump(rowCnt, ri); bump(colCnt, ci); grandCnt++;
    }
    if (n !== null) {
      push(cellNums, cellKey, n);
      push(rowNums, ri, n); push(colNums, ci, n); grandNums.push(n);
    }
  }

  const nCols = hasCols ? Math.max(1, colKeys.length) : 1;
  const matrix = rowKeys.map((_, ri) =>
    Array.from({ length: nCols }, (_, ci) =>
      round10(aggregate(cfg.agg, cellNums.get(ri + "|" + ci) ?? [], cellCnt.get(ri + "|" + ci) ?? 0)),
    ),
  );
  const rowTotals = rowKeys.map((_, ri) => round10(aggregate(cfg.agg, rowNums.get(ri) ?? [], rowCnt.get(ri) ?? 0)));
  const colTotals = Array.from({ length: nCols }, (_, ci) => round10(aggregate(cfg.agg, colNums.get(ci) ?? [], colCnt.get(ci) ?? 0)));
  const grandTotal = round10(aggregate(cfg.agg, grandNums, grandCnt));

  const valueName = input.headers[cfg.valueField] ?? `Colonne ${cfg.valueField + 1}`;

  return {
    corner: `${aggPrefix(cfg.agg)} ${valueName}`.trim(),
    colLabels: hasCols ? colKeys : [],
    rowLabels: rowKeys,
    matrix,
    rowTotals,
    colTotals,
    grandTotal,
    hasCols,
  };
}

/** Render a pivot result into a fresh SheetData (labels in row 1 / column A, a
 *  trailing "Total" row and column). */
export function pivotToSheet(result: PivotResult, name: string): SheetData {
  const cells: Record<string, string> = {};
  const set = (c: number, r: number, v: string | number) => {
    if (v === "" || v == null) return;
    cells[indexToCol(c) + (r + 1)] = typeof v === "number" ? String(v) : v;
  };

  const colHeaders = result.hasCols ? [...result.colLabels, "Total"] : ["Total"];

  // Header row.
  set(0, 0, result.corner);
  colHeaders.forEach((h, i) => set(1 + i, 0, h));

  // Body rows.
  result.rowLabels.forEach((rl, ri) => {
    const r = 1 + ri;
    set(0, r, rl);
    if (result.hasCols) {
      result.matrix[ri].forEach((v, ci) => set(1 + ci, r, v));
      set(1 + result.colLabels.length, r, result.rowTotals[ri]);
    } else {
      set(1, r, result.rowTotals[ri]);
    }
  });

  // Total row.
  const totalR = 1 + result.rowLabels.length;
  set(0, totalR, "Total");
  if (result.hasCols) {
    result.colTotals.forEach((v, ci) => set(1 + ci, totalR, v));
    set(1 + result.colLabels.length, totalR, result.grandTotal);
  } else {
    set(1, totalR, result.grandTotal);
  }

  const rows = totalR + 1;
  const cols = 1 + colHeaders.length;
  const sheet = emptySheet(name);
  sheet.cells = cells;
  sheet.rows = Math.max(sheet.rows, rows);
  sheet.cols = Math.max(sheet.cols, cols);
  // Bold the header row and the label column + total row via styles.
  const styles: Record<string, { bold?: boolean }> = {};
  for (let c = 0; c < cols; c++) styles[indexToCol(c) + "1"] = { bold: true };
  for (let r = 0; r < rows; r++) styles[indexToCol(0) + (r + 1)] = { bold: true };
  for (let c = 0; c < cols; c++) styles[indexToCol(c) + (totalR + 1)] = { bold: true };
  sheet.styles = styles;
  return sheet;
}
