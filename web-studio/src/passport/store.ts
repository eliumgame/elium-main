/**
 * Persistance locale du passeport (IndexedDB `elium-passeport`, un seul
 * enregistrement). Quand le coffre local est actif, tout le contenu — identité,
 * situations, stages — est chiffré au repos (mêmes primitives que le Parapheur).
 */
import { decryptAtRest, encryptAtRest, hasVaultSecret, type VaultSecret } from "../crypto/local-vault";
import { PASSPORT_SPEC } from "../format/db-specs";
import { openMigrated } from "../format/idb-migrate";
import { normalizePassport } from "./model";
import type { PassportData } from "./types";

const STORE = "passport";
const KEY = "main" as const;

interface StoredPassport {
  id: typeof KEY;
  updatedAt: string;
  vaultProtected: boolean;
  data?: PassportData; // clair — seulement hors coffre
  enc?: string; // PassportData chiffré — seulement avec le coffre
}

export class PassportLockedError extends Error {
  constructor() {
    super("Le passeport est protégé par le coffre local — déverrouillez-le d'abord.");
  }
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openMigrated(PASSPORT_SPEC).then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
        t.onabort = () => db.close();
      }),
  );
}

/** `null` = aucun passeport enregistré. Lève `PassportLockedError` si le coffre est requis. */
export async function loadPassport(secret?: VaultSecret): Promise<PassportData | null> {
  const rec = await run<StoredPassport | undefined>("readonly", (s) => s.get(KEY));
  if (!rec) return null;
  if (!rec.vaultProtected) return normalizePassport(rec.data);
  if (!hasVaultSecret(secret)) throw new PassportLockedError();
  return normalizePassport(await decryptAtRest<unknown>(rec.enc!, secret));
}

async function write(data: PassportData, secret?: VaultSecret): Promise<void> {
  const rec: StoredPassport = hasVaultSecret(secret)
    ? { id: KEY, updatedAt: data.updatedAt, vaultProtected: true, enc: await encryptAtRest(data, secret) }
    : { id: KEY, updatedAt: data.updatedAt, vaultProtected: false, data };
  await run("readwrite", (s) => s.put(rec));
}

/** Refuse d'écrire en clair par-dessus un passeport chiffré tant que le coffre n'est pas déverrouillé. */
export async function savePassport(data: PassportData, secret?: VaultSecret): Promise<void> {
  if (!hasVaultSecret(secret)) {
    const rec = await run<StoredPassport | undefined>("readonly", (s) => s.get(KEY));
    if (rec?.vaultProtected) throw new PassportLockedError();
  }
  await write(data, secret);
}

export async function deletePassport(): Promise<void> {
  await run("readwrite", (s) => s.delete(KEY));
}

/** Rechiffrement quand le coffre est activé / changé / désactivé (un seul enregistrement → atomique). */
export async function reencryptPassportVault(
  from: VaultSecret | undefined,
  to: VaultSecret | undefined,
): Promise<void> {
  const rec = await run<StoredPassport | undefined>("readonly", (s) => s.get(KEY));
  if (!rec) return;
  let data: PassportData | null;
  if (rec.vaultProtected) {
    if (!hasVaultSecret(from)) throw new Error("Mot de passe du coffre requis pour re-chiffrer le passeport.");
    data = normalizePassport(await decryptAtRest<unknown>(rec.enc!, from));
  } else data = normalizePassport(rec.data);
  if (!data) return;
  await write(data, to);
}
