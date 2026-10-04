/**
 * Virtualisation des lignes du Tableur (calcul pur) : on ne rend que les lignes
 * visibles dans la zone de défilement (+ marge), le reste est remplacé par deux
 * lignes d'espacement. Gère les hauteurs de ligne variables, les lignes masquées
 * par un filtre, les fusions verticales qui chevauchent la fenêtre et les lignes
 * figées (toujours rendues).
 */
import type { MergeRect } from "./model";

/** Décalages verticaux cumulés : offsets[r] = position du haut de la ligne r ; offsets[rows] = hauteur totale. */
export function rowOffsets(rows: number, heightOf: (r: number) => number, hidden?: (r: number) => boolean): Float64Array {
  const out = new Float64Array(rows + 1);
  let acc = 0;
  for (let r = 0; r < rows; r++) {
    out[r] = acc;
    if (!hidden || !hidden(r)) acc += heightOf(r);
  }
  out[rows] = acc;
  return out;
}

/** Plus petit r tel que offsets[r+1] > y (ligne contenant la position y). */
export function rowAt(offsets: Float64Array, y: number): number {
  const rows = offsets.length - 1;
  if (rows <= 0) return 0;
  let lo = 0;
  let hi = rows - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1]! > y) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

export interface RowWindow {
  /** Première ligne rendue (incluse). */
  start: number;
  /** Dernière ligne rendue (exclue). */
  end: number;
}

/** Fenêtre de lignes pour une zone de défilement ; `overscanPx` ajoute une marge haut et bas. */
export function windowFor(offsets: Float64Array, scrollTop: number, viewportH: number, overscanPx = 320): RowWindow {
  const rows = offsets.length - 1;
  if (rows <= 0) return { start: 0, end: 0 };
  const top = Math.max(0, scrollTop - overscanPx);
  const bottom = scrollTop + viewportH + overscanPx;
  const start = rowAt(offsets, top);
  let end = rowAt(offsets, Math.min(bottom, Math.max(0, offsets[rows]! - 1))) + 1;
  end = Math.min(rows, Math.max(end, start + 1));
  return { start, end };
}

/** Étend la fenêtre pour qu'aucune fusion verticale ne soit coupée à ses bords. */
export function expandForMerges(w: RowWindow, merges: MergeRect[] | undefined): RowWindow {
  if (!merges?.length) return w;
  let { start, end } = w;
  let changed = true;
  while (changed) {
    changed = false;
    for (const m of merges) {
      if (m.r1 < start || m.r0 >= end) continue;
      if (m.r0 < start) {
        start = m.r0;
        changed = true;
      }
      if (m.r1 >= end) {
        end = m.r1 + 1;
        changed = true;
      }
    }
  }
  return { start, end };
}

/**
 * Hauteurs d'espacement avant et après la fenêtre. Les `frozen` premières lignes sont rendues
 * à part (toujours en tête) : elles ne comptent donc pas dans l'espacement du haut.
 */
export function spacers(offsets: Float64Array, w: RowWindow, frozen: number): { top: number; bottom: number } {
  const rows = offsets.length - 1;
  const frozenRows = Math.min(frozen, rows);
  const startAfterFrozen = Math.max(w.start, frozenRows);
  const top = Math.max(0, offsets[startAfterFrozen]! - offsets[frozenRows]!);
  const bottom = Math.max(0, offsets[rows]! - offsets[Math.min(rows, Math.max(w.end, frozenRows))]!);
  return { top, bottom };
}

/** Nouvelle valeur de scrollTop pour révéler la ligne `r` (null si déjà visible). */
export function scrollTopToReveal(
  offsets: Float64Array,
  r: number,
  scrollTop: number,
  viewportH: number,
  stickyTop: number,
): number | null {
  const rows = offsets.length - 1;
  if (r < 0 || r >= rows) return null;
  const top = offsets[r]!;
  const bottom = offsets[r + 1]!;
  if (top - stickyTop < scrollTop) return Math.max(0, top - stickyTop);
  if (bottom > scrollTop + viewportH) return Math.max(0, bottom - viewportH);
  return null;
}

/** Ligne atteinte par un saut de page depuis `r` (visible seulement ; `dir` = ±1). */
export function pageJump(offsets: Float64Array, r: number, viewportH: number, dir: 1 | -1): number {
  const rows = offsets.length - 1;
  const y = Math.min(Math.max(0, offsets[r]! + dir * Math.max(40, viewportH - 56)), Math.max(0, offsets[rows]! - 1));
  return Math.min(rows - 1, Math.max(0, rowAt(offsets, y)));
}
