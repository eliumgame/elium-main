/**
 * The PDF module's preferences kept in this browser (Acrobat's Preferences
 * → Identity, and the properties each commenting tool remembers).
 * Private to the viewer; absent or unreadable storage simply means defaults.
 */

import type { AnnotKind, DraftStyle } from "../model/types";

const KEY = "elium.pdf.prefs";

export interface PdfPrefs {
  /** Name written as the author of new comments. */
  author?: string;
  /** Each tool's own properties (colour, width, font…), as last set. */
  toolStyles?: Partial<Record<AnnotKind, Partial<DraftStyle>>>;
}

/** Properties a tool remembers: its look, never the stamp being placed. */
const STYLE_KEYS: (keyof DraftStyle)[] = [
  "color",
  "fill",
  "opacity",
  "strokeWidth",
  "borderStyle",
  "fontSize",
  "fontFamily",
  "bold",
  "italic",
  "underline",
  "align",
  "lineStart",
  "lineEnd",
  "textBg",
];

export function styleSubset(patch: Partial<DraftStyle>): Partial<DraftStyle> {
  const out: Partial<DraftStyle> = {};
  for (const k of STYLE_KEYS) if (k in patch) (out as Record<string, unknown>)[k] = patch[k];
  return out;
}

export function loadPdfPrefs(): PdfPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as PdfPrefs) : {};
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function savePdfPrefs(patch: Partial<PdfPrefs>): PdfPrefs {
  const next = { ...loadPdfPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage blocked or full: the preference lasts this session only */
  }
  return next;
}

/** Remember `patch` as part of `kind`'s properties. */
export function rememberToolStyle(kind: AnnotKind, patch: Partial<DraftStyle>): void {
  const subset = styleSubset(patch);
  if (!Object.keys(subset).length) return;
  const prefs = loadPdfPrefs();
  savePdfPrefs({ toolStyles: { ...prefs.toolStyles, [kind]: { ...prefs.toolStyles?.[kind], ...subset } } });
}

export function toolStyle(kind: AnnotKind): Partial<DraftStyle> {
  return loadPdfPrefs().toolStyles?.[kind] ?? {};
}
