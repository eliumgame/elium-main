/**
 * Pure helpers for multi-selection, grouping, marquee hit-testing, proportional
 * resize and copy/paste cloning in the slides editor. Kept side-effect-free so
 * the interaction-heavy canvas can be unit-tested without a DOM.
 */
import type { SlideElement } from "./model";

/** Rectangle in canvas % coordinates. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** All ids that select/move together with `id` (its whole group, or just it). */
export function unitIds(elements: SlideElement[], id: string): string[] {
  const el = elements.find((e) => e.id === id);
  if (el?.groupId) return elements.filter((e) => e.groupId === el.groupId).map((e) => e.id);
  return el ? [id] : [];
}

/** Expand a selection so any selected element pulls in its whole group. */
export function expandGroups(elements: SlideElement[], ids: string[]): string[] {
  const out = new Set<string>();
  for (const id of ids) for (const u of unitIds(elements, id)) out.add(u);
  return [...out];
}

/**
 * New selection after clicking `id`. `additive` (Shift/Ctrl) toggles the clicked
 * unit in/out; a plain click selects just that unit. Groups move as one.
 */
export function selectionAfterClick(
  elements: SlideElement[],
  current: string[],
  id: string,
  additive: boolean,
): string[] {
  const unit = unitIds(elements, id);
  if (!additive) {
    // Clicking an already-selected element keeps the (multi) selection so a drag
    // moves the whole group; otherwise it becomes the sole selection.
    return current.includes(id) ? current : unit;
  }
  const set = new Set(current);
  const allIn = unit.every((u) => set.has(u));
  for (const u of unit) {
    if (allIn) set.delete(u);
    else set.add(u);
  }
  return [...set];
}

const bbox = (e: SlideElement): Rect => ({ x: e.x, y: e.y, w: e.w, h: e.h });
function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Ids of elements whose bounding box intersects the marquee rect. */
export function marqueeHits(elements: SlideElement[], rect: Rect): string[] {
  const norm: Rect = {
    x: Math.min(rect.x, rect.x + rect.w),
    y: Math.min(rect.y, rect.y + rect.h),
    w: Math.abs(rect.w),
    h: Math.abs(rect.h),
  };
  return elements.filter((e) => intersects(bbox(e), norm)).map((e) => e.id);
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Resize geometry for a handle drag. `dxp`/`dyp` are the pointer delta in canvas
 * %. Corner handles with `proportional` keep the element's aspect ratio (Shift).
 * Mirrors the edge math in canvas.tsx but pure + testable.
 */
export function resizeGeometry(
  o: Rect,
  mode: string, // "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w"
  dxp: number,
  dyp: number,
  proportional: boolean,
): Rect {
  let { x, y, w, h } = o;
  if (mode.includes("e")) w = clamp(o.w + dxp, 3, 100 - o.x);
  if (mode.includes("s")) h = clamp(o.h + dyp, 3, 100 - o.y);
  if (mode.includes("w")) {
    const nx = clamp(o.x + dxp, 0, o.x + o.w - 3);
    w = o.w + (o.x - nx);
    x = nx;
  }
  if (mode.includes("n")) {
    const ny = clamp(o.y + dyp, 0, o.y + o.h - 3);
    h = o.h + (o.y - ny);
    y = ny;
  }
  // Proportional only makes sense on corner handles (two axes change).
  const corner = mode.length === 2;
  if (proportional && corner && o.w > 0 && o.h > 0) {
    const ratio = o.w / o.h;
    // Drive height from width, keeping the dragged corner anchored.
    const nh = w / ratio;
    if (mode.includes("n")) y = o.y + o.h - nh;
    h = nh;
  }
  return { x: r1(x), y: r1(y), w: r1(w), h: r1(h) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Clone elements for paste/duplicate: fresh ids, shifted by (dx,dy)%, group tags
 * remapped so a pasted group stays grouped but distinct from the original.
 * `mkId` supplies fresh unique ids (e.g. the store's element-id generator).
 */
export function cloneElements(
  els: SlideElement[],
  mkId: () => string,
  dx: number,
  dy: number,
): SlideElement[] {
  const groupMap = new Map<string, string>();
  return els.map((e) => {
    const clone: SlideElement = {
      ...e,
      id: mkId(),
      x: r1(clamp(e.x + dx, 0, 97)),
      y: r1(clamp(e.y + dy, 0, 97)),
    };
    if (e.morphKey) delete clone.morphKey; // a fresh copy is not a morph pair
    if (e.groupId) {
      if (!groupMap.has(e.groupId)) groupMap.set(e.groupId, mkId());
      clone.groupId = groupMap.get(e.groupId)!;
    }
    return clone;
  });
}
