/**
 * Merged cells — pure logic (no React). A merge is a rectangle whose top-left
 * cell spans the whole area; the other covered cells are hidden (not rendered)
 * and hold no value. Dependency-free + unit-tested.
 */
import type { MergeRect } from "./model";

function norm(r: MergeRect): MergeRect {
  return { c0: Math.min(r.c0, r.c1), c1: Math.max(r.c0, r.c1), r0: Math.min(r.r0, r.r1), r1: Math.max(r.r0, r.r1) };
}

function intersects(a: MergeRect, b: MergeRect): boolean {
  return a.c0 <= b.c1 && a.c1 >= b.c0 && a.r0 <= b.r1 && a.r1 >= b.r0;
}

/** The merge covering (c, r), or null. */
export function mergeAt(merges: MergeRect[] | undefined, c: number, r: number): MergeRect | null {
  if (!merges) return null;
  for (const m of merges) if (c >= m.c0 && c <= m.c1 && r >= m.r0 && r <= m.r1) return m;
  return null;
}

export function isMergeOrigin(m: MergeRect, c: number, r: number): boolean {
  return c === m.c0 && r === m.r0;
}

/** True when (c, r) is inside a merge but not its top-left origin — i.e. hidden. */
export function isCovered(merges: MergeRect[] | undefined, c: number, r: number): boolean {
  const m = mergeAt(merges, c, r);
  return !!m && !isMergeOrigin(m, c, r);
}

/** colSpan/rowSpan for the origin cell of a merge, or null when (c, r) isn't an origin. */
export function spanAt(merges: MergeRect[] | undefined, c: number, r: number): { colSpan: number; rowSpan: number } | null {
  const m = mergeAt(merges, c, r);
  if (!m || !isMergeOrigin(m, c, r)) return null;
  return { colSpan: m.c1 - m.c0 + 1, rowSpan: m.r1 - m.r0 + 1 };
}

/**
 * Toggle a merge over `sel`: if any existing merge intersects the selection,
 * remove all intersecting ones (unmerge); otherwise merge the (multi-cell)
 * rectangle. Merging a single cell is a no-op.
 */
export function toggleMerge(merges: MergeRect[] | undefined, sel: MergeRect): MergeRect[] {
  const list = merges ?? [];
  const s = norm(sel);
  const hit = list.filter((m) => intersects(m, s));
  if (hit.length) return list.filter((m) => !intersects(m, s));
  if (s.c0 === s.c1 && s.r0 === s.r1) return list; // nothing to merge
  return [...list, s];
}
