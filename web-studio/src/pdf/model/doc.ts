/**
 * Pure state transitions over `PdfState`.
 *
 * Every mutation the UI can perform lives here as a plain function so it can be
 * unit-tested without React, pdf.js or a DOM, and so the undo stack only ever
 * has to snapshot one object.
 */

import type { Rect, Rotation } from "../core/coords";
import { normRotation, rectOfPoints, rectOfQuads } from "../core/coords";
import type {
  Annot,
  AnnotKind,
  Bookmark,
  ContentEdit,
  CreatedField,
  FormValue,
  ImageEdit,
  Page,
  PdfState,
  Reply,
  ReviewStatus,
} from "./types";
import { isPolyKind, isTextMarkup, newId } from "./types";

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function makePage(from: number | null, extra?: Partial<Page>): Page {
  return { id: newId("pg"), from, ...extra };
}

export function pagesFromSource(count: number): Page[] {
  return Array.from({ length: count }, (_, i) => makePage(i));
}

export function pageIndexById(state: PdfState, id: string): number {
  return state.pages.findIndex((p) => p.id === id);
}

/** Move `ids` so they land at `to` (an index in the *current* order). */
export function reorderPages(state: PdfState, ids: readonly string[], to: number): PdfState {
  const moving = state.pages.filter((p) => ids.includes(p.id));
  if (!moving.length) return state;
  const rest = state.pages.filter((p) => !ids.includes(p.id));
  // `to` counts positions in the original list; translate it to the gap it
  // designates once the moved pages are lifted out.
  const before = state.pages.slice(0, to).filter((p) => !ids.includes(p.id)).length;
  const next = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
  return { ...state, pages: next };
}

export function movePageBy(state: PdfState, id: string, delta: number): PdfState {
  const i = pageIndexById(state, id);
  if (i < 0) return state;
  const j = Math.max(0, Math.min(state.pages.length - 1, i + delta));
  if (i === j) return state;
  const pages = state.pages.slice();
  const [p] = pages.splice(i, 1);
  pages.splice(j, 0, p);
  return { ...state, pages };
}

/** Delete pages (and their annotations). Never leaves the document empty. */
export function deletePages(state: PdfState, ids: readonly string[]): PdfState {
  const keep = state.pages.filter((p) => !ids.includes(p.id));
  if (!keep.length) return state;
  const gone = new Set(ids);
  return {
    ...state,
    pages: keep,
    annots: state.annots.filter((a) => !gone.has(a.pageId)),
    contentEdits: state.contentEdits.filter((e) => !gone.has(e.pageId)),
    imageEdits: state.imageEdits.filter((e) => !gone.has(e.pageId)),
    createdFields: state.createdFields.filter((f) => !gone.has(f.pageId)),
  };
}

export function duplicatePages(state: PdfState, ids: readonly string[]): PdfState {
  const pages: Page[] = [];
  const annots = state.annots.slice();
  const contentEdits = state.contentEdits.slice();
  const createdFields = state.createdFields.slice();
  for (const p of state.pages) {
    pages.push(p);
    if (!ids.includes(p.id)) continue;
    const copy: Page = { ...p, id: newId("pg") };
    pages.push(copy);
    for (const a of state.annots) {
      if (a.pageId !== p.id) continue;
      annots.push({ ...cloneAnnot(a), pageId: copy.id });
    }
    for (const e of state.contentEdits) {
      if (e.pageId === p.id) contentEdits.push({ ...e, id: newId("ce"), pageId: copy.id });
    }
    for (const f of state.createdFields) {
      if (f.pageId === p.id) createdFields.push({ ...f, id: newId("fd"), pageId: copy.id, name: `${f.name}_copie` });
    }
  }
  return { ...state, pages, annots, contentEdits, createdFields };
}

export function insertPages(state: PdfState, at: number, pages: readonly Page[]): PdfState {
  const next = state.pages.slice();
  next.splice(Math.max(0, Math.min(next.length, at)), 0, ...pages);
  return { ...state, pages: next };
}

export function rotatePages(state: PdfState, ids: readonly string[], delta: number): PdfState {
  const set = new Set(ids);
  return {
    ...state,
    pages: state.pages.map((p) => (set.has(p.id) ? { ...p, rotate: normRotation((p.rotate ?? 0) + delta) } : p)),
  };
}

export function setPageRotation(state: PdfState, id: string, rotation: Rotation): PdfState {
  return { ...state, pages: state.pages.map((p) => (p.id === id ? { ...p, rotate: rotation } : p)) };
}

export function cropPages(state: PdfState, ids: readonly string[], crop: NonNullable<Page["crop"]> | null): PdfState {
  const set = new Set(ids);
  return { ...state, pages: state.pages.map((p) => (set.has(p.id) ? { ...p, crop } : p)) };
}

export function setPageSkipped(state: PdfState, ids: readonly string[], skipped: boolean): PdfState {
  const set = new Set(ids);
  return { ...state, pages: state.pages.map((p) => (set.has(p.id) ? { ...p, skipped } : p)) };
}

export function reversePages(state: PdfState): PdfState {
  return { ...state, pages: state.pages.slice().reverse() };
}

/** Pages actually written on export (skipped ones are kept but not emitted). */
export function exportablePages(state: PdfState): Page[] {
  return state.pages.filter((p) => !p.skipped);
}

// ---------------------------------------------------------------------------
// Page labels
// ---------------------------------------------------------------------------

const ROMAN: [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

export function toRoman(n: number, upper = false): string {
  let v = Math.max(1, Math.floor(n));
  let out = "";
  for (const [val, sym] of ROMAN) {
    while (v >= val) {
      out += sym;
      v -= val;
    }
  }
  return upper ? out.toUpperCase() : out;
}

export function toAlpha(n: number, upper = false): string {
  // 1→a … 26→z, 27→aa (Acrobat's "A, B, … Z, AA" scheme).
  const i = Math.max(1, Math.floor(n)) - 1;
  const letter = String.fromCharCode(97 + (i % 26));
  const out = letter.repeat(Math.floor(i / 26) + 1);
  return upper ? out.toUpperCase() : out;
}

export type LabelStyle = "decimal" | "roman" | "ROMAN" | "alpha" | "ALPHA" | "none";

/** Apply a numbering style to a range of pages (Acrobat's "Number pages"). */
export function labelPages(
  state: PdfState,
  ids: readonly string[],
  style: LabelStyle,
  prefix: string,
  start: number,
): PdfState {
  const set = new Set(ids);
  let n = start;
  return {
    ...state,
    pages: state.pages.map((p) => {
      if (!set.has(p.id)) return p;
      const num = n++;
      const body =
        style === "decimal"
          ? String(num)
          : style === "roman"
            ? toRoman(num)
            : style === "ROMAN"
              ? toRoman(num, true)
              : style === "alpha"
                ? toAlpha(num)
                : style === "ALPHA"
                  ? toAlpha(num, true)
                  : "";
      const label = `${prefix}${body}`;
      return { ...p, label: label || undefined };
    }),
  };
}

/** Display label of a page: its custom label, else its 1-based position. */
export function pageLabel(state: PdfState, index: number): string {
  return state.pages[index]?.label || String(index + 1);
}

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

export function cloneAnnot(a: Annot): Annot {
  return {
    ...a,
    id: newId("an"),
    quads: a.quads?.map((q) => q.map((p) => ({ ...p })) as typeof q),
    paths: a.paths?.map((path) => path.map((p) => ({ ...p }))),
    callout: a.callout?.map((p) => ({ ...p })),
    dash: a.dash ? [...a.dash] : a.dash,
    replies: a.replies?.map((r) => ({ ...r, id: newId("rp") })),
  };
}

/** Recompute `rect` from whichever geometry is authoritative for the kind. */
export function syncRect(a: Annot): Annot {
  if (isTextMarkup(a.kind) && a.quads?.length) return { ...a, rect: rectOfQuads(a.quads) };
  if (a.kind === "ink" && a.paths?.length) {
    const pts = a.paths.flat();
    if (pts.length) {
      const r = rectOfPoints(pts);
      const pad = a.strokeWidth;
      return { ...a, rect: { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 } };
    }
  }
  if (isPolyKind(a.kind) && a.paths?.[0]?.length) return { ...a, rect: rectOfPoints(a.paths[0]) };
  return a;
}

export function addAnnot(state: PdfState, a: Annot): PdfState {
  return { ...state, annots: [...state.annots, syncRect(a)] };
}

export function updateAnnot(state: PdfState, id: string, patch: Partial<Annot>): PdfState {
  return {
    ...state,
    annots: state.annots.map((a) =>
      a.id === id ? syncRect({ ...a, ...patch, modifiedAt: patch.modifiedAt ?? a.modifiedAt }) : a,
    ),
  };
}

/** Update several annotations at once (multi-select property changes). */
export function updateAnnots(state: PdfState, ids: readonly string[], patch: Partial<Annot>): PdfState {
  const set = new Set(ids);
  return {
    ...state,
    annots: state.annots.map((a) => (set.has(a.id) && !a.locked ? syncRect({ ...a, ...patch }) : a)),
  };
}

export function removeAnnots(state: PdfState, ids: readonly string[]): PdfState {
  const set = new Set(ids);
  return { ...state, annots: state.annots.filter((a) => !set.has(a.id) || a.locked) };
}

export function moveAnnots(state: PdfState, ids: readonly string[], dx: number, dy: number): PdfState {
  const set = new Set(ids);
  return {
    ...state,
    annots: state.annots.map((a) => {
      if (!set.has(a.id) || a.locked) return a;
      return {
        ...a,
        rect: { ...a.rect, x: a.rect.x + dx, y: a.rect.y + dy },
        quads: a.quads?.map((q) => q.map((p) => ({ x: p.x + dx, y: p.y + dy })) as typeof q),
        paths: a.paths?.map((path) => path.map((p) => ({ x: p.x + dx, y: p.y + dy }))),
        callout: a.callout?.map((p) => ({ x: p.x + dx, y: p.y + dy })),
      };
    }),
  };
}

/** Resize an annotation to a new bounding box, scaling its inner geometry. */
export function resizeAnnot(state: PdfState, id: string, next: Rect): PdfState {
  return {
    ...state,
    annots: state.annots.map((a) => {
      if (a.id !== id || a.locked) return a;
      const sx = a.rect.w > 0.01 ? next.w / a.rect.w : 1;
      const sy = a.rect.h > 0.01 ? next.h / a.rect.h : 1;
      const map = (p: { x: number; y: number }) => ({
        x: next.x + (p.x - a.rect.x) * sx,
        y: next.y + (p.y - a.rect.y) * sy,
      });
      return {
        ...a,
        rect: next,
        quads: a.quads?.map((q) => q.map(map) as typeof q),
        paths: a.paths?.map((path) => path.map(map)),
        callout: a.callout?.map(map),
      };
    }),
  };
}

/** Send an annotation to the front/back of its page's z-order. */
export function reorderAnnot(state: PdfState, id: string, where: "front" | "back" | "forward" | "backward"): PdfState {
  const i = state.annots.findIndex((a) => a.id === id);
  if (i < 0) return state;
  const list = state.annots.slice();
  const [a] = list.splice(i, 1);
  const j =
    where === "front"
      ? list.length
      : where === "back"
        ? 0
        : where === "forward"
          ? Math.min(list.length, i + 1)
          : Math.max(0, i - 1);
  list.splice(j, 0, a);
  return { ...state, annots: list };
}

export function annotsOnPage(state: PdfState, pageId: string): Annot[] {
  return state.annots.filter((a) => a.pageId === pageId);
}

// --- comment threads --------------------------------------------------------

export function addReply(state: PdfState, annotId: string, reply: Omit<Reply, "id">): PdfState {
  return {
    ...state,
    annots: state.annots.map((a) =>
      a.id === annotId
        ? { ...a, replies: [...(a.replies ?? []), { ...reply, id: newId("rp") }], modifiedAt: reply.createdAt }
        : a,
    ),
  };
}

export function removeReply(state: PdfState, annotId: string, replyId: string): PdfState {
  return {
    ...state,
    annots: state.annots.map((a) =>
      a.id === annotId ? { ...a, replies: (a.replies ?? []).filter((r) => r.id !== replyId) } : a,
    ),
  };
}

export function setStatus(
  state: PdfState,
  ids: readonly string[],
  status: ReviewStatus,
  author: string,
  when: string,
): PdfState {
  const set = new Set(ids);
  return {
    ...state,
    annots: state.annots.map((a) => {
      if (!set.has(a.id)) return a;
      const label: Record<ReviewStatus, string> = {
        none: "a effacé le statut",
        accepted: "a accepté",
        rejected: "a rejeté",
        cancelled: "a annulé",
        completed: "a terminé",
      };
      return {
        ...a,
        status,
        modifiedAt: when,
        replies: [...(a.replies ?? []), { id: newId("rp"), author, text: label[status], createdAt: when, status }],
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Comment pane filtering / sorting
// ---------------------------------------------------------------------------

export interface CommentFilter {
  authors: string[] | null;
  kinds: AnnotKind[] | null;
  statuses: ReviewStatus[] | null;
  query: string;
}

export const EMPTY_FILTER: CommentFilter = { authors: null, kinds: null, statuses: null, query: "" };

export type CommentSort = "page" | "author" | "date" | "kind" | "status";

/** Annotations that carry a comment — the ones Acrobat lists in its pane. */
export function commentable(annots: readonly Annot[]): Annot[] {
  return annots.filter((a) => a.kind !== "link");
}

export function filterComments(
  annots: readonly Annot[],
  filter: CommentFilter,
  pageOrder: ReadonlyMap<string, number>,
  sort: CommentSort,
): Annot[] {
  const q = filter.query.trim().toLowerCase();
  const out = commentable(annots).filter((a) => {
    if (filter.authors && !filter.authors.includes(a.author)) return false;
    if (filter.kinds && !filter.kinds.includes(a.kind)) return false;
    if (filter.statuses && !filter.statuses.includes(a.status ?? "none")) return false;
    if (q) {
      const hay = `${a.contents ?? ""} ${a.text ?? ""} ${a.subject ?? ""} ${a.author} ${(a.replies ?? []).map((r) => r.text).join(" ")}`;
      if (!hay.toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const pageOf = (a: Annot) => pageOrder.get(a.pageId) ?? 1e9;
  out.sort((a, b) => {
    switch (sort) {
      case "author":
        return a.author.localeCompare(b.author) || pageOf(a) - pageOf(b);
      case "date":
        return b.createdAt.localeCompare(a.createdAt);
      case "kind":
        return a.kind.localeCompare(b.kind) || pageOf(a) - pageOf(b);
      case "status":
        return (a.status ?? "none").localeCompare(b.status ?? "none") || pageOf(a) - pageOf(b);
      default:
        return pageOf(a) - pageOf(b) || a.rect.y - b.rect.y || a.rect.x - b.rect.x;
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Content & image edits
// ---------------------------------------------------------------------------

export function upsertContentEdit(state: PdfState, edit: ContentEdit): PdfState {
  const i = state.contentEdits.findIndex((e) => e.pageId === edit.pageId && e.blockKey === edit.blockKey);
  const unchanged = !edit.deleted && edit.text === edit.original;
  if (i < 0) {
    return unchanged ? state : { ...state, contentEdits: [...state.contentEdits, edit] };
  }
  const next = state.contentEdits.slice();
  if (unchanged) next.splice(i, 1);
  else next[i] = { ...next[i], ...edit };
  return { ...state, contentEdits: next };
}

export function contentEditFor(state: PdfState, pageId: string, blockKey: string): ContentEdit | undefined {
  return state.contentEdits.find((e) => e.pageId === pageId && e.blockKey === blockKey);
}

export function upsertImageEdit(state: PdfState, edit: ImageEdit): PdfState {
  const i = state.imageEdits.findIndex((e) => e.pageId === edit.pageId && e.occurrence === edit.occurrence);
  const next = state.imageEdits.slice();
  if (i < 0) next.push(edit);
  else next[i] = { ...next[i], ...edit };
  return { ...state, imageEdits: next };
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------

export function setFormValue(state: PdfState, name: string, value: FormValue): PdfState {
  return { ...state, formValues: { ...state.formValues, [name]: value } };
}

export function resetForm(state: PdfState): PdfState {
  return { ...state, formValues: {} };
}

export function addField(state: PdfState, field: CreatedField): PdfState {
  return { ...state, createdFields: [...state.createdFields, field] };
}

export function updateField(state: PdfState, id: string, patch: Partial<CreatedField>): PdfState {
  return { ...state, createdFields: state.createdFields.map((f) => (f.id === id ? { ...f, ...patch } : f)) };
}

export function removeField(state: PdfState, id: string): PdfState {
  return { ...state, createdFields: state.createdFields.filter((f) => f.id !== id) };
}

/** A field name that does not collide with an existing one. */
export function uniqueFieldName(state: PdfState, base: string): string {
  const taken = new Set(state.createdFields.map((f) => f.name));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${newId("f").slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Bookmarks
// ---------------------------------------------------------------------------

export function flattenBookmarks(tree: readonly Bookmark[], depth = 0): { node: Bookmark; depth: number }[] {
  const out: { node: Bookmark; depth: number }[] = [];
  for (const b of tree) {
    out.push({ node: b, depth });
    if (!b.closed && b.children.length) out.push(...flattenBookmarks(b.children, depth + 1));
  }
  return out;
}

export function mapBookmarks(tree: readonly Bookmark[], fn: (b: Bookmark) => Bookmark): Bookmark[] {
  return tree.map((b) => {
    const mapped = fn(b);
    return { ...mapped, children: mapBookmarks(mapped.children, fn) };
  });
}

export function removeBookmark(tree: readonly Bookmark[], id: string): Bookmark[] {
  return tree.filter((b) => b.id !== id).map((b) => ({ ...b, children: removeBookmark(b.children, id) }));
}

export function insertBookmark(tree: readonly Bookmark[], parentId: string | null, node: Bookmark): Bookmark[] {
  if (parentId === null) return [...tree, node];
  return tree.map((b) =>
    b.id === parentId
      ? { ...b, closed: false, children: [...b.children, node] }
      : { ...b, children: insertBookmark(b.children, parentId, node) },
  );
}

/** Renumber bookmark targets after pages moved or were deleted. */
export function remapBookmarkPages(tree: readonly Bookmark[], remap: (page: number) => number | null): Bookmark[] {
  return tree.map((b) => {
    const p = remap(b.page);
    return { ...b, page: p ?? b.page, children: remapBookmarkPages(b.children, remap) };
  });
}
