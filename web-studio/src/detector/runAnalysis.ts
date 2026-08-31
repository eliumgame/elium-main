/**
 * Orchestrateur : enchaîne les 4 moteurs de signaux locaux (toujours) puis, en
 * option, le scan de plagiat web, et termine par `computeReport`. Chaque étape
 * cède la main entre les phases (`yieldToMain`) pour rester réactif sur un
 * document de plusieurs centaines de pages sans introduire de Web Worker
 * (aucun précédent de ce genre dans le code base — voir la note de conception).
 * Seul l'appelant (l'UI) horodate : ce module n'appelle jamais Date.now().
 */
import { analyzeFormattingSignals } from "./formattingSignals";
import { analyzeImageSignals } from "./imageSignals";
import { analyzeMetadataSignals } from "./metadataSignals";
import { runPlagiarismScan } from "./plagiarism/runPlagiarismScan";
import { computeReport } from "./scoring";
import { analyzeTextSignals } from "./textSignals";
import type { AnalysisProgress, AnalysisReport, DocumentModel, Finding, SearchProvider } from "./types";

export interface RunAnalysisPlagiarismOptions {
  provider: SearchProvider;
  maxQueries?: number;
  similarityThreshold?: number;
}

export interface RunAnalysisOptions {
  /** Horodatage ISO fourni par l'appelant — reporté tel quel dans le rapport. */
  generatedAt: string;
  plagiarism?: RunAnalysisPlagiarismOptions;
  /** Ids de `Finding.signal` (voir signalCatalog.ts) à exclure du rapport et du score —
   *  réglage de sensibilité pour réduire les faux positifs sur un type de document donné. */
  disabledSignals?: ReadonlySet<string>;
  signal?: AbortSignal;
  onProgress?: (progress: AnalysisProgress) => void;
}

function withoutDisabled(findings: Finding[], disabled: ReadonlySet<string> | undefined): Finding[] {
  if (!disabled || disabled.size === 0) return findings;
  return findings.filter((f) => !disabled.has(f.signal));
}

function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("Analyse annulée", "AbortError");
}

export async function runAnalysis(model: DocumentModel, opts: RunAnalysisOptions): Promise<AnalysisReport> {
  const { signal, onProgress, disabledSignals } = opts;

  throwIfAborted(signal);
  onProgress?.({ stage: "texte", processed: 0, total: 1 });
  const texte = withoutDisabled(analyzeTextSignals(model.paragraphs), disabledSignals);
  onProgress?.({ stage: "texte", processed: 1, total: 1 });
  await yieldToMain();

  throwIfAborted(signal);
  onProgress?.({ stage: "mise_en_forme", processed: 0, total: 1 });
  const mise_en_forme = withoutDisabled(analyzeFormattingSignals(model.paragraphs), disabledSignals);
  onProgress?.({ stage: "mise_en_forme", processed: 1, total: 1 });
  await yieldToMain();

  throwIfAborted(signal);
  onProgress?.({ stage: "metadonnees", processed: 0, total: 1 });
  const metadonnees = withoutDisabled(analyzeMetadataSignals(model.metadata, model.paragraphs), disabledSignals);
  onProgress?.({ stage: "metadonnees", processed: 1, total: 1 });
  await yieldToMain();

  throwIfAborted(signal);
  const imageTotal = model.images.length || 1;
  onProgress?.({ stage: "image", processed: 0, total: imageTotal });
  const image = withoutDisabled(analyzeImageSignals(model.images, model.metadata), disabledSignals);
  onProgress?.({ stage: "image", processed: imageTotal, total: imageTotal });
  await yieldToMain();

  let plagiarism;
  if (opts.plagiarism) {
    throwIfAborted(signal);
    const maxQueries = opts.plagiarism.maxQueries ?? 60;
    onProgress?.({ stage: "plagiat", processed: 0, total: maxQueries });
    plagiarism = await runPlagiarismScan(model.paragraphs, opts.plagiarism.provider, {
      maxQueries,
      similarityThreshold: opts.plagiarism.similarityThreshold,
      signal,
      onProgress: (processed, total) => onProgress?.({ stage: "plagiat", processed, total }),
    });
  }

  onProgress?.({ stage: "score", processed: 0, total: 1 });
  const report = computeReport(
    { paragraphs: model.paragraphs, images: model.images, metadata: model.metadata },
    { texte, mise_en_forme, metadonnees, image },
    plagiarism,
    opts.generatedAt,
  );
  onProgress?.({ stage: "score", processed: 1, total: 1 });
  return report;
}
