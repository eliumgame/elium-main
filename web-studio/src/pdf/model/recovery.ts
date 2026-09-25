/**
 * Recovery drafts for PDF editing sessions — the safety net for edits not yet
 * saved (crash, closed window, power cut).
 *
 * While the document has unsaved changes the workspace snapshots the editing
 * state (never the PDF itself: only the model plus a fingerprint of the source
 * file) into IndexedDB. Re-opening the same file (same SHA-256) offers to
 * restore it. When the local vault is unlocked the state is encrypted at rest
 * with its secret (crypto/local-vault.ts, same scheme as the documents'
 * drafts); a protected PDF's edits are never stored in clear — without a vault
 * secret they are simply not snapshotted.
 *
 * Separate database from the text-document drafts (format/drafts-store.ts) to
 * avoid coordinating IndexedDB versions between independent features.
 */

import {
  decryptAtRest,
  decryptBytesAtRest,
  encryptAtRest,
  encryptBytesAtRest,
  hasVaultSecret,
  type VaultSecret,
} from "../../crypto/local-vault";
import type { FsFileHandle } from "../core/destination";
import type { PdfState } from "./types";

const DB_NAME = "elium-pdf-recovery";
const STORE = "drafts";
const DB_VERSION = 1;

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
  /** Encrypted state — only when protected. */
  enc?: string;
  /** Handle of the file on disk, when it was opened with one (to reopen it directly). */
  handle?: FsFileHandle;
  /**
   * SHA-256 of the file as last SAVED in place. Once the session has written
   * into the file, the original is gone from disk: the draft then also keeps
   * the source bytes the state applies to, and re-opening the saved file
   * (found by this key) restores the session on top of them.
   */
  diskKey?: string;
  /** Source bytes (clear) — only after an in-place save, unprotected session. */
  source?: Uint8Array;
  /** Source bytes (encrypted at rest) — only after an in-place save, vault unlocked. */
  sourceEnc?: string;
}

export type PdfDraftEntry = Omit<PdfDraft, "state" | "enc" | "source" | "sourceEnc">;

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
  sourceProtected: boolean;
  secret?: VaultSecret;
  handle?: FsFileHandle;
  updatedAt?: string;
  /** Set once the session saved into its file: see `PdfDraft.diskKey`. */
  diskKey?: string;
  source?: Uint8Array;
}): Promise<PdfDraft | null> {
  const base = {
    id: input.id,
    name: input.name,
    size: input.size,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
    ...(input.handle ? { handle: input.handle } : {}),
    ...(input.diskKey ? { diskKey: input.diskKey } : {}),
  };
  const keepSource = !!input.diskKey && !!input.source;
  if (hasVaultSecret(input.secret)) {
    return {
      ...base,
      protected: true,
      enc: await encryptAtRest({ state: input.state }, input.secret!),
      ...(keepSource ? { sourceEnc: await encryptBytesAtRest(input.source!, input.secret!) } : {}),
    };
  }
  if (input.sourceProtected) return null;
  return { ...base, protected: false, state: input.state, ...(keepSource ? { source: input.source } : {}) };
}

/** The source bytes a draft kept (after an in-place save), or null. */
export async function resolvePdfDraftSource(d: PdfDraft, secret?: VaultSecret): Promise<Uint8Array | null> {
  if (d.sourceEnc != null) {
    if (!hasVaultSecret(secret))
      throw new Error("Brouillon chiffré : déverrouillez le coffre local pour le restaurer.");
    return decryptBytesAtRest(d.sourceEnc, secret!);
  }
  return d.source ?? null;
}

/** The state a draft holds, decrypting when needed. Throws when the secret is missing or wrong. */
export async function resolvePdfDraft(d: PdfDraft, secret?: VaultSecret): Promise<PdfState> {
  if (d.enc != null) {
    if (!hasVaultSecret(secret))
      throw new Error("Brouillon chiffré : déverrouillez le coffre local pour le restaurer.");
    return (await decryptAtRest<{ state: PdfState }>(d.enc, secret!)).state;
  }
  if (!d.state) throw new Error("Brouillon vide.");
  return d.state;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export async function putPdfDraft(d: PdfDraft): Promise<void> {
  try {
    await run("readwrite", (s) => s.put(d));
  } catch {
    // A handle that cannot be cloned (some embedders): keep the draft without it.
    const { handle: _drop, ...rest } = d;
    void _drop;
    await run("readwrite", (s) => s.put(rest));
  }
}

export async function getPdfDraft(id: string): Promise<PdfDraft | undefined> {
  return run<PdfDraft | undefined>("readonly", (s) => s.get(id));
}

/** The draft for a file just opened: filed under its SHA-256, or saved into by a session (`diskKey`). */
export async function findPdfDraft(key: string): Promise<PdfDraft | undefined> {
  const direct = await getPdfDraft(key);
  if (direct) return direct;
  const all = await run<PdfDraft[]>("readonly", (s) => s.getAll());
  return all.find((d) => d.diskKey === key);
}

export async function deletePdfDraft(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}

/** Drafts, newest first (metadata only). */
export async function listPdfDrafts(): Promise<PdfDraftEntry[]> {
  const all = await run<PdfDraft[]>("readonly", (s) => s.getAll());
  return all
    .map(
      ({ state: _s, enc: _e, source: _src, sourceEnc: _se, ...meta }) => (void _s, void _e, void _src, void _se, meta),
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
    state.pages.some((p, i) => p.from !== i || p.rotate || p.crop || p.skipped || p.label) ||
    state.watermark.enabled ||
    state.header.enabled ||
    state.footer.enabled ||
    state.bates.enabled
  );
}
