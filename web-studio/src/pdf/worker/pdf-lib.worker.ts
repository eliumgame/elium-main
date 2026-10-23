/// <reference lib="webworker" />
/** Worker pdf-lib unique du module PDF : chargement/analyse lourds hors du fil principal. */
import { serveWorkerTask } from "../../workers/worker-host";
import { runPdfTask, type PdfTaskRequest, type PdfTaskResult } from "./pdf-worker-tasks";

serveWorkerTask<PdfTaskRequest, PdfTaskResult>((req) => runPdfTask(req));
