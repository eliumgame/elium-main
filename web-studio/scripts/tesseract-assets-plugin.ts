/**
 * Vite plugin — publishes Tesseract's runtime (worker script and WebAssembly
 * core) next to the app, so OCR never reaches the network: the desktop CSP
 * (`script-src 'self'`, `connect-src 'self'`) forbids the CDN tesseract.js
 * uses by default, and an offline machine has none.
 *
 * Only the LSTM cores are published (Elium runs OEM 1, LSTM only), with and
 * without SIMD — tesseract.js picks one at run time. Language models live in
 * `public/tessdata/`. Build: emitted under `<outDir>/tesseract/`; dev: served
 * from node_modules under the same URL. Keep TESSERACT_ASSET_DIR in sync with
 * `src/pdf/ops/ocr.ts`.
 */
import { createReadStream, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

export const TESSERACT_ASSET_DIR = "tesseract";

function assets(): Map<string, string> {
  const require = createRequire(import.meta.url);
  const js = dirname(require.resolve("tesseract.js/package.json"));
  const core = dirname(require.resolve("tesseract.js-core/package.json"));
  return new Map([
    ["worker.min.js", join(js, "dist/worker.min.js")],
    ["tesseract-core-lstm.wasm.js", join(core, "tesseract-core-lstm.wasm.js")],
    ["tesseract-core-simd-lstm.wasm.js", join(core, "tesseract-core-simd-lstm.wasm.js")],
  ]);
}

export default function tesseractAssets(): Plugin {
  let base = "/";
  return {
    name: "elium-tesseract-assets",
    configResolved(config) {
      base = config.base || "/";
    },
    configureServer(server) {
      const files = assets();
      const prefix = `${base.endsWith("/") ? base : `${base}/`}${TESSERACT_ASSET_DIR}/`;
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?", 1)[0];
        if (!url.startsWith(prefix)) return next();
        const file = files.get(decodeURIComponent(url.slice(prefix.length)));
        if (!file) return next();
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const [name, file] of assets()) {
        this.emitFile({ type: "asset", fileName: `${TESSERACT_ASSET_DIR}/${name}`, source: readFileSync(file) });
      }
    },
  };
}
