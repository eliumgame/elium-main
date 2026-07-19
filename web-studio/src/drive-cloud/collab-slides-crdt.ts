/**
 * CRDT (de)serialization for the collaborative Présentations editor, on the SAME
 * free-canvas model as the local suite (slides/model.ts). A deck is a Y.Map; its
 * `slides` is a Y.Array of slide Y.Maps; each slide carries an `elements` Y.Array
 * of per-element Y.Maps, so two people editing different elements merge cleanly
 * (per-field last-write-wins). Legacy rooms (created before the free-canvas model)
 * stored only fixed-layout fields + `shapes`; they are migrated to `elements` on
 * read via elementsOf(), and persisted to the Y.Doc the first time an element is
 * edited (ensureElementsY). Pure module — unit-tested against yjs in node.
 */
import * as Y from "yjs";
import {
  elementsOf,
  type Slide, type Shape, type SlideElement, type SlideAnim, type SlideLayout, type SlideTransition, type ShapeKind,
} from "../slides/model";

type YMap = Y.Map<unknown>;

// Text fields stored as Y.Text so concurrent edits merge character-by-character
// (CRDT) instead of whole-field last-write-wins. `Y.Map.toJSON()` and
// `String(yText)` both collapse a Y.Text to its string, so every read path
// (yToEl / legacySlide) keeps working unchanged.
export const EL_TEXT_FIELDS = new Set(["html", "text"]); // text element rich text + shape label
export const SLIDE_TEXT_FIELDS = new Set(["title", "body", "bodyHtml", "notes"]);

function newYText(s: string): Y.Text {
  const t = new Y.Text();
  if (s) t.insert(0, s);
  return t;
}

/** Get-or-create the Y.Text at `key`, migrating a legacy plain-string value. */
export function ensureYText(m: YMap, key: string): Y.Text {
  const cur = m.get(key);
  if (cur instanceof Y.Text) return cur;
  const t = newYText(cur == null ? "" : String(cur));
  m.set(key, t);
  return t;
}

/**
 * Apply the minimal edit turning `yt`'s current content into `next` (shared
 * common prefix/suffix, splice the middle). Concurrent edits in different
 * regions then merge instead of clobbering; only a genuine same-span conflict
 * is resolved by Yjs. Call inside a ydoc.transact.
 */
export function syncYText(yt: Y.Text, next: string): void {
  const cur = yt.toString();
  if (cur === next) return;
  const max = Math.min(cur.length, next.length);
  let p = 0;
  while (p < max && cur[p] === next[p]) p++;
  let s = 0;
  while (s < max - p && cur[cur.length - 1 - s] === next[next.length - 1 - s]) s++;
  const delLen = cur.length - p - s;
  if (delLen > 0) yt.delete(p, delLen);
  const ins = next.slice(p, next.length - s);
  if (ins) yt.insert(p, ins);
}

// --- element <-> Y.Map (flat objects; toJSON round-trips them faithfully) ---
export function elToY(el: SlideElement): YMap {
  const m = new Y.Map() as YMap;
  for (const [k, v] of Object.entries(el)) {
    if (v === undefined) continue;
    if (EL_TEXT_FIELDS.has(k) && typeof v === "string") m.set(k, newYText(v));
    else m.set(k, v);
  }
  return m;
}
export function yToEl(m: YMap): SlideElement {
  return m.toJSON() as SlideElement;
}

export function shapeToY(s: Shape): YMap {
  const m = new Y.Map() as YMap;
  for (const [k, v] of Object.entries(s)) if (v !== undefined) m.set(k, v);
  return m;
}

/** Build a legacy (elements-less) Slide from a slide Y.Map's fixed-layout fields. */
function legacySlide(m: YMap): Slide {
  const shapesArr = (m.get("shapes") as Y.Array<YMap>) ?? null;
  const shapes: Shape[] = shapesArr
    ? shapesArr.toArray().map((sm) => ({
        id: String(sm.get("id")), kind: sm.get("kind") as ShapeKind,
        x: Number(sm.get("x")), y: Number(sm.get("y")), w: Number(sm.get("w")), h: Number(sm.get("h")),
        fill: String(sm.get("fill")), stroke: String(sm.get("stroke")), strokeWidth: Number(sm.get("strokeWidth")),
        text: (sm.get("text") as string) || undefined,
      }))
    : [];
  return {
    id: String(m.get("id")), title: String(m.get("title") ?? ""), body: String(m.get("body") ?? ""),
    bodyHtml: String(m.get("bodyHtml") ?? ""), layout: (m.get("layout") as SlideLayout) ?? "title-content",
    notes: String(m.get("notes") ?? ""), image: (m.get("image") as string) || undefined,
    imageWidth: Number(m.get("imageWidth") ?? 100), transition: (m.get("transition") as SlideTransition) || undefined,
    shapes,
  };
}

/** Serialize a full Slide to a Y.Map, including the free-canvas `elements`. */
export function slideToY(s: Slide): YMap {
  const m = new Y.Map() as YMap;
  m.set("id", s.id);
  m.set("title", newYText(s.title ?? "")); m.set("body", newYText(s.body ?? "")); m.set("bodyHtml", newYText(s.bodyHtml ?? ""));
  m.set("notes", newYText(s.notes ?? ""));
  m.set("layout", s.layout); m.set("image", s.image ?? ""); m.set("imageWidth", s.imageWidth ?? 100);
  m.set("transition", s.transition ?? "");
  if (s.background != null) m.set("background", s.background);
  if (s.anims && s.anims.length) m.set("anims", s.anims);
  const shapes = new Y.Array<YMap>();
  shapes.push((s.shapes ?? []).map(shapeToY));
  m.set("shapes", shapes);
  const els = new Y.Array<YMap>();
  els.push((s.elements ?? elementsOf(s)).map(elToY));
  m.set("elements", els);
  return m;
}

/** Read a Slide from a Y.Map; legacy rooms are migrated to `elements` in memory. */
export function yToSlide(m: YMap): Slide {
  const base = legacySlide(m);
  const bg = (m.get("background") as string) || undefined;
  if (bg) base.background = bg;
  const anims = m.get("anims") as SlideAnim[] | undefined;
  if (anims && anims.length) base.anims = anims;
  const elsArr = m.get("elements") as Y.Array<YMap> | undefined;
  base.elements = elsArr && elsArr.length > 0 ? elsArr.toArray().map(yToEl) : elementsOf(base);
  return base;
}

/**
 * Return the slide's `elements` Y.Array, creating and seeding it from the legacy
 * fixed-layout content the first time (persists the migration). Must run inside a
 * ydoc.transact.
 */
export function ensureElementsY(m: YMap): Y.Array<YMap> {
  let arr = m.get("elements") as Y.Array<YMap> | undefined;
  if (!arr || arr.length === 0) {
    const seed = elementsOf(legacySlide(m));
    arr = new Y.Array<YMap>();
    arr.push(seed.map(elToY));
    m.set("elements", arr);
  }
  return arr;
}
