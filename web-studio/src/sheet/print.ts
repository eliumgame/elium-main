/**
 * Mise en page d'impression du Tableur (calcul PUR) : papier, orientation,
 * marges, échelle / ajustement à la largeur, zone d'impression, lignes/colonnes
 * à répéter, sauts de page manuels, et découpage en pages. Sert à l'aperçu des
 * sauts de page dans la grille, à l'export PDF et à l'export XLSX.
 */
import { DEFAULT_COL_W, ROW_H, type SheetData } from "./model";

export type PaperName = "A4" | "A3" | "A5" | "Letter" | "Legal";
export const PAPER_MM: Record<PaperName, { w: number; h: number }> = {
  A4: { w: 210, h: 297 },
  A3: { w: 297, h: 420 },
  A5: { w: 148, h: 210 },
  Letter: { w: 215.9, h: 279.4 },
  Legal: { w: 215.9, h: 355.6 },
};
/** Codes `paperSize` d'Excel (ECMA-376 §18.18.50). */
export const PAPER_XLSX: Record<PaperName, number> = { Letter: 1, Legal: 5, A3: 8, A4: 9, A5: 11 };

export interface PrintRect {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}
export interface PrintSetup {
  orientation: "portrait" | "landscape";
  paper: PaperName;
  /** Marges en millimètres. */
  margins: { top: number; right: number; bottom: number; left: number };
  /** Échelle en % (10-400) ; ignorée si `fitWidth`. */
  scale: number;
  /** Réduit pour tenir sur une page en largeur (jamais d'agrandissement). */
  fitWidth: boolean;
  /** Zone d'impression ; absente = plage utilisée de la feuille. */
  area?: PrintRect;
  /** Lignes répétées en haut de chaque page (indices 0-based, inclus). */
  repeatRows?: { r0: number; r1: number };
  /** Colonnes répétées à gauche de chaque page. */
  repeatCols?: { c0: number; c1: number };
  /** Saut de page APRÈS ces lignes / colonnes (0-based). */
  rowBreaks?: number[];
  colBreaks?: number[];
  gridlines: boolean;
  /** Numéros de ligne / lettres de colonne imprimés. */
  headings: boolean;
  header?: string;
  footer?: string;
  /** Ordre des pages : « down » = de haut en bas puis à droite (défaut Excel). */
  order: "down" | "over";
}

export const DEFAULT_PRINT: PrintSetup = {
  orientation: "portrait",
  paper: "A4",
  margins: { top: 15, right: 12, bottom: 15, left: 12 },
  scale: 100,
  fitWidth: false,
  gridlines: false,
  headings: false,
  order: "down",
};

const MM_PX = 96 / 25.4;
const clamp = (v: unknown, a: number, b: number, d: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(b, Math.max(a, n)) : d;
};

/** Valide et complète une configuration quelconque (document ancien, import…). */
export function normalizePrint(p: Partial<PrintSetup> | undefined | null): PrintSetup {
  const s = p ?? {};
  const paper = (Object.keys(PAPER_MM) as PaperName[]).includes(s.paper as PaperName) ? (s.paper as PaperName) : "A4";
  const m = s.margins ?? DEFAULT_PRINT.margins;
  const ints = (a?: number[]) => (a ?? []).filter((n) => Number.isInteger(n) && n >= 0).sort((x, y) => x - y);
  return {
    orientation: s.orientation === "landscape" ? "landscape" : "portrait",
    paper,
    margins: {
      top: clamp(m.top, 0, 60, 15),
      right: clamp(m.right, 0, 60, 12),
      bottom: clamp(m.bottom, 0, 60, 15),
      left: clamp(m.left, 0, 60, 12),
    },
    scale: Math.round(clamp(s.scale, 10, 400, 100)),
    fitWidth: !!s.fitWidth,
    ...(s.area ? { area: s.area } : {}),
    ...(s.repeatRows && s.repeatRows.r1 >= s.repeatRows.r0 ? { repeatRows: s.repeatRows } : {}),
    ...(s.repeatCols && s.repeatCols.c1 >= s.repeatCols.c0 ? { repeatCols: s.repeatCols } : {}),
    ...(ints(s.rowBreaks).length ? { rowBreaks: [...new Set(ints(s.rowBreaks))] } : {}),
    ...(ints(s.colBreaks).length ? { colBreaks: [...new Set(ints(s.colBreaks))] } : {}),
    gridlines: !!s.gridlines,
    headings: !!s.headings,
    ...(s.header ? { header: s.header } : {}),
    ...(s.footer ? { footer: s.footer } : {}),
    order: s.order === "over" ? "over" : "down",
  };
}

/** Plage utilisée (cellules et styles), ou une cellule A1 si la feuille est vide. */
export function usedArea(sheet: SheetData): PrintRect {
  let c1 = 0;
  let r1 = 0;
  const grow = (ref: string) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!m) return;
    let c = 0;
    for (const ch of m[1]!) c = c * 26 + (ch.charCodeAt(0) - 64);
    c1 = Math.max(c1, c - 1);
    r1 = Math.max(r1, Number(m[2]) - 1);
  };
  for (const [ref, v] of Object.entries(sheet.cells)) if (v !== "") grow(ref);
  for (const m of sheet.merges ?? []) {
    c1 = Math.max(c1, m.c1);
    r1 = Math.max(r1, m.r1);
  }
  return { c0: 0, r0: 0, c1, r1 };
}

export interface PrintPage {
  rows: number[];
  cols: number[];
  /** Numéro 1-based dans l'ordre d'impression. */
  index: number;
}
export interface PrintPlan {
  pages: PrintPage[];
  /** Échelle effective (1 = 100 %). */
  scale: number;
  /** Zone imprimable d'une page en px CSS (avant échelle). */
  usable: { w: number; h: number };
  area: PrintRect;
  /** Lignes / colonnes après lesquelles tombe un saut (automatique ou manuel), pour l'aperçu. */
  rowBreakAfter: Set<number>;
  colBreakAfter: Set<number>;
}

export function pageSizePx(setup: PrintSetup): { w: number; h: number } {
  const p = PAPER_MM[setup.paper];
  const landscape = setup.orientation === "landscape";
  return { w: (landscape ? p.h : p.w) * MM_PX, h: (landscape ? p.w : p.h) * MM_PX };
}

/** Découpe un axe : liste d'indices en blocs selon la taille disponible et les sauts manuels. */
function chunk(
  indices: number[],
  size: (i: number) => number,
  avail: number,
  breaks: Set<number>,
  repeatSize: number,
  repeat: number[],
): number[][] {
  const out: number[][] = [];
  let cur: number[] = [];
  let used = 0;
  const limit = (first: boolean) => avail - (first ? 0 : repeatSize);
  for (const i of indices) {
    const s = size(i);
    const first = out.length === 0;
    if (cur.length && used + s > limit(first)) {
      out.push(cur);
      cur = [];
      used = 0;
    }
    cur.push(i);
    used += s;
    if (breaks.has(i)) {
      out.push(cur);
      cur = [];
      used = 0;
    }
  }
  if (cur.length) out.push(cur);
  // Les blocs suivants reçoivent les lignes/colonnes répétées (sans doublon si elles y figurent déjà).
  return out.map((b, k) => (k === 0 ? b : [...repeat.filter((r) => !b.includes(r)), ...b]));
}

export function paginate(
  sheet: SheetData,
  setupIn: Partial<PrintSetup> | undefined,
  opts: { hidden?: (r: number) => boolean } = {},
): PrintPlan {
  const setup = normalizePrint(setupIn);
  const area = setup.area ?? usedArea(sheet);
  const page = pageSizePx(setup);
  const usable = {
    w: Math.max(40, page.w - (setup.margins.left + setup.margins.right) * MM_PX),
    h: Math.max(40, page.h - (setup.margins.top + setup.margins.bottom) * MM_PX),
  };
  const colW = (c: number) => sheet.colWidths?.[c] ?? DEFAULT_COL_W;
  const rowH = (r: number) => sheet.rowHeights?.[r] ?? ROW_H;
  const rows: number[] = [];
  for (let r = area.r0; r <= area.r1; r++) if (!opts.hidden?.(r)) rows.push(r);
  const cols: number[] = [];
  for (let c = area.c0; c <= area.c1; c++) cols.push(c);

  let scale = setup.scale / 100;
  if (setup.fitWidth) {
    const total = cols.reduce((a, c) => a + colW(c), 0) || 1;
    scale = Math.min(1, usable.w / total);
  }
  const availW = usable.w / scale;
  const availH = usable.h / scale;

  const rr = setup.repeatRows;
  const rc = setup.repeatCols;
  const repRows = rr ? rows.filter((r) => r >= rr.r0 && r <= rr.r1) : [];
  const repCols = rc ? cols.filter((c) => c >= rc.c0 && c <= rc.c1) : [];
  const rowBlocks = chunk(
    rows,
    rowH,
    availH,
    new Set(setup.rowBreaks ?? []),
    repRows.reduce((a, r) => a + rowH(r), 0),
    repRows,
  );
  const colBlocks = chunk(
    cols,
    colW,
    availW,
    new Set(setup.colBreaks ?? []),
    repCols.reduce((a, c) => a + colW(c), 0),
    repCols,
  );

  const pages: PrintPage[] = [];
  const push = (rb: number[], cb: number[]) => pages.push({ rows: rb, cols: cb, index: pages.length + 1 });
  if (setup.order === "over") for (const rb of rowBlocks) for (const cb of colBlocks) push(rb, cb);
  else for (const cb of colBlocks) for (const rb of rowBlocks) push(rb, cb);

  const lastOf = (blocks: number[][]) => new Set(blocks.slice(0, -1).map((b) => b[b.length - 1]!));
  return { pages, scale, usable, area, rowBreakAfter: lastOf(rowBlocks), colBreakAfter: lastOf(colBlocks) };
}

/** En-tête / pied de page : substitue {page}, {pages}, {feuille}, {date}. */
export function expandHeaderFooter(
  text: string | undefined,
  ctx: { page: number; pages: number; sheet: string; date?: Date },
): string {
  if (!text) return "";
  const d = ctx.date ?? new Date();
  return text
    .replace(/\{page\}/gi, String(ctx.page))
    .replace(/\{pages\}/gi, String(ctx.pages))
    .replace(/\{feuille\}/gi, ctx.sheet)
    .replace(/\{date\}/gi, d.toLocaleDateString("fr-FR"));
}

/** Ajoute / retire un saut de ligne manuel après la ligne r. */
export function toggleRowBreak(setup: Partial<PrintSetup> | undefined, r: number): PrintSetup {
  const s = normalizePrint(setup);
  const set = new Set(s.rowBreaks ?? []);
  if (set.has(r)) set.delete(r);
  else set.add(r);
  return normalizePrint({ ...s, rowBreaks: [...set] });
}
export function toggleColBreak(setup: Partial<PrintSetup> | undefined, c: number): PrintSetup {
  const s = normalizePrint(setup);
  const set = new Set(s.colBreaks ?? []);
  if (set.has(c)) set.delete(c);
  else set.add(c);
  return normalizePrint({ ...s, colBreaks: [...set] });
}
