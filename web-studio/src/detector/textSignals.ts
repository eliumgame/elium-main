/**
 * Signaux "texte" — le style d'écriture au fil du document : régularité du
 * rythme des phrases et des paragraphes, tournures stéréotypées bien
 * documentées dans les sorties de modèles de langage, répétition des amorces
 * de phrase, tic de ponctuation (tiret cadratin) et densité de listes à
 * puces. Chaque `Finding` cite la valeur mesurée (coefficient de variation,
 * fréquence pour 1000 mots, part des phrases…), jamais un simple soupçon —
 * un texte humain peut rester en dessous de tous ces seuils, et c'est
 * volontaire : mieux vaut rater un signal faible que noyer l'utilisateur
 * sous des faux positifs.
 */
import type { Finding, ParagraphModel } from "./types";

const WORD_RE = /[\p{L}\p{N}]+/gu;

function wordCount(text: string): number {
  return (text.match(WORD_RE) ?? []).length;
}

function wordTokens(text: string): string[] {
  return text.match(WORD_RE) ?? [];
}

function round(value: number, decimals = 2): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function meanStdev(values: number[]): { mean: number; stdev: number } {
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, stdev: Math.sqrt(variance) };
}

function fullDocText(paragraphs: ParagraphModel[]): string {
  return paragraphs.map((p) => p.text).join(" ");
}

// ---- Découpage en phrases --------------------------------------------------

/**
 * Abréviations courantes dont le point ne marque pas une fin de phrase.
 * Volontairement une liste courte et prudente (cf. `editor/proofing.ts`
 * `checkCapital`) : le but n'est pas un découpage parfait, seulement d'éviter
 * les faux positifs les plus fréquents avant de mesurer la longueur des phrases.
 */
const ABBREVIATIONS = new Set([
  "m",
  "mm",
  "mme",
  "mlle",
  "dr",
  "pr",
  "st",
  "ste",
  "etc",
  "cf",
  "ex",
  "art",
  "p",
  "no",
  "vol",
  "fig",
  "chap",
  "vs",
  "jr",
  "sr",
  "mr",
  "mrs",
  "ms",
  "inc",
  "corp",
  "ltd",
  "co",
  "av",
  "bd",
  "tél",
]);

/**
 * Découpe un texte en phrases sur `. ! ? …`, en ignorant loosement les points
 * d'abréviation et d'initiale ("J. K. Rowling") : un point suivi d'une lettre
 * collée (nombre décimal, URL) n'est jamais une frontière, et un point précédé
 * d'une abréviation connue ou d'une lettre seule ne l'est pas non plus.
 */
function splitSentences(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  const out: string[] = [];
  const re = /[.!?…]+/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    const end = m.index + m[0].length;
    const after = t[end];
    if (after !== undefined && !/\s/.test(after)) continue;
    const before = t.slice(start, m.index);
    const lastWordMatch = before.match(/[\p{L}]+$/u);
    const lastWord = lastWordMatch ? lastWordMatch[0] : "";
    const isAbbreviation = lastWord.length > 0 && ABBREVIATIONS.has(lastWord.toLowerCase());
    const isInitial = lastWord.length === 1 && m[0][0] === ".";
    if (isAbbreviation || isInitial) continue;
    const sentence = t.slice(start, end).trim();
    if (sentence) out.push(sentence);
    start = end;
  }
  const rest = t.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

interface SentenceEntry {
  words: number;
  /** Clé de comparaison (repliée) des 2-3 premiers mots de la phrase. */
  openerKey: string;
  /** Forme d'origine, pour la citer dans l'explication. */
  openerLabel: string;
}

function collectSentences(paragraphs: ParagraphModel[]): SentenceEntry[] {
  const out: SentenceEntry[] = [];
  for (const p of paragraphs) {
    for (const sentence of splitSentences(p.text)) {
      const tokens = wordTokens(sentence);
      if (tokens.length === 0) continue;
      const openerTokens = tokens.slice(0, Math.min(3, tokens.length));
      out.push({
        words: tokens.length,
        openerKey: openerTokens.map((w) => w.toLocaleLowerCase("fr")).join(" "),
        openerLabel: openerTokens.join(" "),
      });
    }
  }
  return out;
}

// ---- 1. Burstiness (régularité de longueur de phrase) ---------------------

const MIN_SENTENCES_FOR_BURSTINESS = 8;
const BURSTINESS_CV_THRESHOLD = 0.35;
const BURSTINESS_CV_THRESHOLD_STRONG = 0.22;

function burstinessFinding(sentences: SentenceEntry[]): Finding | null {
  if (sentences.length < MIN_SENTENCES_FOR_BURSTINESS) return null;
  const { mean, stdev } = meanStdev(sentences.map((s) => s.words));
  if (mean === 0) return null;
  const cv = stdev / mean;
  if (cv >= BURSTINESS_CV_THRESHOLD) return null;
  const strong = cv < BURSTINESS_CV_THRESHOLD_STRONG;
  return {
    id: "txt-burstiness",
    category: "texte",
    signal: "burstiness_faible",
    label: "Longueur de phrase anormalement régulière",
    explanation:
      `Les ${sentences.length} phrases du document ont une longueur remarquablement homogène : coefficient de ` +
      `variation de ${round(cv)} (moyenne de ${round(mean, 1)} mots par phrase, écart-type de ${round(stdev, 1)}), ` +
      `nettement en dessous du seuil de ${BURSTINESS_CV_THRESHOLD} attendu d'une écriture humaine, qui alterne ` +
      "naturellement phrases courtes et phrases longues.",
    severity: strong ? "eleve" : "moyen",
    weight: strong ? 0.85 : 0.6,
    location: { label: "Ensemble du document" },
    evidence: `CV = ${round(cv)} (n = ${sentences.length})`,
  };
}

// ---- 2. Uniformité de longueur des paragraphes -----------------------------

const MIN_PARAGRAPHS_FOR_UNIFORMITY = 8;
const PARAGRAPH_CV_THRESHOLD = 0.3;
const PARAGRAPH_CV_THRESHOLD_STRONG = 0.18;

function paragraphUniformityFinding(paragraphs: ParagraphModel[]): Finding | null {
  const lengths = paragraphs.map((p) => wordCount(p.text)).filter((n) => n > 0);
  if (lengths.length < MIN_PARAGRAPHS_FOR_UNIFORMITY) return null;
  const { mean, stdev } = meanStdev(lengths);
  if (mean === 0) return null;
  const cv = stdev / mean;
  if (cv >= PARAGRAPH_CV_THRESHOLD) return null;
  const strong = cv < PARAGRAPH_CV_THRESHOLD_STRONG;
  return {
    id: "txt-paragraphes-uniformes",
    category: "texte",
    signal: "paragraphes_uniformes",
    label: "Longueur de paragraphe anormalement régulière",
    explanation:
      `Les ${lengths.length} paragraphes du document ont une longueur très homogène : coefficient de variation ` +
      `de ${round(cv)} (moyenne de ${round(mean, 1)} mots par paragraphe, écart-type de ${round(stdev, 1)}), ` +
      `nettement en dessous du seuil de ${PARAGRAPH_CV_THRESHOLD} attendu d'une rédaction humaine, où la longueur ` +
      "des paragraphes varie naturellement selon les idées développées.",
    severity: strong ? "eleve" : "moyen",
    weight: strong ? 0.75 : 0.5,
    location: { label: "Ensemble du document" },
    evidence: `CV = ${round(cv)} (n = ${lengths.length})`,
  };
}

// ---- 3. Lexique de tournures stéréotypées d'IA -----------------------------

const CLICHE_PHRASES_FR = [
  "il est important de noter que",
  "il convient de souligner",
  "en résumé,",
  "en conclusion,",
  "de plus,",
  "par ailleurs,",
  "en outre,",
  "dans le monde d'aujourd'hui",
  "il ne fait aucun doute que",
  "voici quelques éléments clés",
  "en fin de compte,",
  "il est essentiel de",
];

const CLICHE_PHRASES_EN = [
  "it is important to note that",
  "in conclusion,",
  "moreover,",
  "furthermore,",
  "delve into",
  "navigate the complexities",
  "in today's world",
  "boasts",
  "a testament to",
  "plays a pivotal role",
  "plays a crucial role",
  "it's worth noting that",
  "let's dive in",
];

const CLICHE_PHRASES = [...CLICHE_PHRASES_FR, ...CLICHE_PHRASES_EN];

/** La paire corrélative "d'une part... d'autre part" ne se recherche pas comme
 * une sous-chaîne littérale : on exige les deux membres dans le même voisinage. */
const CLICHE_PAIR_LABEL = "d'une part... d'autre part";
const CLICHE_PAIR_RE = /d['’]une part[\s\S]{0,400}?d['’]autre part/gi;

function normalizeForMatch(text: string): string {
  return text.toLocaleLowerCase("fr").replace(/[’‘]/g, "'").replace(/\s+/g, " ");
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function findCliches(text: string): Map<string, number> {
  const normalized = normalizeForMatch(text);
  const found = new Map<string, number>();
  for (const phrase of CLICHE_PHRASES) {
    const n = countOccurrences(normalized, phrase);
    if (n > 0) found.set(phrase, n);
  }
  const pairMatches = normalized.match(CLICHE_PAIR_RE);
  if (pairMatches && pairMatches.length > 0) found.set(CLICHE_PAIR_LABEL, pairMatches.length);
  return found;
}

function formatClicheList(found: Map<string, number>): string {
  return [...found.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([phrase, n]) => `« ${phrase} » (${n} fois)`)
    .join(", ");
}

const CLICHE_RATE_THRESHOLD = 3; // occurrences pour 1000 mots
const CLICHE_RATE_THRESHOLD_STRONG = 6;
const MIN_WORDS_FOR_CLICHE_RATE = 100;

function clicheDocFinding(fullText: string, totalWordCount: number): Finding | null {
  if (totalWordCount < MIN_WORDS_FOR_CLICHE_RATE) return null;
  const found = findCliches(fullText);
  if (found.size === 0) return null;
  const totalOccurrences = [...found.values()].reduce((a, b) => a + b, 0);
  const rate = (totalOccurrences / totalWordCount) * 1000;
  if (rate <= CLICHE_RATE_THRESHOLD) return null;
  const strong = rate >= CLICHE_RATE_THRESHOLD_STRONG;
  const detail = formatClicheList(found);
  return {
    id: "txt-cliches-ia",
    category: "texte",
    signal: "cliches_ia",
    label: "Tournures stéréotypées de texte généré par IA",
    explanation:
      `${totalOccurrences} occurrence(s) de tournures caractéristiques des textes générés par IA relevées sur ` +
      `${totalWordCount} mots, soit ${round(rate, 1)} pour 1000 mots (seuil : ${CLICHE_RATE_THRESHOLD} pour 1000). ` +
      `Expressions trouvées : ${detail}.`,
    severity: strong ? "eleve" : "moyen",
    weight: strong ? 0.8 : 0.55,
    location: { label: "Ensemble du document" },
    evidence: detail,
  };
}

const MIN_DISTINCT_CLICHES_PER_PARAGRAPH = 2;

function clicheParagraphFindings(paragraphs: ParagraphModel[]): Finding[] {
  const out: Finding[] = [];
  for (const p of paragraphs) {
    const found = findCliches(p.text);
    if (found.size < MIN_DISTINCT_CLICHES_PER_PARAGRAPH) continue;
    const detail = formatClicheList(found);
    out.push({
      id: `txt-cliches-ia-p${p.index}`,
      category: "texte",
      signal: "cliches_ia",
      label: "Plusieurs tournures stéréotypées d'IA dans un même paragraphe",
      explanation:
        `Ce paragraphe combine ${found.size} tournures distinctes caractéristiques des textes générés par IA : ` +
        `${detail}.`,
      severity: "faible",
      weight: 0.3,
      location: { paragraphIndex: p.index, label: `Paragraphe ${p.index + 1}` },
      evidence: detail,
    });
  }
  return out;
}

// ---- 4. Amorces de phrase répétées -----------------------------------------

const MIN_SENTENCES_FOR_OPENERS = 15;
const OPENER_SHARE_THRESHOLD = 0.15;
const OPENER_SHARE_THRESHOLD_STRONG = 0.25;

function repeatedOpenerFinding(sentences: SentenceEntry[]): Finding | null {
  if (sentences.length < MIN_SENTENCES_FOR_OPENERS) return null;
  const counts = new Map<string, { count: number; label: string }>();
  for (const s of sentences) {
    const entry = counts.get(s.openerKey);
    if (entry) entry.count++;
    else counts.set(s.openerKey, { count: 1, label: s.openerLabel });
  }
  let best: { count: number; label: string } | null = null;
  for (const entry of counts.values()) {
    if (!best || entry.count > best.count) best = entry;
  }
  if (!best) return null;
  const share = best.count / sentences.length;
  if (share < OPENER_SHARE_THRESHOLD) return null;
  const strong = share >= OPENER_SHARE_THRESHOLD_STRONG;
  return {
    id: "txt-amorces-repetees",
    category: "texte",
    signal: "amorces_repetees",
    label: "Amorce de phrase répétée de façon excessive",
    explanation:
      `L'amorce « ${best.label} » ouvre ${best.count} phrases sur ${sentences.length} ` +
      `(${round(share * 100, 1)} %), bien au-delà du seuil de ${round(OPENER_SHARE_THRESHOLD * 100)} % attendu ` +
      "dans une écriture humaine, où les débuts de phrase varient davantage.",
    severity: strong ? "eleve" : "moyen",
    weight: strong ? 0.75 : 0.5,
    location: { label: "Ensemble du document" },
    evidence: `« ${best.label} » : ${best.count}/${sentences.length}`,
  };
}

// ---- 5. Tic de ponctuation : tiret cadratin --------------------------------

const EM_DASH_RATE_THRESHOLD = 3; // occurrences pour 1000 mots
const EM_DASH_RATE_THRESHOLD_STRONG = 6;
const MIN_WORDS_FOR_EM_DASH = 150;
const MIN_EM_DASH_COUNT = 3;

function emDashFinding(fullText: string, totalWordCount: number): Finding | null {
  if (totalWordCount < MIN_WORDS_FOR_EM_DASH) return null;
  const count = (fullText.match(/—/g) ?? []).length;
  if (count < MIN_EM_DASH_COUNT) return null;
  const rate = (count / totalWordCount) * 1000;
  if (rate <= EM_DASH_RATE_THRESHOLD) return null;
  const strong = rate >= EM_DASH_RATE_THRESHOLD_STRONG;
  return {
    id: "txt-tirets-cadratins",
    category: "texte",
    signal: "tirets_cadratins_frequents",
    label: "Usage excessif du tiret cadratin",
    explanation:
      `Le tiret cadratin « — » apparaît ${count} fois sur ${totalWordCount} mots, soit ${round(rate, 1)} pour ` +
      `1000 mots (seuil : ${EM_DASH_RATE_THRESHOLD} pour 1000) — une fréquence bien supérieure à l'usage ` +
      "typographique français courant, et connue pour être surreprésentée dans les sorties de certains modèles d'IA.",
    severity: strong ? "eleve" : "moyen",
    weight: strong ? 0.6 : 0.4,
    location: { label: "Ensemble du document" },
    evidence: `${count} occurrences / ${totalWordCount} mots`,
  };
}

// ---- 6. Densité de listes à puces -------------------------------------------

const LIST_DENSITY_THRESHOLD = 0.4;
const LIST_DENSITY_THRESHOLD_STRONG = 0.65;
const MIN_PARAGRAPHS_FOR_LIST_DENSITY = 20;

function listDensityFinding(paragraphs: ParagraphModel[]): Finding | null {
  if (paragraphs.length < MIN_PARAGRAPHS_FOR_LIST_DENSITY) return null;
  const listCount = paragraphs.filter((p) => p.listItem).length;
  const ratio = listCount / paragraphs.length;
  if (ratio <= LIST_DENSITY_THRESHOLD) return null;
  const strong = ratio >= LIST_DENSITY_THRESHOLD_STRONG;
  return {
    id: "txt-densite-listes",
    category: "texte",
    signal: "densite_listes_elevee",
    label: "Densité de listes à puces anormalement élevée",
    explanation:
      `${listCount} des ${paragraphs.length} paragraphes (${round(ratio * 100, 1)} %) sont des éléments de liste, ` +
      "une densité inhabituelle pour un texte qui se présente comme de la prose continue " +
      `(seuil : ${round(LIST_DENSITY_THRESHOLD * 100)} %).`,
    severity: strong ? "moyen" : "faible",
    weight: strong ? 0.5 : 0.35,
    location: { label: "Ensemble du document" },
    evidence: `${listCount}/${paragraphs.length} paragraphes en liste`,
  };
}

// ---- Point d'entrée ----------------------------------------------------------

export function analyzeTextSignals(paragraphs: ParagraphModel[]): Finding[] {
  const findings: Finding[] = [];
  if (paragraphs.length === 0) return findings;

  const sentences = collectSentences(paragraphs);
  const fullText = fullDocText(paragraphs);
  const totalWordCount = wordCount(fullText);

  const burstiness = burstinessFinding(sentences);
  if (burstiness) findings.push(burstiness);

  const paragraphUniformity = paragraphUniformityFinding(paragraphs);
  if (paragraphUniformity) findings.push(paragraphUniformity);

  const clicheDoc = clicheDocFinding(fullText, totalWordCount);
  if (clicheDoc) findings.push(clicheDoc);
  findings.push(...clicheParagraphFindings(paragraphs));

  const openers = repeatedOpenerFinding(sentences);
  if (openers) findings.push(openers);

  const emDash = emDashFinding(fullText, totalWordCount);
  if (emDash) findings.push(emDash);

  const listDensity = listDensityFinding(paragraphs);
  if (listDensity) findings.push(listDensity);

  return findings;
}
