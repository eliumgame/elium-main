/**
 * Le correcteur : règles typographiques françaises, mots répétés, capitales, et
 * mots inconnus quand un dictionnaire est chargé.
 *
 * **Ce que fait quoi.** L'orthographe proprement dite est confiée au correcteur
 * *natif* du navigateur (`spellcheck` + `lang="fr"`), qui utilise les
 * dictionnaires du système : c'est ce qui permet de vérifier réellement
 * l'orthographe hors ligne sans embarquer plusieurs mégaoctets de Hunspell dans
 * le paquet. Ce module s'occupe de tout ce que le navigateur ne sait **pas**
 * faire : la typographie française, les répétitions, les capitales, un
 * dictionnaire personnel, une liste à ignorer — et la détection de mots inconnus
 * dès qu'un dictionnaire est fourni.
 *
 * Tout est ici en fonctions pures sur des chaînes, positions comprises : c'est ce
 * qui rend les règles testables sans éditeur et réutilisables par le volet, les
 * décorations et un éventuel rapport.
 */

/** Familles de problèmes détectés. */
export type IssueKind =
  | "repeated"
  | "double-space"
  | "space-before-punct"
  | "space-after-punct"
  | "capital"
  | "unknown-word"
  | "unpaired-quote";

export interface ProofIssue {
  kind: IssueKind;
  /** Décalage de début dans le texte analysé. */
  from: number;
  /** Décalage de fin (exclu). */
  to: number;
  /** Le fragment fautif. */
  text: string;
  message: string;
  /** Remplacements proposés, du plus probable au moins. */
  suggestions: string[];
}

export const ISSUE_LABELS: Record<IssueKind, string> = {
  repeated: "Mot répété",
  "double-space": "Espace en double",
  "space-before-punct": "Espace avant la ponctuation",
  "space-after-punct": "Espace après la ponctuation",
  capital: "Capitale manquante",
  "unknown-word": "Mot inconnu",
  "unpaired-quote": "Guillemet non fermé",
};

/** L'espace fine insécable, exigée en français avant ; : ! ? et dans les guillemets. */
export const NARROW_NBSP = " ";
/** L'espace insécable ordinaire. */
export const NBSP = " ";

/**
 * Ponctuation qui demande une espace fine insécable AVANT elle en français.
 *
 * Le deux-points prend historiquement une espace insécable pleine, mais l'usage
 * typographique courant et les principaux traitements de texte emploient la fine
 * pour les quatre : rester cohérent vaut mieux qu'appliquer deux règles.
 */
const PUNCT_BEFORE = [";", ":", "!", "?"] as const;

/** Ponctuation qui ne prend jamais d'espace avant. */
const PUNCT_NO_SPACE_BEFORE = [",", ".", ")", "]", "…"] as const;

export interface ProofOptions {
  /** Mots acceptés en plus du dictionnaire (dictionnaire personnel). */
  personal?: Iterable<string>;
  /** Mots ignorés pour cette session. */
  ignored?: Iterable<string>;
  /**
   * Dictionnaire de référence : une liste de mots, ou un vérificateur complet
   * (`dict/index.ts`). Sans lui, la détection de mots inconnus est **désactivée** :
   * ne rien détecter vaut mieux qu'un tapis de faux positifs.
   */
  dictionary?: Iterable<string> | SpellChecker | null;
  /** Règles désactivées. */
  disabled?: Iterable<IssueKind>;
  /**
   * Signaler TOUT mot absent du dictionnaire.
   *
   * Par défaut, un dictionnaire qui se déclare **partiel** (le dictionnaire
   * embarqué) travaille en mode *prudent* : un mot inconnu n'est signalé que si une
   * correction plausible existe. C'est ce qui évite de souligner le vocabulaire
   * spécialisé de l'auteur — le défaut qui fait cesser de lire les soulignements.
   * Le mode strict est là pour une relecture exhaustive.
   */
  strict?: boolean;
}

/**
 * Le contrat d'un dictionnaire vu par le correcteur.
 *
 * Volontairement minimal : le correcteur n'a pas à savoir si les formes viennent
 * d'une liste importée, du dictionnaire embarqué ou d'un futur service — il
 * demande « connu ? » et « quoi à la place ? ».
 */
export interface SpellChecker {
  known(word: string): boolean;
  suggest(word: string, limit?: number): string[];
  /** Vrai si la couverture est incomplète : le mode prudent s'applique alors. */
  partial?: boolean;
}

/** Repli d'un mot pour la comparaison : minuscules, sans accents. */
export function foldWord(word: string): string {
  return word
    .toLocaleLowerCase("fr")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/**
 * Les mots d'un texte, avec leur position.
 *
 * Un « mot » français inclut les apostrophes d'élision et les traits d'union :
 * « aujourd'hui » et « peut-être » sont des mots uniques, et les découper
 * produirait des fragments inconnus de tout dictionnaire.
 */
export function words(text: string): { text: string; from: number; to: number }[] {
  const out: { text: string; from: number; to: number }[] = [];
  // Le trait d'union est en fin de classe : il s'y lit littéralement, sans échappement.
  const re = /[\p{L}\p{M}]+(?:[’'-][\p{L}\p{M}]+)*/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text ?? ""))) {
    out.push({ text: m[0], from: m.index, to: m.index + m[0].length });
  }
  return out;
}

function has(set: Set<string>, word: string): boolean {
  return set.has(foldWord(word));
}

function toSet(it: Iterable<string> | null | undefined): Set<string> {
  const s = new Set<string>();
  for (const w of it ?? []) {
    const f = foldWord(String(w).trim());
    if (f) s.add(f);
  }
  return s;
}

// --- Règles ---------------------------------------------------------------

/** Mots répétés à l'identique (« le le »), à la casse et aux accents près. */
function checkRepeated(text: string): ProofIssue[] {
  const out: ProofIssue[] = [];
  const ws = words(text);
  for (let i = 1; i < ws.length; i++) {
    const a = ws[i - 1]!;
    const b = ws[i]!;
    if (foldWord(a.text) !== foldWord(b.text)) continue;
    // Uniquement si rien d'autre qu'une espace les sépare : « non, non » est
    // volontaire, « le le » ne l'est pas.
    const between = text.slice(a.to, b.from);
    if (!/^\s+$/.test(between)) continue;
    // Quelques répétitions sont correctes en français.
    if (["nous", "vous", "si", "tres", "tout"].includes(foldWord(a.text))) continue;
    out.push({
      kind: "repeated",
      from: a.from,
      to: b.to,
      text: text.slice(a.from, b.to),
      message: `« ${a.text} » est répété`,
      suggestions: [a.text],
    });
  }
  return out;
}

/** Deux espaces ou plus d'affilée, hors début de ligne. */
function checkDoubleSpace(text: string): ProofIssue[] {
  const out: ProofIssue[] = [];
  const re = / {2,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    out.push({
      kind: "double-space",
      from: m.index,
      to: m.index + m[0].length,
      text: m[0],
      message: `${m[0].length} espaces consécutives`,
      suggestions: [" "],
    });
  }
  return out;
}

/**
 * Espace avant une ponctuation haute.
 *
 * Deux fautes distinctes : l'espace ordinaire là où il faut une fine insécable
 * (elle laisse la ponctuation partir seule en début de ligne), et l'absence
 * totale d'espace.
 */
function checkSpaceBeforePunct(text: string): ProofIssue[] {
  const out: ProofIssue[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (!(PUNCT_BEFORE as readonly string[]).includes(ch)) continue;
    // « ?! » ou « ... : » enchaînés ne prennent pas d'espace intercalaire.
    const prev = text[i - 1];
    if (prev == null) continue;
    if ((PUNCT_BEFORE as readonly string[]).includes(prev)) continue;
    // Un « : » dans une heure (12:30) ou une URL n'est pas de la ponctuation.
    if (ch === ":" && /\d/.test(prev) && /\d/.test(text[i + 1] ?? "")) continue;
    if (ch === ":" && text.slice(Math.max(0, i - 5), i + 3).includes("//")) continue;

    if (prev === NARROW_NBSP || prev === NBSP) continue;
    if (prev === " ") {
      out.push({
        kind: "space-before-punct",
        from: i - 1,
        to: i + 1,
        text: text.slice(i - 1, i + 1),
        message: `Espace fine insécable attendue avant « ${ch} »`,
        suggestions: [`${NARROW_NBSP}${ch}`],
      });
    } else if (/[\p{L}\p{M}\d)\]»]/u.test(prev)) {
      out.push({
        kind: "space-before-punct",
        from: i,
        to: i + 1,
        text: ch,
        message: `Espace fine insécable manquante avant « ${ch} »`,
        suggestions: [`${NARROW_NBSP}${ch}`],
      });
    }
  }
  return out;
}

/** Espace manquante après une virgule, un point ou un point-virgule. */
function checkSpaceAfterPunct(text: string): ProofIssue[] {
  const out: ProofIssue[] = [];
  for (let i = 0; i < text.length - 1; i++) {
    const ch = text[i]!;
    if (!(PUNCT_NO_SPACE_BEFORE as readonly string[]).includes(ch) && ch !== ";") continue;
    if (ch === ")" || ch === "]") continue;
    const next = text[i + 1]!;
    if (!/[\p{L}\p{M}]/u.test(next)) continue;
    // Un point entre chiffres ou dans un sigle/URL n'est pas une fin de phrase.
    if (ch === "." && /\d/.test(text[i - 1] ?? "")) continue;
    if (ch === "," && /\d/.test(text[i - 1] ?? "") && /\d/.test(next)) continue;
    // Une abréviation en majuscules (« S.A.R.L. ») ne prend pas d'espace.
    if (ch === "." && /\p{Lu}/u.test(text[i - 1] ?? "") && /\p{Lu}/u.test(next)) continue;
    out.push({
      kind: "space-after-punct",
      from: i,
      to: i + 2,
      text: text.slice(i, i + 2),
      message: `Espace manquante après « ${ch} »`,
      suggestions: [`${ch} ${next}`],
    });
  }
  return out;
}

/** Minuscule en début de phrase, après un point, un point d'exclamation ou d'interrogation. */
function checkCapital(text: string): ProofIssue[] {
  const out: ProofIssue[] = [];
  const re = /(^|[.!?…]\s+)(\p{Ll})/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const at = m.index + m[1]!.length;
    // Un point d'abréviation courante n'ouvre pas une phrase.
    const before = text.slice(Math.max(0, m.index - 6), m.index + 1).toLowerCase();
    if (/(?:m|mm|mme|dr|st|ste|etc|cf|ex|art|p|no|n°)\.$/.test(before)) continue;
    out.push({
      kind: "capital",
      from: at,
      to: at + 1,
      text: m[2]!,
      message: "Capitale attendue en début de phrase",
      suggestions: [m[2]!.toLocaleUpperCase("fr")],
    });
  }
  return out;
}

/** Guillemets français ouverts et jamais fermés. */
function checkQuotes(text: string): ProofIssue[] {
  const opens: number[] = [];
  const out: ProofIssue[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "«") opens.push(i);
    else if (text[i] === "»") opens.pop();
  }
  for (const at of opens) {
    out.push({
      kind: "unpaired-quote",
      from: at,
      to: at + 1,
      text: "«",
      message: "Guillemet ouvrant sans guillemet fermant",
      suggestions: [],
    });
  }
  return out;
}

/**
 * Mots absents du dictionnaire.
 *
 * Ne fait rien sans dictionnaire : c'est délibéré, ne rien détecter vaut mieux que
 * signaler la moitié d'un texte correct — l'auteur cesserait de regarder les
 * soulignements.
 *
 * Avec un dictionnaire **partiel** (l'embarqué), le mode prudent ne signale un mot
 * inconnu que si une correction plausible existe. Un mot rare mais bien orthographié
 * n'a, par construction, aucun voisin à une faute près dans le dictionnaire : c'est
 * ce qui le distingue d'une faute de frappe.
 */
function checkUnknown(
  text: string,
  checker: SpellChecker,
  allowed: Set<string>,
  strict: boolean,
): ProofIssue[] {
  const out: ProofIssue[] = [];
  const prudent = checker.partial === true && !strict;
  for (const w of words(text)) {
    // Les nombres, les sigles tout en capitales et les mots de deux lettres ou
    // moins ne sont pas des fautes exploitables.
    if (w.text.length <= 2) continue;
    if (/^\p{Lu}+$/u.test(w.text)) continue;
    if (has(allowed, w.text) || checker.known(w.text)) continue;
    // Une forme élidée : on teste aussi la partie après l'apostrophe.
    const tail = w.text.split(/[’']/).pop() ?? w.text;
    if (tail !== w.text && (checker.known(tail) || has(allowed, tail))) continue;
    const suggestions = checker.suggest(w.text, 5);
    if (prudent && !suggestions.length) continue;
    out.push({
      kind: "unknown-word",
      from: w.from,
      to: w.to,
      text: w.text,
      message: `« ${w.text} » est absent du dictionnaire`,
      suggestions,
    });
  }
  return out;
}

/** Vrai si l'objet fourni est un vérificateur, et non une simple liste de mots. */
function isChecker(d: unknown): d is SpellChecker {
  return !!d && typeof (d as SpellChecker).known === "function";
}

/**
 * Un vérificateur bâti sur une liste de mots.
 *
 * Les listes fournies à la main sont comparées **sans accents ni casse** (voir
 * `foldWord`) : elles viennent de sources hétérogènes où l'accentuation est
 * inégale, et une comparaison stricte y produirait des fautes imaginaires. Une
 * liste explicite n'est pas déclarée partielle : ce qui n'y est pas est signalé.
 */
function setChecker(list: Iterable<string> | null | undefined): SpellChecker | null {
  const set = toSet(list);
  if (!set.size) return null;
  return {
    known: (word) => has(set, word),
    suggest: (word, limit = 5) => suggest(word, set).slice(0, limit),
  };
}

/**
 * Distance de Levenshtein bornée.
 *
 * Bornée parce qu'on ne cherche que des suggestions proches : au-delà de deux
 * corrections, une propositionne n'aide plus, et la borne évite de parcourir
 * intégralement un dictionnaire de centaines de milliers de mots.
 */
export function editDistance(a: string, b: string, max = 2): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev = new Array<number>(b.length + 1);
  const cur = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let best = cur[0]!;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      best = Math.min(best, cur[j]!);
    }
    if (best > max) return max + 1;
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]!;
  }
  return prev[b.length]!;
}

/** Suggestions pour un mot, par proximité orthographique. */
export function suggest(word: string, dict: Set<string>): string[] {
  const f = foldWord(word);
  const scored: { w: string; d: number }[] = [];
  for (const candidate of dict) {
    const d = editDistance(f, candidate, 2);
    if (d <= 2) scored.push({ w: candidate, d });
  }
  scored.sort((a, b) => a.d - b.d || a.w.localeCompare(b.w, "fr"));
  return scored.map((s) => s.w);
}

/**
 * Tous les problèmes d'un texte, triés par position.
 *
 * Les règles sont indépendantes et s'appliquent au même texte : elles peuvent se
 * chevaucher (un mot répété dont le second est inconnu), et c'est l'appelant qui
 * décide comment les présenter.
 */
export function checkText(text: string, opts: ProofOptions = {}): ProofIssue[] {
  const src = String(text ?? "");
  if (!src) return [];
  const off = toSet(opts.disabled as Iterable<string> | undefined);
  const allowed = new Set([...toSet(opts.personal), ...toSet(opts.ignored)]);
  const checker = isChecker(opts.dictionary) ? opts.dictionary : setChecker(opts.dictionary);
  const enabled = (k: IssueKind) => !off.has(k);

  const issues: ProofIssue[] = [];
  if (enabled("repeated")) issues.push(...checkRepeated(src));
  if (enabled("double-space")) issues.push(...checkDoubleSpace(src));
  if (enabled("space-before-punct")) issues.push(...checkSpaceBeforePunct(src));
  if (enabled("space-after-punct")) issues.push(...checkSpaceAfterPunct(src));
  if (enabled("capital")) issues.push(...checkCapital(src));
  if (enabled("unpaired-quote")) issues.push(...checkQuotes(src));
  if (enabled("unknown-word") && checker) {
    issues.push(...checkUnknown(src, checker, allowed, opts.strict === true));
  }

  // Les mots explicitement ignorés ne doivent plus rien produire, quelle que
  // soit la règle qui les a signalés.
  const kept = issues.filter((i) => !(i.kind === "unknown-word" && has(allowed, i.text)));
  return kept.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** Applique une suggestion dans un texte, et rend le texte corrigé. */
export function applyIssue(text: string, issue: ProofIssue, suggestion?: string): string {
  const rep = suggestion ?? issue.suggestions[0];
  if (rep == null) return text;
  return text.slice(0, issue.from) + rep + text.slice(issue.to);
}

/** Un résumé lisible : « 3 problèmes, dont 2 de typographie ». */
export function summarize(issues: ProofIssue[]): string {
  if (!issues.length) return "Aucun problème détecté";
  const n = issues.length;
  return n === 1 ? "1 problème détecté" : `${n} problèmes détectés`;
}

/**
 * Lit une liste de mots (un par ligne) ou un fichier `.dic` Hunspell.
 *
 * Un `.dic` commence par un compteur et suffixe chaque mot de drapeaux après une
 * barre oblique : les ignorer donne les formes de base, ce qui suffit largement
 * pour signaler un mot inconnu.
 */
export function parseDictionary(raw: string): string[] {
  const lines = String(raw ?? "").split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    // Le compteur en tête d'un .dic n'est pas un mot.
    if (i === 0 && /^\d+$/.test(line)) continue;
    const word = line.split("/")[0]!.trim();
    if (word && !/\s/.test(word)) out.push(word);
  }
  return out;
}
