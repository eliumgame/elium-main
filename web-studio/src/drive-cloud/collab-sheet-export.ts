/**
 * Bridge the collaborative sheet's CRDT snapshot to the shared XLSX exporter
 * (`sheet/xlsx-export.ts`), so the Drive editor exports the same valid package
 * as the local Tableur (dual-platform parity). Pure + testable: no Yjs here.
 */
import type { CellStyle, Workbook } from "../sheet/model";

/** One collaborative sheet as read from the Y.Doc (mirrors CollabSheetEditor's SheetSnap). */
export interface CollabSheetSnap {
  name: string;
  rows: number;
  cols: number;
  cells: Record<string, string>;
  styles: Record<string, CellStyle>;
}

/** Rebuild a `Workbook` from the live CRDT snapshot, ready for `workbookToXlsx`. */
export function collabSheetsToWorkbook(sheets: CollabSheetSnap[], active = 0): Workbook {
  return {
    sheets: sheets.map((s) => ({
      name: s.name,
      rows: s.rows,
      cols: s.cols,
      cells: { ...s.cells },
      styles: { ...s.styles },
    })),
    active: sheets.length ? Math.max(0, Math.min(active, sheets.length - 1)) : 0,
  };
}
