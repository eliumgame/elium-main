/**
 * Tâches pdf-lib exécutables hors du fil principal. Une seule définition, deux exécutions :
 * dans `pdf-lib.worker.ts` (production) ou en ligne (tests, repli) — voir src/workers/worker-task.ts.
 * Rien ici ne touche au DOM.
 */
import type { AnnotExtras } from "../ops/import-annots";

export type PdfTaskRequest = { op: "annotExtras"; bytes: Uint8Array; password: string | null };
export type PdfTaskResult = Map<number, Map<string, AnnotExtras>>;

export async function runPdfTask(req: PdfTaskRequest): Promise<PdfTaskResult> {
  switch (req.op) {
    case "annotExtras": {
      const { resolveAnnotExtras } = await import("../ops/import-annots");
      return resolveAnnotExtras(req.bytes, req.password);
    }
  }
}
