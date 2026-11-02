/**
 * Persistance locale du passeport (IndexedDB `elium-passeport`, un seul
 * enregistrement). Quand le coffre local est actif, tout le contenu — identité,
 * situations, stages — est chiffré au repos (mêmes primitives que le Parapheur).
 */
import { decryptAtRest, encryptAtRest, hasVaultSecret, toB64, type VaultSecret } from "../crypto/local-vault";
import { PASSPORT_SPEC } from "../format/db-specs";
import { openMigrated } from "../format/idb-migrate";
import { committedRequest } from "./idb-request";
import { isVaultConfigured } from "../format/vault-store";
import { clearAnnexes, listStoredAnnexes, reencryptAnnexes, type StoredAnnexe } from "./annexes";
import { normalizePassport } from "./model";
import type { PassportData } from "./types";
import { markDirty } from "../workspace/sync-dirty";

const STORE = "passport";
const KEY = "main" as const;

export interface StoredPassport {
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

/**
 * Passeport chiffré qui ne peut pas être lu avec le secret disponible : coffre réinitialisé ou désactivé alors que
 * l'enregistrement était chiffré (`no-vault`), ou coffre recréé avec un autre mot de passe (`wrong-secret`).
 * Les données NE SONT PAS effacées : le module propose de réessayer avec l'ancien mot de passe, d'exporter
 * l'enregistrement chiffré tel quel, ou de repartir à zéro après confirmation.
 */
export class PassportUnreadableError extends Error {
  constructor(readonly reason: "no-vault" | "wrong-secret") {
    super(
      reason === "no-vault"
        ? "Le passeport est chiffré avec un coffre local qui n'existe plus sur ce poste."
        : "Le passeport est chiffré avec un autre mot de passe que celui du coffre local actuel.",
    );
  }
}

/**
 * Règle de lecture d'un enregistrement (pure, testée sans IndexedDB). `vaultConfigured` distingue un coffre
 * simplement verrouillé (on attend le déverrouillage) d'un coffre disparu (données orphelines).
 */
export async function resolvePassportRecord(
  rec: StoredPassport | undefined,
  secret: VaultSecret | undefined,
  vaultConfigured: () => Promise<boolean>,
): Promise<PassportData | null> {
  if (!rec) return null;
  if (!rec.vaultProtected) return normalizePassport(rec.data);
  if (!hasVaultSecret(secret)) {
    if (await vaultConfigured()) throw new PassportLockedError();
    throw new PassportUnreadableError("no-vault");
  }
  let raw: unknown;
  try {
    raw = await decryptAtRest<unknown>(rec.enc!, secret);
  } catch {
    throw new PassportUnreadableError("wrong-secret");
  }
  return normalizePassport(raw);
}

/**
 * Rechiffrement d'un enregistrement (pur). `"keep"` = enregistrement chiffré illisible avec `from` (orphelin d'une
 * ancienne réinitialisation du coffre) : on le laisse INTACT plutôt que de bloquer l'activation / le changement
 * du coffre — il reste récupérable depuis le module avec l'ancien mot de passe.
 */
export async function reencryptStoredPassport(
  rec: StoredPassport,
  from: VaultSecret | undefined,
  to: VaultSecret | undefined,
): Promise<StoredPassport | "keep" | null> {
  let data: PassportData | null;
  if (rec.vaultProtected) {
    if (!hasVaultSecret(from)) return "keep";
    try {
      data = normalizePassport(await decryptAtRest<unknown>(rec.enc!, from));
    } catch {
      return "keep";
    }
  } else data = normalizePassport(rec.data);
  if (!data) return null;
  return toStored(data, to);
}

async function toStored(data: PassportData, secret?: VaultSecret): Promise<StoredPassport> {
  return hasVaultSecret(secret)
    ? { id: KEY, updatedAt: data.updatedAt, vaultProtected: true, enc: await encryptAtRest(data, secret) }
    : { id: KEY, updatedAt: data.updatedAt, vaultProtected: false, data };
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openMigrated(PASSPORT_SPEC).then((db) => committedRequest(db, STORE, mode, fn));
}

/**
 * `null` = aucun passeport enregistré. Lève `PassportLockedError` si le coffre est verrouillé,
 * `PassportUnreadableError` si l'enregistrement chiffré ne peut pas être lu avec le coffre actuel.
 */
export async function loadPassport(secret?: VaultSecret): Promise<PassportData | null> {
  const rec = await run<StoredPassport | undefined>("readonly", (s) => s.get(KEY));
  return resolvePassportRecord(rec, secret, isVaultConfigured);
}

async function write(data: PassportData, secret?: VaultSecret): Promise<void> {
  const rec = await toStored(data, secret);
  await run("readwrite", (s) => s.put(rec));
  markDirty("passeport");
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
  markDirty("passeport");
}

/** Rechiffrement quand le coffre est activé / changé / désactivé (un seul enregistrement → atomique). */
async function reencryptPassportRecord(from: VaultSecret | undefined, to: VaultSecret | undefined): Promise<void> {
  const rec = await run<StoredPassport | undefined>("readonly", (s) => s.get(KEY));
  if (!rec) return;
  const next = await reencryptStoredPassport(rec, from, to);
  if (!next || next === "keep") return;
  await run("readwrite", (s) => s.put(next));
  markDirty("passeport");
}

/** Passeport ET annexes : en cas d'échec sur les annexes, le passeport est ramené sous son ancien secret. */
export async function reencryptPassportVault(
  from: VaultSecret | undefined,
  to: VaultSecret | undefined,
): Promise<void> {
  await reencryptPassportRecord(from, to);
  try {
    await reencryptAnnexes(from, to);
  } catch (e) {
    await reencryptPassportRecord(to, from).catch(() => undefined);
    throw e;
  }
}

/**
 * Récupère un passeport illisible avec l'ANCIEN mot de passe du coffre : le déchiffre, puis le réenregistre sous le
 * secret courant (ou en clair s'il n'y a plus de coffre), annexes comprises. Lève une erreur explicite si le mot de
 * passe ne convient pas — rien n'est modifié dans ce cas.
 */
export async function recoverPassport(old: VaultSecret, current: VaultSecret | undefined): Promise<PassportData> {
  const rec = await run<StoredPassport | undefined>("readonly", (s) => s.get(KEY));
  if (!rec?.vaultProtected || !rec.enc) throw new Error("Aucun passeport chiffré à récupérer sur ce poste.");
  let data: PassportData | null;
  try {
    data = normalizePassport(await decryptAtRest<unknown>(rec.enc, old));
  } catch {
    throw new Error("Ce mot de passe ne déchiffre pas le passeport. Vérifiez-le et réessayez.");
  }
  if (!data) throw new Error("Le passeport déchiffré est vide ou endommagé.");
  await write(data, current);
  // Les annexes chiffrées sous l'ancien secret suivent ; celles déjà lisibles autrement ne bougent pas.
  await reencryptAnnexes(old, current);
  return data;
}

/** Sérialise l'enregistrement chiffré brut et ses annexes (pur) — rien n'est déchiffré. */
export function rawPassportExportJson(rec: StoredPassport | undefined, annexes: StoredAnnexe[]): string {
  const b = (u?: Uint8Array) => (u ? toB64(u) : undefined);
  return JSON.stringify(
    {
      format: "elium-passeport-chiffre",
      note:
        "Copie brute du passeport chiffré par le coffre local d'Elium (Argon2id + AES-256-GCM). " +
        "Lisible uniquement avec l'ancien mot de passe du coffre.",
      exportedAt: new Date().toISOString(),
      passport: rec ?? null,
      annexes: annexes.map((a) => ({
        id: a.id,
        vaultProtected: a.vaultProtected,
        bytes: b(a.bytes),
        sealed: a.sealed
          ? { v: a.sealed.v, salt: b(a.sealed.salt), iv: b(a.sealed.iv), ct: b(a.sealed.ct) }
          : undefined,
      })),
    },
    null,
    2,
  );
}

/** Copie brute (toujours chiffrée) de tout ce que le module conserve, à garder avant de repartir à zéro. */
export async function exportRawPassport(): Promise<string> {
  const rec = await run<StoredPassport | undefined>("readonly", (s) => s.get(KEY));
  return rawPassportExportJson(rec, await listStoredAnnexes());
}

/** Repartir à zéro (après confirmation explicite) : passeport ET annexes de ce poste. */
export async function discardPassport(): Promise<void> {
  await deletePassport();
  await clearAnnexes();
}
