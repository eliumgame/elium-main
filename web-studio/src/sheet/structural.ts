/**
 * Opérations structurelles PURES sur une feuille : insertion / suppression de
 * lignes et de colonnes. Aucune dépendance à React ni au stockage — la même
 * fonction sert au Tableur local (mono-utilisateur) et au Tableur collaboratif
 * (réconcilié dans le CRDT), donc un seul comportement, testé une seule fois.
 *
 * Le même plan de relocalisation qui déplace les cellules réécrit AUSSI les
 * références dans les formules survivantes : `=SOMME(A1:A5)` suit les lignes
 * insérées/supprimées. Les largeurs de colonnes suivent leur colonne. (Comme le
 * Tableur local historique, les plages des fusions / mises en forme
 * conditionnelles / validations ne sont pas redécalées — comportement conservé
 * à l'identique pour la parité.)
 */
import { indexToCol, parseRef, rewriteRefs, type RefMap } from "./formula";
import type { CellStyle, SheetData } from "./model";

type Pos = { c: number; r: number };
const cellRef = (c: number, r: number) => indexToCol(c) + (r + 1);

function reindexCells(
  cells: Record<string, string>,
  fn: (c: number, r: number) => Pos | null,
  rewrite: (v: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ref, v] of Object.entries(cells)) {
    const p = parseRef(ref);
    if (!p) continue;
    const np = fn(p.col, p.row);
    if (np) out[cellRef(np.c, np.r)] = rewrite(v);
  }
  return out;
}

function reindexStyles(
  styles: Record<string, CellStyle> | undefined,
  fn: (c: number, r: number) => Pos | null,
): Record<string, CellStyle> | undefined {
  if (!styles) return undefined;
  const out: Record<string, CellStyle> = {};
  for (const [ref, v] of Object.entries(styles)) {
    const p = parseRef(ref);
    if (!p) continue;
    const np = fn(p.col, p.row);
    if (np) out[cellRef(np.c, np.r)] = v;
  }
  return out;
}

/** Applique un plan de relocalisation `fn` (et le décalage de taille) à la feuille. */
function structural(sheet: SheetData, fn: (c: number, r: number) => Pos | null, dCols: number, dRows: number): SheetData {
  const refMap: RefMap = (col, row) => {
    const np = fn(col, row);
    return np ? { col: np.c, row: np.r } : null;
  };
  const rewrite = (v: string) => (v[0] === "=" ? rewriteRefs(v, refMap) : v);

  let colWidths: Record<number, number> | undefined;
  if (sheet.colWidths) {
    colWidths = {};
    for (const [k, w] of Object.entries(sheet.colWidths)) {
      const np = fn(Number(k), 0);
      if (np) colWidths[np.c] = w;
    }
  }

  const next: SheetData = {
    ...sheet,
    cols: Math.max(1, sheet.cols + dCols),
    rows: Math.max(1, sheet.rows + dRows),
    cells: reindexCells(sheet.cells, fn, rewrite),
  };
  const styles = reindexStyles(sheet.styles, fn);
  if (styles) next.styles = styles; else delete next.styles;
  if (colWidths) next.colWidths = colWidths; else delete next.colWidths;
  return next;
}

export function insertRow(sheet: SheetData, at: number): SheetData {
  return structural(sheet, (c, r) => ({ c, r: r >= at ? r + 1 : r }), 0, 1);
}
export function deleteRow(sheet: SheetData, at: number): SheetData {
  return structural(sheet, (c, r) => (r === at ? null : { c, r: r > at ? r - 1 : r }), 0, -1);
}
export function insertCol(sheet: SheetData, at: number): SheetData {
  return structural(sheet, (c, r) => ({ c: c >= at ? c + 1 : c, r }), 1, 0);
}
export function deleteCol(sheet: SheetData, at: number): SheetData {
  return structural(sheet, (c, r) => (c === at ? null : { c: c > at ? c - 1 : c, r }), -1, 0);
}
