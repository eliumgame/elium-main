/**
 * Carnet de clés de confiance — un répertoire nommé de clés publiques de
 * signataires (Ed25519, 64 hex). Il généralise l'ancienne « clé de confiance »
 * unique (`elium_trusted_key`) : au lieu d'attendre UNE seule clé, on connaît N
 * signataires par leur nom.
 *
 * À quoi ça sert : un sceau ou une preuve dit « ce fichier est intègre et signé
 * par CETTE clé », mais pas QUI est derrière la clé. Le carnet fait le pont :
 * si la clé du sceau/de la preuve figure au carnet, on peut afficher
 * « scellé par Alice » / « signé par Alice » au lieu d'un simple « clé non
 * vérifiée ». C'est une décision de confiance locale (elle ne voyage PAS dans le
 * `.elium`), stockée dans ce navigateur uniquement — comme le TOFU du sceau
 * (voir seal-pinning.ts), qu'elle complète : le carnet est nominatif et
 * transversal aux documents, le pin TOFU est anonyme et par document.
 *
 * Le cœur (findContact/upsertContact/withoutContact/isTrustKeyHex) est pur pour
 * être testable ; seuls les wrappers touchent localStorage.
 */

import { fingerprintOf } from "./keys";

const STORAGE_KEY = "elium_trust_book";
const LEGACY_KEY = "elium_trusted_key";

/** Ed25519 public key = 32 octets = 64 caractères hexadécimaux. */
const KEY_RE = /^[0-9a-f]{64}$/;

export interface TrustedContact {
  name: string;
  /** Clé publique Ed25519 (64 hex), toujours normalisée en minuscules. */
  publicKeyHex: string;
  /** sha256 des octets de la clé publique (affichage / safety-words). */
  fingerprint: string;
  addedAt: string;
}

/** Normalise une clé hex (trim + minuscules) pour des comparaisons stables. */
export function normalizeKeyHex(hex: string): string {
  return hex.trim().toLowerCase();
}

/** True si `hex` a la forme d'une clé publique Ed25519 (64 hex). */
export function isTrustKeyHex(hex: string): boolean {
  return KEY_RE.test(normalizeKeyHex(hex));
}

/** Cherche un contact par sa clé publique (insensible à la casse). Pur. */
export function findContact(list: TrustedContact[], publicKeyHex: string): TrustedContact | undefined {
  const k = normalizeKeyHex(publicKeyHex);
  return list.find((c) => c.publicKeyHex === k);
}

/**
 * Insère ou met à jour un contact (dédup par clé publique). Pur : renvoie une
 * NOUVELLE liste, triée par nom pour un affichage stable.
 */
export function upsertContact(list: TrustedContact[], contact: TrustedContact): TrustedContact[] {
  const k = normalizeKeyHex(contact.publicKeyHex);
  const next = list.filter((c) => c.publicKeyHex !== k);
  next.push({ ...contact, publicKeyHex: k });
  next.sort((a, b) => a.name.localeCompare(b.name) || a.publicKeyHex.localeCompare(b.publicKeyHex));
  return next;
}

/** Retire un contact par sa clé publique. Pur : renvoie une NOUVELLE liste. */
export function withoutContact(list: TrustedContact[], publicKeyHex: string): TrustedContact[] {
  const k = normalizeKeyHex(publicKeyHex);
  return list.filter((c) => c.publicKeyHex !== k);
}

// --- Persistance (localStorage) -------------------------------------------

function readRaw(): TrustedContact[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is TrustedContact =>
        !!c &&
        typeof c === "object" &&
        typeof (c as TrustedContact).publicKeyHex === "string" &&
        typeof (c as TrustedContact).name === "string",
    );
  } catch {
    return [];
  }
}

function writeRaw(list: TrustedContact[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

/** Charge le carnet (lecture seule, synchrone — utilisable au rendu). */
export function loadTrustBook(): TrustedContact[] {
  return readRaw();
}

/**
 * Ajoute/renomme un contact et persiste. Calcule l'empreinte à partir de la clé.
 * Rejette une clé mal formée. Renvoie le carnet mis à jour.
 */
export async function trustContact(name: string, publicKeyHex: string): Promise<TrustedContact[]> {
  const k = normalizeKeyHex(publicKeyHex);
  if (!isTrustKeyHex(k)) throw new Error("Clé de confiance invalide (64 caractères hexadécimaux Ed25519 attendus).");
  const cleanName = name.trim() || "Sans nom";
  const existing = findContact(readRaw(), k);
  const contact: TrustedContact = {
    name: cleanName,
    publicKeyHex: k,
    fingerprint: await fingerprintOf(k),
    addedAt: existing?.addedAt ?? new Date().toISOString(),
  };
  const next = upsertContact(readRaw(), contact);
  writeRaw(next);
  return next;
}

/** Retire un contact et persiste. Renvoie le carnet mis à jour. */
export function untrustContact(publicKeyHex: string): TrustedContact[] {
  const next = withoutContact(readRaw(), publicKeyHex);
  writeRaw(next);
  return next;
}

/** Attribue une clé (de sceau ou de preuve) à un contact connu, ou undefined. */
export function attributeKey(publicKeyHex: string): TrustedContact | undefined {
  return findContact(readRaw(), publicKeyHex);
}

/**
 * Migration douce : l'ancienne « clé de confiance » unique (`elium_trusted_key`)
 * devient un contact nommé du carnet la première fois, puis la clé legacy est
 * effacée. Idempotente et sûre si la clé est absente/mal formée. À appeler une
 * fois au démarrage de l'app.
 */
export async function migrateLegacyTrustedKey(): Promise<void> {
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY_KEY);
  } catch {
    return;
  }
  if (!legacy) return;
  const k = normalizeKeyHex(legacy);
  if (isTrustKeyHex(k) && !findContact(readRaw(), k)) {
    await trustContact("Ma clé de confiance", k);
  }
  // Consommée (valide ou non) : on ne relit plus le legacy.
  localStorage.removeItem(LEGACY_KEY);
}
