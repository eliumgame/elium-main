/**
 * Local "Drive" — a library of saved .elium documents persisted in IndexedDB
 * (this browser only, local-first). Each saved document is stored by a stable
 * key (its creation timestamp), so re-saving updates the same entry rather than
 * duplicating it.
 *
 * When the local vault (crypto/local-vault.ts, see format/vault-store.ts) is
 * configured, title/profile/bytes are encrypted at rest — including for
 * "standard" (unprotected) documents, whose bytes would otherwise sit as plain
 * `.elium` content in IndexedDB regardless of the document's own protection.
 * Without a vault, behaviour is unchanged: bytes are stored verbatim, exactly
 * as written to disk.
 *
 * Separate database from the version history store to avoid IndexedDB version
 * coordination between the two independent features.
 */
import { encryptAtRest, decryptAtRest, encryptBytesAtRest, decryptBytesAtRest, hasVaultSecret, type VaultSecret } from "../crypto/local-vault";

const DB_NAME = "elium-drive";
const STORE = "docs";
const DB_VERSION = 1;

interface TitleProfile {
  title: string;
  profile: string;
}

export interface DriveDoc {
  id: string; // stable doc key (manifest.createdAt)
  savedAt: string; // ISO
  size: number;
  vaultProtected: boolean;
  title?: string; // plaintext — only when NOT vault-protected
  profile?: string; // plaintext — only when NOT vault-protected
  bytes?: Uint8Array; // plaintext — only when NOT vault-protected
  enc?: string; // encrypted { title, profile } — only when vault-protected
  encBytes?: string; // encrypted bytes — only when vault-protected
}

export type DriveEntry = Omit<DriveDoc, "bytes" | "encBytes">;

/** A document resolved for actual use (opening it) — always plaintext fields. */
export interface ResolvedDriveDoc {
  id: string;
  title: string;
  profile: string;
  savedAt: string;
  size: number;
  bytes: Uint8Array;
}

/** A library entry as returned by {@link listDriveDocs} — title/profile always resolved (real or a locked placeholder). */
export interface ResolvedDriveEntry {
  id: string;
  savedAt: string;
  size: number;
  vaultProtected: boolean;
  title: string;
  profile: string;
  locked?: boolean;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
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

/** Insert or update a document in the library (upsert by id). Encrypts at rest when `vaultSecret` is set. */
export async function putDriveDoc(
  input: { id: string; title: string; profile: string; savedAt: string; size: number; bytes: Uint8Array },
  vaultSecret?: VaultSecret,
): Promise<void> {
  const record: DriveDoc = hasVaultSecret(vaultSecret)
    ? {
        id: input.id,
        savedAt: input.savedAt,
        size: input.size,
        vaultProtected: true,
        enc: await encryptAtRest({ title: input.title, profile: input.profile } satisfies TitleProfile, vaultSecret!),
        encBytes: await encryptBytesAtRest(input.bytes, vaultSecret!),
      }
    : {
        id: input.id,
        savedAt: input.savedAt,
        size: input.size,
        vaultProtected: false,
        title: input.title,
        profile: input.profile,
        bytes: input.bytes,
      };
  await run("readwrite", (s) => s.put(record));
}

/**
 * All library entries (without bytes), newest first. Vault-protected entries
 * are decrypted when `vaultSecret` is provided; otherwise (or if decryption
 * fails) a locked placeholder is returned instead of leaving the real title
 * un-rendered — the caller decides how to show that (lock icon, disabled
 * click, etc.).
 */
export async function listDriveDocs(vaultSecret?: VaultSecret): Promise<ResolvedDriveEntry[]> {
  const all = await run<DriveDoc[]>("readonly", (s) => s.getAll());
  const out: ResolvedDriveEntry[] = [];
  for (const { bytes: _bytes, encBytes: _encBytes, ...meta } of all) {
    if (!meta.vaultProtected) {
      out.push({ ...meta, title: meta.title!, profile: meta.profile! });
      continue;
    }
    if (!hasVaultSecret(vaultSecret)) {
      out.push({ ...meta, title: "Document protégé", profile: "?", locked: true });
      continue;
    }
    try {
      const { title, profile } = await decryptAtRest<TitleProfile>(meta.enc!, vaultSecret!);
      out.push({ ...meta, title, profile });
    } catch {
      out.push({ ...meta, title: "Document protégé (mot de passe du coffre incorrect)", profile: "?", locked: true });
    }
  }
  return out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

/** Resolve one document for opening. Throws if it's vault-protected and no (working) `vaultSecret` is given. */
export async function getDriveDoc(id: string, vaultSecret?: VaultSecret): Promise<ResolvedDriveDoc | undefined> {
  const rec = await run<DriveDoc | undefined>("readonly", (s) => s.get(id));
  if (!rec) return undefined;
  if (!rec.vaultProtected) {
    return { id: rec.id, title: rec.title!, profile: rec.profile!, savedAt: rec.savedAt, size: rec.size, bytes: rec.bytes! };
  }
  if (!hasVaultSecret(vaultSecret)) throw new Error("Ce document est protégé par le coffre local — déverrouillez-le d'abord.");
  const { title, profile } = await decryptAtRest<TitleProfile>(rec.enc!, vaultSecret!);
  const bytes = await decryptBytesAtRest(rec.encBytes!, vaultSecret!);
  return { id: rec.id, title, profile, savedAt: rec.savedAt, size: rec.size, bytes };
}

export async function deleteDriveDoc(id: string): Promise<void> {
  await run("readwrite", (s) => s.delete(id));
}

/**
 * Re-encrypt every entry from `from` to `to` — used when the vault is enabled
 * for the first time (`from` undefined), its password changes (both set), or
 * it's disabled (`to` undefined, everything decrypted back to plaintext).
 * `from` must be the CURRENTLY correct vault secret for any already-protected
 * entry, or decryption throws.
 * All records are committed in a SINGLE IndexedDB transaction: if any single
 * `put` fails (e.g. quota), the whole batch rolls back rather than leaving
 * some records under `from` and others under `to`.
 */
export async function reencryptDriveVault(from: VaultSecret | undefined, to: VaultSecret | undefined): Promise<void> {
  const all = await run<DriveDoc[]>("readonly", (s) => s.getAll());
  const next: DriveDoc[] = [];
  for (const rec of all) {
    let title: string, profile: string, bytes: Uint8Array;
    if (rec.vaultProtected) {
      if (!hasVaultSecret(from)) throw new Error("Mot de passe du coffre requis pour re-chiffrer la bibliothèque.");
      ({ title, profile } = await decryptAtRest<TitleProfile>(rec.enc!, from!));
      bytes = await decryptBytesAtRest(rec.encBytes!, from!);
    } else {
      title = rec.title!;
      profile = rec.profile!;
      bytes = rec.bytes!;
    }
    next.push(
      hasVaultSecret(to)
        ? {
            id: rec.id,
            savedAt: rec.savedAt,
            size: rec.size,
            vaultProtected: true,
            enc: await encryptAtRest({ title, profile } satisfies TitleProfile, to!),
            encBytes: await encryptBytesAtRest(bytes, to!),
          }
        : { id: rec.id, savedAt: rec.savedAt, size: rec.size, vaultProtected: false, title, profile, bytes },
    );
  }
  if (next.length === 0) return;
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    t.oncomplete = () => { db.close(); resolve(); };
    t.onerror = () => { db.close(); reject(t.error ?? new Error("Transaction annulée")); };
    t.onabort = () => { db.close(); reject(t.error ?? new Error("Transaction annulée")); };
    const store = t.objectStore(STORE);
    for (const rec of next) store.put(rec);
  });
}
