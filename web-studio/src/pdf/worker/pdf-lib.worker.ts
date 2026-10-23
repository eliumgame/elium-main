/// <reference lib="webworker" />
/** Worker pdf-lib unique du module PDF : analyse, lecture et enregistrement lourds hors du fil principal. */
import { serveWorkerTask } from "../../workers/worker-host";
import { runPdfTask, type PdfTaskRequest, type PdfTaskResult } from "./pdf-worker-tasks";
import {
  runReadDiskTask,
  runSaveTask,
  transferablesOf,
  type DiskProxy,
  type ReadDiskRequest,
  type SaveRequest,
  type SaveResponse,
} from "./save-task";

type Req = PdfTaskRequest | SaveRequest | ReadDiskRequest;
type Res = PdfTaskResult | SaveResponse | DiskProxy;

serveWorkerTask<Req, Res>(async (req, ctx) => {
  if (req.op === "save") {
    const value = await runSaveTask(req, ctx.progress);
    return { value, transfer: transferablesOf(value) };
  }
  if (req.op === "readDisk") {
    const value = await runReadDiskTask(req);
    return { value, transfer: transferablesOf(value) };
  }
  return runPdfTask(req);
});
