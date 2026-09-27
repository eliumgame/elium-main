/**
 * Loader for pdf.js' viewer components (`pdfjs-dist/web/pdf_viewer.mjs` — the
 * `PDFPageView` that Firefox's own PDF viewer is built from, with its canvas,
 * detail/tile canvas, text layer and annotation layer).
 *
 * `pdf_viewer.mjs` does not import pdf.js: it destructures `globalThis.pdfjsLib`
 * when it is EVALUATED. So it is loaded with a dynamic `import()` only after
 * `pdfjs-dist` itself is guaranteed to have run (and assigned that global) —
 * a static import would leave the order to the bundler's chunking.
 */

import { importViewerModule, pdfjs } from "../pdfjs";
import "../assets"; // shared options

type ViewerModule = typeof import("pdfjs-dist/web/pdf_viewer.mjs");

export interface ViewerLib {
  PDFPageView: ViewerModule["PDFPageView"];
  EventBus: ViewerModule["EventBus"];
  RenderingStates: { INITIAL: number; RUNNING: number; PAUSED: number; FINISHED: number };
}

let loading: Promise<ViewerLib> | null = null;

export function loadViewerLib(): Promise<ViewerLib> {
  if (!loading) {
    const g = globalThis as { pdfjsLib?: unknown };
    g.pdfjsLib ??= pdfjs;
    loading = importViewerModule().then((m) => ({
      PDFPageView: m.PDFPageView,
      EventBus: m.EventBus,
      RenderingStates: m.RenderingStates as unknown as ViewerLib["RenderingStates"],
    }));
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

/** pdf.js' CSS pixels per PDF point (96 / 72): `PDFPageView.scale` is expressed relative to it. */
export const PDF_TO_CSS_UNITS = pdfjs.PixelsPerInch.PDF_TO_CSS_UNITS;

/**
 * `PDFPageView` wants an l10n service; its default one fetches Fluent locale
 * files from the network. The page view only uses it to pause/resume DOM
 * observation and for ARIA labels we set ourselves, so a no-op is exact.
 */
export const NO_L10N = {
  getLanguage: () => "fr",
  getDirection: () => "ltr",
  get: async () => "",
  translate: async () => {},
  translateOnce: async () => {},
  pause: () => {},
  resume: () => {},
  destroy: async () => {},
};

/**
 * Canvas budget. pdf.js caps each page canvas to `maxCanvasPixels`, further
 * limited to the screen area × (1 + capCanvasAreaFactor / 100); beyond that it
 * renders the page at a lower resolution and paints a sharp "detail" canvas
 * (a tile) over the visible part only — how Firefox stays crisp at 800 %
 * without allocating gigabytes. Lower budget on low-memory devices.
 */
export function canvasBudget(): { maxCanvasPixels: number; maxCanvasDim: number; capCanvasAreaFactor: number } {
  const mem = (globalThis.navigator as { deviceMemory?: number } | undefined)?.deviceMemory ?? 8;
  return {
    maxCanvasPixels: mem <= 2 ? 2 ** 22 : mem <= 4 ? 2 ** 23 : 2 ** 25,
    // GPU textures top out at 16384 on most integrated chips; larger canvases
    // silently fall back to (slow) software rendering.
    maxCanvasDim: 16384,
    capCanvasAreaFactor: 200,
  };
}
