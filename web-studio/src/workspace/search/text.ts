/**
 * Extraction du texte indexable de chaque type d'élément, et normalisation de
 * recherche. Fonctions PURES (aucune E/S) : testées dans tests/workspace-search.test.ts.
 */
import type { ProseMirrorNode } from "../../format/types";
import type { Workbook } from "../../sheet/model";
import type { Deck, SlideElement } from "../../slides/model";

/** Plafond de texte conservé par élément (évite qu'un énorme PDF fasse exploser l'index). */
export const MAX_INDEXED_CHARS = 200_000;

const MARK = /\p{M}/u;

/**
 * Plie UN caractère pour la recherche : minuscule, sans accent. Toujours UN
 * seul caractère en sortie pour UN en entrée, de sorte qu'un décalage dans le
 * texte plié est le même décalage dans l'original (surlignage exact).
 */
export function foldChar(ch: string): string {
  const d = ch.normalize("NFD").toLowerCase();
  for (const c of d) if (!MARK.test(c)) return c.length === 1 ? c : ch.toLowerCase().slice(0, 1) || ch;
  return ch;
}

export function foldText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) out += foldChar(s[i]!);
  return out;
}

/** Mots de la requête : lettres/chiffres, pliés, sans doublon. */
export function queryTerms(q: string): string[] {
  const out: string[] = [];
  for (const w of foldText(q).split(/[^\p{L}\p{N}]+/u)) if (w && !out.includes(w)) out.push(w);
  return out;
}

export function capText(s: string, max = MAX_INDEXED_CHARS): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** HTML → texte (retire les balises, décode les entités courantes). */
export function stripHtml(html: string): string {
  return html
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

const BLOCKS = new Set([
  "paragraph",
  "heading",
  "listItem",
  "blockquote",
  "codeBlock",
  "tableRow",
  "tableCell",
  "tableHeader",
  "taskItem",
  "footnote",
]);

/** Texte d'un document ProseMirror, un retour à la ligne entre blocs. */
export function docText(doc: ProseMirrorNode | undefined): string {
  if (!doc) return "";
  const parts: string[] = [];
  const walk = (n: ProseMirrorNode) => {
    if (typeof n.text === "string") {
      parts.push(n.text);
      return;
    }
    if (n.type === "hardBreak") parts.push("\n");
    for (const c of n.content ?? []) walk(c);
    if (BLOCKS.has(n.type)) parts.push("\n");
  };
  walk(doc);
  return capText(parts.join("").replace(/\n{3,}/g, "\n\n"));
}

/** Noms de feuilles et valeurs de cellules (les formules ne sont pas du texte lisible : ignorées). */
export function sheetText(wb: Workbook): string {
  const parts: string[] = [];
  for (const s of wb.sheets) {
    parts.push(s.name);
    for (const raw of Object.values(s.cells)) {
      if (typeof raw !== "string" || raw === "" || raw.startsWith("=")) continue;
      parts.push(raw);
    }
  }
  return capText(parts.join("\n"));
}

function elementText(e: SlideElement): string[] {
  const out: string[] = [];
  if (e.html) out.push(stripHtml(e.html));
  if (e.text) out.push(e.text);
  if (e.table) for (const row of e.table.cells) out.push(row.join(" "));
  if (e.chart?.title) out.push(e.chart.title);
  return out;
}

/** Titres, corps, notes et objets de chaque diapositive. */
export function deckText(deck: Deck): string {
  const parts: string[] = [];
  for (const s of deck.slides) {
    if (s.title) parts.push(s.title);
    if (s.bodyHtml) parts.push(stripHtml(s.bodyHtml));
    else if (s.body) parts.push(s.body);
    if (s.notes) parts.push(s.notes);
    for (const e of s.elements ?? []) parts.push(...elementText(e));
  }
  return capText(parts.filter(Boolean).join("\n"));
}
