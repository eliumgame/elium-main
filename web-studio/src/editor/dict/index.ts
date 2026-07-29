/**
 * Le dictionnaire orthographique embarqué.
 *
 * Assemble le lexique (`lexicon-*.ts`) et la morphologie (`morphology-*.ts`) en un
 * vérificateur : « ce mot existe-t-il ? » et « par quoi le remplacer ? ». Rien n'est
 * téléchargé, rien n'est demandé au système : le correcteur fonctionne hors ligne,
 * comme le reste de la suite.
 *
 * **Trois décisions de conception, et leurs raisons.**
 *
 * 1. *Les formes sont calculées au premier usage, pas transportées.* Le lexique
 *    tient en quelques dizaines de kilooctets ; ses ~150 000 formes fléchies
 *    pèseraient plusieurs mégaoctets. La construction prend quelques dizaines de
 *    millisecondes, une fois par session.
 *
 * 2. *Les suggestions sont GÉNÉRÉES puis vérifiées, jamais cherchées.* Parcourir
 *    150 000 formes pour chaque mot inconnu coûterait des dizaines de millisecondes
 *    par frappe. On produit à l'inverse les quelques centaines de voisins à une
 *    correction près (insertion, suppression, substitution, transposition, accent)
 *    et on teste leur appartenance : quelques centaines de recherches en table,
 *    donc quelques microsecondes.
 *
 * 3. *Mode prudent par défaut.* Un lexique de 6 000 entrées ne couvre pas tout le
 *    français : signaler tout mot absent soulignerait le vocabulaire spécialisé de
 *    l'auteur, et il cesserait de regarder les soulignements. En mode prudent, un
 *    mot inconnu n'est signalé que si une correction plausible existe — c'est-à-dire
 *    si un mot connu est à une faute de frappe près. Le mode strict, lui, signale
 *    tout ce qui est absent, pour qui veut une relecture exhaustive.
 */
import {
  ADJ, INVAR, IRREGULAR, NOUNS, PROPER, TECH, VERBS_3, VERBS_ER, VERBS_IR2, words,
} from "./lexicon-fr";
import {
  adjectiveForms, adverbsFr, conjugateEr, conjugateFamily, conjugateIr2, nounForms, splitCompound,
  verbAdjectives,
} from "./morphology-fr";
import { EN_BASE, EN_IRREGULAR, enForms } from "./lexicon-en";
import type { SpellChecker as ProofChecker } from "../proofing";

export type DictLang = "fr" | "en";

export const DICT_LANGS: { id: DictLang; label: string }[] = [
  { id: "fr", label: "Français" },
  { id: "en", label: "English" },
];

/**
 * Un dictionnaire utilisable par le correcteur, avec ce qu'il faut à l'interface.
 *
 * Le contrat de base (`known`/`suggest`/`partial`) est celui de `proofing.ts` : le
 * redéclarer ici en aurait fait deux définitions à garder d'accord. On n'y ajoute
 * que ce que l'interface montre — un nom et une taille.
 */
export interface SpellChecker extends ProofChecker {
  /** Étiquette lisible, pour l'interface. */
  label: string;
  /** Nombre de formes couvertes (indicatif). */
  size: number;
}

/**
 * Préfixes verbaux productifs.
 *
 * « redemander », « réécrire », « prévoir », « sous-estimer » ne figurent dans aucun
 * lexique raisonnable, et pourtant se forment librement. Les accepter dès que le
 * radical restant est une forme verbale connue couvre des milliers de verbes sans
 * une ligne de données — et sans accepter n'importe quoi, puisque le reste doit être
 * un verbe conjugué, pas un mot quelconque.
 */
const VERB_PREFIXES = ["re", "ré", "r", "dé", "des", "pré", "sur", "sous", "entre", "co", "mé", "dis", "non"];

/** Minuscule sans changer les accents : en français, ils font partie du mot. */
function lower(word: string): string {
  return String(word ?? "").toLocaleLowerCase("fr");
}

/** Sans accents : sert uniquement aux mots tout en capitales et au classement. */
function unaccent(word: string): string {
  return word.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

interface Built {
  /** Toutes les formes connues, en minuscules. */
  all: Set<string>;
  /** Les formes VERBALES, seules à accepter un préfixe productif. */
  verbs: Set<string>;
  /** Les formes sans accents, pour les mots écrits en capitales. */
  bare: Set<string>;
}

/**
 * Construit le dictionnaire français.
 *
 * L'ordre importe peu, sauf pour les verbes : un infinitif du 3e groupe non
 * reconnu par une famille est signalé en développement plutôt que d'être
 * silencieusement conjugué de travers.
 */
function buildFr(): Built {
  const all = new Set<string>();
  const verbs = new Set<string>();
  const addVerb = (form: string) => {
    all.add(form);
    verbs.add(form);
  };

  for (const inf of words(VERBS_ER)) {
    for (const f of conjugateEr(inf)) addVerb(f);
    // L'adjectif en -able : « utilisable », « paramétrable ». Il n'est PAS une
    // forme verbale (donc pas de préfixe productif dessus).
    for (const a of verbAdjectives(inf)) all.add(a);
  }
  for (const inf of words(VERBS_IR2)) for (const f of conjugateIr2(inf)) addVerb(f);
  for (const inf of words(VERBS_3)) {
    const forms = conjugateFamily(inf);
    // Sans famille reconnue, l'infinitif seul est ajouté : mieux vaut une
    // conjugaison manquante qu'une conjugaison inventée.
    if (forms) for (const f of forms) addVerb(f);
    else addVerb(inf);
  }
  // Les verbes irréguliers arrivent déjà fléchis (aucune règle n'y mène).
  for (const f of words(IRREGULAR)) addVerb(lower(f));

  for (const noun of words(NOUNS)) for (const f of nounForms(noun)) all.add(f);
  for (const adj of words(ADJ)) {
    for (const f of adjectiveForms(adj)) all.add(f);
    for (const a of adverbsFr(adj)) all.add(a);
  }
  for (const w of words(INVAR)) all.add(lower(w));
  for (const w of words(TECH)) for (const f of nounForms(w)) all.add(f);
  // Les noms propres sont surtout là pour les cas en minuscules (mois, jours,
  // adjectifs de nationalité) : la règle des capitales les ignore de toute façon.
  for (const w of words(PROPER)) {
    all.add(lower(w));
    for (const f of nounForms(lower(w))) all.add(f);
  }

  const bare = new Set<string>();
  for (const w of all) bare.add(unaccent(w));
  return { all, verbs, bare };
}

/** Construit le dictionnaire anglais (morphologie régulière + formes irrégulières). */
function buildEn(): Built {
  const all = new Set<string>();
  const verbs = new Set<string>();
  for (const w of words(EN_BASE)) for (const f of enForms(w)) all.add(f);
  for (const f of words(EN_IRREGULAR)) {
    all.add(f.toLowerCase());
    verbs.add(f.toLowerCase());
  }
  const bare = new Set<string>();
  for (const w of all) bare.add(unaccent(w));
  return { all, verbs, bare };
}

/** Les dictionnaires déjà construits, une fois par langue et par session. */
const built = new Map<DictLang, Built>();

function dict(lang: DictLang): Built {
  const hit = built.get(lang);
  if (hit) return hit;
  const made = lang === "en" ? buildEn() : buildFr();
  built.set(lang, made);
  return made;
}

/** Les lettres candidates à l'insertion et à la substitution. */
const ALPHABET_FR = "abcdefghijklmnopqrstuvwxyzàâäçéèêëîïôöùûüÿœæ'-";
const ALPHABET_EN = "abcdefghijklmnopqrstuvwxyz'-";

/**
 * Les variantes accentuées d'une lettre.
 *
 * L'oubli d'accent est la faute la plus fréquente en français, et de loin : c'est
 * la première correction proposée, avant toute autre.
 */
const ACCENTS: Record<string, string> = {
  a: "àâä", e: "éèêë", i: "îï", o: "ôö", u: "ùûü", c: "ç", y: "ÿ",
  à: "aâä", â: "aàä", é: "eèêë", è: "eéêë", ê: "eéèë", ë: "eéèê",
  î: "iï", ï: "iî", ô: "oö", ö: "oô", ù: "uûü", û: "uùü", ü: "uùû", ç: "c",
};

/** Les voisins d'un mot à une seule correction d'accent. */
function accentNeighbors(word: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < word.length; i++) {
    for (const rep of ACCENTS[word[i]!] ?? "") {
      out.push(word.slice(0, i) + rep + word.slice(i + 1));
    }
  }
  return out;
}

/** Les voisins d'un mot à une correction près (hors accents). */
function editNeighbors(word: string, alphabet: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < word.length; i++) {
    // Suppression d'une lettre en trop.
    out.push(word.slice(0, i) + word.slice(i + 1));
    // Transposition de deux lettres voisines (« recevior » → « recevoir »).
    if (i + 1 < word.length) {
      out.push(word.slice(0, i) + word[i + 1]! + word[i]! + word.slice(i + 2));
    }
    for (const c of alphabet) {
      if (c !== word[i]) out.push(word.slice(0, i) + c + word.slice(i + 1));
      out.push(word.slice(0, i) + c + word.slice(i));
    }
  }
  for (const c of alphabet) out.push(word + c);
  return out;
}

/** Une correction candidate, avec son coût (plus bas = plus probable). */
interface Candidate {
  word: string;
  cost: number;
}

/**
 * Les corrections d'un mot, classées.
 *
 * Le classement est le cœur de l'utilité : un correcteur qui propose la bonne
 * réponse en troisième position fait perdre plus de temps qu'il n'en gagne. L'ordre
 * suit la fréquence réelle des fautes — accent, doublement de lettre, lettre en
 * trop, lettre manquante, inversion — puis la longueur.
 */
function candidates(word: string, d: Built, alphabet: string, limit: number): string[] {
  const seen = new Map<string, number>();
  const push = (w: string, cost: number) => {
    if (w === word || w.length < 2) return;
    if (!d.all.has(w)) return;
    const prev = seen.get(w);
    if (prev == null || cost < prev) seen.set(w, cost);
  };

  // 1. Les accents seuls : « etre » → « être », « francais » → « français ».
  for (const n of accentNeighbors(word)) push(n, 0);
  // 2. Le mot sans ses accents, ou avec ceux du dictionnaire : « déja » → « déjà ».
  const bare = unaccent(word);
  if (bare !== word) push(bare, 1);
  // 3. Une correction ordinaire.
  for (const n of editNeighbors(word, alphabet)) {
    // Une lettre doublée par erreur, ou manquante dans une paire, est plus
    // fréquente que n'importe quelle autre substitution.
    const doubled = n.length !== word.length && /(.)\1/.test(n + word);
    push(n, doubled ? 2 : 3);
  }
  // 4. Deux corrections : seulement si rien n'a été trouvé, car le coût grimpe.
  if (!seen.size) {
    for (const n of editNeighbors(word, alphabet)) {
      for (const m of accentNeighbors(n)) push(m, 4);
      for (const m of editNeighbors(n, alphabet)) push(m, 5);
      if (seen.size > 40) break;
    }
  }

  const list: Candidate[] = [...seen].map(([w, cost]) => ({ word: w, cost }));
  list.sort(
    (a, b) =>
      a.cost - b.cost ||
      Math.abs(a.word.length - word.length) - Math.abs(b.word.length - word.length) ||
      a.word.localeCompare(b.word, "fr"),
  );
  return list.slice(0, limit).map((c) => c.word);
}

/** Vrai si le mot est connu, préfixes verbaux et formes composées compris. */
function isKnown(raw: string, d: Built): boolean {
  const word = lower(raw);
  if (!word) return true;
  if (d.all.has(word)) return true;

  // Un mot tout en capitales perd souvent ses accents (« ECOLE ») : la
  // comparaison se fait alors sans accents, mais seulement dans ce cas.
  if (raw === raw.toLocaleUpperCase("fr") && raw.length > 1 && d.bare.has(unaccent(word))) return true;

  // Élision et enclise : « qu'il », « c'est », « allons-y », « donne-le-moi ».
  const parts = splitCompound(word);
  if (parts && parts.every((p) => d.all.has(p) || d.verbs.has(p))) return true;

  // Mot composé à trait d'union : chaque membre doit être connu.
  if (word.includes("-")) {
    const members = word.split("-").filter(Boolean);
    if (members.length > 1 && members.every((m) => d.all.has(m))) return true;
  }

  // Préfixe productif sur une forme verbale.
  for (const p of VERB_PREFIXES) {
    if (!word.startsWith(p) || word.length <= p.length + 2) continue;
    const rest = word.slice(p.length);
    if (d.verbs.has(rest)) return true;
    // Le trait d'union des préfixes autonomes : « sous-estimer », « non-respect ».
    if (rest.startsWith("-") && d.all.has(rest.slice(1))) return true;
  }
  return false;
}

/**
 * Le dictionnaire embarqué d'une langue.
 *
 * Construit paresseusement : ouvrir l'application ne paie pas le coût d'un
 * correcteur que l'auteur n'utilisera peut-être pas.
 */
export function embeddedDictionary(lang: DictLang = "fr"): SpellChecker {
  const alphabet = lang === "en" ? ALPHABET_EN : ALPHABET_FR;
  const label = lang === "en" ? "English (embarqué)" : "Français (embarqué)";
  return {
    label,
    // Partiel, et il le dit : c'est ce qui met le correcteur en mode prudent
    // (voir `checkUnknown`), donc ce qui évite de souligner le vocabulaire
    // spécialisé absent d'un lexique de quelques milliers d'entrées.
    partial: true,
    get size() {
      return dict(lang).all.size;
    },
    known(word: string) {
      return isKnown(word, dict(lang));
    },
    suggest(word: string, limit = 5) {
      const d = dict(lang);
      const w = lower(word);
      if (!w || d.all.has(w)) return [];
      const found = candidates(w, d, alphabet, limit);
      // La casse du mot d'origine est rendue : corriger « Etre » en « être »
      // obligerait à remajusculer à la main.
      const isCapital = /^\p{Lu}/u.test(word);
      return isCapital ? found.map((c) => c.charAt(0).toLocaleUpperCase("fr") + c.slice(1)) : found;
    },
  };
}

/**
 * Un vérificateur bâti sur une liste de mots fournie (fichier `.dic` importé).
 *
 * Les listes importées sont comparées **sans accents ni casse** : elles viennent de
 * sources hétérogènes, souvent partielles, et une comparaison stricte y produirait
 * des faux positifs que l'utilisateur ne peut pas corriger.
 */
export function listDictionary(list: Iterable<string>, label = "Dictionnaire importé"): SpellChecker {
  const all = new Set<string>();
  for (const w of list) {
    const t = lower(String(w).trim());
    if (t) all.add(t);
  }
  const bare = new Set<string>();
  for (const w of all) bare.add(unaccent(w));
  const d: Built = { all, verbs: new Set(), bare };
  return {
    label,
    size: all.size,
    // Une liste fournie explicitement n'est PAS partielle : ce qui n'y figure pas
    // est signalé, puisque c'est l'auteur qui a choisi la référence.
    partial: false,
    known(word: string) {
      const w = lower(word);
      return all.has(w) || bare.has(unaccent(w));
    },
    suggest(word: string, limit = 5) {
      const w = lower(word);
      if (!w || all.has(w)) return [];
      return candidates(w, d, ALPHABET_FR, limit);
    },
  };
}

/** Combine deux dictionnaires : le second complète le premier. */
export function mergeDictionaries(base: SpellChecker, extra: SpellChecker): SpellChecker {
  return {
    label: `${base.label} + ${extra.label}`,
    size: base.size + extra.size,
    // La prudence du plus incomplet des deux s'applique à l'ensemble.
    partial: base.partial === true || extra.partial === true,
    known: (w) => base.known(w) || extra.known(w),
    suggest: (w, limit = 5) => {
      const out = [...base.suggest(w, limit)];
      for (const s of extra.suggest(w, limit)) if (!out.includes(s)) out.push(s);
      return out.slice(0, limit);
    },
  };
}
