/// <reference lib="webworker" />
/** Worker pdf-lib unique du module PDF : analyse, lecture et enregistrement lourds hors du fil principal. */
import { extractPdfImages, type ImageExtractionResult, type PdfImagesRequest } from "../../detector/ingest/pdfImages";
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

type Req = PdfTaskRequest | SaveRequest | ReadDiskRequest | PdfImagesRequest;
type Res = PdfTaskResult | SaveResponse | DiskProxy | ImageExtractionResult;

serveWorkerTask<Req, Res>(async (req, ctx) => {
  if (req.op === "pdfImages") {
    // Extraction d'images du Détecteur : les images sont des vues sur le PDF entier, on copie leurs octets.
    const out = await extractPdfImages(req.bytes, req.pageCount);
    const images = out.images.map((im) => ({ ...im, bytes: im.bytes.slice() }));
    return { value: { ...out, images }, transfer: images.map((im) => im.bytes.buffer as ArrayBuffer) };
  }
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
