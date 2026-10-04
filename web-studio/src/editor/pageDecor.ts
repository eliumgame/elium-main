/**
 * Apparence de la page : couleur de fond, bordure de page, numérotation des
 * lignes. Modèle, normalisation, pastilles de numéros de ligne (calcul pur) et
 * fragments OOXML (`w:background`, `w:pgBorders`, `w:lnNumType`) + lecture inverse.
 */
export type PageBorderStyle = "solid" | "double" | "dashed" | "dotted";
export interface PageBorder {
  style: PageBorderStyle;
  /** Épaisseur en points. */
  widthPt: number;
  color: string; // #rrggbb
  /** Distance du bord de la feuille, en millimètres. */
  offsetMm: number;
}
export interface LineNumbering {
  /** « page » : la numérotation repart à 1 sur chaque page. */
  mode: "continuous" | "page";
  /** N'afficher qu'un numéro sur `step`. */
  step: number;
}

export const DEFAULT_BORDER: PageBorder = { style: "solid", widthPt: 1, color: "#1e293b", offsetMm: 10 };
export const DEFAULT_LINE_NUMBERING: LineNumbering = { mode: "continuous", step: 1 };

const HEX = /^#[0-9a-f]{6}$/i;
const clamp = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
};

export function normalizeBackground(v: unknown): string | undefined {
  return typeof v === "string" && HEX.test(v) ? v.toLowerCase() : undefined;
}
export function normalizeBorder(v: unknown): PageBorder | undefined {
  if (!v || typeof v !== "object") return undefined;
  const b = v as Partial<PageBorder>;
  const style: PageBorderStyle =
    b.style === "double" || b.style === "dashed" || b.style === "dotted" ? b.style : "solid";
  return {
    style,
    widthPt: clamp(b.widthPt, 0.25, 12, DEFAULT_BORDER.widthPt),
    color: typeof b.color === "string" && HEX.test(b.color) ? b.color.toLowerCase() : DEFAULT_BORDER.color,
    offsetMm: clamp(b.offsetMm, 2, 30, DEFAULT_BORDER.offsetMm),
  };
}
export function normalizeLineNumbering(v: unknown): LineNumbering | undefined {
  if (!v || typeof v !== "object") return undefined;
  const l = v as Partial<LineNumbering>;
  return { mode: l.mode === "page" ? "page" : "continuous", step: Math.round(clamp(l.step, 1, 100, 1)) };
}

/** CSS d'une bordure de page (cadre posé à `offsetMm` du bord de la feuille). */
export function borderCss(b: PageBorder): { border: string; inset: string } {
  const w = b.style === "double" ? Math.max(3, b.widthPt * 3) : b.widthPt;
  return { border: `${w}pt ${b.style} ${b.color}`, inset: `${b.offsetMm}mm` };
}

// --- Numéros de ligne -------------------------------------------------------

export interface LineLabel {
  top: number;
  n: number;
}

/**
 * Numéros à afficher pour des lignes mesurées (position verticale en px, dans l'ordre).
 * `pages` (tops/hauteurs en px) sert au mode « par page » ; sans lui, tout est continu.
 */
export function lineNumberLabels(
  lineTops: number[],
  pages: { top: number; height: number }[] | null,
  cfg: LineNumbering,
): LineLabel[] {
  const out: LineLabel[] = [];
  let n = 0;
  let curPage = -1;
  const pageOf = (top: number): number => {
    if (!pages?.length) return 0;
    const i = pages.findIndex((p) => top >= p.top && top < p.top + p.height);
    return i < 0 ? pages.length - 1 : i;
  };
  for (const top of lineTops) {
    const pg = pageOf(top);
    if (cfg.mode === "page" && pg !== curPage) {
      n = 0;
      curPage = pg;
    }
    n++;
    if (n % cfg.step === 0 || cfg.step === 1) out.push({ top, n });
  }
  return out;
}

/** Regroupe des rectangles (une ligne de texte = plusieurs fragments) en tops de lignes distincts. */
export function groupLineTops(rectTops: number[], tolerance = 3): number[] {
  const sorted = rectTops.slice().sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of sorted) if (!out.length || t - out[out.length - 1]! > tolerance) out.push(t);
  return out;
}

// --- OOXML ------------------------------------------------------------------

const hexNoHash = (c: string): string => c.replace(/^#/, "").toUpperCase();
const BORDER_VAL: Record<PageBorderStyle, string> = {
  solid: "single",
  double: "double",
  dashed: "dashed",
  dotted: "dotted",
};
const VAL_BORDER: Record<string, PageBorderStyle> = {
  single: "solid",
  double: "double",
  dashed: "dashed",
  dotted: "dotted",
};

/** `w:background` (enfant direct de `w:document`, avant `w:body`). */
export function backgroundXml(color: string | undefined): string {
  return color ? `<w:background w:color="${hexNoHash(color)}"/>` : "";
}
/** `w:displayBackgroundShape` pour `settings.xml` : sans lui, Word masque le fond. */
export function displayBackgroundXml(color: string | undefined): string {
  return color ? "<w:displayBackgroundShape/>" : "";
}
/** `w:pgBorders` (4 côtés identiques, mesurés depuis le bord de la page). */
export function pgBordersXml(b: PageBorder | undefined): string {
  if (!b) return "";
  const sz = Math.round(Math.min(96, Math.max(2, b.widthPt * 8))); // huitièmes de point
  const space = Math.round(Math.min(31, b.offsetMm * 2.83465)); // points
  const side = (n: string) =>
    `<w:${n} w:val="${BORDER_VAL[b.style]}" w:sz="${sz}" w:space="${space}" w:color="${hexNoHash(b.color)}"/>`;
  return `<w:pgBorders w:offsetFrom="page">${side("top")}${side("left")}${side("bottom")}${side("right")}</w:pgBorders>`;
}
/** `w:lnNumType`. */
export function lnNumTypeXml(l: LineNumbering | undefined): string {
  return l ? `<w:lnNumType w:countBy="${l.step}" w:restart="${l.mode === "page" ? "newPage" : "continuous"}"/>` : "";
}

/** Lecture inverse depuis des attributs déjà extraits (utilisée par l'import DOCX). */
export function borderFromOoxml(
  top: { val?: string; sz?: string; space?: string; color?: string } | undefined,
): PageBorder | undefined {
  if (!top?.val || top.val === "nil" || top.val === "none") return undefined;
  return normalizeBorder({
    style: VAL_BORDER[top.val] ?? "solid",
    widthPt: Number(top.sz) / 8 || 1,
    color: top.color && /^[0-9a-f]{6}$/i.test(top.color) ? `#${top.color}` : DEFAULT_BORDER.color,
    offsetMm: (Number(top.space) || 24) / 2.83465,
  });
}
export function lineNumberingFromOoxml(
  a: { countBy?: string; restart?: string } | undefined,
): LineNumbering | undefined {
  if (!a) return undefined;
  return normalizeLineNumbering({
    mode: a.restart === "newPage" ? "page" : "continuous",
    step: Number(a.countBy) || 1,
  });
}
