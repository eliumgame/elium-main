/** View-level state shared across the PDF workspace components. */

import type { Rotation } from "../core/coords";
import type { AnnotKind, DraftStyle, Tool } from "../model/types";

export type ViewMode = "single" | "continuous" | "facing" | "facingContinuous";
export type ZoomMode = "custom" | "fitWidth" | "fitPage" | "fitVisible";
export type ReadingTheme = "paper" | "sepia" | "grey" | "night" | "invert";
export type RibbonTab = "home" | "comment" | "edit" | "organise" | "forms" | "protect" | "convert" | "view";
export type SidePanel =
  "thumbnails" | "bookmarks" | "destinations" | "comments" | "search" | "attachments" | "layers" | "fields";

export interface ViewState {
  scale: number;
  zoomMode: ZoomMode;
  mode: ViewMode;
  /** Extra rotation applied to the whole view, not saved to the document. */
  viewRotation: Rotation;
  theme: ReadingTheme;
  /** 1-based page currently under the viewport centre. */
  current: number;
  spreadCover: boolean;
  scrollWrapped: boolean;
  showGrid: boolean;
  showRulers: boolean;
  fullscreen: boolean;
}

export const DEFAULT_VIEW: ViewState = {
  scale: 1,
  zoomMode: "fitWidth",
  mode: "continuous",
  viewRotation: 0,
  theme: "paper",
  current: 1,
  spreadCover: true,
  scrollWrapped: false,
  showGrid: false,
  showRulers: false,
  fullscreen: false,
};

/**
 * Zoom as the user reads it is Acrobat's and Firefox's: 100 % is the page at
 * its real size on a 96 dpi screen (one point = 96/72 CSS px) — an A4 page is
 * 794 px wide at 100 %. Internally a scale is in CSS px per point (what every
 * layer's coordinates use); this is the factor between the two
 * (pdf.js `PixelsPerInch.PDF_TO_CSS_UNITS`).
 */
export const ZOOM_UNIT = 96 / 72;
/** Displayed zoom levels: 1 = 100 % = real size. */
export const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const;
/** Internal scale of a displayed zoom level. */
export const presetScale = (zoom: number): number => zoom * ZOOM_UNIT;
/** Displayed percentage of an internal scale. */
export const zoomPercent = (scale: number): number => Math.round((scale / ZOOM_UNIT) * 100);
export const MIN_SCALE = 0.08;
/** 1000 %, pdf.js' maximum (the detail canvas keeps it sharp). */
export const MAX_SCALE = 10 * ZOOM_UNIT;

export const READING_THEMES: { id: ReadingTheme; label: string; filter: string; canvas: string }[] = [
  { id: "paper", label: "Papier", filter: "none", canvas: "#ffffff" },
  { id: "sepia", label: "Sépia", filter: "sepia(0.34) saturate(1.05) brightness(0.99)", canvas: "#fbf3e4" },
  { id: "grey", label: "Gris doux", filter: "grayscale(0.15) brightness(0.96)", canvas: "#f1f2f4" },
  {
    id: "night",
    label: "Nuit",
    filter: "invert(0.9) hue-rotate(180deg) brightness(1.05) contrast(0.92)",
    canvas: "#12161d",
  },
  { id: "invert", label: "Contraste inversé", filter: "invert(1)", canvas: "#000000" },
];

/** Which ribbon tab a tool belongs to, so picking a tool reveals its options. */
export const TOOL_TAB: Partial<Record<Tool, RibbonTab>> = {
  highlight: "comment",
  underline: "comment",
  strikeout: "comment",
  squiggly: "comment",
  note: "comment",
  freetext: "comment",
  callout: "comment",
  ink: "comment",
  square: "comment",
  circle: "comment",
  line: "comment",
  arrow: "comment",
  polygon: "comment",
  polyline: "comment",
  cloud: "comment",
  stamp: "comment",
  eraser: "comment",
  typewriter: "edit",
  image: "edit",
  link: "edit",
  whiteout: "edit",
  redact: "protect",
  distance: "view",
  perimeter: "view",
  area: "view",
  signature: "home",
};

export interface Selection {
  ids: string[];
  /** The annotation being text-edited inline, if any. */
  editing: string | null;
}

export const EMPTY_SELECTION: Selection = { ids: [], editing: null };

/** Everything the toolbar needs to describe the pen currently in hand. */
export interface ToolState {
  tool: Tool;
  style: DraftStyle;
  /** Sticky tool: stay armed after one use instead of snapping back to select. */
  sticky: boolean;
}

export interface SearchState {
  open: boolean;
  panel: boolean;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  ignoreDiacritics: boolean;
  highlightAll: boolean;
  index: number;
}

export const DEFAULT_SEARCH: SearchState = {
  open: false,
  panel: false,
  query: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ignoreDiacritics: true,
  highlightAll: true,
  index: -1,
};

/** A transient message shown in the status bar / toast area. */
export interface Toast {
  id: number;
  tone: "info" | "success" | "warning" | "danger" | "progress";
  text: string;
  /** 0..1 when `tone` is "progress". */
  ratio?: number;
  detail?: string;
}

/** Human labels for every annotation kind, used across the UI. */
export const KIND_LABEL: Record<AnnotKind, string> = {
  highlight: "Surlignage",
  underline: "Soulignement",
  strikeout: "Texte barré",
  squiggly: "Soulignement ondulé",
  caret: "Insertion de texte",
  note: "Note",
  attachment: "Pièce jointe",
  freetext: "Zone de texte",
  callout: "Légende",
  typewriter: "Machine à écrire",
  ink: "Dessin",
  square: "Rectangle",
  circle: "Ellipse",
  line: "Trait",
  arrow: "Flèche",
  polygon: "Polygone",
  polyline: "Ligne brisée",
  cloud: "Nuage",
  stamp: "Tampon",
  image: "Image",
  signature: "Signature",
  whiteout: "Masque blanc",
  redact: "Caviardage",
  link: "Lien",
  distance: "Distance",
  perimeter: "Périmètre",
  area: "Surface",
};

/** Format a timestamp the way the comment pane shows it. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const p = (n: number) => String(n).padStart(2, "0");
  if (sameDay) return `${p(d.getHours())}:${p(d.getMinutes())}`;
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
    : `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}
