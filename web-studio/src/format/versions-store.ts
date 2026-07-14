/**
 * Local version history (editable drafts) backed by IndexedDB. These snapshots
 * live in THIS browser only — they are deliberately separate from the document's
 * immutable, hash-chained journal (which travels inside the .elium and is the
 * signed audit trail). Keyed by the document's creation timestamp.
 *
 * For protected documents (password and/or keyfile) the snapshot CONTENT is
 * encrypted at rest (see crypto/local-vault.ts) so the plaintext never sits in
 * IndexedDB. Labels/timestamps stay in clear (non-sensitive).
 */
import type { ProseMirrorNode } from "./types";
import { encryptAtRest, decryptAtRest, hasVaultSecret, type VaultSecret } from "../crypto/local-vault";

const DB_NAME = "elium";
const STORE = "versions";
const DB_VERSION = 1;
const MAX_VERSIONS = 50;

export interface DocumentVersion {
  id?: number;
  docKey: string;
  label: string;
  ts: string; // ISO timestamp
  doc?: ProseMirrorNode; // plaintext snapshot (unprotected documents)
  enc?: string; // base64 salt+iv+ciphertext (protected documents)
}

/** Resolve a stored version to its ProseMirror doc, decrypting if needed. */
export async function versionDoc(v: DocumentVersion, secret?: VaultSecret): Promise<ProseMirrorNode> {
  if (v.enc != null) {
    if (!hasVaultSecret(secret)) throw new Error("Cette version est chiffrée — mot de passe requis.");
    return decryptAtRest<ProseMirrorNode>(v.enc, secret!);
  }
  if (!v.doc) throw new Error("Version vide.");
  return v.doc;
}

// --- IndexedDB plumbing ---------------------------------------------------

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        os.createIndex("docKey", "docKey", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
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

/** Versions for a document, newest first. */
export async function listVersions(docKey: string): Promise<DocumentVersion[]> {
  const all = await run<DocumentVersion[]>("readonly", (s) => s.index("docKey").getAll(docKey));
  return all.sort((a, b) => (a.ts < b.ts ? 1 : -1));
}

export async function deleteVersion(id: number): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}

/**
 * Append a snapshot (encrypted at rest when `secret` is provided), then prune
 * the oldest beyond MAX_VERSIONS.
 */
export async function saveVersion(docKey: string, label: string, doc: ProseMirrorNode, ts: string, secret?: VaultSecret): Promise<void> {
  const rec: DocumentVersion = hasVaultSecret(secret)
    ? { docKey, label, ts, enc: await encryptAtRest(doc, secret!) }
    : { docKey, label, ts, doc };
  await run("readwrite", (s) => s.add(rec));
  const all = await listVersions(docKey);
  for (const v of all.slice(MAX_VERSIONS)) {
    if (v.id != null) await deleteVersion(v.id);
  }
}
