/**
 * Les formes : catalogue, géométrie paramétrique, style et sérialisation.
 *
 * **Une seule géométrie pour trois surfaces.** Chaque forme est décrite par un
 * générateur de chemin en millimètres, et ce chemin unique alimente l'écran
 * (SVG), l'export HTML (le même SVG) et le VML de repli du DOCX (converti
 * mécaniquement). Word, lui, reçoit en priorité sa **géométrie préréglée**
 * (`a:prstGeom`) : c'est ce qui fait qu'une étoile reste une vraie étoile
 * éditable dans Word, et non un tracé figé. Trois tracés séparés auraient dérivé
 * les uns des autres à la première correction.
 *
 * **Les chemins n'utilisent que M, L, C et Z** — jamais l'arc `A` de SVG. C'est
 * la contrainte qui rend la conversion vers VML mécanique : VML connaît la courbe
 * de Bézier cubique mais pas l'arc elliptique de SVG. Tout ce qui est rond passe
 * donc par `arcCubics`, qui découpe un arc en Béziers.
 *
 * La géométrie de placement (position, taille, habillage, rotation) est celle des
 * zones de texte : `textBox.ts` en est la source, une forme est une zone de texte
 * avec un contour. Rien n'est dupliqué ici.
 */
import { normalizeGeometry, mmToPt, wrapCss, type TextBoxGeometry } from "./textBox";

// =========================================================================
// Catalogue
// =========================================================================

export type ShapeGroup = "lines" | "rect" | "basic" | "arrows" | "flow" | "stars" | "callouts";

export const SHAPE_GROUPS: { id: ShapeGroup; label: string }[] = [
  { id: "lines", label: "Lignes et connecteurs" },
  { id: "rect", label: "Rectangles" },
  { id: "basic", label: "Formes de base" },
  { id: "arrows", label: "Flèches" },
  { id: "flow", label: "Organigramme" },
  { id: "stars", label: "Étoiles et bannières" },
  { id: "callouts", label: "Bulles et légendes" },
];

export type ShapeKind =
  // Lignes
  | "line" | "arrow" | "doubleArrow" | "elbow"
  // Rectangles
  | "rect" | "roundRect" | "snipRect" | "stadium" | "frame"
  // Formes de base
  | "ellipse" | "triangle" | "rtTriangle" | "diamond" | "parallelogram" | "trapezoid"
  | "pentagon" | "hexagon" | "heptagon" | "octagon" | "cross" | "donut" | "can" | "cube"
  | "heart" | "cloud" | "sun" | "moon" | "bolt" | "chevron"
  // Flèches
  | "rightArrow" | "leftArrow" | "upArrow" | "downArrow" | "leftRightArrow" | "upDownArrow"
  | "homePlate" | "notchedArrow"
  // Organigramme
  | "flowProcess" | "flowDecision" | "flowTerminator" | "flowData" | "flowPreparation"
  | "flowConnector" | "flowDocument" | "flowManualInput" | "flowDelay"
  // Étoiles et bannières
  | "star4" | "star5" | "star6" | "star8" | "star12" | "explosion" | "ribbon"
  // Bulles
  | "calloutRect" | "calloutRoundRect" | "calloutEllipse";

export interface ShapeDef {
  kind: ShapeKind;
  label: string;
  group: ShapeGroup;
  /** Géométrie préréglée OOXML (`a:prstGeom/@prst`) — ce que Word rend nativement. */
  prst: string;
  /** Une ligne : pas de remplissage, pas de texte, hauteur libre. */
  line?: boolean;
  /** Pointe de flèche : au bout, ou aux deux bouts. */
  head?: "end" | "both";
  /** Réglage d'ajustement, en pourcentage (rayon des coins, épaisseur d'un bras…). */
  adj?: { label: string; min: number; max: number; default: number };
}

/**
 * Le catalogue, dans l'ordre du sélecteur.
 *
 * Les formes d'organigramme réutilisent la géométrie d'une forme de base (un
 * processus EST un rectangle) mais gardent leur propre `prst` : ouvert dans Word,
 * un organigramme importé depuis Elium reste un organigramme.
 */
export const SHAPES: ShapeDef[] = [
  { kind: "line", label: "Droite", group: "lines", prst: "line", line: true },
  { kind: "arrow", label: "Flèche", group: "lines", prst: "straightConnector1", line: true, head: "end" },
  { kind: "doubleArrow", label: "Flèche double", group: "lines", prst: "straightConnector1", line: true, head: "both" },
  { kind: "elbow", label: "Connecteur en angle", group: "lines", prst: "bentConnector3", line: true },

  { kind: "rect", label: "Rectangle", group: "rect", prst: "rect" },
  { kind: "roundRect", label: "Rectangle arrondi", group: "rect", prst: "roundRect", adj: { label: "Rayon des coins", min: 0, max: 50, default: 16 } },
  { kind: "snipRect", label: "Rectangle à coin coupé", group: "rect", prst: "snip1Rect", adj: { label: "Coupe", min: 0, max: 50, default: 16 } },
  { kind: "stadium", label: "Rectangle à bouts ronds", group: "rect", prst: "flowChartTerminator" },
  { kind: "frame", label: "Cadre", group: "rect", prst: "frame", adj: { label: "Épaisseur", min: 2, max: 45, default: 12 } },

  { kind: "ellipse", label: "Ellipse", group: "basic", prst: "ellipse" },
  { kind: "triangle", label: "Triangle", group: "basic", prst: "triangle", adj: { label: "Sommet", min: 0, max: 100, default: 50 } },
  { kind: "rtTriangle", label: "Triangle rectangle", group: "basic", prst: "rtTriangle" },
  { kind: "diamond", label: "Losange", group: "basic", prst: "diamond" },
  { kind: "parallelogram", label: "Parallélogramme", group: "basic", prst: "parallelogram", adj: { label: "Inclinaison", min: 0, max: 50, default: 25 } },
  { kind: "trapezoid", label: "Trapèze", group: "basic", prst: "trapezoid", adj: { label: "Inclinaison", min: 0, max: 50, default: 25 } },
  { kind: "pentagon", label: "Pentagone", group: "basic", prst: "pentagon" },
  { kind: "hexagon", label: "Hexagone", group: "basic", prst: "hexagon" },
  { kind: "heptagon", label: "Heptagone", group: "basic", prst: "heptagon" },
  { kind: "octagon", label: "Octogone", group: "basic", prst: "octagon" },
  { kind: "cross", label: "Croix", group: "basic", prst: "plus", adj: { label: "Épaisseur", min: 5, max: 50, default: 25 } },
  { kind: "donut", label: "Anneau", group: "basic", prst: "donut", adj: { label: "Épaisseur", min: 2, max: 48, default: 20 } },
  { kind: "can", label: "Cylindre", group: "basic", prst: "can", adj: { label: "Perspective", min: 5, max: 45, default: 18 } },
  { kind: "cube", label: "Cube", group: "basic", prst: "cube", adj: { label: "Profondeur", min: 5, max: 45, default: 25 } },
  { kind: "heart", label: "Cœur", group: "basic", prst: "heart" },
  { kind: "cloud", label: "Nuage", group: "basic", prst: "cloud" },
  { kind: "sun", label: "Soleil", group: "basic", prst: "sun" },
  { kind: "moon", label: "Croissant", group: "basic", prst: "moon", adj: { label: "Épaisseur", min: 10, max: 80, default: 50 } },
  { kind: "bolt", label: "Éclair", group: "basic", prst: "lightningBolt" },
  { kind: "chevron", label: "Chevron", group: "basic", prst: "chevron", adj: { label: "Pointe", min: 5, max: 50, default: 25 } },

  { kind: "rightArrow", label: "Flèche droite", group: "arrows", prst: "rightArrow", adj: { label: "Épaisseur", min: 10, max: 90, default: 50 } },
  { kind: "leftArrow", label: "Flèche gauche", group: "arrows", prst: "leftArrow", adj: { label: "Épaisseur", min: 10, max: 90, default: 50 } },
  { kind: "upArrow", label: "Flèche haut", group: "arrows", prst: "upArrow", adj: { label: "Épaisseur", min: 10, max: 90, default: 50 } },
  { kind: "downArrow", label: "Flèche bas", group: "arrows", prst: "downArrow", adj: { label: "Épaisseur", min: 10, max: 90, default: 50 } },
  { kind: "leftRightArrow", label: "Flèche double horizontale", group: "arrows", prst: "leftRightArrow", adj: { label: "Épaisseur", min: 10, max: 90, default: 50 } },
  { kind: "upDownArrow", label: "Flèche double verticale", group: "arrows", prst: "upDownArrow", adj: { label: "Épaisseur", min: 10, max: 90, default: 50 } },
  { kind: "homePlate", label: "Flèche pentagonale", group: "arrows", prst: "homePlate", adj: { label: "Pointe", min: 5, max: 50, default: 25 } },
  { kind: "notchedArrow", label: "Flèche encochée", group: "arrows", prst: "notchedRightArrow", adj: { label: "Épaisseur", min: 10, max: 90, default: 50 } },

  { kind: "flowProcess", label: "Processus", group: "flow", prst: "flowChartProcess" },
  { kind: "flowDecision", label: "Décision", group: "flow", prst: "flowChartDecision" },
  { kind: "flowTerminator", label: "Début / fin", group: "flow", prst: "flowChartTerminator" },
  { kind: "flowData", label: "Données", group: "flow", prst: "flowChartInputOutput" },
  { kind: "flowPreparation", label: "Préparation", group: "flow", prst: "flowChartPreparation" },
  { kind: "flowConnector", label: "Connecteur", group: "flow", prst: "flowChartConnector" },
  { kind: "flowDocument", label: "Document", group: "flow", prst: "flowChartDocument" },
  { kind: "flowManualInput", label: "Saisie manuelle", group: "flow", prst: "flowChartManualInput" },
  { kind: "flowDelay", label: "Attente", group: "flow", prst: "flowChartDelay" },

  { kind: "star4", label: "Étoile à 4 branches", group: "stars", prst: "star4" },
  { kind: "star5", label: "Étoile à 5 branches", group: "stars", prst: "star5" },
  { kind: "star6", label: "Étoile à 6 branches", group: "stars", prst: "star6" },
  { kind: "star8", label: "Étoile à 8 branches", group: "stars", prst: "star8" },
  { kind: "star12", label: "Étoile à 12 branches", group: "stars", prst: "star12" },
  { kind: "explosion", label: "Explosion", group: "stars", prst: "irregularSeal2" },
  { kind: "ribbon", label: "Bannière", group: "stars", prst: "ribbon2" },

  { kind: "calloutRect", label: "Bulle rectangulaire", group: "callouts", prst: "wedgeRectCallout" },
  { kind: "calloutRoundRect", label: "Bulle arrondie", group: "callouts", prst: "wedgeRoundRectCallout" },
  { kind: "calloutEllipse", label: "Bulle ovale", group: "callouts", prst: "wedgeEllipseCallout" },
];

const BY_KIND = new Map<string, ShapeDef>(SHAPES.map((s) => [s.kind, s]));

export const DEFAULT_KIND: ShapeKind = "rect";

/** La définition d'une forme, en retombant sur le rectangle si le nom est inconnu. */
export function shapeDef(kind: unknown): ShapeDef {
  return BY_KIND.get(String(kind)) ?? BY_KIND.get(DEFAULT_KIND)!;
}

export function isShapeKind(kind: unknown): kind is ShapeKind {
  return BY_KIND.has(String(kind));
}

/** L'ajustement par défaut d'une forme (0 quand elle n'en a pas). */
export function defaultAdj(kind: unknown): number {
  return shapeDef(kind).adj?.default ?? 0;
}

/** Un ajustement borné aux valeurs acceptées par la forme. */
export function clampAdj(kind: unknown, value: unknown): number {
  const def = shapeDef(kind).adj;
  if (!def) return 0;
  const n = Number(value);
  if (!Number.isFinite(n)) return def.default;
  return Math.round(Math.min(def.max, Math.max(def.min, n)));
}

// =========================================================================
// Style
// =========================================================================

export type DashStyle = "solid" | "dash" | "dot" | "dashDot" | "longDash";

export const DASH_LABELS: Record<DashStyle, string> = {
  solid: "Trait continu",
  dash: "Tirets",
  dot: "Pointillés",
  dashDot: "Tiret-point",
  longDash: "Longs tirets",
};

/** Le motif de tirets, en multiples de l'épaisseur du trait (SVG et OOXML). */
const DASH_PATTERN: Record<DashStyle, number[]> = {
  solid: [],
  dash: [4, 3],
  dot: [1, 2],
  dashDot: [4, 2, 1, 2],
  longDash: [8, 3],
};

/** Le nom OOXML du motif (`a:prstDash/@val`). */
const DASH_OOXML: Record<DashStyle, string> = {
  solid: "solid",
  dash: "dash",
  dot: "sysDot",
  dashDot: "dashDot",
  longDash: "lgDash",
};

export type VAlign = "top" | "middle" | "bottom";

export interface ShapeStyle {
  /** Remplissage ; chaîne vide = aucun (transparent). */
  fill: string;
  /** Opacité du remplissage, 0..1. */
  fillOpacity: number;
  /** Dégradé : vide = remplissage uni. */
  gradient: "" | "linear" | "radial";
  /** Seconde couleur du dégradé. */
  fill2: string;
  /** Angle du dégradé linéaire, en degrés. */
  gradientAngle: number;
  strokeColor: string;
  /** Épaisseur du contour en px ; 0 = aucun contour. */
  strokeWidth: number;
  dash: DashStyle;
  shadow: boolean;
  /** Couleur du texte de la forme. */
  textColor: string;
  /** Alignement vertical du texte dans la forme. */
  vAlign: VAlign;
  /** Marge intérieure du texte, en mm. */
  padMm: number;
}

export const DEFAULT_SHAPE_STYLE: ShapeStyle = {
  fill: "#dbeafe",
  fillOpacity: 1,
  gradient: "",
  fill2: "#93c5fd",
  gradientAngle: 90,
  strokeColor: "#2563eb",
  strokeWidth: 1,
  dash: "solid",
  shadow: false,
  textColor: "#0f172a",
  vAlign: "middle",
  padMm: 3,
};

const HEX = /^#[0-9a-f]{6}$/i;
const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
/** Deux décimales : un chemin en millimètres n'a pas besoin de plus, et le XML reste lisible. */
const r2 = (n: number) => Math.round(n * 100) / 100;

function isDash(v: unknown): v is DashStyle {
  return typeof v === "string" && v in DASH_PATTERN;
}

/** Un style de forme nettoyé et borné. */
export function normalizeShapeStyle(raw: unknown): ShapeStyle {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const color = (v: unknown, fallback: string) => (HEX.test(String(v ?? "")) ? String(v) : fallback);
  return {
    // Chaîne vide = pas de remplissage, ce qui n'est PAS blanc : une forme sans
    // remplissage laisse voir le texte et le filigrane derrière.
    fill: s.fill === "" ? "" : color(s.fill, DEFAULT_SHAPE_STYLE.fill),
    fillOpacity: clamp(num(s.fillOpacity, 1), 0, 1),
    gradient: s.gradient === "linear" || s.gradient === "radial" ? s.gradient : "",
    fill2: color(s.fill2, DEFAULT_SHAPE_STYLE.fill2),
    gradientAngle: ((Math.round(num(s.gradientAngle, 90)) % 360) + 360) % 360,
    strokeColor: color(s.strokeColor, DEFAULT_SHAPE_STYLE.strokeColor),
    strokeWidth: clamp(num(s.strokeWidth, DEFAULT_SHAPE_STYLE.strokeWidth), 0, 12),
    dash: isDash(s.dash) ? s.dash : "solid",
    shadow: Boolean(s.shadow),
    textColor: color(s.textColor, DEFAULT_SHAPE_STYLE.textColor),
    vAlign: s.vAlign === "top" || s.vAlign === "bottom" ? s.vAlign : "middle",
    padMm: Math.round(clamp(num(s.padMm, DEFAULT_SHAPE_STYLE.padMm), 0, 40) * 10) / 10,
  };
}

// =========================================================================
// Géométrie
// =========================================================================

const TAU = Math.PI * 2;
/** Le facteur de Bézier d'un quart de cercle : 4/3·tan(45°/2). */
const KAPPA = 0.5522847498307936;

const pt = (x: number, y: number) => `${r2(x)},${r2(y)}`;

/** Un polygone fermé. */
function poly(points: [number, number][]): string {
  if (!points.length) return "";
  const [first, ...rest] = points;
  return `M${pt(first![0], first![1])}` + rest.map((p) => `L${pt(p[0], p[1])}`).join("") + "Z";
}

/**
 * Un arc d'ellipse en courbes de Bézier cubiques.
 *
 * Tout ce qui est rond passe par ici : sans cela il faudrait l'arc `A` de SVG,
 * que VML ne sait pas lire — et le repli VML du DOCX deviendrait un second tracé
 * à maintenir. Les angles sont en radians, sens horaire à l'écran (y vers le bas).
 * `move` écrit le `M` initial ; à faux, l'arc se raccorde au tracé en cours.
 */
export function arcCubics(
  cx: number, cy: number, rx: number, ry: number,
  a0: number, a1: number, move = true,
): string {
  const sweep = a1 - a0;
  // Un quart de tour au maximum par courbe : au-delà, l'approximation dévie
  // visiblement du cercle.
  const steps = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2)));
  const delta = sweep / steps;
  const k = (4 / 3) * Math.tan(delta / 4);
  let out = move ? `M${pt(cx + rx * Math.cos(a0), cy + ry * Math.sin(a0))}` : "";
  let a = a0;
  for (let i = 0; i < steps; i++) {
    const b = a + delta;
    const x0 = cx + rx * Math.cos(a);
    const y0 = cy + ry * Math.sin(a);
    const x1 = cx + rx * Math.cos(b);
    const y1 = cy + ry * Math.sin(b);
    const c1x = x0 - k * rx * Math.sin(a);
    const c1y = y0 + k * ry * Math.cos(a);
    const c2x = x1 + k * rx * Math.sin(b);
    const c2y = y1 - k * ry * Math.cos(b);
    out += `C${pt(c1x, c1y)} ${pt(c2x, c2y)} ${pt(x1, y1)}`;
    a = b;
  }
  return out;
}

/** Une ellipse complète, en quatre courbes. */
function ellipse(cx: number, cy: number, rx: number, ry: number, clockwise = true): string {
  const a0 = -Math.PI / 2;
  return arcCubics(cx, cy, rx, ry, a0, clockwise ? a0 + TAU : a0 - TAU) + "Z";
}

/** Un rectangle à coins arrondis (rayon borné à la moitié du plus petit côté). */
function roundRect(w: number, h: number, radius: number): string {
  const rr = Math.max(0, Math.min(radius, Math.min(w, h) / 2));
  if (rr <= 0) return poly([[0, 0], [w, 0], [w, h], [0, h]]);
  const q = KAPPA * rr;
  return (
    `M${pt(rr, 0)}L${pt(w - rr, 0)}` +
    `C${pt(w - rr + q, 0)} ${pt(w, rr - q)} ${pt(w, rr)}` +
    `L${pt(w, h - rr)}` +
    `C${pt(w, h - rr + q)} ${pt(w - rr + q, h)} ${pt(w - rr, h)}` +
    `L${pt(rr, h)}` +
    `C${pt(rr - q, h)} ${pt(0, h - rr + q)} ${pt(0, h - rr)}` +
    `L${pt(0, rr)}` +
    `C${pt(0, rr - q)} ${pt(rr - q, 0)} ${pt(rr, 0)}Z`
  );
}

/** Un polygone régulier inscrit dans la boîte, `offsetDeg` donnant le premier sommet. */
function regular(n: number, w: number, h: number, offsetDeg: number): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = ((offsetDeg + (i * 360) / n) * Math.PI) / 180;
    pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)]);
  }
  return poly(pts);
}

/** Une étoile : sommets alternés sur l'ellipse de la boîte et sur son homothétie. */
function star(points: number, inner: number, w: number, h: number): string {
  const pts: [number, number][] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (-90 + (i * 180) / points) * (Math.PI / 180);
    const k = i % 2 === 0 ? 1 : inner;
    pts.push([w / 2 + (w / 2) * k * Math.cos(a), h / 2 + (h / 2) * k * Math.sin(a)]);
  }
  return poly(pts);
}

/** Le rayon relatif du creux, par nombre de branches (au plus près de Word). */
const STAR_INNER: Record<number, number> = { 4: 0.375, 5: 0.382, 6: 0.577, 8: 0.5, 12: 0.6 };

/**
 * Une flèche, dans les quatre directions.
 *
 * Un seul générateur : les trois autres directions sont la même liste de points
 * transposée. Quatre générateurs auraient divergé au premier ajustement.
 */
function arrow(w: number, h: number, thickPct: number, dir: "right" | "left" | "up" | "down"): string {
  const vertical = dir === "up" || dir === "down";
  // Raisonner dans le repère « vers la droite », puis transposer.
  const bw = vertical ? h : w;
  const bh = vertical ? w : h;
  const shaft = (bh * clamp(thickPct, 5, 95)) / 100;
  const head = Math.min(bw * 0.6, Math.max(bh * 0.75, bw * 0.25));
  const top = (bh - shaft) / 2;
  const local: [number, number][] = [
    [0, top], [bw - head, top], [bw - head, 0], [bw, bh / 2],
    [bw - head, bh], [bw - head, top + shaft], [0, top + shaft],
  ];
  const map = (p: [number, number]): [number, number] => {
    switch (dir) {
      case "right": return p;
      case "left": return [w - p[0], p[1]];
      case "down": return [p[1], p[0]];
      case "up": return [p[1], h - p[0]];
    }
  };
  return poly(local.map(map));
}

/** Une flèche à deux pointes, horizontale ou verticale. */
function doubleHeadArrow(w: number, h: number, thickPct: number, vertical: boolean): string {
  const bw = vertical ? h : w;
  const bh = vertical ? w : h;
  const shaft = (bh * clamp(thickPct, 5, 95)) / 100;
  const head = Math.min(bw * 0.35, Math.max(bh * 0.75, bw * 0.15));
  const top = (bh - shaft) / 2;
  const local: [number, number][] = [
    [0, bh / 2], [head, 0], [head, top], [bw - head, top], [bw - head, 0], [bw, bh / 2],
    [bw - head, bh], [bw - head, top + shaft], [head, top + shaft], [head, bh],
  ];
  return poly(local.map(([x, y]) => (vertical ? [y, x] : [x, y]) as [number, number]));
}

/** Le nuage : six lobes autour de la boîte, en arcs de cercle. */
function cloud(w: number, h: number): string {
  // Les lobes sont donnés en fractions de la boîte : centre, rayon horizontal et
  // vertical, angle de début et de fin. C'est ce qui garde le nuage reconnaissable
  // à n'importe quelle proportion.
  const lobes: [number, number, number, number, number, number][] = [
    [0.26, 0.62, 0.26, 0.30, 130, 340],
    [0.42, 0.36, 0.22, 0.26, 190, 350],
    [0.66, 0.34, 0.20, 0.24, 220, 20],
    [0.82, 0.56, 0.18, 0.24, 280, 90],
    [0.68, 0.76, 0.22, 0.24, 340, 160],
    [0.36, 0.80, 0.24, 0.22, 30, 210],
  ];
  let d = "";
  lobes.forEach(([cx, cy, rx, ry, a0, a1], i) => {
    const s = a0 * (Math.PI / 180);
    const e = (a1 > a0 ? a1 : a1 + 360) * (Math.PI / 180);
    d += arcCubics(cx * w, cy * h, rx * w, ry * h, s, e, i === 0);
  });
  return d + "Z";
}

/** Le soleil : un disque et huit rayons triangulaires. */
function sun(w: number, h: number): string {
  const cx = w / 2;
  const cy = h / 2;
  const core = 0.34;
  let d = ellipse(cx, cy, w * core, h * core);
  for (let i = 0; i < 8; i++) {
    const a = (i * TAU) / 8;
    const spread = TAU / 40;
    const p1: [number, number] = [cx + w * core * Math.cos(a - spread), cy + h * core * Math.sin(a - spread)];
    const p2: [number, number] = [cx + (w / 2) * Math.cos(a), cy + (h / 2) * Math.sin(a)];
    const p3: [number, number] = [cx + w * core * Math.cos(a + spread), cy + h * core * Math.sin(a + spread)];
    d += poly([p1, p2, p3]);
  }
  return d;
}

/** Le croissant : le disque de la boîte moins un disque décalé. */
function moon(w: number, h: number, thickPct: number) {
  const t = clamp(thickPct, 5, 95) / 100;
  // Arc extérieur (bord droit), puis arc intérieur en sens inverse : la
  // différence des deux dessine le croissant d'un seul tracé.
  const outer = arcCubics(w, h / 2, w, h / 2, Math.PI - Math.PI / 2.2, Math.PI + Math.PI / 2.2, true);
  const inner = arcCubics(w + w * (1 - t) * 0.9, h / 2, w, h / 2, Math.PI + Math.PI / 2.2, Math.PI - Math.PI / 2.2, false);
  return `${outer}${inner}Z`;
}

/** Les points de l'éclair, en fractions de la boîte (relevés sur la forme de Word). */
const BOLT: [number, number][] = [
  [0.44, 0], [0.86, 0.36], [0.62, 0.42], [1, 0.78], [0.72, 0.72],
  [0.78, 1], [0.36, 0.62], [0.56, 0.56], [0.2, 0.34], [0.42, 0.32],
];

/** Les rayons de l'explosion, alternés, en fractions du rayon de la boîte. */
const BURST = [1, 0.52, 0.86, 0.44, 1, 0.5, 0.78, 0.42, 0.94, 0.48, 0.84, 0.4, 1, 0.46, 0.8, 0.52];

type Gen = (w: number, h: number, adj: number) => string;

/**
 * Les générateurs de chemin, par forme.
 *
 * `adj` est le pourcentage d'ajustement de la forme (voir `ShapeDef.adj`) ; il est
 * déjà borné par `clampAdj`.
 */
const GEN: Record<ShapeKind, Gen> = {
  // Lignes : le tracé va d'un coin à l'autre de la boîte, comme dans Word.
  line: (w, h) => `M${pt(0, 0)}L${pt(w, h)}`,
  arrow: (w, h) => `M${pt(0, 0)}L${pt(w, h)}`,
  doubleArrow: (w, h) => `M${pt(0, 0)}L${pt(w, h)}`,
  elbow: (w, h) => `M${pt(0, 0)}L${pt(w / 2, 0)}L${pt(w / 2, h)}L${pt(w, h)}`,

  rect: (w, h) => poly([[0, 0], [w, 0], [w, h], [0, h]]),
  roundRect: (w, h, adj) => roundRect(w, h, (Math.min(w, h) * adj) / 100),
  snipRect: (w, h, adj) => {
    const c = (Math.min(w, h) * adj) / 100;
    return poly([[0, 0], [w - c, 0], [w, c], [w, h], [0, h]]);
  },
  stadium: (w, h) => roundRect(w, h, Math.min(w, h) / 2),
  frame: (w, h, adj) => {
    const t = Math.max(0.2, (Math.min(w, h) * adj) / 100);
    // Deux contours, le second en sens inverse : le remplissage `evenodd` creuse
    // le cadre sans avoir à dessiner quatre rectangles.
    return poly([[0, 0], [w, 0], [w, h], [0, h]]) + poly([[t, t], [t, h - t], [w - t, h - t], [w - t, t]]);
  },

  ellipse: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2),
  triangle: (w, h, adj) => poly([[(w * adj) / 100, 0], [w, h], [0, h]]),
  rtTriangle: (w, h) => poly([[0, 0], [0, h], [w, h]]),
  diamond: (w, h) => poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]),
  parallelogram: (w, h, adj) => {
    const o = Math.min(w / 2, (Math.min(w, h) * adj) / 100);
    return poly([[o, 0], [w, 0], [w - o, h], [0, h]]);
  },
  trapezoid: (w, h, adj) => {
    const o = Math.min(w / 2, (Math.min(w, h) * adj) / 100);
    return poly([[o, 0], [w - o, 0], [w, h], [0, h]]);
  },
  pentagon: (w, h) => regular(5, w, h, -90),
  // L'hexagone de Word est pointu à gauche et à droite, pas en haut.
  hexagon: (w, h) => regular(6, w, h, 0),
  heptagon: (w, h) => regular(7, w, h, -90),
  // Décalé d'un demi-secteur : c'est ce qui donne un octogone à côtés plats.
  octagon: (w, h) => regular(8, w, h, -67.5),
  cross: (w, h, adj) => {
    const tx = (w * adj) / 100;
    const ty = (h * adj) / 100;
    const x0 = (w - tx) / 2;
    const y0 = (h - ty) / 2;
    return poly([
      [x0, 0], [x0 + tx, 0], [x0 + tx, y0], [w, y0], [w, y0 + ty], [x0 + tx, y0 + ty],
      [x0 + tx, h], [x0, h], [x0, y0 + ty], [0, y0 + ty], [0, y0], [x0, y0],
    ]);
  },
  donut: (w, h, adj) => {
    const tx = (w * adj) / 100;
    const ty = (h * adj) / 100;
    return ellipse(w / 2, h / 2, w / 2, h / 2) + ellipse(w / 2, h / 2, w / 2 - tx, h / 2 - ty, false);
  },
  can: (w, h, adj) => {
    const ry = Math.min(h / 2, (h * adj) / 100);
    // Le corps : côté gauche, fond bombé, côté droit, puis le dessus bombé.
    const body =
      `M${pt(0, ry)}L${pt(0, h - ry)}` +
      arcCubics(w / 2, h - ry, w / 2, ry, Math.PI, 0, false) +
      `L${pt(w, ry)}` +
      arcCubics(w / 2, ry, w / 2, ry, 0, Math.PI, false) +
      "Z";
    return body + ellipse(w / 2, ry, w / 2, ry);
  },
  cube: (w, h, adj) => {
    const d = Math.min(Math.min(w, h) / 2, (Math.min(w, h) * adj) / 100);
    return (
      poly([[0, d], [d, 0], [w, 0], [w, h - d], [w - d, h], [0, h]]) +
      `M${pt(0, d)}L${pt(w - d, d)}L${pt(w, 0)}M${pt(w - d, d)}L${pt(w - d, h)}`
    );
  },
  heart: (w, h) =>
    `M${pt(w / 2, h)}` +
    `C${pt(-0.06 * w, 0.62 * h)} ${pt(0.06 * w, 0.02 * h)} ${pt(w / 2, 0.26 * h)}` +
    `C${pt(0.94 * w, 0.02 * h)} ${pt(1.06 * w, 0.62 * h)} ${pt(w / 2, h)}Z`,
  cloud,
  sun,
  moon: (w, h, adj) => moon(w, h, adj),
  bolt: (w, h) => poly(BOLT.map(([x, y]) => [x * w, y * h] as [number, number])),
  chevron: (w, h, adj) => {
    const n = Math.min(w / 2, (Math.min(w, h) * adj) / 100);
    return poly([[0, 0], [w - n, 0], [w, h / 2], [w - n, h], [0, h], [n, h / 2]]);
  },

  rightArrow: (w, h, adj) => arrow(w, h, adj, "right"),
  leftArrow: (w, h, adj) => arrow(w, h, adj, "left"),
  upArrow: (w, h, adj) => arrow(w, h, adj, "up"),
  downArrow: (w, h, adj) => arrow(w, h, adj, "down"),
  leftRightArrow: (w, h, adj) => doubleHeadArrow(w, h, adj, false),
  upDownArrow: (w, h, adj) => doubleHeadArrow(w, h, adj, true),
  homePlate: (w, h, adj) => {
    const n = Math.min(w / 2, (Math.min(w, h) * adj) / 100);
    return poly([[0, 0], [w - n, 0], [w, h / 2], [w - n, h], [0, h]]);
  },
  notchedArrow: (w, h, adj) => {
    const shaft = (h * clamp(adj, 5, 95)) / 100;
    const head = Math.min(w * 0.6, Math.max(h * 0.75, w * 0.25));
    const top = (h - shaft) / 2;
    const notch = Math.min(w * 0.2, head * 0.5);
    return poly([
      [0, top], [w - head, top], [w - head, 0], [w, h / 2], [w - head, h],
      [w - head, top + shaft], [0, top + shaft], [notch, h / 2],
    ]);
  },

  flowProcess: (w, h) => poly([[0, 0], [w, 0], [w, h], [0, h]]),
  flowDecision: (w, h) => poly([[w / 2, 0], [w, h / 2], [w / 2, h], [0, h / 2]]),
  flowTerminator: (w, h) => roundRect(w, h, Math.min(w, h) / 2),
  flowData: (w, h) => {
    const o = Math.min(w / 2, Math.min(w, h) * 0.2);
    return poly([[o, 0], [w, 0], [w - o, h], [0, h]]);
  },
  flowPreparation: (w, h) => {
    const o = Math.min(w / 2, Math.min(w, h) * 0.2);
    return poly([[o, 0], [w - o, 0], [w, h / 2], [w - o, h], [o, h], [0, h / 2]]);
  },
  flowConnector: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2),
  flowDocument: (w, h) => {
    const wave = Math.min(h * 0.2, h / 3);
    // Le bas ondulé : deux courbes symétriques, ce qui distingue un document
    // d'un processus au premier regard.
    return (
      `M${pt(0, 0)}L${pt(w, 0)}L${pt(w, h - wave)}` +
      `C${pt(w * 0.75, h - wave * 2.2)} ${pt(w * 0.25, h + wave * 0.9)} ${pt(0, h - wave * 0.6)}Z`
    );
  },
  flowManualInput: (w, h) => poly([[0, h * 0.28], [w, 0], [w, h], [0, h]]),
  flowDelay: (w, h) => {
    const rr = Math.min(w / 2, h / 2);
    return (
      `M${pt(0, 0)}L${pt(w - rr, 0)}` +
      arcCubics(w - rr, h / 2, rr, h / 2, -Math.PI / 2, Math.PI / 2, false) +
      `L${pt(0, h)}Z`
    );
  },

  star4: (w, h) => star(4, STAR_INNER[4]!, w, h),
  star5: (w, h) => star(5, STAR_INNER[5]!, w, h),
  star6: (w, h) => star(6, STAR_INNER[6]!, w, h),
  star8: (w, h) => star(8, STAR_INNER[8]!, w, h),
  star12: (w, h) => star(12, STAR_INNER[12]!, w, h),
  explosion: (w, h) =>
    poly(
      BURST.map((k, i) => {
        const a = (-90 + (i * 360) / BURST.length) * (Math.PI / 180);
        return [w / 2 + (w / 2) * k * Math.cos(a), h / 2 + (h / 2) * k * Math.sin(a)] as [number, number];
      }),
    ),
  ribbon: (w, h) => {
    // Une bannière : le bandeau central, et deux pans repliés aux extrémités.
    const tail = Math.min(w * 0.18, h);
    const band = h * 0.62;
    const notch = tail * 0.5;
    return poly([
      [0, 0], [tail, 0], [tail, band * 0.18], [w - tail, band * 0.18], [w - tail, 0], [w, 0],
      [w - notch, band / 2], [w, band], [w - tail, band], [w - tail, h], [tail, h], [tail, band],
      [0, band], [notch, band / 2],
    ]);
  },

  // Bulles : la queue est FONDUE dans le contour, sinon son attache se dessine
  // en travers de la bulle.
  calloutRect: (w, h) => {
    const bh = h * 0.76;
    return poly([
      [0, 0], [w, 0], [w, bh], [w * 0.34, bh], [w * 0.16, h], [w * 0.22, bh], [0, bh],
    ]);
  },
  calloutRoundRect: (w, h) => {
    const bh = h * 0.76;
    const rr = Math.min(w, bh) * 0.14;
    const q = KAPPA * rr;
    return (
      `M${pt(rr, 0)}L${pt(w - rr, 0)}` +
      `C${pt(w - rr + q, 0)} ${pt(w, rr - q)} ${pt(w, rr)}` +
      `L${pt(w, bh - rr)}` +
      `C${pt(w, bh - rr + q)} ${pt(w - rr + q, bh)} ${pt(w - rr, bh)}` +
      `L${pt(w * 0.34, bh)}L${pt(w * 0.16, h)}L${pt(w * 0.22, bh)}L${pt(rr, bh)}` +
      `C${pt(rr - q, bh)} ${pt(0, bh - rr + q)} ${pt(0, bh - rr)}` +
      `L${pt(0, rr)}` +
      `C${pt(0, rr - q)} ${pt(rr - q, 0)} ${pt(rr, 0)}Z`
    );
  },
  calloutEllipse: (w, h) => {
    const bh = h * 0.78;
    const cx = w / 2;
    const cy = bh / 2;
    const rx = w / 2;
    const ry = bh / 2;
    // Les deux points d'attache sur l'ellipse, puis l'arc qui les relie par le
    // grand côté : la queue prolonge le contour au lieu de le croiser.
    const a1 = Math.PI * 0.62;
    const a2 = Math.PI * 0.42;
    const p1: [number, number] = [cx + rx * Math.cos(a1), cy + ry * Math.sin(a1)];
    return (
      `M${pt(p1[0], p1[1])}` +
      `L${pt(w * 0.16, h)}` +
      `L${pt(cx + rx * Math.cos(a2), cy + ry * Math.sin(a2))}` +
      arcCubics(cx, cy, rx, ry, a2, a1 - TAU, false) +
      "Z"
    );
  },
};

/**
 * Le chemin d'une forme, en millimètres.
 *
 * Les dimensions sont bornées à une valeur positive : une forme de largeur nulle
 * produirait un chemin dégénéré (`NaN` compris) que le navigateur ignore
 * silencieusement, ce qui se lit comme « la forme a disparu ».
 */
export function shapePath(kind: unknown, widthMm: number, heightMm: number, adj?: unknown): string {
  const def = shapeDef(kind);
  const w = Math.max(0.5, num(widthMm, 10));
  const h = Math.max(0.5, num(heightMm, 10));
  const a = clampAdj(def.kind, adj ?? def.adj?.default ?? 0);
  return GEN[def.kind](w, h, a);
}

/**
 * Les pointes de flèche d'une forme de ligne (chemin plein, couleur du trait).
 *
 * Séparées du tracé parce qu'elles se remplissent alors que la ligne, elle, ne
 * fait que se tracer : un seul chemin obligerait à choisir entre les deux.
 */
export function shapeHeads(kind: unknown, widthMm: number, heightMm: number, sizeMm = 3): string {
  const def = shapeDef(kind);
  if (!def.head) return "";
  const w = Math.max(0.5, num(widthMm, 10));
  const h = Math.max(0.5, num(heightMm, 10));
  const len = Math.max(1.2, Math.min(sizeMm, Math.hypot(w, h) / 3));
  const head = (x: number, y: number, ax: number, ay: number): string => {
    const n = Math.hypot(ax, ay) || 1;
    const ux = ax / n;
    const uy = ay / n;
    // La base de la pointe, perpendiculaire à la direction de la ligne.
    const bx = x - ux * len;
    const by = y - uy * len;
    const half = len * 0.45;
    return poly([[x, y], [bx - uy * half, by + ux * half], [bx + uy * half, by - ux * half]]);
  };
  let d = head(w, h, w, h);
  if (def.head === "both") d += head(0, 0, -w, -h);
  return d;
}

/**
 * Un trait de détail, tracé sans remplissage (arête d'un cube, col d'un cylindre).
 *
 * Ces traits font partie du chemin renvoyé par `shapePath` — les isoler ici
 * permettrait de les styler autrement, mais rien n'en a besoin pour l'instant :
 * la fonction existe pour dire lesquels le sont, et le repérage se fait sur la
 * forme, pas sur une heuristique de tracé.
 */
export function hasDetailStrokes(kind: unknown): boolean {
  const k = shapeDef(kind).kind;
  return k === "cube" || k === "can" || k === "sun" || k === "donut" || k === "frame";
}

/** Le remplissage `evenodd` est requis dès qu'un contour en creuse un autre. */
export function usesEvenOdd(kind: unknown): boolean {
  const k = shapeDef(kind).kind;
  return k === "frame" || k === "donut";
}

// =========================================================================
// Rendu SVG (écran + export HTML)
// =========================================================================

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Millimètres depuis une épaisseur en pixels CSS (1 px = 1/96 pouce). */
export function pxToMm(px: number): number {
  return Math.round(((px * 25.4) / 96) * 100) / 100;
}

/**
 * Le SVG complet d'une forme.
 *
 * Le `viewBox` est en millimètres et l'élément fait 100 % de son conteneur, lui
 * aussi dimensionné en millimètres : une unité utilisateur vaut donc exactement
 * un millimètre, et l'épaisseur du trait s'exprime dans la même unité que la
 * géométrie. C'est ce qui garantit qu'un contour d'1 px reste d'1 px à l'écran
 * comme à l'impression, sans facteur d'échelle caché.
 *
 * `id` distingue les dégradés de deux formes de la même page ; sans lui, la
 * seconde réutiliserait la définition de la première.
 */
export function shapeSvg(
  kind: unknown,
  widthMm: number,
  heightMm: number,
  rawStyle: unknown,
  adj?: unknown,
  id = "s",
): string {
  const def = shapeDef(kind);
  const s = normalizeShapeStyle(rawStyle);
  const w = Math.max(0.5, num(widthMm, 10));
  const h = Math.max(0.5, num(heightMm, 10));
  const d = shapePath(def.kind, w, h, adj);
  const heads = shapeHeads(def.kind, w, h);
  const strokeMm = s.strokeWidth > 0 ? pxToMm(s.strokeWidth) : 0;
  const gradId = `elium-grad-${id}`;

  const defs =
    !def.line && s.fill && s.gradient
      ? `<defs>${
          s.gradient === "radial"
            ? `<radialGradient id="${gradId}"><stop offset="0" stop-color="${esc(s.fill)}"/>` +
              `<stop offset="1" stop-color="${esc(s.fill2)}"/></radialGradient>`
            : `<linearGradient id="${gradId}" gradientTransform="rotate(${s.gradientAngle} .5 .5)">` +
              `<stop offset="0" stop-color="${esc(s.fill)}"/><stop offset="1" stop-color="${esc(s.fill2)}"/></linearGradient>`
        }</defs>`
      : "";

  const fill = def.line
    ? "none"
    : !s.fill
      ? "none"
      : s.gradient
        ? `url(#${gradId})`
        : esc(s.fill);
  const dash = DASH_PATTERN[s.dash];
  const dashAttr =
    strokeMm > 0 && dash.length
      ? ` stroke-dasharray="${dash.map((n) => r2(n * Math.max(strokeMm, 0.2))).join(" ")}"`
      : "";
  const strokeAttrs =
    strokeMm > 0
      ? ` stroke="${esc(s.strokeColor)}" stroke-width="${strokeMm}" stroke-linejoin="round" stroke-linecap="round"${dashAttr}`
      : ' stroke="none"';
  const fillRule = usesEvenOdd(def.kind) ? ' fill-rule="evenodd"' : "";
  const opacity = !def.line && s.fill && s.fillOpacity < 1 ? ` fill-opacity="${r2(s.fillOpacity)}"` : "";
  const shadow = s.shadow
    ? ` filter="drop-shadow(${r2(0.8)}mm ${r2(0.8)}mm ${r2(0.9)}mm rgba(15,23,42,.35))"`
    : "";

  return (
    `<svg class="elium-shape__svg" viewBox="0 0 ${r2(w)} ${r2(h)}" width="100%" height="100%" ` +
    `preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">` +
    defs +
    `<path d="${d}" fill="${fill}"${fillRule}${opacity}${strokeAttrs}${shadow}/>` +
    (heads ? `<path d="${heads}" fill="${esc(s.strokeColor)}" stroke="none"/>` : "") +
    `</svg>`
  );
}

/** Hauteur par défaut d'une forme : contrairement à un encadré, aucun contenu ne la dicte. */
export const DEFAULT_SHAPE_HEIGHT_MM = 25;
export const DEFAULT_SHAPE_WIDTH_MM = 40;

/**
 * Le style du conteneur d'une forme.
 *
 * Le conteneur ne porte QUE la taille, le placement (partagé avec les zones de
 * texte) et la couleur du texte : le dessin est dans le SVG. Un conteneur qui
 * porterait aussi une bordure CSS doublerait le contour de la forme.
 *
 * Vit ici, et non dans l'extension TipTap, parce que l'export HTML en a besoin
 * sans embarquer l'éditeur : un second générateur finirait par placer la forme à
 * deux endroits différents.
 */
export function shapeContainerCss(geometry: unknown, rawStyle: unknown, heightMm?: number): string {
  const g = normalizeGeometry(geometry);
  const s = normalizeShapeStyle(rawStyle);
  const h = num(heightMm, 0) > 0 ? num(heightMm, 0) : g.heightMm > 0 ? g.heightMm : DEFAULT_SHAPE_HEIGHT_MM;
  return [
    `width:${g.widthMm}mm`,
    `height:${r2(h)}mm`,
    "box-sizing:border-box",
    `color:${s.textColor}`,
    ...wrapCss(g),
  ].join(";");
}

/** L'alignement vertical du texte, en `justify-content` du conteneur flex. */
export function vAlignCss(vAlign: unknown): string {
  return vAlign === "top" ? "flex-start" : vAlign === "bottom" ? "flex-end" : "center";
}

// =========================================================================
// OOXML
// =========================================================================

/** Millimètres en EMU (914 400 par pouce), l'unité de DrawingML. */
export function mmToEmu(mm: number): number {
  return Math.round((num(mm, 0) / 25.4) * 914400);
}

/** EMU en millimètres, pour la relecture d'un DOCX. */
export function emuToMm(emu: unknown): number {
  return Math.round((num(emu, 0) / 914400) * 25.4 * 10) / 10;
}

/**
 * La forme correspondant à une géométrie préréglée OOXML.
 *
 * Sert à la relecture d'un DOCX : sans elle, une forme exportée puis réimportée
 * reviendrait en rectangle. Plusieurs formes peuvent partager un `prst` (un
 * rectangle à bouts ronds EST un `flowChartTerminator`) — la première déclarée
 * gagne, ce qui garde le catalogue comme unique source.
 */
const BY_PRST = new Map<string, ShapeKind>();
for (const s of SHAPES) if (!BY_PRST.has(s.prst)) BY_PRST.set(s.prst, s.kind);

export function kindFromPrst(prst: unknown): ShapeKind | null {
  return BY_PRST.get(String(prst ?? "")) ?? null;
}

/** Le motif de tirets correspondant à un `a:prstDash/@val`. */
export function dashFromOoxml(val: unknown): DashStyle {
  const v = String(val ?? "");
  for (const [k, name] of Object.entries(DASH_OOXML)) if (name === v) return k as DashStyle;
  // Les variantes de Word (`sysDash`, `dashDotDot`, `lgDashDot`…) n'ont pas
  // d'équivalent exact. Le repli va du plus spécifique au plus général : tester
  // « dot » d'abord ferait passer « dashDotDot » pour du pointillé.
  if (/lg(dash)/i.test(v) && !/dot/i.test(v)) return "longDash";
  if (/dashdot/i.test(v)) return "dashDot";
  if (/dash/i.test(v)) return "dash";
  if (/dot/i.test(v)) return "dot";
  return "solid";
}

/** Une couleur hexadécimale sans dièse, comme l'attend `a:srgbClr/@val`. */
function rgb(hex: string): string {
  return String(hex ?? "").replace(/^#/, "").toUpperCase();
}

/**
 * Le chemin VML équivalent, en coordonnées de la boîte de la forme.
 *
 * Conversion mécanique parce que les chemins n'utilisent que M, L, C et Z : VML
 * connaît `m`, `l`, `c`, `x` (fermer) et `e` (fin). Les coordonnées sont mises à
 * l'échelle d'un espace de 21 600 unités — la convention de VML — et arrondies à
 * l'entier, ce que le format exige.
 */
export function vmlPath(svgPath: string, widthMm: number, heightMm: number, coord = 21600): string {
  const w = Math.max(0.5, num(widthMm, 10));
  const h = Math.max(0.5, num(heightMm, 10));
  const sx = coord / w;
  const sy = coord / h;
  let out = "";
  // Un balayage de tokens : une lettre de commande, puis des paires de nombres.
  const re = /([MLCZ])([^MLCZ]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svgPath))) {
    const cmd = m[1]!.toUpperCase();
    const nums = (m[2] ?? "").trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (cmd === "Z") {
      out += "x";
      continue;
    }
    const pairs: string[] = [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      pairs.push(`${Math.round(nums[i]! * sx)},${Math.round(nums[i + 1]! * sy)}`);
    }
    if (!pairs.length) continue;
    out += (cmd === "M" ? "m" : cmd === "L" ? "l" : "c") + pairs.join(",");
  }
  return `${out}e`;
}

/** L'habillage DrawingML : ancrée hors flux, ou dans le flux. */
function wrapDml(g: TextBoxGeometry): { anchored: boolean; behind: boolean; wrapEl: string } {
  switch (g.wrap) {
    case "inline":
      return { anchored: false, behind: false, wrapEl: "" };
    case "square":
      return { anchored: true, behind: false, wrapEl: '<wp:wrapSquare wrapText="bothSides"/>' };
    case "front":
      return { anchored: true, behind: false, wrapEl: "<wp:wrapNone/>" };
    case "behind":
      return { anchored: true, behind: true, wrapEl: "<wp:wrapNone/>" };
  }
}

/**
 * La forme en DrawingML (`wps:wsp`), enveloppée dans son `w:drawing`.
 *
 * C'est la branche que Word 2007 et suivants lisent, et celle qui porte la vraie
 * **géométrie préréglée** : la forme y reste éditable (poignées d'ajustement,
 * changement de forme) au lieu d'arriver comme un tracé mort. `inner` est du XML
 * de blocs `w:p` — le contenu d'une forme est du document ordinaire.
 */
export function shapeDml(
  kind: unknown,
  geometry: unknown,
  rawStyle: unknown,
  inner: string,
  id: number,
  adj?: unknown,
): string {
  const def = shapeDef(kind);
  const g = normalizeGeometry(geometry);
  const s = normalizeShapeStyle(rawStyle);
  const { anchored, behind, wrapEl } = wrapDml(g);
  const cx = mmToEmu(g.widthMm);
  const cy = mmToEmu(g.heightMm > 0 ? g.heightMm : 20);
  const rot = g.rotation ? ` rot="${Math.round(g.rotation * 60000)}"` : "";

  const alpha = s.fillOpacity < 1 ? `<a:alpha val="${Math.round(s.fillOpacity * 100000)}"/>` : "";
  /** Une couleur, refermée sur elle-même quand elle ne porte pas d'opacité. */
  const clr = (hex: string) =>
    alpha ? `<a:srgbClr val="${rgb(hex)}">${alpha}</a:srgbClr>` : `<a:srgbClr val="${rgb(hex)}"/>`;
  const fillXml = def.line || !s.fill
    ? "<a:noFill/>"
    : s.gradient
      ? `<a:gradFill rotWithShape="1"><a:gsLst>` +
        `<a:gs pos="0">${clr(s.fill)}</a:gs>` +
        `<a:gs pos="100000">${clr(s.fill2)}</a:gs></a:gsLst>` +
        (s.gradient === "radial"
          ? '<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>'
          : `<a:lin ang="${Math.round(s.gradientAngle * 60000)}" scaled="0"/>`) +
        `</a:gradFill>`
      : `<a:solidFill>${clr(s.fill)}</a:solidFill>`;

  const lnXml =
    s.strokeWidth > 0
      ? `<a:ln w="${Math.round(pxToMm(s.strokeWidth) * 36000)}">` +
        `<a:solidFill><a:srgbClr val="${rgb(s.strokeColor)}"/></a:solidFill>` +
        `<a:prstDash val="${DASH_OOXML[s.dash]}"/>` +
        (def.head
          ? '<a:tailEnd type="triangle" w="med" len="med"/>' +
            (def.head === "both" ? '<a:headEnd type="triangle" w="med" len="med"/>' : "")
          : "") +
        `</a:ln>`
      : "<a:ln><a:noFill/></a:ln>";

  const effect = s.shadow
    ? '<a:effectLst><a:outerShdw blurRad="50800" dist="38100" dir="2700000" algn="tl" rotWithShape="0">' +
      '<a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst>'
    : "";

  const avLst = def.adj
    ? `<a:avLst><a:gd name="adj" fmla="val ${Math.round(clampAdj(def.kind, adj ?? def.adj.default) * 1000)}"/></a:avLst>`
    : "<a:avLst/>";

  const anchorAttr = s.vAlign === "top" ? "t" : s.vAlign === "bottom" ? "b" : "ctr";
  const insEmu = Math.round(mmToEmu(s.padMm));
  const txbx =
    def.line || !inner
      ? ""
      : `<wps:txbx><w:txbxContent>${inner}</w:txbxContent></wps:txbx>`;
  const bodyPr =
    `<wps:bodyPr rot="0" wrap="square" lIns="${insEmu}" tIns="${insEmu}" rIns="${insEmu}" bIns="${insEmu}" ` +
    `anchor="${anchorAttr}" anchorCtr="0"><a:noAutofit/></wps:bodyPr>`;

  // Pas de `txBox="1"` : dans Word, ce drapeau distingue une VRAIE zone de texte
  // d'une forme qui contient du texte. Le poser ferait revenir toutes nos formes
  // rectangulaires en zones de texte à la relecture du DOCX.
  const wsp =
    `<wps:wsp><wps:cNvSpPr/>` +
    `<wps:spPr><a:xfrm${rot}><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="${def.prst}">${avLst}</a:prstGeom>${fillXml}${lnXml}${effect}</wps:spPr>` +
    txbx +
    bodyPr +
    `</wps:wsp>`;

  const graphic =
    `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">` +
    `${wsp}</a:graphicData></a:graphic>`;
  const docPr = `<wp:docPr id="${id}" name="${esc(def.label)} ${id}"/><wp:cNvGraphicFramePr/>`;
  const extent = `<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>`;

  if (!anchored) {
    return (
      `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
      `${extent}${docPr}${graphic}</wp:inline></w:drawing>`
    );
  }
  // Hors du flux : la position est relative à la PAGE, comme à l'écran, et
  // `behindDoc` est ce qui fait passer la forme derrière le texte.
  return (
    `<w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" ` +
    `relativeHeight="${behind ? 251657728 : 251658240}" behindDoc="${behind ? 1 : 0}" locked="0" ` +
    `layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/>` +
    `<wp:positionH relativeFrom="page"><wp:posOffset>${mmToEmu(g.x)}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="page"><wp:posOffset>${mmToEmu(g.y)}</wp:posOffset></wp:positionV>` +
    `${extent}${wrapEl}${docPr}${graphic}</wp:anchor></w:drawing>`
  );
}

/**
 * La même forme en VML, pour le repli.
 *
 * Word 2007+ lit la branche DrawingML ; ce repli sert aux lecteurs plus anciens
 * (et à ceux qui ignorent `wps`). Le tracé vient du **même** générateur, converti,
 * donc les deux branches ne peuvent pas représenter deux formes différentes.
 */
export function shapeVml(
  kind: unknown,
  geometry: unknown,
  rawStyle: unknown,
  inner: string,
  id: string,
  adj?: unknown,
): string {
  const def = shapeDef(kind);
  const g = normalizeGeometry(geometry);
  const s = normalizeShapeStyle(rawStyle);
  const h = g.heightMm > 0 ? g.heightMm : 20;
  const path = vmlPath(shapePath(def.kind, g.widthMm, h, adj), g.widthMm, h);
  const floating = g.wrap === "front" || g.wrap === "behind";
  const style = [
    g.wrap === "inline" ? "" : "position:absolute",
    `width:${mmToPt(g.widthMm)}pt`,
    `height:${mmToPt(h)}pt`,
    g.wrap === "front" ? "z-index:251658240" : g.wrap === "behind" ? "z-index:-251658240" : "",
    ...(floating
      ? [
          `margin-left:${mmToPt(g.x)}pt`,
          `margin-top:${mmToPt(g.y)}pt`,
          "mso-position-horizontal-relative:page",
          "mso-position-vertical-relative:page",
        ]
      : []),
    g.rotation ? `rotation:${g.rotation}` : "",
  ]
    .filter(Boolean)
    .join(";");
  const stroke =
    s.strokeWidth > 0
      ? ` strokecolor="${esc(s.strokeColor)}" strokeweight="${(s.strokeWidth * 0.75).toFixed(2)}pt"`
      : ' stroked="f"';
  const fill = def.line || !s.fill ? ' filled="f"' : ` fillcolor="${esc(s.fill)}"`;
  const wrapEl =
    g.wrap === "inline"
      ? '<w10:wrap type="inline"/>'
      : g.wrap === "square"
        ? '<w10:wrap type="square"/>'
        : '<w10:wrap type="none"/>';
  const textbox =
    def.line || !inner
      ? ""
      : `<v:textbox inset="${mmToPt(s.padMm)}pt,${mmToPt(s.padMm)}pt,${mmToPt(s.padMm)}pt,${mmToPt(s.padMm)}pt">` +
        `<w:txbxContent>${inner}</w:txbxContent></v:textbox>`;
  return (
    `<v:shape id="${esc(id)}" style="${esc(style)}" coordsize="21600,21600" path="${esc(path)}"` +
    `${stroke}${fill}>${textbox}${wrapEl}</v:shape>`
  );
}

/**
 * La forme prête à être écrite dans `document.xml`.
 *
 * Les deux branches voyagent dans un `mc:AlternateContent` : Word prend la
 * première qu'il comprend. Écrire seulement du VML aurait figé la géométrie ;
 * écrire seulement du DrawingML aurait perdu les lecteurs anciens.
 */
export function shapeXml(
  kind: unknown,
  geometry: unknown,
  style: unknown,
  inner: string,
  seq: number,
  adj?: unknown,
): string {
  const dml = shapeDml(kind, geometry, style, inner, seq, adj);
  const vml = shapeVml(kind, geometry, style, inner, `EliumShape${seq}`, adj);
  return (
    `<w:p><w:r><w:rPr><w:noProof/></w:rPr><mc:AlternateContent>` +
    `<mc:Choice Requires="wps">${dml}</mc:Choice>` +
    `<mc:Fallback><w:pict>${vml}</w:pict></mc:Fallback>` +
    `</mc:AlternateContent></w:r></w:p>`
  );
}
