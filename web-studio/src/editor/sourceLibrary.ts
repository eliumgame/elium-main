/**
 * Bibliothèque personnelle de sources (hors ligne, dans ce navigateur) : on y
 * garde ses références d'un document à l'autre. Le stockage est injectable
 * (tests) et toute lecture/écriture est protégée : un stockage bloqué ou
 * corrompu ne casse jamais l'éditeur.
 */
import type { BibSource } from "./citations";

const KEY = "elium.bibliography.sources.v1";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const defaultStorage = (): KeyValueStorage | null => {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
};

const isSource = (x: unknown): x is BibSource =>
  !!x &&
  typeof x === "object" &&
  typeof (x as BibSource).key === "string" &&
  typeof (x as BibSource).title === "string";

export function loadLibrary(storage: KeyValueStorage | null = defaultStorage()): BibSource[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isSource) : [];
  } catch {
    return [];
  }
}

/** Retourne false si l'écriture a échoué (quota, stockage bloqué) pour que l'appelant le signale. */
export function saveLibrary(list: BibSource[], storage: KeyValueStorage | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/** Ajoute ou remplace (par clé) une source dans une liste. */
export function upsertSource(list: BibSource[], s: BibSource): BibSource[] {
  const i = list.findIndex((x) => x.key === s.key);
  if (i < 0) return [...list, s];
  const out = list.slice();
  out[i] = s;
  return out;
}

export function removeSource(list: BibSource[], key: string): BibSource[] {
  return list.filter((x) => x.key !== key);
}

/** Fusionne sources du document et bibliothèque (le document prime), sans doublon de clé. */
export function mergeSources(docSources: BibSource[], library: BibSource[]): BibSource[] {
  const seen = new Set(docSources.map((s) => s.key));
  return [...docSources, ...library.filter((s) => !seen.has(s.key))];
}
