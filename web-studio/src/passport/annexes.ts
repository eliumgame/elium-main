/**
 * Annexes d'une fiche de situation : fichiers de tout type (captures, devis, courriels, tableaux…) que le
 * candidat joint à une situation. Les octets vivent dans IndexedDB (`elium-passeport`, table `annexes`),
 * chiffrés par le coffre local quand il est actif ; la fiche ne garde que la description (nom, type, taille).
 */
import {
  hasVaultSecret,
  openSealedBytes,
  sealBytesAtRest,
  type SealedBytes,
  type VaultSecret,
} from "../crypto/local-vault";
import { PASSPORT_SPEC } from "../format/db-specs";
import { openMigrated } from "../format/idb-migrate";
import { committedRequest } from "./idb-request";
import type { Annexe } from "./types";
import { markDirty } from "../workspace/sync-dirty";

const STORE = "annexes";
/** Taille maximale d'une annexe (le passeport reste dans le navigateur : on évite d'y verser des vidéos). */
export const MAX_ANNEXE_BYTES = 40 * 1024 * 1024;

export interface StoredAnnexe {
  id: string;
  vaultProtected: boolean;
  bytes?: Uint8Array; // clair — seulement hors coffre
  sealed?: SealedBytes; // chiffré — seulement avec le coffre
}

export class AnnexeLockedError extends Error {
  constructor() {
    super("Les annexes sont protégées par le coffre local — déverrouillez-le d'abord.");
  }
}

export function newAnnexeId(): string {
  const c = globalThis.crypto;
  return c && typeof c.randomUUID === "function"
    ? `an-${c.randomUUID()}`
    : `an-${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openMigrated(PASSPORT_SPEC).then((db) => committedRequest(db, STORE, mode, fn));
}

export async function putAnnexe(id: string, bytes: Uint8Array, secret?: VaultSecret): Promise<void> {
  const rec: StoredAnnexe = hasVaultSecret(secret)
    ? { id, vaultProtected: true, sealed: await sealBytesAtRest(bytes, secret) }
    : { id, vaultProtected: false, bytes };
  await tx("readwrite", (s) => s.put(rec));
  markDirty("passeport");
}

/** `undefined` si le fichier n'existe plus (annexe orpheline). */
export async function getAnnexe(id: string, secret?: VaultSecret): Promise<Uint8Array | undefined> {
  const rec = await tx<StoredAnnexe | undefined>("readonly", (s) => s.get(id));
  if (!rec) return undefined;
  if (!rec.vaultProtected) return rec.bytes;
  if (!hasVaultSecret(secret)) throw new AnnexeLockedError();
  return openSealedBytes(rec.sealed!, secret);
}

export async function deleteAnnexe(id: string): Promise<void> {
  await tx("readwrite", (s) => s.delete(id));
  markDirty("passeport");
}

/** Supprime les octets de toutes les annexes dont l'identifiant n'est PAS dans `keep` (import, réinitialisation). */
export async function pruneAnnexes(keep: Set<string>): Promise<void> {
  const keys = await tx<IDBValidKey[]>("readonly", (s) => s.getAllKeys());
  for (const k of keys) if (!keep.has(String(k))) await deleteAnnexe(String(k));
}

/**
 * Rechiffrement d'une annexe (pur). `null` = annexe chiffrée illisible avec `from` (orpheline d'une ancienne
 * réinitialisation du coffre) : laissée intacte, récupérable avec l'ancien mot de passe depuis le module.
 */
export async function reencryptStoredAnnexe(
  rec: StoredAnnexe,
  from: VaultSecret | undefined,
  to: VaultSecret | undefined,
): Promise<StoredAnnexe | null> {
  let bytes: Uint8Array;
  if (rec.vaultProtected) {
    if (!hasVaultSecret(from)) return null;
    try {
      bytes = await openSealedBytes(rec.sealed!, from);
    } catch {
      return null;
    }
  } else bytes = rec.bytes ?? new Uint8Array();
  return hasVaultSecret(to)
    ? { id: rec.id, vaultProtected: true, sealed: await sealBytesAtRest(bytes, to) }
    : { id: rec.id, vaultProtected: false, bytes };
}

/** Rechiffrement quand le coffre est activé / changé / désactivé (une transaction : tout ou rien). */
export async function reencryptAnnexes(from: VaultSecret | undefined, to: VaultSecret | undefined): Promise<void> {
  const all = await tx<StoredAnnexe[]>("readonly", (s) => s.getAll());
  const next: StoredAnnexe[] = [];
  for (const rec of all) {
    const out = await reencryptStoredAnnexe(rec, from, to);
    if (out) next.push(out);
  }
  if (next.length === 0) return;
  const db = await openMigrated(PASSPORT_SPEC);
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction(STORE, "readwrite");
    for (const rec of next) t.objectStore(STORE).put(rec);
    t.oncomplete = () => {
      db.close();
      resolve();
    };
    t.onerror = t.onabort = () => {
      db.close();
      reject(t.error ?? new Error("Transaction annulée"));
    };
  });
}

/** Enregistrements bruts (chiffrés ou non), pour l'export de secours d'un passeport illisible. */
export const listStoredAnnexes = (): Promise<StoredAnnexe[]> => tx<StoredAnnexe[]>("readonly", (s) => s.getAll());

/** Supprime toutes les annexes de ce poste (repartir à zéro). */
export async function clearAnnexes(): Promise<void> {
  await tx("readwrite", (s) => s.clear());
  markDirty("passeport");
}

/** Lit un `File` en octets en refusant les fichiers trop gros. */
export async function readAnnexeFile(file: File): Promise<{ meta: Annexe; bytes: Uint8Array }> {
  if (file.size > MAX_ANNEXE_BYTES)
    throw new Error(
      `« ${file.name} » dépasse ${Math.round(MAX_ANNEXE_BYTES / 1048576)} Mo : choisissez un fichier plus léger.`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  return {
    bytes,
    meta: {
      id: newAnnexeId(),
      name: file.name || "annexe",
      mime: file.type || mimeFromName(file.name),
      size: bytes.length,
      addedAt: new Date().toISOString(),
      note: "",
    },
  };
}

export function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  return (
    {
      pdf: "application/pdf",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      txt: "text/plain",
      csv: "text/csv",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }[ext] ?? "application/octet-stream"
  );
}
