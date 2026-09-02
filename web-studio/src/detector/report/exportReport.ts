/**
 * Exporte le rapport (score + points relevés + document annoté) en .docx ou
 * PDF, en réutilisant tel quel le pipeline d'export de documents texte déjà
 * utilisé partout ailleurs dans l'app (`createEliumFile` → `docToDocx` /
 * `exportPdf`), plutôt que d'écrire un générateur .docx/PDF dédié : le
 * rapport construit par `buildReportDoc` est un document ProseMirror comme un
 * autre. Le PDF suit donc la même convention que le reste de l'app — impression
 * navigateur sur un document autonome, pas des octets PDF générés directement
 * (voir `export/exporters.ts`, aucune génération PDF programmatique n'existe
 * ailleurs dans le projet pour un document texte).
 */
import { createEliumFile } from "../../format/document";
import { docToDocx } from "../../format/docx";
import { downloadBlob, exportPdf } from "../../export/exporters";
import type { AnalysisReport, DocumentModel } from "../types";
import { buildReportDoc } from "./buildReportDoc";

function reportTitle(fileName: string): string {
  return `Rapport Détecteur — ${fileName}`;
}

function safeFileStem(fileName: string): string {
  const withoutExt = fileName.replace(/\.[^./\\]+$/, "");
  return withoutExt.replace(/[\\/:*?"<>|]/g, "_").trim() || "document";
}

export async function exportReportAsDocx(
  report: AnalysisReport,
  model: DocumentModel,
  fileName: string,
): Promise<void> {
  const doc = buildReportDoc(report, model, fileName);
  const file = await createEliumFile({ title: reportTitle(fileName), profile: "standard", doc });
  downloadBlob(
    `Rapport-Detecteur-${safeFileStem(fileName)}.docx`,
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    docToDocx(file),
  );
}

export async function exportReportAsPdf(report: AnalysisReport, model: DocumentModel, fileName: string): Promise<void> {
  const doc = buildReportDoc(report, model, fileName);
  const file = await createEliumFile({ title: reportTitle(fileName), profile: "standard", doc });
  exportPdf(file);
}
