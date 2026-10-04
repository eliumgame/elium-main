import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * Garde-fou « pas de couleur hexadécimale en dur » (audit visuel, constat C2).
 *
 * Périmètre = les feuilles CSS de la coque et des écrans transverses qui ont été
 * nettoyées (Détecteur, Documentation, Drive, coque de l'espace de travail,
 * trousseau). Hors d'une DÉFINITION de variable (`--nom: #…`, donc tokens.css et
 * consorts restent la source de vérité), une couleur doit passer par `var(--…)`.
 * Ce test empêche la régression ; il ne prétend pas que tout le dépôt est propre
 * (App.css et workspace.css, partagés avec les éditeurs, ne sont PAS dans le
 * périmètre).
 */
const SRC = path.resolve(__dirname, "../src");

const SCOPE = [
  "detector/ui/DetectorView.css",
  "detector/ui/DocumentPreview.css",
  "docs/documentation.css",
  "drive-cloud/drive-cloud.css",
  "components/keyring.css",
  "workspace/ui/workspace-shell.css",
];

/** Exceptions motivées : { fichier, fragment de ligne, motif }. */
const ALLOW: { file: string; fragment: string; why: string }[] = [
  {
    file: "workspace/ui/workspace-shell.css",
    fragment: "#090c12",
    why: "bureau de l'éditeur en thème sombre (page qui se détache du bureau) — appartient au thème des éditeurs",
  },
  {
    file: "workspace/ui/workspace-shell.css",
    fragment: "#1b2232",
    why: "feuille de page de l'éditeur en thème sombre",
  },
];

const HEX = /#[0-9a-fA-F]{3,8}\b/;
const VAR_DEF = /^\s*--[\w-]+\s*:/;

function offenders(rel: string): string[] {
  const css = fs
    .readFileSync(path.join(SRC, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const out: string[] = [];
  css.split(/\r?\n/).forEach((line, i) => {
    if (!HEX.test(line) || VAR_DEF.test(line)) return;
    if (ALLOW.some((a) => a.file === rel && line.includes(a.fragment))) return;
    out.push(`${rel}:${i + 1}: ${line.trim()}`);
  });
  return out;
}

describe("CSS : pas de couleur hexadécimale en dur dans le périmètre nettoyé", () => {
  for (const rel of SCOPE) {
    it(rel, () => {
      expect(offenders(rel)).toEqual([]);
    });
  }

  it("la liste blanche ne contient que des motifs encore présents", () => {
    for (const a of ALLOW) {
      const css = fs.readFileSync(path.join(SRC, a.file), "utf8");
      expect(css.includes(a.fragment), `${a.file} : ${a.fragment} (${a.why})`).toBe(true);
    }
  });
});
