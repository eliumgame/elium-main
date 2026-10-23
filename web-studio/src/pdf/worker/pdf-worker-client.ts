import { runWorkerTask } from "../../workers/worker-task";
import type { AnnotExtras } from "../ops/import-annots";
import { runPdfTask, type PdfTaskRequest, type PdfTaskResult } from "./pdf-worker-tasks";

/** Au-delà, la lecture des annotations enrichies est abandonnée (le PDF s'ouvre quand même). */
export const MAX_ANNOT_SCAN_BYTES = 400 * 1048576;
/** Une analyse qui dure plus d'une minute est interrompue : le Worker est terminé, pas le navigateur. */
const ANALYSIS_TIMEOUT_MS = 60_000;

const createPdfWorker = () => new Worker(new URL("./pdf-lib.worker.ts", import.meta.url), { type: "module" });

function run(req: PdfTaskRequest, opts: { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number }) {
  // Les octets de l'appelant restent utilisables : le Worker reçoit une copie transférée.
  const copy = req.bytes.slice();
  return runWorkerTask<PdfTaskRequest, PdfTaskResult>({
    create: createPdfWorker,
    request: { ...req, bytes: copy },
    transfer: [copy.buffer],
    inline: () => runPdfTask(req),
    signal: opts.signal,
    timeoutMs: opts.timeoutMs ?? ANALYSIS_TIMEOUT_MS,
    inputBytes: req.bytes.length,
    maxInputBytes: opts.maxBytes,
    limitMessage: "Ce PDF est trop volumineux pour lire ses annotations enrichies.",
  });
}

/**
 * `resolveAnnotExtras` dans le Worker pdf-lib : ce que pdf.js omet des annotations (tampons,
 * pièces jointes…), sans figer l'interface à l'ouverture d'un gros PDF annoté.
 * Rejette au-delà de MAX_ANNOT_SCAN_BYTES ou du délai ; l'appelant poursuit alors sans extras.
 */
export function resolveAnnotExtrasAsync(
  bytes: Uint8Array,
  password?: string | null,
  signal?: AbortSignal,
): Promise<Map<number, Map<string, AnnotExtras>>> {
  return run({ op: "annotExtras", bytes, password: password ?? null }, { signal, maxBytes: MAX_ANNOT_SCAN_BYTES });
}
