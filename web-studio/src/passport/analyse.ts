/**
 * Analyse d'une fiche de situation : complétude rubrique par rubrique, cohérence (activités et tâches cochées,
 * nature, période) et lisibilité. Pure et déterministe : chaque remarque cite ce qui a été mesuré et le seuil —
 * ce sont des repères de rédaction, pas une note d'examen.
 */
import { activityById, allActivities, completion } from "./model";
import type { PassportData, Situation } from "./types";

export type Level = "ok" | "info" | "warn" | "error";

export interface Finding {
  level: Level;
  rubric: string;
  message: string;
}

export interface Analysis {
  /** 0-100 : part des contrôles satisfaits (les erreurs pèsent plus que les avertissements). */
  score: number;
  findings: Finding[];
  stats: { words: number; sentences: number; avgSentence: number; longestRubric: string; completion: number };
  /** Activités que le texte évoque sans qu'elles soient cochées. */
  suggestedActivities: string[];
}

const words = (t: string): string[] => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
const sentences = (t: string): string[] => t.split(/(?<=[.!?…])\s+|\n+/).filter((x) => words(x).length > 0);

/** Repères de longueur minimale (en mots) par rubrique obligatoire. */
const MIN_WORDS: { key: keyof Situation; label: string; min: number; max: number }[] = [
  { key: "intitule", label: "Intitulé", min: 3, max: 25 },
  { key: "lieuPeriodeDuree", label: "Lieu, période et durée", min: 4, max: 60 },
  { key: "cadre", label: "Cadre de la situation", min: 30, max: 250 },
  { key: "acteurs", label: "Acteurs et relations", min: 15, max: 200 },
  { key: "objectif", label: "Objectif", min: 10, max: 120 },
  { key: "conditions", label: "Conditions de réalisation", min: 15, max: 250 },
  { key: "ressources", label: "Ressources à disposition", min: 8, max: 200 },
  { key: "solutions", label: "Solutions logicielles", min: 2, max: 120 },
  { key: "productions", label: "Productions réalisées", min: 5, max: 200 },
  { key: "analyse", label: "Analyse de la situation", min: 120, max: 700 },
  { key: "contribution", label: "Contribution à la professionnalisation", min: 40, max: 300 },
];

/** Mots-clés qui trahissent chacune des six activités du domaine 1 (E4). */
const ACTIVITY_HINTS: Record<string, RegExp> = {
  "1.1": /prospect|appel\s+d[’']offre|cibl|prise\s+de\s+contact|nouveaux?\s+clients?/i,
  "1.2":
    /devis|facture|facturation|relance|impay|commande\s+client|livraison|contrat\s+(commercial|de\s+vente)|encaissement/i,
  "1.3": /r[ée]clamation|litige|accueil|conseil(?:ler)?\s+(?:le\s+)?client|fid[ée]lis|satisfaction|retour\s+client/i,
  "1.4":
    /choix\s+d[eu]s?\s+fournisseurs?|comparaison\s+des\s+offres|s[ée]lection\s+d[eu]s?\s+fournisseurs?|appel\s+aux\s+fournisseurs|cahier\s+des\s+charges/i,
  "1.5":
    /bon\s+de\s+commande|immobilisation|[ée]valuation\s+des\s+fournisseurs|r[èe]glement\s+(?:du\s+)?fournisseur|contr[ôo]le\s+des\s+achats|n[ée]gociation/i,
  "1.6": /comptab|\bTVA\b|rapprochement|banque|bancaire|tr[ée]sorerie|d[ée]claration\s+de\s+TVA|[ée]criture/i,
};

const PLACEHOLDER = /^(?:\.{3,}|…+|à\s+compl[ée]ter|n\/?a|néant|rien|xxx+|lorem)\b/i;

export function analyseSituation(s: Situation, ctx?: Pick<PassportData, "holder">): Analysis {
  const f: Finding[] = [];
  const add = (level: Level, rubric: string, message: string) => f.push({ level, rubric, message });
  let pass = 0;
  let weight = 0;
  const check = (ok: boolean, level: Exclude<Level, "ok">, rubric: string, message: string, w = 1) => {
    weight += w;
    if (ok) pass += w;
    else add(level, rubric, message);
  };

  // ---- complétude et longueur
  let longest = { label: "", n: 0 };
  let all = "";
  for (const r of MIN_WORDS) {
    const t = String(s[r.key] ?? "").trim();
    const n = words(t).length;
    all += `${t}\n`;
    if (n > longest.n) longest = { label: r.label, n };
    if (!t) {
      check(false, "error", r.label, "Rubrique vide.", 2);
      continue;
    }
    if (PLACEHOLDER.test(t)) {
      check(
        false,
        "error",
        r.label,
        "Le texte ressemble à un texte provisoire (« à compléter », points de suspension…).",
        2,
      );
      continue;
    }
    check(n >= r.min, "warn", r.label, `Rédaction courte : ${n} mot(s), au moins ${r.min} sont recommandés.`);
    if (n >= r.min && n > r.max)
      add("info", r.label, `Rubrique longue (${n} mots, repère ${r.max}) : pensez à synthétiser.`);
    else if (n >= r.min) add("ok", r.label, `${n} mot(s).`);
  }

  // ---- nature et problèmes posés
  const probs: [string, keyof Situation, boolean][] = [
    ["GRCF", "problemeGestion", s.natures.includes("grcf")],
    ["communication orale", "problemeOral", s.natures.includes("orale")],
    ["communication écrite", "problemeEcrit", s.natures.includes("ecrite")],
  ];
  for (const [label, key, wanted] of probs) {
    const n = words(String(s[key] ?? "")).length;
    if (wanted)
      check(
        n >= 15,
        n === 0 ? "error" : "warn",
        `Problème — ${label}`,
        n === 0 ? "Nature cochée mais enjeu non rédigé." : `Enjeu court : ${n} mot(s), 15 recommandés.`,
        n === 0 ? 2 : 1,
      );
    else if (n > 0)
      add(
        "info",
        `Problème — ${label}`,
        "Un enjeu est rédigé alors que cette nature n'est pas cochée : cochez-la ou retirez le texte.",
      );
  }
  check(s.natures.length > 0, "error", "Nature", "Aucune nature cochée (GRCF, communication orale ou écrite).", 2);

  // ---- activités et tâches
  check(s.activityIds.length > 0, "error", "Activités", "Aucune activité concernée n'est cochée.", 2);
  if (s.activityIds.length > 0)
    check(s.taskIds.length > 0, "warn", "Tâches", "Aucune tâche cochée : le passeport n'en grisera aucune.");
  const e4 = s.activityIds.filter((a) => a.startsWith("1."));
  if (s.activityIds.length > 0 && e4.length === 0)
    add("warn", "Activités", "Aucune activité du domaine 1 (épreuve E4) : cette fiche ne compte pas pour E4.");
  for (const a of s.activityIds) {
    const own = (activityById(a)?.tasks ?? []).filter((t) => s.taskIds.includes(t.id)).length;
    if (own === 0 && s.taskIds.length > 0) add("info", `Activité ${a}`, "Activité cochée sans aucune de ses tâches.");
  }

  // ---- cohérence texte ↔ activités
  const suggested: string[] = [];
  for (const [id, re] of Object.entries(ACTIVITY_HINTS)) {
    const hits = all.match(new RegExp(re.source, "gi"))?.length ?? 0;
    const ticked = s.activityIds.includes(id);
    if (hits > 0 && !ticked) {
      suggested.push(id);
      add(
        "info",
        `Activité ${id}`,
        `Le texte évoque cette activité (${hits} mention(s)) sans qu'elle soit cochée : « ${activityById(id)?.title ?? id} ».`,
      );
    }
    if (ticked && id.startsWith("1.") && hits === 0 && words(all).length > 60)
      add(
        "info",
        `Activité ${id}`,
        "Activité cochée mais aucun terme du texte ne la rappelle : vérifiez qu'elle est bien décrite.",
      );
  }

  // ---- période
  const nowY = new Date().getFullYear();
  const sess = Number(ctx?.holder.session);
  check(s.annee >= 2015 && s.annee <= nowY + 1, "warn", "Période", `Année « ${s.annee} » peu vraisemblable.`);
  if (Number.isFinite(sess) && s.annee > sess)
    add("warn", "Période", `La situation date de ${s.annee}, après la session ${sess}.`);

  // ---- lisibilité
  const sent = sentences(all);
  const w = words(all).length;
  const avg = sent.length ? Math.round(w / sent.length) : 0;
  if (w > 80) {
    check(
      avg <= 32,
      "info",
      "Lisibilité",
      `Phrases longues en moyenne (${avg} mots) : coupez-les pour gagner en clarté.`,
    );
    if (avg <= 32) add("ok", "Lisibilité", `Phrases de ${avg} mots en moyenne.`);
  }
  const lines = all
    .split(/\n|(?<=[.!?])\s+/)
    .map((x) => x.trim().toLowerCase())
    .filter((x) => words(x).length >= 6);
  const dup = lines.filter((x, i) => lines.indexOf(x) !== i);
  check(
    dup.length === 0,
    "warn",
    "Répétitions",
    `${dup.length} phrase(s) répétée(s) à l'identique entre les rubriques (copier-coller ?).`,
  );
  const caps = (all.match(/\b[A-ZÀ-Ý]{5,}\b/g) ?? []).length;
  if (caps > 12) add("info", "Mise en forme", `${caps} mots en capitales : à réserver aux sigles.`);
  const first = (String(s.analyse).match(/\b(je|j[’'])\b/gi) ?? []).length;
  if (words(s.analyse).length > 60 && first === 0)
    add(
      "info",
      "Analyse",
      "Aucune formulation à la première personne : l'analyse porte sur votre propre action, dites « j'ai… », « j'ai constaté… ».",
    );

  const score = weight ? Math.round((pass / weight) * 100) : 0;
  return {
    score,
    findings: f.sort((a, b) => rank(a.level) - rank(b.level)),
    stats: {
      words: w,
      sentences: sent.length,
      avgSentence: avg,
      longestRubric: longest.label,
      completion: completion(s),
    },
    suggestedActivities: suggested.filter((id) => allActivities().some((a) => a.id === id)),
  };
}

const rank = (l: Level) => ({ error: 0, warn: 1, info: 2, ok: 3 })[l];

export const LEVEL_LABEL: Record<Level, string> = {
  error: "À corriger",
  warn: "À améliorer",
  info: "À savoir",
  ok: "Conforme",
};

/** Synthèse d'un ensemble de fiches (liste des situations). */
export function analyseAll(data: PassportData): { average: number; byId: Map<number, Analysis> } {
  const byId = new Map<number, Analysis>();
  for (const s of data.situations) byId.set(s.id, analyseSituation(s, data));
  const scores = [...byId.values()].map((a) => a.score);
  return { average: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0, byId };
}
