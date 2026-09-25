/**
 * Recovery drafts for PDF editing sessions — the safety net for edits not yet
 * saved (crash, closed window, power cut).
 *
 * While the document has unsaved changes the workspace snapshots the editing
 * state (the model, plus the SHA-256 of the source file it applies to) into
 * IndexedDB. Re-opening the same file offers to restore it. When the local
 * vault is unlocked the state is encrypted at rest with its secret
 * (crypto/local-vault.ts); a protected PDF's edits are never stored in clear —
 * without a vault secret they are simply not snapshotted.
 *
 * The PDF itself is NOT copied with every draft:
 *  - before the session writes into its file, the file on disk IS the source;
 *  - after incremental saves into it, the source is still the first bytes of
 *    that file (an incremental save only appends): re-opening the saved file
 *    (found by `diskKey`) gives the source back by its prefix, checked
 *    against the draft's SHA-256;
 *  - only a session whose source is no longer on disk at all — recomposed
 *    (pages inserted from another PDF, OCR) — keeps it, ONCE, in a separate
 *    store (`sources`), encrypted when the vault is unlocked, never in clear
 *    for a protected document. Listing or finding drafts never reads it.
 *
 * Separate database from the text-document drafts (format/drafts-store.ts) to
 * avoid coordinating IndexedDB versions between independent features.
 */

import {
  decryptAtRest,
  decryptBytesAtRest,
  hasVaultSecret,
  openSealedBytes,
  sealBytesAtRest,
  type SealedBytes,
  type VaultSecret,
} from "../../crypto/local-vault";
import type { FsFileHandle } from "../core/destination";
import type { PdfState } from "./types";

const DB_NAME = "elium-pdf-recovery";
const STORE = "drafts";
const SOURCES = "sources";
const DB_VERSION = 2;

/** What a recomposed session carries besides its state (see PdfWorkspace « document dérivé »). */
export interface DerivedSession {
  /** Changes of the recomposed source relative to the file on disk (« pages insérées »…). */
  changes: string[];
  /** Why the next save into that file must rewrite it entirely. */
  forceFull: string[];
}

export interface PdfDraft {
  /** SHA-256 (hex) of the source file the state applies to. */
  id: string;
  name: string;
  updatedAt: string;
  /** Byte length of the source file. */
  size: number;
  /** True when the state is encrypted at rest. */
  protected: boolean;
  /** Plaintext state — only when not protected. */
  state?: PdfState;
  /** Encrypted state (binary envelope) — only when protected. */
  sealed?: SealedBytes;
  /** Encrypted state, legacy JSON/base64 envelope (drafts written before `sealed`). */
  enc?: string;
  /** Handle of the file on disk, when it was opened with one (to reopen it directly). */
  handle?: FsFileHandle;
  /**
   * SHA-256 of the destination file as it is on disk when it no longer holds
   * the source as such (saved into, or the session was recomposed): re-opening
   * that file finds the draft by this key.
   */
  diskKey?: string;
  /** Recomposed session: its source is kept in the `sources` store. */
  derived?: DerivedSession;
  /** Legacy (v1) in-record source copies — migrated to `sources` on upgrade, still read. */
  source?: Uint8Array;
  sourceEnc?: string;
}

export type PdfDraftEntry = Omit<PdfDraft, "state" | "sealed" | "enc" | "source" | "sourceEnc">;

/** A source kept for a recomposed session (store `sources`, keyed by the draft id). */
export interface PdfSourceRecord {
  id: string;
  protected: boolean;
  /** Clear bytes — only for an unprotected document without vault. */
  bytes?: Uint8Array;
  /** Encrypted bytes — vault unlocked. */
  sealed?: SealedBytes;
  /** Legacy (v1) encrypted copy. */
  legacyEnc?: string;
}

/** SHA-256 hex of the source bytes: the key a draft is filed under. */
export async function sourceKey(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource));
  let s = "";
  for (const b of digest) s += b.toString(16).padStart(2, "0");
  return s;
}

/**
 * Build the record to persist. Pure (no IndexedDB), so the clear/encrypted
 * rule is unit-testable: encrypted when `secret` holds a password/keyfile;
 * in clear only for an unprotected source; otherwise null (do not store).
 */
export async function buildPdfDraft(input: {
  id: string;
  name: string;
  size: number;
  state: PdfState;
  /** The source, the destination file or a pending protection is password-protected. */
  sourceProtected: boolean;
  secret?: VaultSecret;
  handle?: FsFileHandle;
  updatedAt?: string;
  diskKey?: string;
  derived?: DerivedSession;
}): Promise<PdfDraft | null> {
  const base = {
    id: input.id,
    name: input.name,
    size: input.size,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    ...(input.handle ? { handle: input.handle } : {}),
    ...(input.diskKey ? { diskKey: input.diskKey } : {}),
    ...(input.derived ? { derived: input.derived } : {}),
  };
  if (hasVaultSecret(input.secret)) {
    const json = new TextEncoder().encode(JSON.stringify({ state: input.state }));
    return { ...base, protected: true, sealed: await sealBytesAtRest(json, input.secret!) };
  }
  if (input.sourceProtected) return null;
  return { ...base, protected: false, state: input.state };
}

/** The source record of a recomposed session — same clear/encrypted rule as the drafts. */
export async function buildPdfSource(input: {
  id: string;
  bytes: Uint8Array;
  sourceProtected: boolean;
  secret?: VaultSecret;
}): Promise<PdfSourceRecord | null> {
  if (hasVaultSecret(input.secret)) {
    return { id: input.id, protected: true, sealed: await sealBytesAtRest(input.bytes, input.secret!) };
  }
  if (input.sourceProtected) return null;
  return { id: input.id, protected: false, bytes: input.bytes };
}

const locked = () => new Error("Brouillon chiffré : déverrouillez le coffre local pour le restaurer.");

/**
 * The source bytes a draft's state applies to, when the file just opened
 * (`disk`) is not that source itself: its prefix (the session saved into it
 * incrementally), or the copy kept for a recomposed session (`stored`).
 * Null when neither holds it.
 */
export async function resolvePdfDraftSource(
  d: PdfDraft,
  opts: { disk?: Uint8Array; stored?: PdfSourceRecord | null; secret?: VaultSecret } = {},
): Promise<Uint8Array | null> {
  const { disk, stored, secret } = opts;
  const prefix = disk ? await sourceFromPrefix(d, disk) : null;
  if (prefix) return prefix;
  const rec: PdfSourceRecord | null | undefined =
    stored ??
    (d.source || d.sourceEnc ? { id: d.id, protected: !!d.sourceEnc, bytes: d.source, legacyEnc: d.sourceEnc } : null);
  if (!rec) return null;
  if (rec.sealed) {
    if (!hasVaultSecret(secret)) throw locked();
    return openSealedBytes(rec.sealed, secret!);
  }
  if (rec.legacyEnc != null) {
    if (!hasVaultSecret(secret)) throw locked();
    return decryptBytesAtRest(rec.legacyEnc, secret!);
  }
  return rec.bytes ?? null;
}

/** The source as the first bytes of the file saved into incrementally, when it is (checked by SHA-256). */
export async function sourceFromPrefix(d: PdfDraft, disk: Uint8Array): Promise<Uint8Array | null> {
  if (disk.length <= d.size || (await sourceKey(disk.subarray(0, d.size))) !== d.id) return null;
  return disk.slice(0, d.size);
}

/** The state a draft holds, decrypting when needed. Throws when the secret is missing or wrong. */
export async function resolvePdfDraft(d: PdfDraft, secret?: VaultSecret): Promise<PdfState> {
  if (d.sealed) {
    if (!hasVaultSecret(secret)) throw locked();
    const json = new TextDecoder().decode(await openSealedBytes(d.sealed, secret!));
    return (JSON.parse(json) as { state: PdfState }).state;
  }
  if (d.enc != null) {
    if (!hasVaultSecret(secret)) throw locked();
    return (await decryptAtRest<{ state: PdfState }>(d.enc, secret!)).state;
  }
  if (!d.state) throw new Error("Brouillon vide.");
  return d.state;
}

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      const tx = req.transaction!;
      const drafts = db.objectStoreNames.contains(STORE)
        ? tx.objectStore(STORE)
        : db.createObjectStore(STORE, { keyPath: "id" });
      if (!drafts.indexNames.contains("diskKey")) drafts.createIndex("diskKey", "diskKey", { unique: false });
      const sources = db.objectStoreNames.contains(SOURCES)
        ? tx.objectStore(SOURCES)
        : db.createObjectStore(SOURCES, { keyPath: "id" });
      if (e.oldVersion >= 1 && e.oldVersion < 2) {
        // v1 kept a copy of the source in every draft: move it out, once.
        drafts.openCursor().onsuccess = (ev) => {
          const cursor = (ev.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          const d = cursor.value as PdfDraft;
          if (d.source || d.sourceEnc) {
            sources.put({ id: d.id, protected: !!d.sourceEnc, bytes: d.source, legacyEnc: d.sourceEnc });
            const { source: _s, sourceEnc: _e, ...rest } = d;
            void _s;
            void _e;
            cursor.update(rest);
          }
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const req = fn(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export async function putPdfDraft(d: PdfDraft): Promise<void> {
  try {
    await run(STORE, "readwrite", (s) => s.put(d));
  } catch {
    // A handle that cannot be cloned (some embedders): keep the draft without it.
    const { handle: _drop, ...rest } = d;
    void _drop;
    await run(STORE, "readwrite", (s) => s.put(rest));
  }
}

export async function getPdfDraft(id: string): Promise<PdfDraft | undefined> {
  return run<PdfDraft | undefined>(STORE, "readonly", (s) => s.get(id));
}

/** The draft for a file just opened: filed under its SHA-256, or naming it as its destination (`diskKey`). */
export async function findPdfDraft(key: string): Promise<PdfDraft | undefined> {
  const direct = await getPdfDraft(key);
  if (direct) return direct;
  return run<PdfDraft | undefined>(STORE, "readonly", (s) => s.index("diskKey").get(key));
}

export async function putPdfSource(rec: PdfSourceRecord): Promise<void> {
  await run(SOURCES, "readwrite", (s) => s.put(rec));
}

export async function getPdfSource(id: string): Promise<PdfSourceRecord | undefined> {
  return run<PdfSourceRecord | undefined>(SOURCES, "readonly", (s) => s.get(id));
}

/** `resolvePdfDraftSource`, reading the kept copy from IndexedDB only when the prefix does not give it. */
export async function loadPdfDraftSource(
  d: PdfDraft,
  disk: Uint8Array,
  secret?: VaultSecret,
): Promise<Uint8Array | null> {
  const prefix = await sourceFromPrefix(d, disk);
  if (prefix) return prefix;
  const stored = d.source || d.sourceEnc ? null : await getPdfSource(d.id).catch(() => undefined);
  return resolvePdfDraftSource(d, { stored, secret });
}

/** Forget a draft and the source kept with it. */
export async function deletePdfDraft(id: string): Promise<void> {
  await run(STORE, "readwrite", (s) => s.delete(id));
  await run(SOURCES, "readwrite", (s) => s.delete(id)).catch(() => {});
}

/** Drafts, newest first (metadata only — kept sources live in another store and are never read here). */
export async function listPdfDrafts(): Promise<PdfDraftEntry[]> {
  const all = await run<PdfDraft[]>(STORE, "readonly", (s) => s.getAll());
  return all
    .map(
      ({ state: _s, sealed: _x, enc: _e, source: _src, sourceEnc: _se, ...meta }) => (
        void _s,
        void _x,
        void _e,
        void _src,
        void _se,
        meta
      ),
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** True when a state carries edits worth recovering (not just a freshly opened file). */
export function hasEdits(state: PdfState): boolean {
  return (
    state.annots.length > 0 ||
    state.contentEdits.length > 0 ||
    state.imageEdits.length > 0 ||
    Object.keys(state.formValues).length > 0 ||
    state.createdFields.length > 0 ||
    (state.fieldEdits?.length ?? 0) > 0 ||
    state.pages.some((p, i) => p.from !== i || p.rotate || p.crop || p.skipped || p.label) ||
    state.watermark.enabled ||
    state.header.enabled ||
    state.footer.enabled ||
    state.bates.enabled ||
    !!state.stripMarks
  );
}
