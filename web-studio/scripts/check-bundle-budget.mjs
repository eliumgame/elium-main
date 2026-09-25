#!/usr/bin/env node
/**
 * Regression guard for `dist/assets/` after `vite build` — not a target to
 * hit, just a tripwire for silent bloat (e.g. a new heavy dependency that
 * isn't lazy-loaded, or an existing lazy chunk pulled into the eager path).
 *
 * Budgets are current measured size + ~20% headroom, rounded. The heaviest
 * chunks (pdf-lib, pdfjs, tiptap) are checked by name PREFIX since Vite
 * content-hashes filenames; a rename/refactor that changes the hash is fine,
 * one that meaningfully changes the size is what this catches. The overall
 * total catches growth spread across many small chunks that no single
 * per-chunk budget would flag.
 *
 * pdf.js exists twice — modern and legacy builds, picked at run time
 * (src/pdf/core/pdfjs.ts) — and a browser only ever downloads ONE of them:
 * each has its own budget, and the total counts the heavier one only.
 *
 * Run after `vite build` (see package.json's `build` script and CI).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ASSETS_DIR = join(process.cwd(), "dist", "assets");

const CHUNK_BUDGETS = [
  { prefix: "vendor-pdf-lib-", limitBytes: 1_300_000 },
  { prefix: "vendor-tiptap-", limitBytes: 570_000 },
  { prefix: "vendor-pdfjs-", exclude: "vendor-pdfjs-legacy-", limitBytes: 520_000 },
  { prefix: "vendor-pdfjs-legacy-", limitBytes: 590_000 },
];

/** Chunk sets of which a browser loads exactly one (see the header). */
const ALTERNATIVES = [
  {
    modern: (n) => /^vendor-(pdfjs|pdfviewer)-/.test(n) && !/-legacy-/.test(n),
    legacy: (n) => /^vendor-(pdfjs|pdfviewer)-legacy-/.test(n),
  },
];
// 5,2 Mo → 5,35 Mo : le total compte désormais le jeu pdf.js LEGACY (le plus
// lourd, ~+65 Kio, que Chromium/Edge reçoivent tant qu'il leur manque
// Math.sumPrecise) plus la refonte PDF (enregistrement incrémental, formulaires).
const TOTAL_JS_BUDGET_BYTES = 5_350_000;

function fmtKiB(bytes) {
  return `${(bytes / 1024).toFixed(1)} KiB`;
}

function main() {
  let files;
  try {
    files = readdirSync(ASSETS_DIR);
  } catch {
    console.error(`check-bundle-budget: ${ASSETS_DIR} introuvable — lancez d'abord "vite build".`);
    process.exit(1);
  }

  const jsFiles = files.filter((f) => f.endsWith(".js"));
  const sizes = jsFiles.map((f) => ({ name: f, bytes: statSync(join(ASSETS_DIR, f)).size }));
  let totalBytes = sizes.reduce((sum, f) => sum + f.bytes, 0);
  for (const { modern, legacy } of ALTERNATIVES) {
    const sum = (test) => sizes.filter((f) => test(f.name)).reduce((acc, f) => acc + f.bytes, 0);
    totalBytes -= Math.min(sum(modern), sum(legacy));
  }

  const failures = [];

  for (const { prefix, exclude, limitBytes } of CHUNK_BUDGETS) {
    const matches = sizes.filter((f) => f.name.startsWith(prefix) && !(exclude && f.name.startsWith(exclude)));
    if (matches.length === 0) {
      console.warn(`check-bundle-budget: aucun chunk "${prefix}*" trouvé — budget ignoré (renommage ?).`);
      continue;
    }
    const bytes = matches.reduce((sum, f) => sum + f.bytes, 0);
    const status = bytes > limitBytes ? "DÉPASSÉ" : "ok";
    console.log(`  ${prefix.padEnd(20)} ${fmtKiB(bytes).padStart(12)} / ${fmtKiB(limitBytes)} budget  [${status}]`);
    if (bytes > limitBytes) {
      failures.push(`${prefix}* : ${fmtKiB(bytes)} > budget ${fmtKiB(limitBytes)}`);
    }
  }

  const totalStatus = totalBytes > TOTAL_JS_BUDGET_BYTES ? "DÉPASSÉ" : "ok";
  console.log(
    `  ${"TOTAL JS".padEnd(20)} ${fmtKiB(totalBytes).padStart(12)} / ${fmtKiB(TOTAL_JS_BUDGET_BYTES)} budget  [${totalStatus}]`,
  );
  if (totalBytes > TOTAL_JS_BUDGET_BYTES) {
    failures.push(`Total JS : ${fmtKiB(totalBytes)} > budget ${fmtKiB(TOTAL_JS_BUDGET_BYTES)}`);
  }

  if (failures.length) {
    console.error("\ncheck-bundle-budget: budget dépassé —\n" + failures.map((f) => `  - ${f}`).join("\n"));
    console.error(
      "\nSi c'est justifié (nouvelle fonctionnalité substantielle), relevez le budget correspondant dans " +
        "scripts/check-bundle-budget.mjs avec une explication ; sinon, vérifiez qu'un nouveau module lourd est " +
        "bien chargé en lazy (import() dynamique) plutôt qu'ajouté au bundle principal.",
    );
    process.exit(1);
  }
  console.log("\ncheck-bundle-budget: tous les budgets respectés.");
}

main();
