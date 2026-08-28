import type {
  AnalysisReport,
  CategoryReport,
  DocumentMetadata,
  Finding,
  ImageModel,
  ParagraphModel,
  PlagiarismScanResult,
  SignalSeverity,
} from "./types";
import { REPORT_DISCLAIMER } from "./types";

export interface ScoringDocumentModel {
  paragraphs: ParagraphModel[];
  images: ImageModel[];
  metadata: DocumentMetadata;
}

export interface FindingsByCategory {
  texte: Finding[];
  mise_en_forme: Finding[];
  metadonnees: Finding[];
  image: Finding[];
}

const SEVERITY_MULTIPLIER: Record<SignalSeverity, number> = {
  info: 0,
  faible: 1,
  moyen: 2.5,
  eleve: 5,
};

/**
 * Saturating constant for score = 100 * (1 - exp(-rawSum / K)). Calibrated so
 * two or three solid "moyen" findings (weight ~0.7 each => rawSum ~5-6)
 * already land in a visibly-elevated ~40-60 range, one lone "info" finding
 * stays near 0, and no finite number of findings can silently hit exactly 100.
 */
const SATURATION_K = 7;

const CATEGORY_ORDER: (keyof FindingsByCategory)[] = ["texte", "mise_en_forme", "metadonnees", "image"];

// v1 always runs all four categories, so the weighted average below is a
// fixed weighting with no renormalization for missing categories.
const CATEGORY_WEIGHT: Record<keyof FindingsByCategory, number> = {
  texte: 0.45,
  mise_en_forme: 0.2,
  metadonnees: 0.15,
  image: 0.2,
};

function categoryScore(findings: Finding[]): number {
  const rawSum = findings.reduce((sum, f) => sum + f.weight * SEVERITY_MULTIPLIER[f.severity], 0);
  if (rawSum <= 0) return 0;
  return Math.round(100 * (1 - Math.exp(-rawSum / SATURATION_K)));
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function computeConfidence(paragraphs: ParagraphModel[]): AnalysisReport["confidence"] {
  const wordCount = paragraphs.reduce((sum, p) => sum + countWords(p.text), 0);
  const paragraphCount = paragraphs.length;
  if (wordCount < 300 || paragraphCount < 5) return "faible";
  if (wordCount > 3000 && paragraphCount >= 20) return "haute";
  return "moyenne";
}

export function computeReport(
  model: ScoringDocumentModel,
  findingsByCategory: FindingsByCategory,
  plagiarism: PlagiarismScanResult | undefined,
  generatedAt: string,
): AnalysisReport {
  const categoryScores = CATEGORY_ORDER.map((category) => ({
    category,
    score: categoryScore(findingsByCategory[category]),
  }));

  const categories: CategoryReport[] = categoryScores.map((c) => ({
    category: c.category,
    score: c.score,
    findings: findingsByCategory[c.category],
  }));

  const overallScore = Math.round(
    categoryScores.reduce((sum, c) => sum + c.score * CATEGORY_WEIGHT[c.category], 0),
  );

  return {
    overallScore,
    confidence: computeConfidence(model.paragraphs),
    categories,
    plagiarism,
    documentMetadata: model.metadata,
    generatedAt,
    disclaimer: REPORT_DISCLAIMER,
  };
}
