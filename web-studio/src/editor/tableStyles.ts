/**
 * Styles de tableau : trames alternées, tri des lignes, alignement de cellule et
 * ajustement automatique.
 *
 * Un style de tableau n'est pas une couleur posée sur chaque cellule : c'est une
 * **règle** (« première ligne accentuée, lignes paires trament ») qui doit rester
 * vraie quand on insère ou supprime une ligne. Le style vit donc sur le nœud
 * `table` et le rendu se déduit de la position de chaque ligne, exactement comme
 * la numérotation des notes se déduit de l'ordre du document.
 *
 * Le tri, lui, est une opération pure sur une matrice de chaînes : le comparateur
 * est ici, l'application à ProseMirror ailleurs.
 */

/** Les styles proposés, dans l'esprit de la galerie de Word. */
export type TableStyleId = "plain" | "grid" | "banded-rows" | "banded-cols" | "header-accent" | "minimal";

export interface TableStyle {
  id: TableStyleId;
  label: string;
  /** Trame appliquée une ligne (ou colonne) sur deux. */
  band: "none" | "rows" | "cols";
  /** Première ligne mise en avant. */
  headerAccent: boolean;
  /** Filets intérieurs visibles. */
  innerBorders: boolean;
  /** Filets extérieurs visibles. */
  outerBorders: boolean;
}

export const TABLE_STYLES: readonly TableStyle[] = [
  { id: "plain", label: "Simple", band: "none", headerAccent: false, innerBorders: true, outerBorders: true },
  { id: "grid", label: "Grille", band: "none", headerAccent: true, innerBorders: true, outerBorders: true },
  {
    id: "banded-rows",
    label: "Lignes alternées",
    band: "rows",
    headerAccent: true,
    innerBorders: false,
    outerBorders: true,
  },
  {
    id: "banded-cols",
    label: "Colonnes alternées",
    band: "cols",
    headerAccent: true,
    innerBorders: false,
    outerBorders: true,
  },
  {
    id: "header-accent",
    label: "En-tête accentué",
    band: "none",
    headerAccent: true,
    innerBorders: false,
    outerBorders: false,
  },
  { id: "minimal", label: "Minimal", band: "none", headerAccent: false, innerBorders: false, outerBorders: false },
];

export const DEFAULT_TABLE_STYLE: TableStyleId = "plain";

/** Le style d'un identifiant, avec repli sur le style simple. */
export function tableStyleById(id: unknown): TableStyle {
  const found = TABLE_STYLES.find((s) => s.id === id);
  return found ?? TABLE_STYLES[0]!;
}

// --- Alignement de cellule ------------------------------------------------

/** Alignement vertical, dans les valeurs de `w:vAlign`. */
export type CellVAlign = "top" | "center" | "bottom";

export const CELL_VALIGNS: readonly CellVAlign[] = ["top", "center", "bottom"] as const;

export const CELL_VALIGN_LABELS: Record<CellVAlign, string> = {
  top: "Haut",
  center: "Milieu",
  bottom: "Bas",
};

export function normalizeVAlign(v: unknown): CellVAlign {
  return v === "center" || v === "bottom" ? v : "top";
}

/** La valeur OOXML de l'alignement vertical (`w:vAlign`). */
export function vAlignXml(v: unknown): string {
  const a = normalizeVAlign(v);
  // OOXML nomme le milieu « center » et le bas « bottom » ; « top » est le défaut
  // et n'a pas besoin d'être écrit.
  return a === "top" ? "" : `<w:vAlign w:val="${a}"/>`;
}

// --- Ajustement -----------------------------------------------------------

/** Modes d'ajustement de largeur, comme le menu « Ajustement automatique ». */
export type TableFit = "auto" | "content" | "window" | "fixed";

export const TABLE_FIT_LABELS: Record<TableFit, string> = {
  auto: "Automatique",
  content: "Ajuster au contenu",
  window: "Ajuster à la fenêtre",
  fixed: "Largeurs fixes",
};

export function normalizeFit(v: unknown): TableFit {
  return v === "content" || v === "window" || v === "fixed" ? v : "auto";
}

/**
 * Le CSS d'ajustement.
 *
 * `table-layout: fixed` est ce qui rend les largeurs de colonnes réellement
 * respectées ; en `auto`, le navigateur les recalcule d'après le contenu et
 * ignore les colonnes redimensionnées à la main.
 */
export function fitCss(fit: unknown): string {
  switch (normalizeFit(fit)) {
    case "content":
      return "width:auto;table-layout:auto";
    case "window":
      return "width:100%;table-layout:fixed";
    case "fixed":
      return "table-layout:fixed";
    default:
      return "";
  }
}

/** Le `w:tblW` correspondant. */
export function fitXml(fit: unknown): string {
  switch (normalizeFit(fit)) {
    case "content":
      return '<w:tblW w:w="0" w:type="auto"/>';
    case "window":
      return '<w:tblW w:w="5000" w:type="pct"/>';
    case "fixed":
      return '<w:tblW w:w="0" w:type="auto"/><w:tblLayout w:type="fixed"/>';
    default:
      return '<w:tblW w:w="0" w:type="auto"/>';
  }
}

// --- Rendu du style -------------------------------------------------------

/**
 * Les classes CSS d'une ligne, d'après sa position et le style.
 *
 * Dérivé de l'index : insérer une ligne au milieu réattribue les trames sans
 * qu'aucune cellule n'ait à être retouchée.
 */
export function rowClasses(style: TableStyle, rowIndex: number, hasHeader: boolean): string[] {
  // Marqueur du style porté par CHAQUE ligne. Le tableau redimensionnable de
  // TipTap est rendu par une vue de nœud qui ignore les attributs de décoration
  // posés sur le tableau : impossible d'atteindre le `<table>` depuis un plugin.
  // Les lignes, elles, sont atteignables — d'où ce marqueur, que le CSS remonte
  // au tableau avec `:has()`.
  const out: string[] = [`tstyle-${style.id}`];
  const isHeader = hasHeader && rowIndex === 0;
  if (isHeader && style.headerAccent) out.push("is-header-accent");
  if (style.band === "rows" && !isHeader) {
    // La bande se compte à partir de la première ligne de CORPS, pas de la ligne
    // d'en-tête : sinon ajouter un en-tête inverserait toutes les trames.
    const bodyIndex = hasHeader ? rowIndex - 1 : rowIndex;
    if (bodyIndex % 2 === 1) out.push("is-banded");
  }
  return out;
}

/** Vrai si la colonne d'index donné est tramée par le style. */
export function isBandedColumn(style: TableStyle, colIndex: number): boolean {
  return style.band === "cols" && colIndex % 2 === 1;
}

/** La feuille de styles des tableaux, générée depuis la table des styles. */
export function tableStylesCss(scope = ".elium-prose"): string {
  const rules: string[] = [
    `${scope} table[data-table-style]{border-collapse:collapse}`,
    `${scope} table[data-table-style] td,${scope} table[data-table-style] th{` +
      `border-color:var(--border-strong,#cbd5e1)}`,
    `${scope} table[data-table-style] tr.is-banded>td,${scope} table[data-table-style] tr.is-banded>th{` +
      `background:var(--surface-2,#f8fafc)}`,
    `${scope} table[data-table-style] td.is-banded-col,${scope} table[data-table-style] th.is-banded-col{` +
      `background:var(--surface-2,#f8fafc)}`,
    `${scope} table[data-table-style] tr.is-header-accent>th,${scope} table[data-table-style] tr.is-header-accent>td{` +
      `background:var(--primary-50,#eff6ff);font-weight:700;color:var(--text,#0f172a)}`,
    // L'alignement vertical d'une cellule : `vertical-align` sur la cellule.
    `${scope} table[data-table-style] td[data-valign="center"],${scope} table[data-table-style] th[data-valign="center"]{vertical-align:middle}`,
    `${scope} table[data-table-style] td[data-valign="bottom"],${scope} table[data-table-style] th[data-valign="bottom"]{vertical-align:bottom}`,
  ];
  // Deux formes de sélecteur pour un seul générateur : l'attribut, écrit par
  // l'export HTML, et le marqueur de ligne remonté par `:has()`, seule voie
  // possible dans l'éditeur (cf. `rowClasses`). Deux générateurs séparés
  // finiraient par rendre l'écran et l'export différents.
  for (const s of TABLE_STYLES) {
    const sels = [`${scope} table[data-table-style="${s.id}"]`, `${scope} table:has(> tbody > tr.tstyle-${s.id})`];
    for (const sel of sels) {
      if (!s.innerBorders) rules.push(`${sel} td,${sel} th{border-left:0;border-right:0}`);
      if (!s.outerBorders) {
        rules.push(`${sel}{border:0}${sel} tr>*:first-child{border-left:0}${sel} tr>*:last-child{border-right:0}`);
      }
      if (!s.innerBorders && !s.outerBorders) rules.push(`${sel} td,${sel} th{border-top:0}`);
    }
  }
  for (const fit of ["content", "window", "fixed"] as TableFit[]) {
    const css = fitCss(fit);
    if (css) rules.push(`${scope} table:has(> tbody > tr.tfit-${fit}){${css}}`);
  }
  return rules.join("\n");
}

/**
 * Le quadrillage des tableaux : les limites des cellules SANS bordure.
 *
 * C'est l'autre « quadrillage » de Word, et il ne concerne que les styles dont
 * les filets sont absents : dessiner un pointillé sur un tableau déjà bordé
 * doublerait ses traits. La liste des styles concernés est DÉDUITE de la table —
 * ajouter un style sans filets le rendra quadrillable sans rien toucher ici.
 *
 * Tracé en `outline`, pas en `border` : une bordure participe à la mise en page
 * (`border-collapse` la fusionne, et les colonnes se décaleraient à l'affichage
 * du quadrillage), un contour se superpose sans rien déplacer.
 */
export function tableGridlinesCss(scope = ".elium-tablegrid .elium-prose"): string {
  const rules: string[] = [];
  for (const s of TABLE_STYLES) {
    if (s.innerBorders && s.outerBorders) continue;
    for (const sel of [
      `${scope} table[data-table-style="${s.id}"]`,
      `${scope} table:has(> tbody > tr.tstyle-${s.id})`,
    ]) {
      rules.push(`${sel} td,${sel} th{outline:1px dashed var(--border-strong,#cbd5e1);outline-offset:-1px}`);
    }
  }
  // Un repère d'écran : il ne s'imprime pas, comme dans Word.
  rules.push("@media print{.elium-tablegrid table td,.elium-tablegrid table th{outline:none !important}}");
  return rules.join("\n");
}

/** Le `w:tblPr` d'un tableau, style et ajustement compris. */
export function tablePrXml(styleId: unknown, fit: unknown): string {
  const s = tableStyleById(styleId);
  const color = "cbd5e1";
  const line = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="${color}"/>`;
  const none = (side: string) => `<w:${side} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`;
  const borders =
    "<w:tblBorders>" +
    (s.outerBorders
      ? line("top") + line("left") + line("bottom") + line("right")
      : none("top") + none("left") + none("bottom") + none("right")) +
    (s.innerBorders ? line("insideH") + line("insideV") : none("insideH") + none("insideV")) +
    "</w:tblBorders>";
  // `w:tblLook` dit à Word quelles bandes de son propre style appliquer ; sans
  // lui, un tableau à lignes alternées s'ouvre uniformément gris.
  const look =
    `<w:tblLook w:val="04A0" w:firstRow="${s.headerAccent ? 1 : 0}" w:lastRow="0"` +
    ` w:firstColumn="0" w:lastColumn="0" w:noHBand="${s.band === "rows" ? 0 : 1}"` +
    ` w:noVBand="${s.band === "cols" ? 0 : 1}"/>`;
  return `<w:tblPr><w:tblStyle w:val="TableGrid"/>${fitXml(fit)}${borders}${look}</w:tblPr>`;
}

// --- Tri ------------------------------------------------------------------

export type SortDir = "asc" | "desc";

/**
 * Compare deux cellules pour le tri.
 *
 * Les nombres se comparent numériquement, le reste par collation française.
 * Comparer « 10 » et « 9 » comme du texte mettrait 10 avant 9, ce qui est le
 * défaut le plus visible d'un tri de tableau.
 */
export function compareCells(a: string, b: string): number {
  const na = parseLoose(a);
  const nb = parseLoose(b);
  if (na != null && nb != null) return na - nb;
  if (na != null) return -1;
  if (nb != null) return 1;
  return a.localeCompare(b, "fr", { sensitivity: "base", numeric: true });
}

/**
 * Un nombre lu dans une cellule, ou `null`.
 *
 * Tolère les formats français : espaces (y compris insécables) comme séparateurs
 * de milliers, virgule décimale, symboles monétaires et pourcentage.
 */
export function parseLoose(value: string): number | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const cleaned = raw
    .replace(/[\s  ]/g, "")
    .replace(/[€$£¥%]/g, "")
    // En présence d'une virgule décimale, le point est un séparateur de milliers
    // (« 1.234,50 ») : il se supprime. Seul, il EST le séparateur décimal.
    .replace(/\./g, (m) => (raw.includes(",") ? "" : m))
    .replace(",", ".");
  if (!/^[-+]?\d*\.?\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/**
 * Les indices des lignes triées selon une colonne.
 *
 * Rend des **indices** plutôt que les lignes : l'appelant réordonne ainsi les
 * vrais nœuds ProseMirror avec toute leur mise en forme, au lieu de reconstruire
 * du texte et de tout perdre.
 */
export function sortRowOrder(rows: string[][], colIndex: number, dir: SortDir, hasHeader: boolean): number[] {
  // Borné au nombre de lignes : un en-tête déclaré sur un tableau vide ferait
  // sinon rendre l'indice 0, qui ne désigne aucune ligne.
  const start = Math.min(hasHeader ? 1 : 0, rows.length);
  const head = Array.from({ length: start }, (_, i) => i);
  const body = rows.slice(start).map((_, i) => i + start);
  const sign = dir === "desc" ? -1 : 1;
  body.sort((ia, ib) => {
    const a = rows[ia]?.[colIndex] ?? "";
    const b = rows[ib]?.[colIndex] ?? "";
    const c = compareCells(a, b);
    // À égalité, on garde l'ordre d'origine : un tri instable ferait sauter des
    // lignes identiques à chaque clic.
    return c !== 0 ? c * sign : ia - ib;
  });
  return [...head, ...body];
}
