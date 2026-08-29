/**
 * Logique de présentation du rapport partagée entre l'écran (DetectorView) et
 * l'export (.docx/.pdf, report/buildReportDoc.ts) — pour que le document
 * exporté montre exactement les mêmes tri/textes que ce qui est affiché,
 * sans dupliquer (et risquer de faire diverger) ces règles à deux endroits.
 */
import type { AnalysisReport, Finding, PlagiarismMatch, SignalCategory, SignalSeverity } from "./types";
import type { PreviewFlag } from "./ui/previewFlags";

export const CATEGORY_TITLES: Record<SignalCategory, string> = {
  texte: "Texte",
  mise_en_forme: "Mise en forme",
  metadonnees: "Métadonnées",
  image: "Images",
  plagiat: "Plagiat",
};

function plagiarismFlagId(m: PlagiarismMatch, index: number): string {
  return `plagiat-${m.paragraphIndex}-${index}`;
}

/** Tous les points repérés du rapport, toutes catégories confondues (+ le
 *  plagiat) — l'aperçu et l'export annoté soulignent le document dans son
 *  ensemble, pas seulement une catégorie ou un onglet. */
export function buildPreviewFlags(report: AnalysisReport): PreviewFlag[] {
  const flags: PreviewFlag[] = [];
  for (const cat of report.categories) {
    for (const f of cat.findings) {
      if (f.location.paragraphIndex == null) continue;
      flags.push({ id: f.id, paragraphIndex: f.location.paragraphIndex, label: f.label, evidence: f.evidence });
    }
  }
  if (report.plagiarism) {
    report.plagiarism.matches.forEach((m, i) => {
      flags.push({
        id: plagiarismFlagId(m, i),
        paragraphIndex: m.paragraphIndex,
        label: `Correspondance possible avec ${m.sourceTitle || m.url}`,
        evidence: m.passage,
      });
    });
  }
  return flags;
}

/** La confiance mesure la quantité de texte disponible pour les statistiques
 *  (seuils exacts dans scoring.ts : faible sous 300 mots ou 5 paragraphes,
 *  haute au-delà de 3000 mots ET 20 paragraphes) — ce n'est PAS une seconde
 *  note sur la fiabilité du score lui-même, d'où ce mémo pour éviter la
 *  confusion entre les deux nombres affichés côte à côte. */
export function confidenceExplanation(confidence: AnalysisReport["confidence"]): string {
  if (confidence === "faible") {
    return "Confiance faible : ce document est trop court (moins de 300 mots ou 5 paragraphes) pour que les statistiques soient significatives — le score ci-contre est peu fiable, quel qu'il soit.";
  }
  if (confidence === "haute") {
    return "Confiance haute : ce document est assez long (plus de 3000 mots et 20 paragraphes) pour que les statistiques du texte soient significatives.";
  }
  return "Confiance moyenne : ce document a une longueur intermédiaire — ni trop court pour fausser les statistiques, ni assez long pour une confiance maximale.";
}

export function severityRank(s: SignalSeverity): number {
  return { eleve: 0, moyen: 1, faible: 2, info: 3 }[s];
}

export function sortedFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const rank = severityRank(a.severity) - severityRank(b.severity);
    return rank !== 0 ? rank : b.weight - a.weight;
  });
}

export function severityLabel(s: SignalSeverity): string {
  switch (s) {
    case "eleve":
      return "Élevé";
    case "moyen":
      return "Moyen";
    case "faible":
      return "Faible";
    case "info":
      return "Info";
  }
}
