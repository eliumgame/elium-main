/**
 * Vite plugin — publishes pdf.js' runtime assets next to the app, so the PDF
 * module never reaches the network and works under the desktop CSP
 * (`default-src 'self'`).
 *
 * pdf.js needs, at run time, files that are NOT JavaScript modules and that the
 * bundler therefore never sees:
 *  - `wasm/`            OpenJPEG (JPEG 2000 / JPXDecode), JBIG2, QCMS (ICC colour
 *                       management) and QuickJS (future form JavaScript sandbox),
 *                       plus their pure-JS fallbacks;
 *  - `cmaps/`           the Adobe CMaps for CID fonts (CJK text without an
 *                       embedded ToUnicode / encoding);
 *  - `standard_fonts/`  Foxit/Liberation substitutes for the 14 standard fonts a
 *                       PDF may reference without embedding them (Helvetica…);
 *  - `iccs/`            the CMYK output profile used by QCMS;
 *  - `pdf.sandbox.min.mjs` the scripting sandbox bundle (AcroForm JavaScript).
 *
 * At build time they are emitted as assets under `<outDir>/pdfjs/…` (copied
 * straight from `node_modules/pdfjs-dist`, NOTHING is committed to the repo);
 * in dev they are served from `node_modules` by a middleware under the same
 * URL. `src/pdf/core/assets.ts` computes the matching URLs at run time.
 */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, normalize, sep } from "node:path";
import type { Plugin } from "vite";

/** Folder (relative to the app base) the assets are published under. Keep in sync with core/assets.ts. */
export const PDFJS_ASSET_DIR = "pdfjs";

/** `node_modules/pdfjs-dist` sub-folders copied verbatim. */
const DIRS = ["wasm", "cmaps", "standard_fonts", "iccs"] as const;
/** Single files copied to the root of `pdfjs/` (source path relative to pdfjs-dist). */
const FILES: Record<string, string> = { "pdf.sandbox.min.mjs": "build/pdf.sandbox.min.mjs" };

const MIME: Record<string, string> = {
  ".wasm": "application/wasm",
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".icc": "application/vnd.iccprofile",
};

function pdfjsRoot(): string {
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("pdfjs-dist/package.json"));
}

/** Every published file: `[publishedPath (relative to pdfjs/), absoluteSource]`. */
function listAssets(root: string): [string, string][] {
  const out: [string, string][] = [];
  for (const dir of DIRS) {
    const abs = join(root, dir);
    if (!existsSync(abs)) throw new Error(`pdfjs-assets: dossier introuvable ${abs}`);
    for (const name of readdirSync(abs)) {
      const file = join(abs, name);
      if (statSync(file).isFile()) out.push([`${dir}/${name}`, file]);
    }
  }
  for (const [name, rel] of Object.entries(FILES)) {
    const file = join(root, rel);
    if (!existsSync(file)) throw new Error(`pdfjs-assets: fichier introuvable ${file}`);
    out.push([name, file]);
  }
  return out;
}

function mimeOf(path: string): string {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 && MIME[path.slice(dot).toLowerCase()]) || "application/octet-stream";
}

export default function pdfjsAssets(): Plugin {
  const root = pdfjsRoot();
  let base = "/";

  return {
    name: "elium-pdfjs-assets",
    configResolved(config) {
      base = config.base || "/";
    },

    // dev: serve straight from node_modules, same URLs as the build output.
    configureServer(server) {
      const assets = new Map(listAssets(root));
      const prefix = `${base.endsWith("/") ? base : `${base}/`}${PDFJS_ASSET_DIR}/`;
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? "").split("?", 1)[0];
        if (!url.startsWith(prefix)) return next();
        const rel = decodeURIComponent(url.slice(prefix.length));
        // Only the exact published set is served — never an arbitrary path.
        const file = assets.get(rel);
        if (!file || !normalize(file).startsWith(normalize(root) + sep)) return next();
        res.setHeader("Content-Type", mimeOf(rel));
        res.setHeader("Cache-Control", "no-cache");
        createReadStream(file).pipe(res);
      });
    },

    // build: emit as regular assets so they land in dist/pdfjs/… (and in the
    // bundle's file list), without being hashed — pdf.js builds the file names
    // itself (`${cMapUrl}${name}.bcmap`, `${wasmUrl}openjpeg.wasm`…).
    generateBundle() {
      for (const [rel, file] of listAssets(root)) {
        this.emitFile({ type: "asset", fileName: `${PDFJS_ASSET_DIR}/${rel}`, source: readFileSync(file) });
      }
    },
  };
}
