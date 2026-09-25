/**
 * The one entry point to pdf.js for the whole app: `import { pdfjs } from ".../core/pdfjs"`.
 *
 * pdf.js ships two builds. The modern one (`pdfjs-dist`) relies on JavaScript
 * that only the latest browsers have — `Map.prototype.getOrInsertComputed`,
 * `Uint8Array.prototype.toHex`, `Promise.try`, `Math.sumPrecise`… — and on a
 * browser a few versions old it fails on the very first call: NO PDF opens
 * (seen with Chromium 141). The legacy build carries polyfills for all of it.
 *
 * The desktop app runs in an evergreen Edge and gets the faster modern build;
 * the Drive, opened in any browser, falls back to the legacy build — with the
 * matching worker, viewer components and form-scripting sandbox — whenever one
 * of those features is missing.
 */

import type * as PdfjsModule from "pdfjs-dist";
import modernWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import legacyWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

type Pdfjs = typeof PdfjsModule;

/**
 * Does this JavaScript engine have what pdf.js' modern build calls WITHOUT a
 * guard? (Float16Array, Iterator helpers… are feature-tested by pdf.js itself.)
 * `Math.sumPrecise` matters most: the worker uses it to derive the key of
 * every AES-256 (R6) protected file and to rebuild Type1/CFF fonts — a missing
 * one means a password PDF that never opens, or text in a fallback font.
 */
export function supportsModernPdfjs(g: typeof globalThis = globalThis): boolean {
  type Bag = Record<string, unknown>;
  const at = (name: string) => (g as unknown as Record<string, Bag | undefined>)[name];
  const proto = (name: string) => (at(name) as { prototype?: Bag } | undefined)?.prototype;
  const fn = (v: unknown) => typeof v === "function";
  try {
    return (
      fn(proto("Map")?.getOrInsertComputed) &&
      fn(proto("Uint8Array")?.toHex) &&
      fn(proto("Uint8Array")?.toBase64) &&
      fn(at("Uint8Array")?.fromBase64) &&
      fn(at("Promise")?.try) &&
      fn(at("Promise")?.withResolvers) &&
      fn(at("Math")?.sumPrecise) &&
      fn(at("RegExp")?.escape) &&
      fn(proto("ArrayBuffer")?.transferToFixedLength)
    );
  } catch {
    return false;
  }
}

/** True when the modern build is in use (false: legacy). */
export const modernPdfjs = supportsModernPdfjs();

export const pdfjs: Pdfjs = modernPdfjs
  ? await import("pdfjs-dist")
  : ((await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as Pdfjs);

pdfjs.GlobalWorkerOptions.workerSrc = modernPdfjs ? modernWorkerUrl : legacyWorkerUrl;

/** pdf.js' viewer components (PDFPageView…), from the same build as `pdfjs`. */
export function importViewerModule(): Promise<typeof import("pdfjs-dist/web/pdf_viewer.mjs")> {
  return modernPdfjs
    ? import("pdfjs-dist/web/pdf_viewer.mjs")
    : (import("pdfjs-dist/legacy/web/pdf_viewer.mjs") as unknown as Promise<
        typeof import("pdfjs-dist/web/pdf_viewer.mjs")
      >);
}

/** File name of the form-scripting sandbox bundle for this build, under the published `pdfjs/` folder. */
export const sandboxBundleName = modernPdfjs ? "pdf.sandbox.min.mjs" : "legacy/pdf.sandbox.min.mjs";
