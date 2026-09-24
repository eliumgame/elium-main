/**
 * One-shot page rasters for the operations that need a picture of a page
 * outside the viewer: image export, OCR, the Drive signature-placement
 * preview. (The viewer itself renders through pdf.js' `PDFPageView`s, driven
 * by `core/viewer/`; thumbnails go through `core/thumbs.ts`.)
 */

import type { PDFPageProxy } from "pdfjs-dist";

/**
 * Render one page to a detached canvas — used by image export, OCR and the
 * signature-placement preview.
 */
export async function renderToCanvas(
  page: PDFPageProxy,
  opts: { scale?: number; maxWidth?: number; maxHeight?: number; rotation?: number; background?: string },
): Promise<HTMLCanvasElement> {
  const base = page.getViewport({ scale: 1, rotation: opts.rotation ?? page.rotate });
  let scale = opts.scale ?? 1;
  if (opts.maxWidth) scale = Math.min(scale, opts.maxWidth / base.width);
  if (opts.maxHeight) scale = Math.min(scale, opts.maxHeight / base.height);
  const viewport = page.getViewport({ scale, rotation: opts.rotation ?? page.rotate });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2d context unavailable");
  ctx.fillStyle = opts.background ?? "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** Canvas → blob, promisified. */
export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), type, quality);
  });
}
