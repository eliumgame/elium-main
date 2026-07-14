/**
 * App-wide local "vault" passphrase — OPT-IN, separate from any document's
 * own password/keyfile. Elium's protection model is per-document by design
 * (see format/profiles.ts: "Protection is OPTIONAL"); this vault exists only
 * to close the one gap that per-document secrets can't cover: locally-cached
 * metadata that must be readable to browse without opening every file one by
 * one — the Drive index (titles) and the Parapheur signer list (PII), see
 * format/drive-store.ts and format/parapheur-store.ts.
 *
 * The vault password is verified against an encrypted canary (never stored in
 * clear) using the same PBKDF2→AES-256-GCM primitive as everything else in
 * crypto/local-vault.ts. Like document passwords, this is zero-knowledge:
 * there is no recovery if it's forgotten (see resetVault, which wipes the
 * locally-cached Drive/Parapheur data rather than trying to guess it).
 * The derived key lives only in memory for the session (App.tsx) — never
 * persisted, never written alongside the verifier.
 */
import { encryptAtRest, decryptAtRest } from "../crypto/local-vault";

const DB_NAME = "elium-vault";
const STORE = "config";
const DB_VERSION = 1;
const CONFIG_KEY = "config";
const CANARY = "elium-vault-v1";

interface VaultConfig {
  id: string; // CONFIG_KEY
  verifier: string; // encryptAtRest(CANARY, { password })
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
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

export async function isVaultConfigured(): Promise<boolean> {
  const rec = await run<VaultConfig | undefined>("readonly", (s) => s.get(CONFIG_KEY));
  return !!rec;
}

/** Configure the vault (first setup) or overwrite it with a new password (see also reencrypt*Vault). */
export async function setVaultPassword(password: string): Promise<void> {
  const verifier = await encryptAtRest(CANARY, { password });
  await run("readwrite", (s) => s.put({ id: CONFIG_KEY, verifier } satisfies VaultConfig));
}

/** True if `password` unlocks the currently configured vault. False (never throws) for a wrong password. */
export async function verifyVaultPassword(password: string): Promise<boolean> {
  const rec = await run<VaultConfig | undefined>("readonly", (s) => s.get(CONFIG_KEY));
  if (!rec) return false;
  try {
    return (await decryptAtRest<string>(rec.verifier, { password })) === CANARY;
  } catch {
    return false;
  }
}

/** Remove the vault configuration itself. Callers are responsible for decrypting Drive/Parapheur data first. */
export async function removeVaultConfig(): Promise<void> {
  await run("readwrite", (s) => s.delete(CONFIG_KEY));
}
