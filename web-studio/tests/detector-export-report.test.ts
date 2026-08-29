import { describe, expect, it, vi } from "vitest";
import { REPORT_DISCLAIMER } from "../src/detector/types";
import type { AnalysisReport, DocumentModel } from "../src/detector/types";

const downloadBlob = vi.fn();
const exportPdf = vi.fn();

vi.mock("../src/export/exporters", () => ({
  downloadBlob: (...args: unknown[]) => downloadBlob(...args),
  exportPdf: (...args: unknown[]) => exportPdf(...args),
}));

// Import après le mock — exportReport.ts importe export/exporters au niveau module.
const { exportReportAsDocx, exportReportAsPdf } = await import("../src/detector/report/exportReport");

function baseReport(): AnalysisReport {
  return {
    overallScore: 10,
    confidence: "faible",
    categories: [
      { category: "texte", score: 0, findings: [] },
      { category: "mise_en_forme", score: 0, findings: [] },
      { category: "metadonnees", score: 0, findings: [] },
      { category: "image", score: 0, findings: [] },
    ],
    documentMetadata: { sourceFormat: "docx", title: "Doc" },
    generatedAt: "2026-01-01T00:00:00.000Z",
    disclaimer: REPORT_DISCLAIMER,
  };
}

const emptyModel: DocumentModel = { paragraphs: [], images: [], metadata: { sourceFormat: "docx" } };

describe("exportReportAsDocx", () => {
  it("télécharge un .docx réel (octets ZIP/OPC valides) avec le bon nom et le bon type MIME", async () => {
    downloadBlob.mockClear();
    await exportReportAsDocx(baseReport(), emptyModel, "Mémoire de test.docx");
    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [filename, mime, bytes] = downloadBlob.mock.calls[0];
    expect(filename).toMatch(/^Rapport-Detecteur-.*\.docx$/);
    expect(mime).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect((bytes as Uint8Array).length).toBeGreaterThan(0);
  });

  it("assainit le nom de fichier (retire l'extension d'origine et les caractères interdits)", async () => {
    downloadBlob.mockClear();
    await exportReportAsDocx(baseReport(), emptyModel, 'rapport:final*"?.pdf');
    const [filename] = downloadBlob.mock.calls[0];
    expect(filename).not.toContain(":");
    expect(filename).not.toContain("*");
    expect(filename).not.toContain('"');
    expect(filename).not.toContain("?");
    expect(filename.endsWith(".docx")).toBe(true);
  });
});

describe("exportReportAsPdf", () => {
  it("appelle exportPdf (impression navigateur, comme le reste de l'app) avec un EliumFile construit à partir du rapport", async () => {
    exportPdf.mockClear();
    await exportReportAsPdf(baseReport(), emptyModel, "photo.png");
    expect(exportPdf).toHaveBeenCalledTimes(1);
    const [file] = exportPdf.mock.calls[0];
    expect(file.document.doc.type).toBe("doc");
    expect(file.manifest.title).toContain("photo.png");
  });
});
