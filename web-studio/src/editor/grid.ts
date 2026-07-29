/**
 * Le quadrillage : grille de dessin, alignement des objets, quadrillage des
 * tableaux.
 *
 * « Quadrillage » désigne DEUX choses distinctes dans Word, et les deux sont ici :
 *   - la **grille de dessin** (onglet Affichage) : un maillage tracé sur la
 *     feuille, sur lequel les objets flottants (zones de texte, formes) viennent
 *     s'aligner ;
 *   - le **quadrillage des tableaux** : les limites des cellules d'un tableau
 *     sans bordure, tracées en pointillé à l'écran seulement.
 * Les confondre serait une demi-fonctionnalité : le premier sert à placer, le
 * second à voir ce qui est invisible à l'impression.
 *
 * Le pas est en millimètres, comme la géométrie de page, la règle graduée et les
 * zones de texte : aucune conversion ne traîne dans l'interface. Le rendu est un
 * **fond** (deux dégradés répétés) et non des éléments : un maillage à 5 mm sur
 * une page A4 ferait 100 nœuds DOM par page, et un fond s'imprime.
 *
 * Tout est pur ici — modèle, bornes, CSS, OOXML — donc testable sans navigateur.
 */

/** Réglages du quadrillage, portés par le document (voir `PageSettings.grid`). */
export interface GridSettings {
  /** Tracer la grille à l'écran. */
  visible: boolean;
  /** Aligner les objets déplacés sur la grille. */
  snap: boolean;
  /** Pas horizontal en mm (le pas d'alignement, pas celui du tracé). */
  spacingXMm: number;
  /** Pas vertical en mm. */
  spacingYMm: number;
  /**
   * N'afficher qu'une ligne verticale sur N (0 = aucune ligne verticale).
   *
   * C'est le réglage de Word (`w:displayVerticalDrawingGridEvery`) : on aligne
   * finement tout en gardant un tracé lisible. Un pas d'alignement de 2 mm
   * dessiné intégralement donnerait une page grise.
   */
  everyX: number;
  /** N'afficher qu'une ligne horizontale sur N (0 = aucune). */
  everyY: number;
  /** Couleur des lignes (hexadécimal). */
  color: string;
  /** Origine au coin de la zone de texte plutôt qu'au coin de la feuille. */
  fromMargins: boolean;
  /** Origine explicite depuis le bord de la feuille, quand `fromMargins` est faux. */
  originXMm: number;
  originYMm: number;
  /** Tracer les limites des cellules des tableaux sans bordure. */
  tableGridlines: boolean;
}

/**
 * Valeurs par défaut.
 *
 * Word part de 0,32 cm affichés une ligne sur deux ; un pas de 2,5 mm affiché
 * une ligne sur deux donne un maillage visible de 5 mm — assez fin pour aligner,
 * assez lâche pour rester lisible sous le texte.
 */
export const DEFAULT_GRID: GridSettings = {
  visible: false,
  snap: true,
  spacingXMm: 2.5,
  spacingYMm: 2.5,
  everyX: 2,
  everyY: 2,
  color: "#94a3b8",
  fromMargins: true,
  originXMm: 0,
  originYMm: 0,
  tableGridlines: false,
};

/** Pas d'alignement minimal exploitable : en deçà, tout point est « sur la grille ». */
export const MIN_SPACING_MM = 0.5;
export const MAX_SPACING_MM = 50;
/** Au-delà, « une ligne sur N » ne trace plus rien d'utile. */
export const MAX_EVERY = 20;

const HEX = /^#[0-9a-f]{6}$/i;

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Quantifie au dixième de millimètre (stabilité des allers-retours en twips). */
const q = (n: number) => Math.round(n * 10) / 10;

/** Des réglages nettoyés et bornés. */
export function normalizeGrid(raw: unknown): GridSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const spacing = (v: unknown, fallback: number) => q(clamp(num(v, fallback), MIN_SPACING_MM, MAX_SPACING_MM));
  const every = (v: unknown, fallback: number) => clamp(Math.round(num(v, fallback)), 0, MAX_EVERY);
  return {
    visible: r.visible === undefined ? DEFAULT_GRID.visible : Boolean(r.visible),
    snap: r.snap === undefined ? DEFAULT_GRID.snap : Boolean(r.snap),
    spacingXMm: spacing(r.spacingXMm, DEFAULT_GRID.spacingXMm),
    spacingYMm: spacing(r.spacingYMm, DEFAULT_GRID.spacingYMm),
    everyX: every(r.everyX, DEFAULT_GRID.everyX),
    everyY: every(r.everyY, DEFAULT_GRID.everyY),
    color: HEX.test(String(r.color ?? "")) ? String(r.color) : DEFAULT_GRID.color,
    fromMargins: r.fromMargins === undefined ? DEFAULT_GRID.fromMargins : Boolean(r.fromMargins),
    // Une origine négative sortirait la grille de la feuille.
    originXMm: q(clamp(num(r.originXMm, 0), 0, MAX_SPACING_MM * MAX_EVERY)),
    originYMm: q(clamp(num(r.originYMm, 0), 0, MAX_SPACING_MM * MAX_EVERY)),
    tableGridlines: Boolean(r.tableGridlines),
  };
}

/** Le pas RÉELLEMENT tracé horizontalement, en mm ; 0 quand rien n'est tracé. */
export function drawnStepX(g: GridSettings): number {
  return g.everyX > 0 ? q(g.spacingXMm * g.everyX) : 0;
}

/** Le pas réellement tracé verticalement, en mm ; 0 quand rien n'est tracé. */
export function drawnStepY(g: GridSettings): number {
  return g.everyY > 0 ? q(g.spacingYMm * g.everyY) : 0;
}

/** Vrai si la grille a quelque chose à dessiner. */
export function gridDraws(raw: unknown): boolean {
  const g = normalizeGrid(raw);
  return g.visible && (drawnStepX(g) > 0 || drawnStepY(g) > 0);
}

/**
 * Le fond du quadrillage : deux dégradés répétés, l'un vertical, l'autre
 * horizontal.
 *
 * `offsetLeftMm`/`offsetTopMm` sont l'origine demandée par rapport au coin de la
 * feuille — les marges quand `fromMargins`, l'origine explicite sinon. C'est
 * l'appelant qui les connaît (elles varient d'une section à l'autre), donc il les
 * fournit plutôt que de faire entrer la géométrie de page dans ce module.
 *
 * Rend `null` quand rien n'est à tracer, pour que l'appelant n'écrive pas un
 * `background-image` vide (Safari le traite différemment de son absence).
 */
export function gridBackground(
  raw: unknown,
  offsetLeftMm = 0,
  offsetTopMm = 0,
): { backgroundImage: string; backgroundPosition: string; backgroundSize: string } | null {
  const g = normalizeGrid(raw);
  if (!gridDraws(g)) return null;
  const stepX = drawnStepX(g);
  const stepY = drawnStepY(g);
  // Une ligne d'un demi-pixel physique : à l'écran comme à l'impression, une
  // ligne d'1 px à 5 mm d'intervalle domine visuellement le texte.
  const w = "0.06mm";
  const images: string[] = [];
  const sizes: string[] = [];
  const positions: string[] = [];
  if (stepX > 0) {
    images.push(
      `repeating-linear-gradient(to right, ${g.color} 0, ${g.color} ${w}, transparent ${w}, transparent ${stepX}mm)`,
    );
    sizes.push("auto");
    positions.push(`${offsetLeftMm}mm 0`);
  }
  if (stepY > 0) {
    images.push(
      `repeating-linear-gradient(to bottom, ${g.color} 0, ${g.color} ${w}, transparent ${w}, transparent ${stepY}mm)`,
    );
    sizes.push("auto");
    positions.push(`0 ${offsetTopMm}mm`);
  }
  return {
    backgroundImage: images.join(","),
    backgroundPosition: positions.join(","),
    backgroundSize: sizes.join(","),
  };
}

/**
 * Une valeur ramenée sur la grille.
 *
 * `origin` décale la grille : aligner sur une grille dont l'origine est la marge
 * gauche n'est pas la même chose qu'aligner sur le bord de la feuille, et une
 * position de zone de texte est mesurée depuis le contenu.
 */
export function snapMm(valueMm: number, stepMm: number, origin = 0): number {
  const step = Number(stepMm);
  if (!Number.isFinite(step) || step < MIN_SPACING_MM) return valueMm;
  const v = Number(valueMm);
  if (!Number.isFinite(v)) return valueMm;
  return q(origin + Math.round((v - origin) / step) * step);
}

/** Un point ramené sur la grille (identité si l'alignement est coupé). */
export function snapPoint(
  xMm: number,
  yMm: number,
  raw: unknown,
): { x: number; y: number } {
  const g = normalizeGrid(raw);
  if (!g.snap) return { x: q(xMm), y: q(yMm) };
  return { x: snapMm(xMm, g.spacingXMm), y: snapMm(yMm, g.spacingYMm) };
}

// --- Grille active --------------------------------------------------------

/**
 * La grille en vigueur, publiée hors du document.
 *
 * Les vues de nœud (zone de texte, forme) doivent l'atteindre pendant un
 * glisser : elles ne reçoivent que le nœud et l'éditeur, et faire descendre les
 * réglages du document jusqu'à elles par les options d'extension reconstruirait
 * l'éditeur à chaque changement de réglage. Même motif que `setPageResolver` et
 * le registre de styles.
 */
let active: GridSettings | null = null;

/** Publie la grille du document courant (ou `null` en l'absence de grille). */
export function setActiveGrid(raw: unknown | null): void {
  active = raw == null ? null : normalizeGrid(raw);
}

/** La grille en vigueur, pour un déplacement d'objet. */
export function activeGrid(): GridSettings | null {
  return active;
}

/**
 * Aligne un déplacement sur la grille active, sauf si l'on demande à l'ignorer.
 *
 * `bypass` porte la touche Alt, exactement comme dans Word : maintenir Alt pose
 * l'objet librement sans avoir à décocher l'alignement.
 */
export function snapDrag(
  xMm: number,
  yMm: number,
  bypass = false,
): { x: number; y: number } {
  const g = active;
  if (!g || !g.snap || bypass) return { x: q(xMm), y: q(yMm) };
  return snapPoint(xMm, yMm, g);
}

// --- OOXML ----------------------------------------------------------------

/** Millimètres en twips (1/1440 de pouce), l'unité des réglages de Word. */
export function mmToTwips(mm: number): number {
  return Math.round(mm * 56.6929);
}

/**
 * Le corps de `word/settings.xml` pour cette grille.
 *
 * Word garde la grille dans les réglages du document, pas dans le corps :
 * espacement, « une ligne sur N », origine. La **visibilité** n'y a pas de champ
 * dédié — c'est un réglage d'affichage de l'application. Une grille masquée est
 * donc exportée avec « une ligne sur 0 », ce qui ne trace effectivement rien
 * dans Word tout en conservant le pas d'alignement : c'est le comportement le
 * plus proche de ce que l'auteur voit.
 */
export function gridSettingsXml(raw: unknown): string {
  const g = normalizeGrid(raw);
  const parts = [
    `<w:drawingGridHorizontalSpacing w:val="${mmToTwips(g.spacingXMm)}"/>`,
    `<w:drawingGridVerticalSpacing w:val="${mmToTwips(g.spacingYMm)}"/>`,
    `<w:displayHorizontalDrawingGridEvery w:val="${g.visible ? g.everyX : 0}"/>`,
    `<w:displayVerticalDrawingGridEvery w:val="${g.visible ? g.everyY : 0}"/>`,
  ];
  if (!g.fromMargins) {
    // Sans ce drapeau, Word ignore l'origine explicite et repart des marges.
    parts.push("<w:doNotUseMarginsForDrawingGridOrigin/>");
    parts.push(`<w:drawingGridHorizontalOrigin w:val="${mmToTwips(g.originXMm)}"/>`);
    parts.push(`<w:drawingGridVerticalOrigin w:val="${mmToTwips(g.originYMm)}"/>`);
  }
  return parts.join("");
}

/** Lit une grille depuis un `settings.xml` de Word (import DOCX). */
export function gridFromSettingsXml(xml: string): Partial<GridSettings> {
  const src = String(xml ?? "");
  const val = (tag: string): number | null => {
    const m = new RegExp(`<w:${tag}[^>]*w:val="(-?\\d+)"`).exec(src);
    return m ? Number(m[1]) : null;
  };
  const twToMm = (tw: number) => q(tw / 56.6929);
  const out: Partial<GridSettings> = {};
  const hs = val("drawingGridHorizontalSpacing");
  const vs = val("drawingGridVerticalSpacing");
  const hx = val("displayHorizontalDrawingGridEvery");
  const vx = val("displayVerticalDrawingGridEvery");
  if (hs != null) out.spacingXMm = clamp(twToMm(hs), MIN_SPACING_MM, MAX_SPACING_MM);
  if (vs != null) out.spacingYMm = clamp(twToMm(vs), MIN_SPACING_MM, MAX_SPACING_MM);
  if (hx != null) out.everyX = clamp(hx, 0, MAX_EVERY);
  if (vx != null) out.everyY = clamp(vx, 0, MAX_EVERY);
  // « Une ligne sur 0 » des deux côtés, c'est une grille masquée.
  if (hx != null || vx != null) out.visible = (hx ?? 0) > 0 || (vx ?? 0) > 0;
  if (/<w:doNotUseMarginsForDrawingGridOrigin\b/.test(src)) {
    out.fromMargins = false;
    const ox = val("drawingGridHorizontalOrigin");
    const oy = val("drawingGridVerticalOrigin");
    if (ox != null) out.originXMm = twToMm(ox);
    if (oy != null) out.originYMm = twToMm(oy);
  }
  return out;
}
