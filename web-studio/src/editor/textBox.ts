/**
 * Zones de texte flottantes : géométrie, habillage et sérialisation.
 *
 * Une zone de texte est un **conteneur de blocs**, pas un nœud de texte : elle
 * accueille des paragraphes, des listes, un tableau. En faire un atome à contenu
 * plat aurait interdit tout ce qui fait l'intérêt d'un encadré.
 *
 * L'habillage décide de la façon dont elle occupe l'espace, et c'est ce qui
 * conditionne son effet sur la pagination :
 *   - `inline`   : un bloc ordinaire dans le flux, donc paginé normalement ;
 *   - `square`   : flottante, le texte coule autour ;
 *   - `front`/`behind` : positionnée en absolu sur la feuille, **hors du flux** —
 *     le moteur de pagination l'ignore donc entièrement, ce qui est voulu : une
 *     zone posée librement ne doit pas pousser le texte d'une page.
 *
 * Positions et tailles sont en millimètres, comme la géométrie de page et la
 * règle graduée, pour qu'aucune conversion ne traîne dans l'interface.
 */

/** Modes d'habillage, alignés sur ceux de Word. */
export type WrapMode = "inline" | "square" | "front" | "behind";

export const WRAP_MODES: readonly WrapMode[] = ["inline", "square", "front", "behind"] as const;

export const WRAP_LABELS: Record<WrapMode, string> = {
  inline: "Dans le texte",
  square: "Habillage carré",
  front: "Devant le texte",
  behind: "Derrière le texte",
};

/** Côté vers lequel une zone en habillage carré flotte. */
export type FloatSide = "left" | "right";

export interface TextBoxGeometry {
  /** Décalage depuis le bord gauche du contenu, en mm. */
  x: number;
  /** Décalage depuis le haut du contenu, en mm. */
  y: number;
  widthMm: number;
  /** Hauteur en mm ; 0 laisse la zone s'ajuster à son contenu. */
  heightMm: number;
  wrap: WrapMode;
  side: FloatSide;
}

/** Taille minimale exploitable : en deçà, la zone n'est plus saisissable. */
export const MIN_WIDTH_MM = 15;
export const MIN_HEIGHT_MM = 8;
/** Garde-fou large : une zone plus grande qu'un A0 vient forcément d'un bug. */
export const MAX_MM = 1200;

export const DEFAULT_GEOMETRY: TextBoxGeometry = {
  x: 0,
  y: 0,
  widthMm: 60,
  heightMm: 0,
  wrap: "square",
  side: "right",
};

export interface TextBoxStyle {
  /** Épaisseur du filet en px ; 0 = aucune bordure. */
  borderWidth: number;
  borderColor: string;
  /** Remplissage ; chaîne vide = transparent. */
  fill: string;
  /** Marge intérieure en mm. */
  padMm: number;
  /** Rayon des coins en px. */
  radius: number;
}

export const DEFAULT_STYLE: TextBoxStyle = {
  borderWidth: 1,
  borderColor: "#cbd5e1",
  fill: "",
  padMm: 3,
  radius: 4,
};

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Quantifie au dixième de millimètre, comme les taquets (stabilité twips). */
const q = (n: number) => Math.round(n * 10) / 10;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function isWrap(v: unknown): v is WrapMode {
  return typeof v === "string" && (WRAP_MODES as readonly string[]).includes(v);
}

const HEX = /^#[0-9a-f]{6}$/i;

/** Une géométrie nettoyée et bornée. */
export function normalizeGeometry(raw: unknown): TextBoxGeometry {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const wrap = isWrap(r.wrap) ? r.wrap : DEFAULT_GEOMETRY.wrap;
  return {
    // Une position négative arrive d'un glisser parti hors de la feuille : la
    // borner vaut mieux que laisser la zone devenir inatteignable.
    x: q(clamp(num(r.x, 0), 0, MAX_MM)),
    y: q(clamp(num(r.y, 0), 0, MAX_MM)),
    widthMm: q(clamp(num(r.widthMm, DEFAULT_GEOMETRY.widthMm), MIN_WIDTH_MM, MAX_MM)),
    // 0 est une valeur légitime : « ajuste-toi au contenu ».
    heightMm: (() => {
      const h = num(r.heightMm, 0);
      return h <= 0 ? 0 : q(clamp(h, MIN_HEIGHT_MM, MAX_MM));
    })(),
    wrap,
    side: r.side === "left" ? "left" : "right",
  };
}

/** Un style nettoyé. */
export function normalizeStyle(raw: unknown): TextBoxStyle {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    borderWidth: clamp(Math.round(num(r.borderWidth, DEFAULT_STYLE.borderWidth)), 0, 12),
    borderColor: HEX.test(String(r.borderColor ?? "")) ? String(r.borderColor) : DEFAULT_STYLE.borderColor,
    // Chaîne vide = transparent, ce qui n'est PAS la même chose que blanc : une
    // zone transparente laisse voir le filigrane et le texte derrière.
    fill: HEX.test(String(r.fill ?? "")) ? String(r.fill) : "",
    padMm: q(clamp(num(r.padMm, DEFAULT_STYLE.padMm), 0, 40)),
    radius: clamp(Math.round(num(r.radius, DEFAULT_STYLE.radius)), 0, 40),
  };
}

/** Vrai si l'habillage sort la zone du flux (donc de la pagination). */
export function isFloating(wrap: unknown): boolean {
  const w = isWrap(wrap) ? wrap : DEFAULT_GEOMETRY.wrap;
  return w === "front" || w === "behind";
}

/**
 * Le style en ligne d'une zone à l'écran et en HTML.
 *
 * Un seul générateur pour les deux surfaces : deux feuilles séparées finiraient
 * par placer la zone à deux endroits différents.
 */
export function textBoxCss(geometry: unknown, style: unknown): string {
  const g = normalizeGeometry(geometry);
  const s = normalizeStyle(style);
  const parts: string[] = [
    `width:${g.widthMm}mm`,
    `padding:${s.padMm}mm`,
    `box-sizing:border-box`,
  ];
  if (g.heightMm > 0) parts.push(`min-height:${g.heightMm}mm`);
  if (s.borderWidth > 0) parts.push(`border:${s.borderWidth}px solid ${s.borderColor}`);
  else parts.push("border:0");
  if (s.fill) parts.push(`background:${s.fill}`);
  if (s.radius > 0) parts.push(`border-radius:${s.radius}px`);

  switch (g.wrap) {
    case "inline":
      // Dans le flux : la largeur reste imposée, mais rien ne flotte.
      parts.push("display:block", `margin:2mm ${g.side === "right" ? "0 2mm auto" : "auto 2mm 0"}`);
      break;
    case "square":
      parts.push(`float:${g.side}`, g.side === "right" ? "margin:0 0 3mm 4mm" : "margin:0 4mm 3mm 0");
      break;
    case "front":
    case "behind":
      // Hors du flux : la pagination l'ignore, ce qui est le but d'une zone
      // posée librement.
      parts.push("position:absolute", `left:${g.x}mm`, `top:${g.y}mm`);
      parts.push(g.wrap === "front" ? "z-index:3" : "z-index:0");
      break;
  }
  return parts.join(";");
}

// --- OOXML ----------------------------------------------------------------

/** Millimètres en points (1 pt = 1/72 pouce). */
export function mmToPt(mm: number): number {
  return Math.round((mm / 25.4) * 72 * 100) / 100;
}

/** L'habillage OOXML correspondant (`v:shape/@style` + `w10:wrap`). */
export function wrapVml(wrap: unknown): { style: string; wrapEl: string } {
  const w = isWrap(wrap) ? wrap : DEFAULT_GEOMETRY.wrap;
  switch (w) {
    case "inline":
      return { style: "", wrapEl: '<w10:wrap type="inline"/>' };
    case "square":
      return { style: "position:absolute", wrapEl: '<w10:wrap type="square"/>' };
    case "front":
      return { style: "position:absolute;z-index:251658240", wrapEl: '<w10:wrap type="none"/>' };
    case "behind":
      // Un z-index NÉGATIF est ce qui met la forme derrière le texte dans Word ;
      // `type="none"` seul la laisserait devant.
      return { style: "position:absolute;z-index:-251658240", wrapEl: '<w10:wrap type="none"/>' };
  }
}

function esc(v: string): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * La forme VML d'une zone de texte, avec son contenu déjà sérialisé.
 *
 * Word lit les zones de texte en **VML** (`v:shape` + `v:textbox` +
 * `w:txbxContent`) : c'est un dialecte hérité, mais c'est la forme que toutes les
 * versions ouvrent sans broncher, contrairement à DrawingML dont le support
 * varie. `inner` est du XML de blocs `w:p`, produit par l'écrivain habituel — le
 * contenu d'une zone est du document ordinaire.
 */
export function textBoxVml(geometry: unknown, style: unknown, inner: string, id: string): string {
  const g = normalizeGeometry(geometry);
  const s = normalizeStyle(style);
  const { style: posStyle, wrapEl } = wrapVml(g.wrap);
  const dims = [
    `width:${mmToPt(g.widthMm)}pt`,
    g.heightMm > 0 ? `height:${mmToPt(g.heightMm)}pt` : "",
  ].filter(Boolean);
  const place = g.wrap === "front" || g.wrap === "behind"
    ? [`margin-left:${mmToPt(g.x)}pt`, `margin-top:${mmToPt(g.y)}pt`,
       "mso-position-horizontal-relative:page", "mso-position-vertical-relative:page"]
    : [];
  const shapeStyle = [posStyle, ...dims, ...place].filter(Boolean).join(";");
  const stroke = s.borderWidth > 0
    ? ` strokecolor="${esc(s.borderColor)}" strokeweight="${(s.borderWidth * 0.75).toFixed(2)}pt"`
    : ' stroked="f"';
  const fill = s.fill ? ` fillcolor="${esc(s.fill)}"` : ' filled="f"';
  const inset = `inset="${mmToPt(s.padMm)}pt,${mmToPt(s.padMm)}pt,${mmToPt(s.padMm)}pt,${mmToPt(s.padMm)}pt"`;
  return (
    `<w:p><w:r><w:rPr><w:noProof/></w:rPr><w:pict>` +
    `<v:shape id="${esc(id)}" type="#_x0000_t202" style="${esc(shapeStyle)}"${stroke}${fill}>` +
    `<v:textbox ${inset}><w:txbxContent>${inner || "<w:p/>"}</w:txbxContent></v:textbox>` +
    `${wrapEl}</v:shape></w:pict></w:r></w:p>`
  );
}

/**
 * Le `v:shapetype` du rectangle à texte, déclaré une fois par document.
 *
 * `#_x0000_t202` est l'identifiant canonique de la zone de texte ; sans sa
 * déclaration, Word ouvre le fichier mais dessine des formes vides.
 */
export function textBoxShapeType(): string {
  return (
    '<w:p><w:r><w:rPr><w:noProof/></w:rPr><w:pict>' +
    '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">' +
    '<v:stroke joinstyle="miter"/>' +
    '<v:path gradientshapeok="t" o:connecttype="rect"/>' +
    "</v:shapetype></w:pict></w:r></w:p>"
  );
}
