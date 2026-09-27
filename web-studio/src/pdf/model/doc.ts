/**
 * Pure state transitions over `PdfState`.
 *
 * Every mutation the UI can perform lives here as a plain function so it can be
 * unit-tested without React, pdf.js or a DOM, and so the undo stack only ever
 * has to snapshot one object.
 */

import type { Rect, Rotation } from "../core/coords";
import { normRotation, rectOfPoints, rectOfQuads } from "../core/coords";
import type { OutlineNode } from "../core/engine";
import type {
  Annot,
  AnnotKind,
  Bookmark,
  ContentEdit,
  CreatedField,
  FieldEdit,
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
/**
 * Bookmarks that follow their pages once the pages changed (moved, deleted,
 * inserted, duplicated, reversed): each keeps its target page — one deleted
 * falls on the next page still there (the previous one at the end).
 */
export function followPages(prev: PdfState, next: PdfState): PdfState {
  if (!prev.bookmarks || prev.pages === next.pages) return next;
  const at = new Map(next.pages.map((p, i) => [p.id, i + 1]));
  const remap = (n: number): number | null => {
    for (let i = n - 1; i < prev.pages.length; i++) {
      const pos = at.get(prev.pages[i]?.id ?? "");
      if (pos) return pos;
    }
    for (let i = n - 2; i >= 0; i--) {
      const pos = at.get(prev.pages[i]?.id ?? "");
      if (pos) return pos;
    }
    return null;
  };
  return { ...next, bookmarks: remapBookmarkPages(prev.bookmarks, remap) };
}

export function reorderPages(state: PdfState, ids: readonly string[], to: number): PdfState {
  const ids_ = new Set(ids);
  const moving = state.pages.filter((p) => ids_.has(p.id));
  if (!moving.length) return state;
  const rest = state.pages.filter((p) => !ids_.has(p.id));
  // `to` counts positions in the original list; translate it to the gap it
  // designates once the moved pages are lifted out.
  const before = state.pages.slice(0, to).filter((p) => !ids_.has(p.id)).length;
  const next = [...rest.slice(0, before), ...moving, ...rest.slice(before)];
  return followPages(state, { ...state, pages: next });
}

export function movePageBy(state: PdfState, id: string, delta: number): PdfState {
  const i = pageIndexById(state, id);
  if (i < 0) return state;
  const j = Math.max(0, Math.min(state.pages.length - 1, i + delta));
  if (i === j) return state;
  const pages = state.pages.slice();
  const [p] = pages.splice(i, 1);
  pages.splice(j, 0, p);
  return followPages(state, { ...state, pages });
}

/** Delete pages (and their annotations). Never leaves the document empty. */
export function deletePages(state: PdfState, ids: readonly string[]): PdfState {
  const gone = new Set(ids);
  const keep = state.pages.filter((p) => !gone.has(p.id));
  if (!keep.length) return state;
  return followPages(state, {
    ...state,
    pages: keep,
    annots: state.annots.filter((a) => !gone.has(a.pageId)),
    contentEdits: state.contentEdits.filter((e) => !gone.has(e.pageId)),
    imageEdits: state.imageEdits.filter((e) => !gone.has(e.pageId)),
    createdFields: state.createdFields.filter((f) => !gone.has(f.pageId)),
  });
}

export function duplicatePages(state: PdfState, ids: readonly string[]): PdfState {
  const wanted = new Set(ids);
  const pages: Page[] = [];
  const annots = state.annots.slice();
  const contentEdits = state.contentEdits.slice();
  const imageEdits = state.imageEdits.slice();
  const createdFields = state.createdFields.slice();
  for (const p of state.pages) {
    pages.push(p);
    if (!wanted.has(p.id)) continue;
    const copy: Page = { ...p, id: newId("pg") };
    pages.push(copy);
    // Group links (a strike-out to its Caret) follow the copies.
    const copied = new Map<string, string>();
    for (const a of state.annots) {
      if (a.pageId !== p.id) continue;
      const c = { ...cloneAnnot(a), pageId: copy.id };
      copied.set(a.id, c.id);
      annots.push(c);
    }
    for (let i = annots.length - copied.size; i < annots.length; i++) {
      const g = annots[i].group;
      if (g && copied.has(g)) annots[i] = { ...annots[i], group: copied.get(g) };
    }
    for (const e of state.contentEdits) {
      if (e.pageId === p.id) contentEdits.push({ ...e, id: newId("ce"), pageId: copy.id });
    }
    for (const e of state.imageEdits) {
      if (e.pageId === p.id) imageEdits.push({ ...e, id: newId("im"), pageId: copy.id });
    }
    for (const f of state.createdFields) {
      if (f.pageId === p.id) createdFields.push({ ...f, id: newId("fd"), pageId: copy.id, name: `${f.name}_copie` });
    }
  }
  return followPages(state, { ...state, pages, annots, contentEdits, imageEdits, createdFields });
}

export function insertPages(state: PdfState, at: number, pages: readonly Page[]): PdfState {
  const next = state.pages.slice();
  next.splice(Math.max(0, Math.min(next.length, at)), 0, ...pages);
  return followPages(state, { ...state, pages: next });
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

/**
 * Crop pages. Page space starts at the crop's top-left corner, so what lies
 * on a cropped page — comments, text and picture edits, created fields — is
 * moved by the change of that corner: it stays on the same spot of the content.
 */
export function cropPages(state: PdfState, ids: readonly string[], crop: NonNullable<Page["crop"]> | null): PdfState {
  const set = new Set(ids);
  const shift = new Map<string, { dx: number; dy: number }>();
  for (const p of state.pages) {
    if (!set.has(p.id)) continue;
    const dx = (p.crop?.left ?? 0) - (crop?.left ?? 0);
    const dy = (p.crop?.top ?? 0) - (crop?.top ?? 0);
    if (dx || dy) shift.set(p.id, { dx, dy });
  }
  const move = (r: Rect, d: { dx: number; dy: number }): Rect => ({ ...r, x: r.x + d.dx, y: r.y + d.dy });
  const pt = <T extends { x: number; y: number }>(q: T, d: { dx: number; dy: number }): T => ({
    ...q,
    x: q.x + d.dx,
    y: q.y + d.dy,
  });
  const next: PdfState = { ...state, pages: state.pages.map((p) => (set.has(p.id) ? { ...p, crop } : p)) };
  if (!shift.size) return next;
  return {
    ...next,
    annots: state.annots.map((a) => {
      const d = shift.get(a.pageId);
      if (!d) return a;
      return {
        ...a,
        rect: move(a.rect, d),
        quads: a.quads?.map((q) => q.map((v) => pt(v, d)) as typeof q),
        paths: a.paths?.map((path) => path.map((v) => pt(v, d))),
        callout: a.callout?.map((v) => pt(v, d)),
      };
    }),
    contentEdits: state.contentEdits.map((e) => {
      const d = shift.get(e.pageId);
      return d ? { ...e, rect: move(e.rect, d), ...(e.placement ? { placement: move(e.placement, d) } : {}) } : e;
    }),
    imageEdits: state.imageEdits.map((e) => {
      const d = shift.get(e.pageId);
      return d && e.rect ? { ...e, rect: move(e.rect, d) } : e;
    }),
    createdFields: state.createdFields.map((f) => {
      const d = shift.get(f.pageId);
      return d ? { ...f, rect: move(f.rect, d) } : f;
    }),
  };
}

/** Margins as seen (a page turned by `rotation`) → the same margins on the unturned page, and back. */
export function visualToSourceInsets(
  v: { top: number; right: number; bottom: number; left: number },
  rotation: number,
): { top: number; right: number; bottom: number; left: number } {
  const r = ((rotation % 360) + 360) % 360;
  // The page turns clockwise: at 90°, what was its left edge is seen on top.
  if (r === 90) return { left: v.top, top: v.right, right: v.bottom, bottom: v.left };
  if (r === 180) return { top: v.bottom, right: v.left, bottom: v.top, left: v.right };
  if (r === 270) return { right: v.top, bottom: v.right, left: v.bottom, top: v.left };
  return { ...v };
}

export function sourceToVisualInsets(
  s: { top: number; right: number; bottom: number; left: number },
  rotation: number,
): { top: number; right: number; bottom: number; left: number } {
  const r = ((rotation % 360) + 360) % 360;
  if (r === 90) return { top: s.left, right: s.top, bottom: s.right, left: s.bottom };
  if (r === 180) return { top: s.bottom, right: s.left, bottom: s.top, left: s.right };
  if (r === 270) return { top: s.right, right: s.bottom, bottom: s.left, left: s.top };
  return { ...s };
}

export function setPageSkipped(state: PdfState, ids: readonly string[], skipped: boolean): PdfState {
  const set = new Set(ids);
  return { ...state, pages: state.pages.map((p) => (set.has(p.id) ? { ...p, skipped } : p)) };
}

export function reversePages(state: PdfState): PdfState {
  return followPages(state, { ...state, pages: state.pages.slice().reverse() });
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
      return { ...p, label: label || undefined, labelDef: { style, prefix, num } };
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
    // A copy is another annotation: not the original's /NM.
    pdf: a.pdf ? { ...a.pdf, nm: undefined } : a.pdf,
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

/**
 * A locked comment (Acrobat's « Verrouillé ») takes no change but its own
 * unlocking — which must stay possible, or an imported locked comment could
 * never be edited again.
 */
function lockAllows(a: Annot, patch: Partial<Annot>): boolean {
  return !a.locked || Object.keys(patch).every((k) => k === "locked" || k === "modifiedAt");
}

export function updateAnnot(state: PdfState, id: string, patch: Partial<Annot>): PdfState {
  return {
    ...state,
    annots: state.annots.map((a) =>
      a.id === id && lockAllows(a, patch)
        ? syncRect({ ...a, ...patch, modifiedAt: patch.modifiedAt ?? a.modifiedAt })
        : a,
    ),
  };
}

/** Update several annotations at once (multi-select property changes). */
export function updateAnnots(state: PdfState, ids: readonly string[], patch: Partial<Annot>): PdfState {
  const set = new Set(ids);
  return {
    ...state,
    annots: state.annots.map((a) => (set.has(a.id) && lockAllows(a, patch) ? syncRect({ ...a, ...patch }) : a)),
  };
}

export function removeAnnots(state: PdfState, ids: readonly string[]): PdfState {
  const wanted = new Set(ids);
  const set = new Set(state.annots.filter((a) => wanted.has(a.id) && !a.locked).map((a) => a.id));
  // A group goes as one (the strike-out of a « Remplacer le texte » with its Caret).
  return { ...state, annots: state.annots.filter((a) => !set.has(a.id) && !(a.group && set.has(a.group))) };
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

/** Acrobat's checkmark on comments (a private mark of the reviewer: not a review status). */
export function setChecked(state: PdfState, ids: readonly string[], checked: boolean): PdfState {
  const set = new Set(ids);
  return { ...state, annots: state.annots.map((a) => (set.has(a.id) ? { ...a, checked } : a)) };
}

export function updateReply(state: PdfState, annotId: string, replyId: string, text: string, when: string): PdfState {
  return {
    ...state,
    annots: state.annots.map((a) =>
      a.id === annotId
        ? { ...a, replies: (a.replies ?? []).map((r) => (r.id === replyId ? { ...r, text } : r)), modifiedAt: when }
        : a,
    ),
  };
}

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
  /** 1-based page numbers. */
  pages?: number[] | null;
  /** Acrobat's checkmark: only the checked, or only the unchecked. */
  checked?: "checked" | "unchecked" | null;
}

export const EMPTY_FILTER: CommentFilter = {
  authors: null,
  kinds: null,
  statuses: null,
  query: "",
  pages: null,
  checked: null,
};

export type CommentSort = "page" | "author" | "date" | "kind" | "status";

/** Annotations that carry a comment — the ones Acrobat lists in its pane (not links, not white-out). */
export function commentable(annots: readonly Annot[]): Annot[] {
  // A group member (the strike-out of a « Remplacer le texte ») is listed as its Caret.
  return annots.filter((a) => a.kind !== "link" && a.kind !== "whiteout" && !a.group);
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
    if (filter.pages && !filter.pages.includes(pageOrder.get(a.pageId) ?? -1)) return false;
    if (filter.checked === "checked" && !a.checked) return false;
    if (filter.checked === "unchecked" && a.checked) return false;
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
  // Added images are told apart by id; the page's own by their draw order.
  const i = state.imageEdits.findIndex((e) =>
    edit.occurrence < 0 ? e.id === edit.id : e.pageId === edit.pageId && e.occurrence === edit.occurrence,
  );
  const next = state.imageEdits.slice();
  if (i < 0) next.push(edit);
  else next[i] = { ...next[i], ...edit };
  return { ...state, imageEdits: next };
}

export function removeImageEdit(state: PdfState, id: string): PdfState {
  return { ...state, imageEdits: state.imageEdits.filter((e) => e.id !== id) };
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

/**
 * A field name that does not collide with an existing one — created fields,
 * the file's fields (`fileNames`) and the names given by renames.
 */
export function uniqueFieldName(state: PdfState, base: string, fileNames: Iterable<string> = []): string {
  const taken = new Set([...state.createdFields.map((f) => f.name), ...fileNames]);
  for (const e of state.fieldEdits ?? []) if (e.rename) taken.add(e.rename);
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

/** The bookmark `id`, found anywhere in the tree. */
export function findBookmark(tree: readonly Bookmark[], id: string): Bookmark | undefined {
  for (const b of tree) {
    if (b.id === id) return b;
    const hit = findBookmark(b.children, id);
    if (hit) return hit;
  }
  return undefined;
}

/**
 * Move bookmark `id` before or after `targetId`, or inside it (as its last
 * child). A bookmark never moves into its own branch.
 */
export function moveBookmark(
  tree: readonly Bookmark[],
  id: string,
  targetId: string,
  where: "before" | "after" | "inside",
): Bookmark[] {
  const node = findBookmark(tree, id);
  if (!node || id === targetId || findBookmark(node.children, targetId)) return tree as Bookmark[];
  const without = removeBookmark(tree, id);
  if (where === "inside") return insertBookmark(without, targetId, node);
  const place = (list: readonly Bookmark[]): Bookmark[] => {
    const i = list.findIndex((b) => b.id === targetId);
    if (i >= 0) {
      const out = list.slice();
      out.splice(where === "before" ? i : i + 1, 0, node);
      return out;
    }
    return list.map((b) => ({ ...b, children: place(b.children) }));
  };
  return place(without);
}

/** Every bookmark with children opened (`closed` false) or closed. */
export function setBookmarksClosed(tree: readonly Bookmark[], closed: boolean): Bookmark[] {
  return mapBookmarks(tree, (b) => (b.children.length ? { ...b, closed } : b));
}

/** Renumber bookmark targets after pages moved or were deleted. */
export function remapBookmarkPages(tree: readonly Bookmark[], remap: (page: number) => number | null): Bookmark[] {
  return tree.map((b) => {
    const p = remap(b.page);
    return { ...b, page: p ?? b.page, children: remapBookmarkPages(b.children, remap) };
  });
}

/**
 * Merge a change into the « Préparer un formulaire » edit of a file field
 * (widget positions and properties accumulate; `deleted` / `rename` replace).
 */
export function upsertFieldEdit(state: PdfState, name: string, patch: Omit<Partial<FieldEdit>, "name">): PdfState {
  const edits = state.fieldEdits ?? [];
  const prev = edits.find((e) => e.name === name);
  const next: FieldEdit = {
    ...(prev ?? { name }),
    ...patch,
    name,
    rects: patch.rects ? { ...(prev?.rects ?? {}), ...patch.rects } : prev?.rects,
    exportValues: patch.exportValues ? { ...(prev?.exportValues ?? {}), ...patch.exportValues } : prev?.exportValues,
    props: patch.props ? { ...(prev?.props ?? {}), ...patch.props } : prev?.props,
  };
  return { ...state, fieldEdits: prev ? edits.map((e) => (e === prev ? next : e)) : [...edits, next] };
}

/** The file's outline (as the engine reads it) as the model's bookmarks. */
export function outlineToBookmarks(nodes: readonly OutlineNode[]): Bookmark[] {
  return nodes.map((n) => {
    const action: Bookmark["action"] =
      n.page != null
        ? undefined
        : n.url
          ? { kind: "uri", url: n.url }
          : n.action
            ? { kind: "named", name: n.action }
            : { kind: "other", label: n.other ?? "Action non prise en charge" };
    return {
      id: newId("bm"),
      title: n.title,
      page: n.page ?? 1,
      y: n.y,
      x: n.x,
      fit: n.fit,
      zoom: n.zoom,
      bold: n.bold,
      italic: n.italic,
      color: n.color,
      closed: n.closed,
      action,
      src: n.path,
      children: outlineToBookmarks(n.children),
    };
  });
}

/** The same tree, each item now the file's item at its own position (after a recomposition wrote it). */
export function rebaseBookmarks(tree: readonly Bookmark[], prefix = ""): Bookmark[] {
  return tree.map((b, i) => {
    const path = prefix ? `${prefix}.${i}` : String(i);
    const { retargeted: _gone, ...rest } = b;
    return { ...rest, src: path, children: rebaseBookmarks(b.children, path) };
  });
}
