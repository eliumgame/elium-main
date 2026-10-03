#!/usr/bin/env node
/**
 * Copie les polices embarquées (paquets @fontsource, licences libres OFL/Apache)
 * dans public/fonts/ et génère public/fonts/fonts.css (@font-face).
 *
 * Pourquoi : Elium est hors-ligne d'abord. Plus aucune police n'est chargée
 * depuis Google Fonts — tout vient du paquet, donc d'un poste sans réseau.
 * Les @font-face sont déclarés mais le navigateur ne télécharge un fichier que
 * lorsqu'une police est réellement utilisée dans le document.
 *
 * Catalogue : src/ui/font-catalog.json (partagé avec src/ui/fonts.ts).
 * Sous-ensemble latin (français inclus) pour toutes les familles ; latin-ext
 * (Europe centrale) seulement pour celles marquées "ext". Graisses 400/700
 * (+ italiques quand elles existent).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const catalog = JSON.parse(readFileSync(join(root, "src/ui/font-catalog.json"), "utf8"));
const outDir = join(root, "public", "fonts");

const RANGES = {
  latin:
    "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
  "latin-ext":
    "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF",
};

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let css = "/* Généré par scripts/gen-fonts.mjs — ne pas éditer. */\n";
let count = 0;
const missing = [];

for (const f of catalog) {
  const dir = join(root, "node_modules", "@fontsource", f.id, "files");
  if (!existsSync(dir)) {
    missing.push(f.id);
    continue;
  }
  const wanted = new Set(f.weights ?? [400, 700]);
  for (const file of readdirSync(dir)) {
    const m = /^(.+)-(latin|latin-ext)-(\d+)-(normal|italic)\.woff2$/.exec(file);
    if (!m) continue;
    const [, , subset, weight, style] = m;
    if (subset === "latin-ext" && !f.ext) continue;
    if (!wanted.has(Number(weight))) continue;
    copyFileSync(join(dir, file), join(outDir, file));
    css +=
      `@font-face{font-family:'${f.name}';font-style:${style};font-weight:${weight};font-display:swap;` +
      `src:url(./${file}) format('woff2');unicode-range:${RANGES[subset]}}\n`;
    count++;
  }
}

writeFileSync(join(outDir, "fonts.css"), css);
console.log(`gen-fonts: ${count} fichiers pour ${catalog.length - missing.length} familles`);
if (missing.length) {
  console.error(`gen-fonts: paquets @fontsource manquants : ${missing.join(", ")}`);
  process.exit(1);
}
