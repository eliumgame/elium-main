/**
 * Shared contract for the Détecteur module. Every signal engine (texte, mise en
 * forme, métadonnées, image, plagiat) reads a `DocumentModel` and emits
 * `Finding[]` against this contract; `scoring.ts` combines them into an
 * `AnalysisReport`. No module here may call `Date.now()`/`Math.random()` —
 * callers stamp timestamps.
 */

export type SignalCategory = "texte" | "mise_en_forme" | "metadonnees" | "image" | "plagiat";

export type SignalSeverity = "info" | "faible" | "moyen" | "eleve";

export interface FindingLocation {
  paragraphIndex?: number; // index into DocumentModel.paragraphs
  pageIndex?: number; // 0-based, when the source is paginated (PDF) or the paragraph maps to a known page
  imageIndex?: number; // index into DocumentModel.images
  charStart?: number;
  charEnd?: number;
  /** Always present, human-readable: "Paragraphe 42", "Page 12", "Image 3". */
  label: string;
}

/**
 * One concrete, explainable observation. Never a bare score: every finding
 * must be traceable to a location and carry a plain-language reason that
 * cites the actual measured value (not just a category name).
 */
export interface Finding {
  id: string;
  category: SignalCategory;
  /** Machine key, stable across runs, e.g. "burstiness_low". */
  signal: string;
  /** Short human title, e.g. "Longueur de phrase anormalement régulière". */
  label: string;
  /** Full plain-language explanation, must cite the measured value. */
  explanation: string;
  severity: SignalSeverity;
  /** 0..1 contribution weight used by scoring.ts; independent of `severity`. */
  weight: number;
  location: FindingLocation;
  /** Short verbatim excerpt or metadata value backing the finding, when applicable. */
  evidence?: string;
}

export interface RunFormat {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontFamily?: string;
  fontSize?: number; // pt
  color?: string;
}

export interface ParagraphModel {
  index: number;
  /** Concatenated plain text of the paragraph (runs joined, no formatting). */
  text: string;
  runs: RunFormat[];
  pageIndex?: number;
  heading?: number; // 1-6 when the paragraph is a heading
  listItem?: boolean;
}

export interface ImageModel {
  index: number;
  bytes: Uint8Array;
  mime: string; // "image/jpeg" | "image/png" | "image/webp" | ...
  width?: number;
  height?: number;
  pageIndex?: number;
  paragraphIndex?: number;
}

export interface DocumentMetadata {
  sourceFormat: "elium" | "docx" | "pdf" | "image";
  title?: string;
  author?: string;
  /** Producing application, when known (Word, Google Docs, a PDF producer, a specific converter...). */
  creator?: string;
  producer?: string;
  createdAt?: string; // ISO
  modifiedAt?: string; // ISO
  /** Total editing time in minutes, when the source format records it (docx app.xml). */
  editingMinutes?: number;
  revisionCount?: number;
  pageCount?: number;
}

export interface DocumentModel {
  paragraphs: ParagraphModel[];
  images: ImageModel[];
  metadata: DocumentMetadata;
}

/** One category's findings plus a 0..100 sub-score for that category. */
export interface CategoryReport {
  category: SignalCategory;
  /** 0..100 — higher means the category's signals point more strongly at AI-generation / anomalie / copie. */
  score: number;
  findings: Finding[];
}

export interface AnalysisReport {
  /** 0..100 — indice de probabilité agrégé sur texte+mise_en_forme+metadonnees+image. PAS le plagiat (score séparé). */
  overallScore: number;
  /** How much signal the document actually offered (e.g. a very short document yields low confidence regardless of score). */
  confidence: "faible" | "moyenne" | "haute";
  categories: CategoryReport[];
  /** Present only when a plagiarism scan was run (opt-in, requires a configured SearchProvider). */
  plagiarism?: PlagiarismScanResult;
  documentMetadata: DocumentMetadata;
  generatedAt: string; // ISO, stamped by the caller
  /** Fixed, honest caveat shown alongside the score everywhere in the UI. */
  disclaimer: string;
}

export const REPORT_DISCLAIMER =
  "Cette analyse produit un indice de probabilité basé sur des signaux statistiques et documentaires (style d'écriture, mise en forme, métadonnées, images). " +
  "Ce n'est pas une preuve : un texte humain peut être signalé à tort, et un texte généré par IA peut passer inaperçu. À utiliser comme point de départ, pas comme verdict.";

// ---- Plagiarism (web search) ---------------------------------------------

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/** Pluggable web-search backend. The document's content leaves the device only
 * through this interface, only for the passages selected for checking, and
 * only when the user has explicitly configured and enabled a provider. */
export interface SearchProvider {
  name: string;
  search(query: string, signal?: AbortSignal): Promise<SearchResult[]>;
}

export interface PlagiarismMatch {
  paragraphIndex: number;
  /** The excerpt from the document that was checked. */
  passage: string;
  url: string;
  sourceTitle: string;
  similarity: number; // 0..1, Jaccard similarity over word shingles
}

export interface PlagiarismScanResult {
  checkedPassages: number;
  matches: PlagiarismMatch[];
  provider: string;
}

// ---- Progress / control ----------------------------------------------------

export type AnalysisStage = "ingestion" | "texte" | "mise_en_forme" | "metadonnees" | "image" | "plagiat" | "score";

export interface AnalysisProgress {
  stage: AnalysisStage;
  processed: number;
  total: number;
}
