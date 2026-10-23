/// <reference lib="webworker" />
/** Worker d'extraction des images d'un PDF pour le Détecteur (terminable si le PDF est pathologique). */
import { serveWorkerTask } from "../../workers/worker-host";
import { extractPdfImages, type ImageExtractionResult, type PdfImagesRequest } from "./pdfImages";

serveWorkerTask<PdfImagesRequest, ImageExtractionResult>(async (req) => {
  const out = await extractPdfImages(req.bytes, req.pageCount);
  // Les images sont des vues sur le PDF entier : on les copie pour ne transférer que leurs octets.
  const images = out.images.map((im) => ({ ...im, bytes: im.bytes.slice() }));
  return { value: { ...out, images }, transfer: images.map((im) => im.bytes.buffer as ArrayBuffer) };
});
