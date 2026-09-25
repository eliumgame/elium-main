/**
 * pdf.js runtime configuration shared by EVERY place that opens a PDF with
 * pdf.js (the PDF module's engine, the Detector's ingest, the Drive signature
 * placement preview) — one worker URL, one set of local asset URLs, one set of
 * `getDocument` options, so a fix here reaches all of them.
 *
 * The assets (OpenJPEG/JBIG2/QCMS wasm, Adobe CMaps, standard-14 font
 * substitutes, ICC profile) are published by `scripts/pdfjs-assets-plugin.ts`
 * under `<base>/pdfjs/`. Without them pdf.js silently degrades: JPEG 2000
 * images stay blank, CJK text in fonts without embedded encodings renders as
 * tofu, and non-embedded Helvetica/Times fall back to whatever the system has.
 *
 * URLs are resolved against `document.baseURI` + Vite's `BASE_URL`, which works
 * both on the dev server and on the desktop launcher's local HTTP server (and
 * with a relative `base`, should the app ever be served from a sub-path).
 */

import type * as PdfjsTypes from "pdfjs-dist";
import type { DocumentInitParameters } from "pdfjs-dist/types/src/display/api";
import { pdfjs, sandboxBundleName } from "./pdfjs"; // also sets the worker URL of the build in use

/** Folder the Vite plugin publishes the assets under. Keep in sync with scripts/pdfjs-assets-plugin.ts. */
export const PDFJS_ASSET_DIR = "pdfjs";

/** True under Node (vitest, scripts): pdf.js then reads assets from the file system, not over HTTP. */
function runningInNode(): boolean {
  const proc = (globalThis as { process?: { versions?: { node?: string } } }).process;
  return !!proc?.versions?.node;
}

/**
 * Absolute URL (with trailing slash) of the published pdf.js asset folder, or
 * null where there is no page to resolve it against (Node).
 */
export function pdfjsAssetBase(): string | null {
  if (runningInNode() || typeof document === "undefined") return null;
  const base = (import.meta.env?.BASE_URL as string | undefined) ?? "/";
  const dir = `${base.endsWith("/") ? base : `${base}/`}${PDFJS_ASSET_DIR}/`;
  try {
    return new URL(dir, document.baseURI).href;
  } catch {
    return null;
  }
}

export interface PdfjsAssetUrls {
  wasmUrl: string;
  cMapUrl: string;
  standardFontDataUrl: string;
  iccUrl: string;
  /** Scripting sandbox bundle, for AcroForm JavaScript (not wired yet). */
  sandboxBundleSrc: string;
}

export function pdfjsAssetUrls(): PdfjsAssetUrls | null {
  const base = pdfjsAssetBase();
  if (!base) return null;
  return {
    wasmUrl: `${base}wasm/`,
    cMapUrl: `${base}cmaps/`,
    standardFontDataUrl: `${base}standard_fonts/`,
    iccUrl: `${base}iccs/`,
    sandboxBundleSrc: `${base}${sandboxBundleName}`,
  };
}

/**
 * The `getDocument` parameters every Elium caller uses. `data` is copied: pdf.js
 * transfers (detaches) the buffer it is handed to its worker.
 */
export function documentParams(data: Uint8Array, password?: string): DocumentInitParameters {
  const urls = pdfjsAssetUrls();
  return {
    data: data.slice(),
    password: password || undefined,
    ...(urls
      ? {
          wasmUrl: urls.wasmUrl,
          cMapUrl: urls.cMapUrl,
          cMapPacked: true,
          standardFontDataUrl: urls.standardFontDataUrl,
          iccUrl: urls.iccUrl,
        }
      : {}),
    // Non-embedded fonts: prefer the matching system font (Arial for
    // Helvetica…), falling back to the bundled substitutes above.
    useSystemFonts: true,
    // Canvas 2D on the GPU when available — markedly faster page rasters.
    enableHWA: true,
    // Stream the whole file eagerly: it is already in memory.
    disableAutoFetch: false,
  };
}

/** Minimal shape of the pdf.js loading task callers keep in order to tear it down. */
export interface LoadingTask {
  promise: Promise<PdfjsTypes.PDFDocumentProxy>;
  destroy: () => Promise<void>;
}

let worker: PdfjsTypes.PDFWorker | null = null;

/**
 * One pdf.js worker for the whole app, created on first use (or ahead of time
 * by `warmUpPdfWorker`) and shared by every document. Spawning a worker means
 * fetching and compiling the ~1 MB worker bundle: doing it once, instead of on
 * every open (pdf.js' default when `getDocument` gets no `worker`), is what
 * makes re-opening or comparing a file feel instant. Destroying a document
 * leaves a shared worker alive. Under Node pdf.js runs a "fake" in-thread
 * worker anyway, so nothing is shared there.
 */
export function sharedPdfWorker(): PdfjsTypes.PDFWorker | undefined {
  if (runningInNode() || typeof Worker === "undefined") return undefined;
  if (!worker || worker.destroyed) worker = new pdfjs.PDFWorker();
  return worker;
}

/** Start the shared worker now (e.g. when the PDF module is shown, before a file is picked). */
export function warmUpPdfWorker(): void {
  try {
    sharedPdfWorker();
  } catch {
    /* the first open will simply create it */
  }
}

/** Open a PDF with the shared configuration (and the shared worker). */
export function openPdfDocument(data: Uint8Array, password?: string): LoadingTask {
  const shared = sharedPdfWorker();
  return pdfjs.getDocument({
    ...documentParams(data, password),
    ...(shared ? { worker: shared } : {}),
  }) as unknown as LoadingTask;
}
