/**
 * View-filter visibility — the single predicate shared by rendering, copy,
 * CSV export and sort, so a "real" AutoFilter is honored everywhere (not just
 * hidden with display:none on screen). Pure and testable: `displayOf(col,row)`
 * returns the SHOWN text of a cell (formulas resolved, formatting applied) so
 * the match is exactly what the user sees.
 */
import type { SheetData } from "./model";

export type Filter = SheetData["filter"];
export type DisplayOf = (col: number, row: number) => string;

/** Does row `r` pass the sheet's view filter? (No filter ⇒ always visible.) */
export function rowVisible(filter: Filter, displayOf: DisplayOf, r: number): boolean {
  if (!filter) return true;
  return displayOf(filter.col, r).toLowerCase().includes(filter.query.toLowerCase());
}

/** The indices in [r0, r1] (inclusive) that are visible under the filter, in order. */
export function visibleRowsInRange(filter: Filter, displayOf: DisplayOf, r0: number, r1: number): number[] {
  const out: number[] = [];
  for (let r = r0; r <= r1; r++) if (rowVisible(filter, displayOf, r)) out.push(r);
  return out;
}
