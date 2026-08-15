/**
 * Notes de bas de page et notes de fin : la logique commune aux deux familles.
 *
 * Les deux ne diffèrent que par trois choses — où la liste s'affiche, comment le
 * marqueur se numérote (chiffres arabes contre romains minuscules, comme Word),
 * et la partie OOXML où elles atterrissent. Tout le reste est identique, donc
 * tout le reste vit ici : une seule numérotation, un seul collecteur, un seul
 * jeu de titres. Une deuxième boucle de numérotation serait une garantie de
 * divergence entre l'appel de note et la liste.
 *
 * Comme les renvois et l'index, la numérotation est **dérivée** de l'ordre du
 * document : insérer une note en amont renumérote la suite sans que rien de
 * périmé ne soit stocké.
 */

/** Les deux familles de notes. */
export type NoteKind = "footnote" | "endnote";

export const NOTE_KINDS: readonly NoteKind[] = ["footnote", "endnote"] as const;

/** Nom du nœud de liste correspondant à chaque famille. */
export const NOTE_LIST_TYPE: Record<NoteKind, string> = {
  footnote: "footnotesList",
  endnote: "endnotesList",
};

/** Titre de la liste, tel qu'affiché et exporté. */
export const NOTE_TITLES: Record<NoteKind, string> = {
  footnote: "Notes de bas de page",
  endnote: "Notes de fin",
};

/** Libellé singulier, pour les menus et les renvois. */
export const NOTE_LABELS: Record<NoteKind, string> = {
  footnote: "Note de bas de page",
  endnote: "Note de fin",
};

const ROMAN: readonly [number, string][] = [
  [1000, "m"],
  [900, "cm"],
  [500, "d"],
  [400, "cd"],
  [100, "c"],
  [90, "xc"],
  [50, "l"],
  [40, "xl"],
  [10, "x"],
  [9, "ix"],
  [5, "v"],
  [4, "iv"],
  [1, "i"],
];

/**
 * Chiffre romain en minuscules — la numérotation par défaut des notes de fin
 * dans Word, qu'on reproduit à l'écran pour que l'export et l'écran s'accordent.
 *
 * Renvoie une chaîne vide hors de la plage représentable (0, négatifs), plutôt
 * que d'inventer un marqueur.
 */
export function romanLower(n: number): string {
  let value = Math.floor(n);
  if (!Number.isFinite(value) || value <= 0) return "";
  let out = "";
  for (const [amount, numeral] of ROMAN) {
    while (value >= amount) {
      out += numeral;
      value -= amount;
    }
  }
  return out;
}

/**
 * Marqueur affiché pour la n-ième note d'une famille.
 *
 * Word numérote les notes de bas de page en chiffres arabes et les notes de fin
 * en romains minuscules : garder cette convention évite qu'un document exporté
 * ne ressemble plus à ce qu'on avait sous les yeux.
 */
export function noteMarker(kind: NoteKind, index: number): string {
  if (kind === "endnote") return romanLower(index) || String(index);
  return String(index);
}

/** Le format de numérotation OOXML correspondant (`w:numFmt`). */
export function noteNumFmt(kind: NoteKind): string {
  return kind === "endnote" ? "lowerRoman" : "decimal";
}

/** Une note collectée, numérotée dans l'ordre du document. */
export interface NoteEntry {
  kind: NoteKind;
  id: string;
  text: string;
  /** Position du nœud dans le document ; -1 quand elle est inconnue (JSON pur). */
  pos: number;
  /** Rang dans sa famille, à partir de 1. */
  number: number;
  /** Marqueur affiché ("3", "iii"). */
  marker: string;
}

/**
 * Forme minimale d'un nœud ProseMirror, pour que ce module n'importe pas TipTap
 * (même convention que `captions.ts`).
 */
interface PMLike {
  descendants(
    fn: (node: { type: { name: string }; attrs: Record<string, unknown> }, pos: number) => boolean | void,
  ): void;
}

/** Document JSON tel qu'il est stocké dans le `.elium`. */
interface JsonLike {
  type: string;
  attrs?: Record<string, unknown> | null;
  content?: JsonLike[] | null;
}

/**
 * Numérote les nœuds visités d'une famille.
 *
 * Les deux formes de document alimentent ce même scanner : c'est ce qui garantit
 * que l'éditeur, l'export et les tests numérotent identiquement.
 */
function scanNotes(
  kind: NoteKind,
  feed: (visit: (type: string, attrs: Record<string, unknown>, pos: number) => void) => void,
): NoteEntry[] {
  const out: NoteEntry[] = [];
  feed((type, attrs, pos) => {
    if (type !== kind) return;
    out.push({
      kind,
      id: String(attrs.id ?? ""),
      text: String(attrs.text ?? ""),
      pos,
      number: out.length + 1,
      marker: noteMarker(kind, out.length + 1),
    });
  });
  return out;
}

/** Notes d'une famille dans un document vivant, avec leurs vraies positions. */
export function collectNotes(doc: PMLike, kind: NoteKind): NoteEntry[] {
  return scanNotes(kind, (visit) => {
    doc.descendants((node, pos) => {
      visit(node.type.name, node.attrs ?? {}, pos);
      return true;
    });
  });
}

/** Notes d'une famille dans un document JSON (les positions valent -1). */
export function collectNotesJson(doc: JsonLike, kind: NoteKind): NoteEntry[] {
  return scanNotes(kind, (visit) => {
    const walk = (node: JsonLike) => {
      visit(node.type, node.attrs ?? {}, -1);
      (node.content ?? []).forEach(walk);
    };
    (doc.content ?? []).forEach(walk);
  });
}

/** Rang d'une note repérée par sa position, ou `null` si absente. */
export function noteNumberAt(entries: NoteEntry[], pos: number): NoteEntry | null {
  return entries.find((e) => e.pos === pos) ?? null;
}

/** Vrai si un document vivant contient déjà la liste de cette famille. */
export function hasNotesList(doc: PMLike, kind: NoteKind): boolean {
  const wanted = NOTE_LIST_TYPE[kind];
  let found = false;
  doc.descendants((node) => {
    if (node.type.name === wanted) found = true;
    return !found;
  });
  return found;
}

/** Variante JSON de {@link hasNotesList}. */
export function hasNotesListJson(doc: JsonLike, kind: NoteKind): boolean {
  const wanted = NOTE_LIST_TYPE[kind];
  let found = false;
  const walk = (node: JsonLike) => {
    if (node.type === wanted) found = true;
    if (!found) (node.content ?? []).forEach(walk);
  };
  (doc.content ?? []).forEach(walk);
  return found;
}

/**
 * Document JSON dont les notes d'une famille sont converties dans l'autre.
 *
 * Word sait convertir les notes dans les deux sens, et c'est la seule opération
 * qui a du sens une fois qu'on a les deux familles. Purement fonctionnel : la
 * liste de destination est ajoutée si elle manque, celle d'origine retirée si
 * elle devient vide, de sorte qu'on ne laisse pas derrière soi le titre d'une
 * section sans contenu.
 */
export function convertNotes<T extends { type: string; content?: unknown[] | null }>(
  doc: T,
  from: NoteKind,
  to: NoteKind,
): T {
  if (from === to) return doc;
  const fromList = NOTE_LIST_TYPE[from];
  const toList = NOTE_LIST_TYPE[to];
  let converted = 0;

  const map = (node: unknown): unknown => {
    if (!node || typeof node !== "object") return node;
    const n = node as { type?: string; content?: unknown[] | null };
    if (typeof n.type !== "string") return node;
    if (n.type === from) {
      converted++;
      return { ...n, type: to };
    }
    const content = Array.isArray(n.content)
      ? n.content.map(map).filter((c) => {
          const t = (c as { type?: string } | null)?.type;
          // La liste d'origine n'a plus rien à lister : la garder afficherait un
          // titre suivi du vide.
          return !(t === fromList);
        })
      : n.content;
    return content === n.content ? node : { ...n, content };
  };

  const out = map(doc) as T;
  if (!converted) return doc;
  const content = Array.isArray(out.content) ? [...out.content] : [];
  const hasTarget = content.some((c) => (c as { type?: string } | null)?.type === toList);
  if (!hasTarget) content.push({ type: toList });
  return { ...out, content };
}
