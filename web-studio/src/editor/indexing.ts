/**
 * Index generation (index / table d'index) — pure.
 *
 * Index marks (`indexEntry` nodes, Word's `XE` fields) are scattered through the
 * text; this module folds them into the alphabetical, page-numbered structure the
 * `indexBlock` renders. Page numbers come from a resolver supplied by the caller
 * (the pagination plugin owns them on screen), so this module never touches the
 * DOM and is unit-testable.
 */

import type { ProseMirrorNode } from "../format/types";

export interface IndexSubEntry {
  term: string;
  pages: number[];
}

export interface IndexEntryModel {
  term: string;
  pages: number[];
  subs: IndexSubEntry[];
}

export interface IndexGroup {
  /** The initial letter, or "#" for entries that do not start with a letter. */
  letter: string;
  entries: IndexEntryModel[];
}

/** Resolves a document position to its 1-based page (null when unknown). */
export type PageOf = (pos: number) => number | null;

/** Strip diacritics so "Élision" files under E, next to "Effacement". */
function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function initialOf(term: string): string {
  const first = fold(term.trim()).charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : "#";
}

const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });

function sortPages(pages: Set<number>): number[] {
  return [...pages].sort((a, b) => a - b);
}

interface Raw {
  term: string;
  sub: string;
  pos: number;
}

/** Fold raw marks into groups. Shared by the live and the JSON entry points. */
function group(raws: Raw[], pageOf: PageOf | null): IndexGroup[] {
  // term → { pages, subs: subTerm → pages }
  const byTerm = new Map<
    string,
    { term: string; pages: Set<number>; subs: Map<string, { term: string; pages: Set<number> }> }
  >();

  for (const raw of raws) {
    const term = raw.term.replace(/\s+/g, " ").trim();
    if (!term) continue;
    const sub = raw.sub.replace(/\s+/g, " ").trim();
    const key = fold(term).toLowerCase();
    let bucket = byTerm.get(key);
    if (!bucket) {
      bucket = { term, pages: new Set(), subs: new Map() };
      byTerm.set(key, bucket);
    }
    const page = pageOf && raw.pos >= 0 ? pageOf(raw.pos) : null;
    if (sub) {
      const subKey = fold(sub).toLowerCase();
      let subBucket = bucket.subs.get(subKey);
      if (!subBucket) {
        subBucket = { term: sub, pages: new Set() };
        bucket.subs.set(subKey, subBucket);
      }
      if (page != null) subBucket.pages.add(page);
    } else if (page != null) {
      bucket.pages.add(page);
    }
  }

  const entries: IndexEntryModel[] = [...byTerm.values()].map((b) => ({
    term: b.term,
    pages: sortPages(b.pages),
    subs: [...b.subs.values()]
      .map((s) => ({ term: s.term, pages: sortPages(s.pages) }))
      .sort((a, b2) => collator.compare(a.term, b2.term)),
  }));
  entries.sort((a, b) => collator.compare(a.term, b.term));

  const byLetter = new Map<string, IndexEntryModel[]>();
  for (const entry of entries) {
    const letter = initialOf(entry.term);
    const list = byLetter.get(letter);
    if (list) list.push(entry);
    else byLetter.set(letter, [entry]);
  }

  // "#" (symbols/digits) last, letters in French collation order — Word's layout.
  return [...byLetter.entries()]
    .sort(([a], [b]) => (a === "#" ? 1 : b === "#" ? -1 : collator.compare(a, b)))
    .map(([letter, list]) => ({ letter, entries: list }));
}

/** Minimal ProseMirror node shape, so this module needs no TipTap import. */
interface PMLike {
  descendants(
    fn: (node: { type: { name: string }; attrs: Record<string, unknown> }, pos: number) => boolean | void,
  ): void;
}

/** Build the index from a live ProseMirror document, with real page numbers. */
export function buildIndex(doc: PMLike, pageOf: PageOf | null): IndexGroup[] {
  const raws: Raw[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "indexEntry") {
      raws.push({ term: String(node.attrs.term ?? ""), sub: String(node.attrs.sub ?? ""), pos });
    }
    return true;
  });
  return group(raws, pageOf);
}

/** Build the index from plain document JSON (no page numbers available). */
export function buildIndexJson(doc: ProseMirrorNode): IndexGroup[] {
  const raws: Raw[] = [];
  const walk = (node: ProseMirrorNode) => {
    if (node.type === "indexEntry") {
      raws.push({ term: String(node.attrs?.term ?? ""), sub: String(node.attrs?.sub ?? ""), pos: -1 });
    }
    (node.content ?? []).forEach(walk);
  };
  walk(doc);
  return group(raws, null);
}

/** Flat list of distinct index terms, for autocompletion in the marking dialog. */
export function indexTerms(doc: ProseMirrorNode): string[] {
  const seen = new Map<string, string>();
  const walk = (node: ProseMirrorNode) => {
    if (node.type === "indexEntry") {
      const term = String(node.attrs?.term ?? "")
        .replace(/\s+/g, " ")
        .trim();
      // First spelling wins, so the suggestion list keeps the author's own
      // capitalisation rather than whatever the last mark happened to use.
      const key = fold(term).toLowerCase();
      if (term && !seen.has(key)) seen.set(key, term);
    }
    (node.content ?? []).forEach(walk);
  };
  walk(doc);
  return [...seen.values()].sort((a, b) => collator.compare(a, b));
}
