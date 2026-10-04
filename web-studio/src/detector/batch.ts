/**
 * Analyse par lot : plusieurs fichiers (ou un dossier déposé) passent un par un
 * dans le même pipeline que l'analyse unitaire ; le résultat est un tableau
 * comparatif exportable (CSV, JSON). Chaque fichier échoue isolément : un
 * document illisible ou protégé n'interrompt jamais le lot, il est signalé sur
 * sa ligne avec la raison.
 */
import {
  EliumPasswordRequired,
  EliumRecipientKeyRequired,
  PdfPasswordRequired,
  UnsupportedFileError,
} from "./ingest/loadFile";
import { runAnalysis } from "./runAnalysis";
import type { AnalysisReport, DocumentModel, Finding } from "./types";

export type BatchStatus = "ok" | "protege" | "illisible" | "erreur" | "annule";

export interface BatchRow {
  fileName: string;
  status: BatchStatus;
  /** Raison lisible pour un statut autre que « ok ». */
  detail?: string;
  overallScore?: number;
  confidence?: AnalysisReport["confidence"];
  /** Score par catégorie (texte, mise_en_forme, metadonnees, image). */
  categoryScores?: Record<string, number>;
  findingCount?: number;
  /** Libellés des trois constats les plus pesants. */
  topFindings?: string[];
  /** Statut C2PA le plus significatif relevé sur les images du fichier. */
  c2pa?: string;
  report?: AnalysisReport;
}

export interface BatchOptions {
  generatedAt: string;
  disabledSignals?: ReadonlySet<string>;
  signal?: AbortSignal;
  load: (file: File) => Promise<DocumentModel>;
  onRow?: (row: BatchRow, index: number, total: number) => void;
}

const SEVERITY_RANK = { info: 0, faible: 1, moyen: 2, eleve: 3 } as const;

function topFindings(report: AnalysisReport): Finding[] {
  return report.categories
    .flatMap((c) => c.findings)
    .filter((f) => f.severity !== "info")
    .sort((a, b) => SEVERITY_RANK[b.severity] * b.weight - SEVERITY_RANK[a.severity] * a.weight)
    .slice(0, 3);
}

function c2paSummary(report: AnalysisReport): string | undefined {
  const sig = new Set(report.categories.flatMap((c) => c.findings.map((f) => f.signal)));
  if (sig.has("image_c2pa_invalid")) return "manifeste invalide";
  const ai = report.categories.flatMap((c) => c.findings).find((f) => f.signal === "image_c2pa_ai_source");
  if (ai) return ai.severity === "eleve" ? "IA déclarée (émetteur reconnu)" : "IA déclarée";
  if (sig.has("image_c2pa_verified_provenance")) return "provenance signée";
  return undefined;
}

export async function analyzeOne(file: File, opts: BatchOptions): Promise<BatchRow> {
  const fileName = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
  try {
    const model = await opts.load(file);
    const report = await runAnalysis(model, {
      generatedAt: opts.generatedAt,
      disabledSignals: opts.disabledSignals,
      signal: opts.signal,
    });
    return {
      fileName,
      status: "ok",
      overallScore: report.overallScore,
      confidence: report.confidence,
      categoryScores: Object.fromEntries(report.categories.map((c) => [c.category, c.score])),
      findingCount: report.categories.reduce((n, c) => n + c.findings.length, 0),
      topFindings: topFindings(report).map((f) => f.label),
      c2pa: c2paSummary(report),
      report,
    };
  } catch (err) {
    if (opts.signal?.aborted) return { fileName, status: "annule", detail: "Analyse annulée" };
    if (err instanceof EliumPasswordRequired || err instanceof PdfPasswordRequired)
      return {
        fileName,
        status: "protege",
        detail: "Document protégé par mot de passe : à analyser individuellement.",
      };
    if (err instanceof EliumRecipientKeyRequired)
      return { fileName, status: "protege", detail: "Document chiffré pour des destinataires." };
    const message = err instanceof Error ? err.message : String(err);
    return { fileName, status: err instanceof UnsupportedFileError ? "illisible" : "erreur", detail: message };
  }
}

const ACCEPTED = /\.(elium|docx|pdf|png|jpe?g|webp)$/i;

/** Garde les formats pris en charge ; renvoie aussi le nombre d'ignorés pour en informer l'utilisateur. */
export function filterSupported(files: File[]): { files: File[]; ignored: number } {
  const kept = files.filter((f) => ACCEPTED.test(f.name));
  return { files: kept, ignored: files.length - kept.length };
}

export async function runBatch(files: File[], opts: BatchOptions): Promise<BatchRow[]> {
  const rows: BatchRow[] = [];
  for (let i = 0; i < files.length; i++) {
    if (opts.signal?.aborted) break;
    const row = await analyzeOne(files[i]!, opts);
    rows.push(row);
    opts.onRow?.(row, i, files.length);
    await new Promise((r) => setTimeout(r, 0)); // laisse respirer l'interface entre deux fichiers
  }
  return rows;
}

const COLUMNS = [
  "Fichier",
  "Statut",
  "Score global",
  "Confiance",
  "Texte",
  "Mise en forme",
  "Métadonnées",
  "Images",
  "Constats",
  "Principaux constats",
  "C2PA",
  "Détail",
];

function csvCell(v: string | number | undefined): string {
  const s = v === undefined ? "" : String(v);
  // Neutralise l'injection de formule à l'ouverture dans un tableur.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[;"\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** CSV français (séparateur « ; », BOM UTF-8) : s'ouvre directement dans Excel. */
export function batchToCsv(rows: BatchRow[]): string {
  const lines = [COLUMNS.join(";")];
  for (const r of rows) {
    lines.push(
      [
        r.fileName,
        r.status,
        r.overallScore,
        r.confidence,
        r.categoryScores?.texte,
        r.categoryScores?.mise_en_forme,
        r.categoryScores?.metadonnees,
        r.categoryScores?.image,
        r.findingCount,
        r.topFindings?.join(" | "),
        r.c2pa,
        r.detail,
      ]
        .map(csvCell)
        .join(";"),
    );
  }
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/** Export combiné : tous les rapports complets dans un seul JSON. */
export function batchToJson(rows: BatchRow[], generatedAt: string): string {
  return JSON.stringify(
    { generatedAt, files: rows.map(({ report, ...summary }) => ({ ...summary, report })) },
    null,
    2,
  );
}
