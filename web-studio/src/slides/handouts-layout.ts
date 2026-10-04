/**
 * Documents (handouts) et pages de notes : mise en page PURE des miniatures de diapositives sur une
 * feuille A4 (1, 2, 3, 4, 6 ou 9 par page, avec lignes de notes pour 3 par page) et des pages de notes
 * (diapositive en haut, notes du présentateur dessous). Unités : pixels CSS (96 dpi).
 */
import type { Slide } from "./model";

export type HandoutPerPage = 1 | 2 | 3 | 4 | 6 | 9;
export type HandoutMode = HandoutPerPage | "notes";

export interface HandoutOptions {
  mode: HandoutMode;
  includeHidden: boolean;
  orientation?: "portrait" | "landscape";
  /** Texte d'en-tête / pied (jetons {titre}, {date}, {page}, {pages}). */
  header?: string;
  footer?: string;
  /** Cadre fin autour de chaque diapositive. */
  frame: boolean;
}

export const DEFAULT_HANDOUT: HandoutOptions = { mode: 4, includeHidden: false, frame: true };

export const A4_PX = { w: 794, h: 1123 };
const MARGIN = 48;
const HEADROOM = 34; // espace réservé à l'en-tête / au pied

export interface Slot {
  /** Position et taille de la diapositive. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Zone de notes / lignes à droite ou dessous (absente pour les mosaïques). */
  note?: { x: number; y: number; w: number; h: number };
}

export interface PageSize {
  w: number;
  h: number;
}
export const pageSize = (o: Pick<HandoutOptions, "orientation" | "mode">): PageSize => {
  const landscape = o.orientation === "landscape" && o.mode !== "notes";
  return landscape ? { w: A4_PX.h, h: A4_PX.w } : { ...A4_PX };
};

const RATIO = 16 / 9;

/** Emplacements des diapositives sur UNE page, pour le mode donné. */
export function slotsFor(mode: HandoutMode, size: PageSize = A4_PX): Slot[] {
  const left = MARGIN;
  const top = MARGIN + HEADROOM;
  const usableW = size.w - 2 * MARGIN;
  const usableH = size.h - 2 * MARGIN - 2 * HEADROOM;
  const gap = 22;

  if (mode === "notes") {
    const w = Math.min(usableW, 560);
    const h = w / RATIO;
    return [
      {
        x: left + (usableW - w) / 2,
        y: top,
        w,
        h,
        note: { x: left, y: top + h + 28, w: usableW, h: usableH - h - 28 },
      },
    ];
  }
  if (mode === 1) {
    const w = Math.min(usableW, usableH * RATIO);
    const h = w / RATIO;
    return [{ x: left + (usableW - w) / 2, y: top + (usableH - h) / 2, w, h }];
  }
  if (mode === 2) {
    const w = Math.min(usableW * 0.82, ((usableH - gap) / 2) * RATIO);
    const h = w / RATIO;
    const total = 2 * h + gap;
    const y0 = top + (usableH - total) / 2;
    return [0, 1].map((i) => ({ x: left + (usableW - w) / 2, y: y0 + i * (h + gap), w, h }));
  }
  if (mode === 3) {
    // Diapositives empilées à gauche, lignes de notes à droite (comme Word).
    const w = Math.min(usableW * 0.52, ((usableH - 2 * gap) / 3) * RATIO);
    const h = w / RATIO;
    const total = 3 * h + 2 * gap;
    const y0 = top + (usableH - total) / 2;
    return [0, 1, 2].map((i) => ({
      x: left,
      y: y0 + i * (h + gap),
      w,
      h,
      note: { x: left + w + 28, y: y0 + i * (h + gap), w: usableW - w - 28, h },
    }));
  }
  const cols = mode === 9 ? 3 : 2;
  const rows = mode === 4 ? 2 : mode === 6 ? 3 : 3;
  const cellW = (usableW - (cols - 1) * gap) / cols;
  const cellH = (usableH - (rows - 1) * gap) / rows;
  const w = Math.min(cellW, cellH * RATIO);
  const h = w / RATIO;
  const gx = (usableW - cols * w) / (cols + 1);
  const gy = (usableH - rows * h) / (rows + 1);
  const out: Slot[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) out.push({ x: left + gx + c * (w + gx), y: top + gy + r * (h + gy), w, h });
  return out;
}

export const perPageOf = (mode: HandoutMode): number => (mode === "notes" ? 1 : mode);

export interface HandoutPage {
  /** Indices (dans le jeu de diapositives retenu) de ce qui figure sur la page. */
  slideIndexes: number[];
}

/** Diapositives retenues (masquées exclues sauf demande) et leur répartition en pages. */
export function planHandouts(slides: Slide[], o: HandoutOptions): { keep: number[]; pages: HandoutPage[] } {
  const keep = slides.map((_, i) => i).filter((i) => o.includeHidden || !slides[i]!.hidden);
  const per = perPageOf(o.mode);
  const pages: HandoutPage[] = [];
  for (let i = 0; i < keep.length; i += per) pages.push({ slideIndexes: keep.slice(i, i + per) });
  return { keep, pages };
}

/** Remplace {titre}, {date}, {page}, {pages}. */
export function expandTokens(
  tpl: string | undefined,
  ctx: { title: string; page: number; pages: number; date?: Date },
): string {
  if (!tpl) return "";
  return tpl
    .replace(/\{titre\}/gi, ctx.title)
    .replace(/\{date\}/gi, (ctx.date ?? new Date()).toLocaleDateString("fr-FR"))
    .replace(/\{pages\}/gi, String(ctx.pages))
    .replace(/\{page\}/gi, String(ctx.page));
}

/** Texte brut des notes (une ligne par paragraphe) pour la page de notes. */
export function notesLines(slide: Slide): string[] {
  return (slide.notes ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}
