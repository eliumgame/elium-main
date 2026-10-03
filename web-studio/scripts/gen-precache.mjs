#!/usr/bin/env node
/**
 * Après `vite build` : injecte dans dist/sw.js la liste des fichiers à
 * précacher et un identifiant de build (hash du contenu), pour que le service
 * worker garantisse un fonctionnement 100 % hors-ligne et se renouvelle
 * proprement à chaque version.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const dist = join(process.cwd(), "dist");

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const all = walk(dist)
  .map((p) => "/" + relative(dist, p).split("\\").join("/"))
  .filter((u) => u !== "/sw.js" && !u.endsWith(".map"))
  .sort();

const isHeavy = (u) => /^\/(fonts|tesseract|tessdata|pdfjs)\//.test(u);
const core = all.filter((u) => !isHeavy(u));
const heavy = all.filter(isHeavy);

const hash = createHash("sha256");
for (const u of all) hash.update(u).update(readFileSync(join(dist, u)));
const build = hash.digest("hex").slice(0, 12);

const swPath = join(dist, "sw.js");
let sw = readFileSync(swPath, "utf8");
sw = sw
  .replace("__BUILD_ID__", build)
  .replace("/*__PRECACHE_CORE__*/ []", JSON.stringify(core))
  .replace("/*__PRECACHE_HEAVY__*/ []", JSON.stringify(heavy));
writeFileSync(swPath, sw);
console.log(`gen-precache: build ${build} — ${core.length} fichiers core, ${heavy.length} lourds`);
