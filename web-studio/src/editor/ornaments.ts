/**
 * Symboles, lettrine et filigrane : la logique pure des trois « ornements ».
 *
 * Rien de commun entre eux fonctionnellement, mais tous trois ont la même forme
 * — une table de données et quelques fonctions de conversion — et tous trois
 * doivent produire exactement le même résultat à l'écran, en HTML et en OOXML.
 * Les garder ici évite qu'une des trois surfaces dérive.
 */

// --- Symboles -------------------------------------------------------------

export interface SymbolGroup {
  id: string;
  label: string;
  chars: string[];
}

/**
 * Le catalogue de symboles, organisé comme la boîte « Symbole » de Word.
 *
 * Les caractères sont écrits littéralement plutôt que par point de code : le
 * fichier est en UTF-8, et une table lisible se relit et se corrige.
 */
export const SYMBOL_GROUPS: readonly SymbolGroup[] = [
  {
    id: "punct",
    label: "Ponctuation",
    chars: ["…", "—", "–", "‑", "«", "»", "“", "”", "‘", "’", "•", "·", "†", "‡", "§", "¶", "‰", "№"],
  },
  {
    id: "math",
    label: "Mathématiques",
    chars: ["±", "×", "÷", "≠", "≈", "≡", "≤", "≥", "∞", "√", "∑", "∏", "∫", "∂", "∆", "∇", "∈", "∉", "⊂", "⊃", "∪", "∩", "∅", "∀", "∃", "¬", "∧", "∨"],
  },
  {
    id: "greek",
    label: "Grec",
    chars: ["α", "β", "γ", "δ", "ε", "ζ", "η", "θ", "ι", "κ", "λ", "μ", "ν", "ξ", "π", "ρ", "σ", "τ", "υ", "φ", "χ", "ψ", "ω", "Γ", "Δ", "Θ", "Λ", "Ξ", "Π", "Σ", "Φ", "Ψ", "Ω"],
  },
  {
    id: "currency",
    label: "Monnaies",
    chars: ["€", "$", "£", "¥", "₽", "₹", "₩", "₪", "₫", "₴", "₺", "¢", "¤"],
  },
  {
    id: "arrows",
    label: "Flèches",
    chars: ["←", "→", "↑", "↓", "↔", "↕", "⇐", "⇒", "⇑", "⇓", "⇔", "↵", "⤶", "➔", "➜"],
  },
  {
    id: "marks",
    label: "Marques",
    chars: ["©", "®", "™", "°", "µ", "℃", "℉", "✓", "✔", "✗", "✘", "★", "☆", "☑", "☒", "☐", "♦", "♣", "♥", "♠"],
  },
  {
    id: "spaces",
    label: "Espaces et tirets",
    chars: [" ", " ", " ", " ", "​", "‑"],
  },
];

/** Noms lisibles des caractères invisibles, sans quoi la grille afficherait du vide. */
export const INVISIBLE_NAMES: Record<string, string> = {
  " ": "Espace insécable",
  " ": "Espace fine insécable",
  " ": "Espace fine",
  " ": "Espace chiffre",
  "​": "Espace sans largeur",
  "‑": "Trait d'union insécable",
};

/** Le nom d'un symbole : son nom lisible s'il est invisible, sinon son point de code. */
export function symbolName(ch: string): string {
  const named = INVISIBLE_NAMES[ch];
  if (named) return named;
  const cp = ch.codePointAt(0);
  return cp == null ? ch : `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** Vrai si le caractère n'a pas de glyphe visible et demande une étiquette. */
export function isInvisible(ch: string): boolean {
  return ch in INVISIBLE_NAMES;
}

/** Les symboles d'un groupe, ou tous si l'identifiant est inconnu. */
export function symbolsOf(groupId: string | null | undefined): string[] {
  if (!groupId) return SYMBOL_GROUPS.flatMap((g) => [...g.chars]);
  return [...(SYMBOL_GROUPS.find((g) => g.id === groupId)?.chars ?? [])];
}

/**
 * Recherche un symbole par nom ou par point de code.
 *
 * Accepte « U+00E9 », « 00e9 » ou un fragment de nom : c'est ce qu'on tape
 * naturellement quand on cherche une espace insécable.
 */
export function findSymbols(query: string): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return symbolsOf(null);
  const hex = /^(?:u\+)?([0-9a-f]{2,6})$/.exec(q)?.[1];
  if (hex) {
    const cp = parseInt(hex, 16);
    if (Number.isFinite(cp) && cp > 0) {
      try {
        return [String.fromCodePoint(cp)];
      } catch {
        return [];
      }
    }
  }
  return symbolsOf(null).filter(
    (ch) => symbolName(ch).toLowerCase().includes(q) || ch === q,
  );
}

// --- Lettrine -------------------------------------------------------------

/** Position de la lettrine, dans les valeurs de `w:dropCap`. */
export type DropCapKind = "none" | "drop" | "margin";

export const DROP_CAP_LABELS: Record<DropCapKind, string> = {
  none: "Aucune",
  drop: "Dans le texte",
  margin: "Dans la marge",
};

/** Nombre de lignes qu'une lettrine peut occuper. */
export const DROP_CAP_LINES = [2, 3, 4, 5] as const;

export const DEFAULT_DROP_LINES = 3;

/** Borne le nombre de lignes d'une lettrine dans la plage utile. */
export function clampDropLines(n: unknown): number {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_DROP_LINES;
  return Math.min(5, Math.max(2, v));
}

/**
 * Le CSS d'une lettrine.
 *
 * `initial-letter` n'est pas encore fiable partout, donc on flotte la première
 * lettre et on cale sa taille sur la hauteur de ligne : c'est plus verbeux mais
 * le rendu est identique dans tous les navigateurs.
 */
export function dropCapCss(kind: DropCapKind, lines: number, lineHeight = 1.5): string {
  if (kind === "none") return "";
  const n = clampDropLines(lines);
  // La lettre doit couvrir `n` lignes : sa taille vaut n × interligne, et on
  // l'assied sur la ligne de base par un interligne propre à 1.
  const fontSize = `${(n * lineHeight).toFixed(2)}em`;
  const margin = kind === "margin" ? "margin-left:-.7em;" : "";
  return (
    `float:left;font-size:${fontSize};line-height:1;` +
    `padding-right:.06em;margin-top:.05em;margin-bottom:-.08em;${margin}`
  );
}

/** Le `w:framePr` d'une lettrine, tel que Word l'attend. */
export function dropCapXml(kind: DropCapKind, lines: number): string {
  if (kind === "none") return "";
  const n = clampDropLines(lines);
  // `w:dropCap` porte la position, `w:lines` la hauteur ; `w:wrap="around"` est
  // ce qui fait couler le texte autour au lieu de le pousser sous la lettre.
  return (
    `<w:framePr w:dropCap="${kind}" w:lines="${n}" w:wrap="around"` +
    ' w:vAnchor="text" w:hAnchor="text"/>'
  );
}

// --- Filigrane ------------------------------------------------------------

export type WatermarkKind = "none" | "text";

export interface Watermark {
  kind: WatermarkKind;
  text: string;
  /** Rotation en degrés ; la diagonale de Word vaut -45. */
  angle: number;
  /** Opacité de 0 à 1. */
  opacity: number;
  color: string;
  /** Taille en points ; 0 laisse le rendu s'ajuster à la largeur. */
  sizePt: number;
}

/** Textes proposés d'emblée, comme la galerie de filigranes de Word. */
export const WATERMARK_PRESETS = [
  "BROUILLON", "CONFIDENTIEL", "NE PAS COPIER", "URGENT", "ÉCHANTILLON", "ORIGINAL",
] as const;

export const DEFAULT_WATERMARK: Watermark = {
  kind: "none",
  text: "BROUILLON",
  angle: -45,
  opacity: 0.12,
  color: "#94a3b8",
  sizePt: 0,
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Un filigrane nettoyé, prêt à être rendu ou stocké. */
export function normalizeWatermark(raw: unknown): Watermark {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_WATERMARK };
  const r = raw as Record<string, unknown>;
  const text = String(r.text ?? DEFAULT_WATERMARK.text).slice(0, 120);
  const angle = Number(r.angle);
  const opacity = Number(r.opacity);
  const sizePt = Number(r.sizePt);
  const color = /^#[0-9a-f]{6}$/i.test(String(r.color ?? "")) ? String(r.color) : DEFAULT_WATERMARK.color;
  return {
    // Un filigrane sans texte n'a rien à dessiner : il vaut « aucun ».
    kind: r.kind === "text" && text.trim() ? "text" : "none",
    text,
    angle: Number.isFinite(angle) ? Math.max(-90, Math.min(90, Math.round(angle))) : DEFAULT_WATERMARK.angle,
    opacity: Number.isFinite(opacity) ? clamp01(opacity) : DEFAULT_WATERMARK.opacity,
    color,
    sizePt: Number.isFinite(sizePt) && sizePt > 0 ? Math.min(400, Math.round(sizePt)) : 0,
  };
}

/**
 * Le filigrane en SVG encodé pour `background-image`.
 *
 * Un fond plutôt qu'un élément : il ne doit ni être sélectionnable, ni entrer
 * dans le flux, ni compter dans la pagination — trois choses qu'un vrai nœud
 * imposerait. Et une image de fond s'imprime, contrairement à un pseudo-élément
 * positionné que certains moteurs escamotent.
 */
export function watermarkCss(mark: Watermark, pageWidthMm: number, pageHeightMm: number): string {
  const m = normalizeWatermark(mark);
  if (m.kind === "none") return "";
  const w = Math.max(10, pageWidthMm);
  const h = Math.max(10, pageHeightMm);
  // Sans taille imposée, on cale la police pour que le texte traverse la page.
  const size = m.sizePt > 0 ? m.sizePt : Math.max(24, Math.round((w * 1.5) / Math.max(4, m.text.length)));
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}">` +
    `<text x="${w / 2}" y="${h / 2}" fill="${m.color}" fill-opacity="${m.opacity}" ` +
    `font-family="Inter, Segoe UI, sans-serif" font-size="${size / 2.83465}" font-weight="700" ` +
    `text-anchor="middle" dominant-baseline="central" ` +
    `transform="rotate(${m.angle} ${w / 2} ${h / 2})">${esc(m.text)}</text></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * Le filigrane en VML, la seule forme que Word reconnaît comme un filigrane.
 *
 * Word ne lit pas un filigrane en SVG : il attend une forme VML `WordArt` dans
 * l'en-tête. C'est un dialecte hérité, mais c'est ce qui fait apparaître le
 * filigrane sur *toutes* les pages du document ouvert dans Word.
 */
export function watermarkVml(mark: Watermark): string {
  const m = normalizeWatermark(mark);
  if (m.kind === "none") return "";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const size = m.sizePt > 0 ? m.sizePt : 72;
  return (
    '<w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:rPr><w:noProof/></w:rPr><w:pict>' +
    `<v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800" path="m@7,l@8,m@5,21600l@6,21600e">` +
    '<v:formulas><v:f eqn="sum #0 0 10800"/></v:formulas>' +
    '<v:path textpathok="t"/><v:textpath on="t" fitshape="t"/></v:shapetype>' +
    `<v:shape id="EliumWatermark" type="#_x0000_t136" style="position:absolute;margin-left:0;margin-top:0;` +
    `width:${Math.round(size * 6)}pt;height:${Math.round(size * 2)}pt;rotation:${m.angle};z-index:-251658752;` +
    `mso-position-horizontal:center;mso-position-horizontal-relative:margin;` +
    `mso-position-vertical:center;mso-position-vertical-relative:margin" ` +
    `o:allowincell="f" fillcolor="${m.color}" stroked="f">` +
    `<v:fill opacity="${Math.round(m.opacity * 65536)}f"/>` +
    `<v:textpath style="font-family:&quot;Inter&quot;;font-size:${size}pt;font-weight:bold" ` +
    `string="${esc(m.text)}"/></v:shape></w:pict></w:r></w:p>`
  );
}
