/**
 * Pure browser logic for the Drive: sorting, filtering, selection ranges and
 * the small formatting helpers the file list needs.
 *
 * Kept free of React and of the API client so the rules that are easy to get
 * subtly wrong — folders always first, shift-click ranges, "is this a legal
 * drop target" — can be unit-tested directly.
 */

import type { DriveEntry } from "./ops";

export type SortKey = "name" | "size" | "modified" | "kind";
export type SortDir = "asc" | "desc";
export type ViewMode = "list" | "grid";

export interface BrowserFilter {
  /** Free-text match on the decrypted name. */
  query: string;
  /** Restrict to one family of documents; null = everything. */
  kind: FilterKind | null;
}

export type FilterKind = "folder" | "document" | "spreadsheet" | "presentation" | "pdf" | "image" | "other";

export const EMPTY_FILTER: BrowserFilter = { query: "", kind: null };

export const FILTER_LABELS: { id: FilterKind; label: string }[] = [
  { id: "folder", label: "Dossiers" },
  { id: "document", label: "Documents" },
  { id: "spreadsheet", label: "Tableurs" },
  { id: "presentation", label: "Présentations" },
  { id: "pdf", label: "PDF" },
  { id: "image", label: "Images" },
  { id: "other", label: "Autres" },
];

/** Which filter family an entry belongs to. */
export function familyOf(entry: DriveEntry): FilterKind {
  if (entry.kind === "folder") return "folder";
  switch (entry.appKind) {
    case "doc":
    case "collab-doc":
      return "document";
    case "sheet":
    case "collab-sheet":
      return "spreadsheet";
    case "slides":
    case "collab-slides":
      return "presentation";
    case "pdf":
      return "pdf";
    case "image":
      return "image";
    default:
      return "other";
  }
}

/** True when the entry is a live co-edited document rather than a stored file. */
export function isCollab(entry: DriveEntry): boolean {
  return String(entry.appKind ?? "").startsWith("collab-");
}

/**
 * Accent- and case-insensitive contains, so searching "resume" finds "Résumé".
 */
export function matchesQuery(name: string, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return fold(name).includes(fold(q));
}

export function filterEntries(entries: readonly DriveEntry[], filter: BrowserFilter): DriveEntry[] {
  return entries.filter((e) => {
    if (filter.kind && familyOf(e) !== filter.kind) return false;
    return matchesQuery(e.name, filter.query);
  });
}

/**
 * Sort for display. Folders always come before files whatever the key — that is
 * what every file manager does and what users expect when they scan a list.
 */
export function sortEntries(entries: readonly DriveEntry[], key: SortKey, dir: SortDir): DriveEntry[] {
  const sign = dir === "asc" ? 1 : -1;
  const collator = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });
  return entries.slice().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    switch (key) {
      case "size": {
        const d = (a.kind === "folder" ? -1 : a.sizeBytes) - (b.kind === "folder" ? -1 : b.sizeBytes);
        return (d || collator.compare(a.name, b.name)) * sign;
      }
      case "modified": {
        const d = Date.parse(a.modifiedAt) - Date.parse(b.modifiedAt);
        return (d || collator.compare(a.name, b.name)) * sign;
      }
      case "kind": {
        const d = familyOf(a).localeCompare(familyOf(b));
        return (d || collator.compare(a.name, b.name)) * sign;
      }
      default:
        return collator.compare(a.name, b.name) * sign;
    }
  });
}

/** Filter then sort — the order the list is actually built in. */
export function visibleEntries(
  entries: readonly DriveEntry[],
  filter: BrowserFilter,
  key: SortKey,
  dir: SortDir,
): DriveEntry[] {
  return sortEntries(filterEntries(entries, filter), key, dir);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * Resolve a click into the next selection, honouring the usual modifiers:
 * plain click replaces, Ctrl/Cmd toggles, Shift extends from the anchor.
 */
export function nextSelection(
  ids: readonly string[],
  current: readonly string[],
  anchor: string | null,
  clicked: string,
  mods: { ctrl?: boolean; shift?: boolean },
): { selection: string[]; anchor: string } {
  if (mods.shift && anchor && ids.includes(anchor)) {
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(clicked);
    if (a >= 0 && b >= 0) {
      const [from, to] = a < b ? [a, b] : [b, a];
      return { selection: ids.slice(from, to + 1), anchor };
    }
  }
  if (mods.ctrl) {
    const has = current.includes(clicked);
    return {
      selection: has ? current.filter((id) => id !== clicked) : [...current, clicked],
      anchor: clicked,
    };
  }
  return { selection: [clicked], anchor: clicked };
}

/** Drop the ids that are no longer present (after a reload or a move). */
export function pruneSelection(selection: readonly string[], entries: readonly DriveEntry[]): string[] {
  const live = new Set(entries.map((e) => e.id));
  return selection.filter((id) => live.has(id));
}

// ---------------------------------------------------------------------------
// Moving
// ---------------------------------------------------------------------------

/**
 * Can `dragged` be dropped into `target`?
 * A folder cannot go into itself, and nothing can be dropped into the folder
 * it already sits in (that would be a no-op round trip to the server).
 */
export function canDropInto(
  dragged: readonly DriveEntry[],
  target: DriveEntry | null,
  currentParentId: string | null,
): boolean {
  if (!dragged.length) return false;
  const targetId = target ? target.id : null;
  if (target && target.kind !== "folder") return false;
  if (targetId === currentParentId) return false;
  return !dragged.some((e) => e.id === targetId);
}

/** Ids that should actually be sent to the server for a move. */
export function movePayload(
  dragged: readonly DriveEntry[],
  targetId: string | null,
): { id: string; parentId: string | null }[] {
  return dragged
    .filter((e) => e.parentId !== targetId && e.id !== targetId)
    .map((e) => ({ id: e.id, parentId: targetId }));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function humanSize(n: number | null | undefined): string {
  if (!n || n <= 0) return "—";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 1 : 0)} ${units[i]}`;
}

/** Relative date for recent changes, absolute beyond a week. */
export function humanDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = now.getTime() - d.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "à l'instant";
  if (diff < hour) return `il y a ${Math.floor(diff / minute)} min`;
  if (diff < day) return `il y a ${Math.floor(diff / hour)} h`;
  if (diff < 7 * day) {
    const days = Math.floor(diff / day);
    return days <= 1 ? "hier" : `il y a ${days} j`;
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(
    "fr-FR",
    sameYear ? { day: "2-digit", month: "short" } : { day: "2-digit", month: "short", year: "numeric" },
  );
}

/** Storage gauge state. `quota` null = unlimited. */
export function quotaState(
  used: number,
  quota: number | null,
): { ratio: number; label: string; tone: "ok" | "warn" | "full" } {
  if (quota === null || quota <= 0) {
    return { ratio: 0, label: `${humanSize(used)} utilisés`, tone: "ok" };
  }
  const ratio = Math.max(0, Math.min(1, used / quota));
  return {
    ratio,
    label: `${humanSize(used)} sur ${humanSize(quota)}`,
    tone: ratio >= 0.95 ? "full" : ratio >= 0.8 ? "warn" : "ok",
  };
}

/** Summary line for a multi-selection, e.g. "3 éléments · 1,2 Mo". */
export function selectionSummary(entries: readonly DriveEntry[]): string {
  if (!entries.length) return "";
  const files = entries.filter((e) => e.kind === "file");
  const folders = entries.length - files.length;
  const bytes = files.reduce((n, e) => n + (e.sizeBytes || 0), 0);
  const parts: string[] = [];
  if (folders) parts.push(`${folders} dossier${folders > 1 ? "s" : ""}`);
  if (files.length) parts.push(`${files.length} fichier${files.length > 1 ? "s" : ""}`);
  if (bytes) parts.push(humanSize(bytes));
  return parts.join(" · ");
}
