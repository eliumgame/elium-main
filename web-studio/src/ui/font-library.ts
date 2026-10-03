/**
 * Bibliothèque de polices personnelles — PERSISTANTE.
 *
 * Avant, une police importée n'existait qu'en mémoire : elle disparaissait au
 * redémarrage (sauf si un document la transportait). Désormais chaque police
 * importée est conservée dans IndexedDB (`elium-fonts`), ré-enregistrée au
 * démarrage et proposée dans TOUS les sélecteurs (Documents, Tableur,
 * Présentations, PDF). Les octets restent aussi incorporés au `.elium` quand le
 * document utilise la police (format/embedded-fonts.ts), si bien qu'un document
 * partagé s'affiche correctement chez quelqu'un qui n'a pas la police.
 */
import { BUILTIN_FONTS, customFontNames, getCustomFont, registerCustomFont, unregisterCustomFont } from "./fonts";
import { MAX_FONT_BYTES, fontDisplayName, readFontMeta } from "./font-meta";
import { reportError } from "./crash-log";

const DB_NAME = "elium-fonts";
const STORE = "fonts";
const DB_VERSION = 1;

export interface UserFont {
  /** Nom affiché et clé (unique). */
  name: string;
  /** Nom de fichier conservé (`<nom>.<ext>`), repris tel quel à l'incorporation dans un .elium. */
  filename: string;
  size: number;
  addedAt: string;
  source: "fichier" | "système";
}

interface StoredFont extends UserFont {
  bytes: Uint8Array;
}

export type PrepareResult =
  | { ok: true; font: { name: string; filename: string; bytes: Uint8Array }; duplicateOf?: undefined }
  | { ok: true; duplicateOf: string; font?: undefined }
  | { ok: false; reason: string };

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Décide ce que devient un fichier déposé : valide la signature (jamais
 * l'extension), choisit un nom unique, détecte un doublon exact. Pur.
 *
 * @param existing nom → octets des polices déjà importées
 * @param reserved noms interdits (polices intégrées à l'application)
 */
export function prepareFont(
  bytes: Uint8Array,
  filename: string,
  existing: ReadonlyMap<string, Uint8Array>,
  reserved: ReadonlySet<string>,
): PrepareResult {
  if (bytes.length > MAX_FONT_BYTES) return { ok: false, reason: "fichier trop volumineux (25 Mo maximum)" };
  const meta = readFontMeta(bytes);
  if (!meta) return { ok: false, reason: "ce n'est pas une police TTF, OTF, WOFF ou WOFF2" };

  let name = fontDisplayName(meta, filename);
  const lower = new Set([...reserved].map((n) => n.toLowerCase()));
  if (lower.has(name.toLowerCase())) name = `${name} (importée)`;

  // Doublon exact (même nom, mêmes octets) : rien à faire. Même nom mais autres octets : suffixe.
  for (const [n, b] of existing) {
    if (n.toLowerCase() === name.toLowerCase() && sameBytes(b, bytes)) return { ok: true, duplicateOf: n };
  }
  const taken = new Set([...existing.keys()].map((n) => n.toLowerCase()));
  let unique = name;
  for (let i = 2; taken.has(unique.toLowerCase()); i++) unique = `${name} ${i}`;
  return { ok: true, font: { name: unique, filename: `${unique}.${meta.kind}`, bytes } };
}

// --- IndexedDB -------------------------------------------------------------

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "name" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const reservedNames = (): Set<string> => new Set(BUILTIN_FONTS.map((f) => f.name));

function existingBytes(): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const n of customFontNames()) {
    const b = getCustomFont(n);
    if (b) out.set(n, b);
  }
  return out;
}

/** Ré-enregistre au démarrage toutes les polices conservées. N'échoue jamais. */
export async function loadUserFonts(): Promise<void> {
  try {
    const all = await run<StoredFont[]>("readonly", (s) => s.getAll());
    for (const f of all) registerCustomFont(f.name, f.bytes, f.filename);
  } catch (e) {
    reportError("fonts-load", e);
  }
}

export async function listUserFonts(): Promise<UserFont[]> {
  const all = await run<StoredFont[]>("readonly", (s) => s.getAll());
  return all
    .map((f) => ({ name: f.name, filename: f.filename, size: f.size, addedAt: f.addedAt, source: f.source }))
    .sort((a, b) => a.name.localeCompare(b.name, "fr", { sensitivity: "base" }));
}

export interface ImportOutcome {
  added: string[];
  duplicates: string[];
  rejected: { file: string; reason: string }[];
}

export interface FontInput {
  filename: string;
  bytes: Uint8Array;
  source?: UserFont["source"];
}

/**
 * Importe et PERSISTE des polices. Chaque fichier est validé ; la police est
 * aussi testée par le navigateur (FontFace) pour écarter un fichier corrompu
 * qui passerait la signature.
 */
export async function importFonts(inputs: FontInput[]): Promise<ImportOutcome> {
  const out: ImportOutcome = { added: [], duplicates: [], rejected: [] };
  const existing = existingBytes();
  const reserved = reservedNames();
  for (const input of inputs) {
    const prepared = prepareFont(input.bytes, input.filename, existing, reserved);
    if (!prepared.ok) {
      out.rejected.push({ file: input.filename, reason: prepared.reason });
      continue;
    }
    if (prepared.duplicateOf) {
      out.duplicates.push(prepared.duplicateOf);
      continue;
    }
    if (!prepared.font) continue;
    const { name, filename, bytes } = prepared.font;
    try {
      const face = new FontFace(name, bytes as unknown as ArrayBuffer);
      await face.load(); // lève si le fichier est illisible pour le moteur de rendu
    } catch {
      out.rejected.push({ file: input.filename, reason: "police illisible ou corrompue" });
      continue;
    }
    try {
      const record: StoredFont = {
        name,
        filename,
        bytes,
        size: bytes.length,
        addedAt: new Date().toISOString(),
        source: input.source ?? "fichier",
      };
      await run("readwrite", (s) => s.put(record));
    } catch (e) {
      reportError("fonts-save", e);
      out.rejected.push({ file: input.filename, reason: "enregistrement local impossible (stockage plein ?)" });
      continue;
    }
    registerCustomFont(name, bytes, filename);
    existing.set(name, bytes);
    out.added.push(name);
  }
  return out;
}

export async function importFontFiles(files: FileList | File[]): Promise<ImportOutcome> {
  const inputs: FontInput[] = [];
  for (const f of Array.from(files)) {
    inputs.push({ filename: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  return importFonts(inputs);
}

export async function removeUserFont(name: string): Promise<void> {
  await run("readwrite", (s) => s.delete(name));
  unregisterCustomFont(name);
}

// --- Polices installées sur l'ordinateur (Local Font Access API, Chromium) ---

interface LocalFontData {
  family: string;
  fullName: string;
  style: string;
  blob(): Promise<Blob>;
}

export function canQuerySystemFonts(): boolean {
  return typeof (globalThis as { queryLocalFonts?: unknown }).queryLocalFonts === "function";
}

export interface SystemFontRef {
  fullName: string;
  family: string;
  style: string;
  load(): Promise<Uint8Array>;
}

/** Liste les polices installées (le navigateur demande l'autorisation à l'utilisateur). */
export async function querySystemFonts(): Promise<SystemFontRef[]> {
  const q = (globalThis as unknown as { queryLocalFonts: () => Promise<LocalFontData[]> }).queryLocalFonts;
  const fonts = await q.call(globalThis);
  return fonts
    .map((f) => ({
      fullName: f.fullName,
      family: f.family,
      style: f.style,
      load: async () => new Uint8Array(await (await f.blob()).arrayBuffer()),
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, "fr", { sensitivity: "base" }));
}
