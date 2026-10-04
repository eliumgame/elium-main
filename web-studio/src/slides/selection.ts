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
export function cloneElements(els: SlideElement[], mkId: () => string, dx: number, dy: number): SlideElement[] {
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

// ---------------------------------------------------------------------------
// Keyboard access (selection / move / resize) and screen-reader descriptions
// ---------------------------------------------------------------------------

const TYPE_LABEL: Record<SlideElement["type"], string> = {
  text: "Texte",
  shape: "Forme",
  image: "Image",
  table: "Tableau",
  chart: "Graphique",
  media: "Média",
  diagram: "Diagramme",
};

const plainText = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** « Texte 2 sur 5 : Bonjour » — what a screen reader says when an element is selected. */
export function describeElement(el: SlideElement, index: number, total: number): string {
  let detail = "";
  if (el.type === "text") detail = plainText(el.html ?? "");
  else if (el.type === "shape") detail = [el.shape, el.text].filter(Boolean).join(" — ");
  else if (el.type === "table" && el.table) detail = `${el.table.rows} lignes, ${el.table.cols} colonnes`;
  else if (el.type === "chart" && el.chart) detail = el.chart.title ?? el.chart.kind;
  if (detail.length > 80) detail = `${detail.slice(0, 80)}…`;
  const locked = el.locked ? " (verrouillé)" : "";
  return `${TYPE_LABEL[el.type]} ${index + 1} sur ${total}${detail ? ` : ${detail}` : ""}${locked}`;
}

/**
 * The patch a key press applies to an element: arrows move by 1 % (Shift: 5 %),
 * Alt + arrows resize by the same step. Null when the key does nothing or the
 * element is locked. Results stay inside the canvas (position 0..100, minimum size 2 %).
 */
export function keyboardPatch(
  el: SlideElement,
  key: string,
  shift: boolean,
  alt: boolean,
): Partial<SlideElement> | null {
  if (el.locked) return null;
  const step = shift ? 5 : 1;
  const dx = key === "ArrowLeft" ? -step : key === "ArrowRight" ? step : 0;
  const dy = key === "ArrowUp" ? -step : key === "ArrowDown" ? step : 0;
  if (!dx && !dy) return null;
  if (alt) {
    return { w: r1(clamp(el.w + dx, 2, 100 - el.x)), h: r1(clamp(el.h + dy, 2, 100 - el.y)) };
  }
  return { x: r1(clamp(el.x + dx, 0, 100 - el.w)), y: r1(clamp(el.y + dy, 0, 100 - el.h)) };
}

/**
 * Tab / Shift+Tab inside the canvas: the next element in stacking order, or null
 * past either end (focus then leaves the canvas as usual).
 */
export function nextElementId(
  elements: SlideElement[],
  current: string | undefined,
  backwards: boolean,
): string | null {
  if (!elements.length) return null;
  const at = current ? elements.findIndex((e) => e.id === current) : -1;
  const next = at < 0 ? (backwards ? elements.length - 1 : 0) : at + (backwards ? -1 : 1);
  return next >= 0 && next < elements.length ? elements[next]!.id : null;
}
