/**
 * Taquets de tabulation, à la façon de Word.
 *
 * Un taquet dit *où* s'arrête la tabulation suivante et *comment* le texte s'y
 * accroche : à gauche, centré, à droite, sur le séparateur décimal, ou une barre
 * verticale. À défaut de taquet explicite, Word retombe sur des taquets par
 * défaut tous les 1,25 cm — c'est ce qui fait qu'une tabulation avance même dans
 * un document où personne n'a touché à la règle.
 *
 * Tout est en millimètres depuis la marge intérieure gauche : c'est l'unité de
 * la règle affichée et celle de la géométrie de page (`format/pageSizes.ts`),
 * donc aucune conversion ne traîne dans l'interface. La conversion en twips
 * n'a lieu qu'au moment d'écrire l'OOXML.
 */

/** Alignements d'un taquet, dans les valeurs de `w:tab/@w:val`. */
export type TabAlign = "left" | "center" | "right" | "decimal" | "bar";

/** Points de conduite, dans les valeurs de `w:tab/@w:leader`. */
export type TabLeader = "none" | "dot" | "hyphen" | "underscore";

export interface TabStop {
  /** Position en millimètres depuis la marge gauche du texte. */
  pos: number;
  align: TabAlign;
  leader: TabLeader;
}

/** Intervalle des taquets par défaut de Word, en millimètres (1,25 cm). */
export const DEFAULT_TAB_MM = 12.5;

/** Le plus grand nombre de taquets qu'un paragraphe peut porter. */
export const MAX_TAB_STOPS = 64;

export const TAB_ALIGNS: readonly TabAlign[] = ["left", "center", "right", "decimal", "bar"] as const;
export const TAB_LEADERS: readonly TabLeader[] = ["none", "dot", "hyphen", "underscore"] as const;

export const TAB_ALIGN_LABELS: Record<TabAlign, string> = {
  left: "Gauche",
  center: "Centré",
  right: "Droite",
  decimal: "Décimal",
  bar: "Barre",
};

export const TAB_LEADER_LABELS: Record<TabLeader, string> = {
  none: "Aucun",
  dot: "Points",
  hyphen: "Tirets",
  underscore: "Souligné",
};

/** Le caractère répété pour dessiner le point de conduite. */
export const LEADER_CHAR: Record<TabLeader, string> = {
  none: "",
  dot: ".",
  hyphen: "-",
  underscore: "_",
};

/**
 * Quantifie une position au dixième de millimètre.
 *
 * L'OOXML stocke les taquets en twips, et 0,01 mm ne survit pas à l'aller-retour
 * (40 mm devient 2268 twips, qui revient à 40,005 mm) : chaque ouverture puis
 * enregistrement déplacerait les taquets d'un cheveu, et la dérive s'accumulerait.
 * Au dixième de millimètre — 5,7 twips, bien plus fin que ce qu'une souris peut
 * viser — la conversion est stable dans les deux sens.
 */
const quantize = (n: number) => Math.round(n * 10) / 10;

function isAlign(v: unknown): v is TabAlign {
  return typeof v === "string" && (TAB_ALIGNS as readonly string[]).includes(v);
}

function isLeader(v: unknown): v is TabLeader {
  return typeof v === "string" && (TAB_LEADERS as readonly string[]).includes(v);
}

/**
 * Un taquet nettoyé, ou `null` si la position n'a aucun sens.
 *
 * Une position négative ou non finie viendrait d'un glisser-déposer parti trop à
 * gauche : mieux vaut refuser le taquet que planter la règle.
 */
export function normalizeStop(raw: unknown): TabStop | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const pos = Number(r.pos);
  if (!Number.isFinite(pos) || pos < 0) return null;
  return {
    pos: quantize(pos),
    align: isAlign(r.align) ? r.align : "left",
    leader: isLeader(r.leader) ? r.leader : "none",
  };
}

/**
 * La liste de taquets d'un paragraphe : triée, dédoublonnée, bornée.
 *
 * Deux taquets à la même position sont indistinguables sur la règle et rendraient
 * la tabulation ambiguë ; le dernier posé gagne, comme dans Word.
 */
export function normalizeStops(raw: unknown): TabStop[] {
  const list = Array.isArray(raw) ? raw : [];
  const byPos = new Map<number, TabStop>();
  for (const item of list) {
    const stop = normalizeStop(item);
    if (stop) byPos.set(stop.pos, stop);
  }
  return [...byPos.values()].sort((a, b) => a.pos - b.pos).slice(0, MAX_TAB_STOPS);
}

/** Ajoute (ou remplace) un taquet et rend la liste normalisée. */
export function addStop(stops: TabStop[], stop: TabStop): TabStop[] {
  return normalizeStops([...stops, stop]);
}

/** Retire le taquet le plus proche de `pos`, dans une tolérance donnée. */
export function removeStopNear(stops: TabStop[], pos: number, tolerance = 1.2): TabStop[] {
  const target = nearestStop(stops, pos, tolerance);
  return target ? stops.filter((s) => s.pos !== target.pos) : stops;
}

/** Déplace un taquet d'une position à une autre. */
export function moveStop(stops: TabStop[], from: number, to: number): TabStop[] {
  const existing = stops.find((s) => s.pos === from);
  if (!existing) return stops;
  return addStop(stops.filter((s) => s.pos !== from), { ...existing, pos: Math.max(0, to) });
}

/** Le taquet le plus proche de `pos` dans la tolérance, sinon `null`. */
export function nearestStop(stops: TabStop[], pos: number, tolerance = 1.2): TabStop | null {
  let best: TabStop | null = null;
  let bestDist = Infinity;
  for (const s of stops) {
    const d = Math.abs(s.pos - pos);
    if (d <= tolerance && d < bestDist) {
      best = s;
      bestDist = d;
    }
  }
  return best;
}

/**
 * Le taquet qui reçoit une tabulation placée à `from` millimètres.
 *
 * Les taquets explicites l'emportent ; passé le dernier, on repart sur la grille
 * par défaut. Un taquet `bar` ne reçoit PAS la tabulation — c'est un simple
 * filet vertical décoratif, et l'ignorer ici est ce qui le distingue des autres.
 */
export function nextStop(
  from: number,
  stops: TabStop[],
  defaultMm: number = DEFAULT_TAB_MM,
  limitMm?: number,
): TabStop | null {
  const eps = 0.01;
  for (const s of stops) {
    if (s.align === "bar") continue;
    if (s.pos > from + eps) return s;
  }
  const step = defaultMm > 0 ? defaultMm : DEFAULT_TAB_MM;
  const next = quantize((Math.floor(from / step) + 1) * step);
  if (limitMm != null && next > limitMm) return null;
  return { pos: next, align: "left", leader: "none" };
}

/** Les filets verticaux (`bar`), qui se dessinent indépendamment des tabulations. */
export function barStops(stops: TabStop[]): TabStop[] {
  return stops.filter((s) => s.align === "bar");
}

/**
 * Les graduations d'une règle, en millimètres depuis la marge gauche.
 *
 * Une graduation majeure par centimètre et une mineure tous les 2 mm : plus
 * dense devient illisible à l'échelle d'affichage.
 */
export function rulerTicks(widthMm: number, majorMm = 10, minorMm = 2): { pos: number; major: boolean }[] {
  const out: { pos: number; major: boolean }[] = [];
  if (!Number.isFinite(widthMm) || widthMm <= 0) return out;
  const step = minorMm > 0 ? minorMm : 2;
  for (let pos = 0; pos <= widthMm + 0.001; pos = quantize(pos + step)) {
    // Le modulo se fait sur des entiers de dixièmes : en flottant, 30 % 10 peut
    // valoir 9,999999999 et perdre une graduation majeure sur trois.
    const major = Math.round(pos * 10) % Math.round(majorMm * 10) === 0;
    out.push({ pos, major });
  }
  return out;
}

/** Étiquettes des graduations majeures, en centimètres. */
export function rulerLabels(widthMm: number, majorMm = 10): { pos: number; label: string }[] {
  return rulerTicks(widthMm, majorMm, majorMm)
    .filter((t) => t.pos > 0)
    .map((t) => ({ pos: t.pos, label: String(Math.round(t.pos / 10)) }));
}

// --- OOXML ----------------------------------------------------------------

/** Millimètres en twips (1 pouce = 1440 twips = 25,4 mm). */
export function mmToTwips(mm: number): number {
  return Math.round((mm / 25.4) * 1440);
}

/** Twips en millimètres. */
export function twipsToMm(tw: number): number {
  return quantize((tw / 1440) * 25.4);
}

/**
 * Le `w:tabs` d'un paragraphe, ou une chaîne vide sans taquet.
 *
 * L'ordre suit la liste normalisée : Word tolère le désordre mais son propre
 * enregistrement est trié, et un fichier trié se compare bien plus facilement.
 */
export function tabsXml(stops: TabStop[]): string {
  const list = normalizeStops(stops);
  if (!list.length) return "";
  const items = list
    .map((s) => {
      const leader = s.leader !== "none" ? ` w:leader="${s.leader}"` : "";
      return `<w:tab w:val="${s.align}" w:pos="${mmToTwips(s.pos)}"${leader}/>`;
    })
    .join("");
  return `<w:tabs>${items}</w:tabs>`;
}

/**
 * Relit une suite d'attributs `w:tab` en liste de taquets.
 *
 * Point d'entrée commun aux deux lecteurs : celui qui part du texte XML brut et
 * celui qui part de l'arbre déjà analysé par le lecteur DOCX. Deux
 * normalisations séparées finiraient par accepter des taquets différents selon
 * le chemin d'import.
 */
export function stopsFromAttrs(
  items: Iterable<{ val?: string; pos?: string | number; leader?: string }>,
): TabStop[] {
  const out: TabStop[] = [];
  for (const item of items) {
    // `w:val="clear"` supprime un taquet hérité d'un style : il n'a rien à
    // devenir dans notre modèle, qui ne connaît pas l'héritage des taquets.
    if (item.val === "clear" || item.pos == null || item.pos === "") continue;
    const tw = Number(item.pos);
    if (!Number.isFinite(tw)) continue;
    const stop = normalizeStop({ pos: twipsToMm(tw), align: item.val, leader: item.leader });
    if (stop) out.push(stop);
  }
  return normalizeStops(out);
}

/** Relit un `w:tabs` (fragment XML brut) en liste de taquets. */
export function parseTabsXml(xml: string): TabStop[] {
  const items: { val?: string; pos?: string; leader?: string }[] = [];
  const re = /<w:tab\b([^>]*?)\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml ?? ""))) {
    const attrs = m[1] ?? "";
    items.push({
      val: /w:val="([^"]*)"/.exec(attrs)?.[1],
      pos: /w:pos="(-?\d+)"/.exec(attrs)?.[1],
      leader: /w:leader="([^"]*)"/.exec(attrs)?.[1],
    });
  }
  return stopsFromAttrs(items);
}
