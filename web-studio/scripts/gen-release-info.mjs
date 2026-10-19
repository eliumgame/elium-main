#!/usr/bin/env node
/**
 * Écrit `dist/release.json` : l'identité PRÉCISE de ce build (version, date, empreinte du bundle) et
 * les notes de mise à jour de la version, tirées du journal des versions de la documentation intégrée.
 * L'accueil du site (hébergé sur un serveur, sans lanceur local) l'affiche ; le serveur peut y ajouter
 * la dernière version publiée et ses installeurs (voir deploy/release-feed.py).
 *
 * Lancé après `vite build` (voir le script `build` de package.json).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Titre et puces de la section la plus récente (« ### Version X — titre ») du journal Markdown. */
export function latestNotes(md) {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^###\s+Version\s+\d/.test(l));
  if (start < 0) return { heading: "", notes: [] };
  const heading = lines[start].replace(/^###\s+/, "").trim();
  const notes = [];
  for (let i = start + 1; i < lines.length && !/^###\s/.test(lines[i]); i++) {
    const m = /^\s*-\s+(.*\S)\s*$/.exec(lines[i]);
    if (m) notes.push(m[1].replace(/\*\*/g, "").replace(/`/g, ""));
  }
  return { heading, notes };
}

export function buildReleaseInfo({ version, builtAt, buildId, journal }) {
  const { heading, notes } = latestNotes(journal);
  return { version, builtAt, buildId, heading, notes };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const root = process.cwd();
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const journalPath = join(root, "src", "docs", "sections", "18-journal-des-versions.md");
  const journal = existsSync(journalPath) ? readFileSync(journalPath, "utf8") : "";
  let buildId = "";
  try {
    const sw = readFileSync(join(root, "dist", "sw.js"), "utf8");
    buildId = /const\s+BUILD\s*=\s*["']([0-9a-f]{6,})["']/.exec(sw)?.[1] ?? "";
  } catch {
    /* pas de service worker généré : l'empreinte reste vide */
  }
  const info = buildReleaseInfo({ version: pkg.version, builtAt: new Date().toISOString(), buildId, journal });
  writeFileSync(join(root, "dist", "release.json"), JSON.stringify(info, null, 2) + "\n");
  console.log(`gen-release-info: v${info.version}, ${info.notes.length} note(s)`);
}
