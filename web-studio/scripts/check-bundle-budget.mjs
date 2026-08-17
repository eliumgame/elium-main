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
 * Run after `vite build` (see package.json's `build` script and CI).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ASSETS_DIR = join(process.cwd(), "dist", "assets");

const CHUNK_BUDGETS = [
  { prefix: "vendor-pdf-lib-", limitBytes: 1_300_000 },
  { prefix: "vendor-tiptap-", limitBytes: 570_000 },
  { prefix: "vendor-pdfjs-", limitBytes: 520_000 },
];
const TOTAL_JS_BUDGET_BYTES = 5_200_000;

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
  const totalBytes = sizes.reduce((sum, f) => sum + f.bytes, 0);

  const failures = [];

  for (const { prefix, limitBytes } of CHUNK_BUDGETS) {
    const matches = sizes.filter((f) => f.name.startsWith(prefix));
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
