/**
 * Persistance et sauvegarde de l'identité Ed25519 du Web Studio.
 *
 * La clé privée n'est JAMAIS écrite en clair : le localStorage et le fichier
 * de sauvegarde `.eliumkey` ne contiennent que le blob chiffré (Argon2id +
 * AES-256-GCM, même conteneur que les documents). Le fichier `.eliumkey`
 * permet de restaurer l'identité sur un autre navigateur/machine — sans lui,
 * vider le stockage du navigateur rend l'identité définitivement irrécupérable.
 */

import { strToU8, strFromU8 } from "fflate";
import { toHex, fromHex } from "../format/canonical";
import { EliumCryptoEngine } from "../crypto/elium-crypto";
import { publicKeyHexFromPrivate, fingerprintOf } from "./keys";

export const IDENTITY_STORAGE_KEY = "elium_identity";

const KEYFILE_FORMAT = "elium-key";
const KEYFILE_VERSION = 1;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX = /^[0-9a-f]+$/;

/** Ce qui est persisté (localStorage) et exporté (.eliumkey) — jamais de clé en clair. */
export interface StoredIdentity {
  publicKeyHex: string;
  fingerprint: string;
  /** Conteneur Elium chiffré (hex) contenant la clé privée. */
  enc: string;
}

export interface EliumKeyFile extends StoredIdentity {
  format: typeof KEYFILE_FORMAT;
  version: typeof KEYFILE_VERSION;
  kdf: "argon2id";
  cipher: "aes-256-gcm";
  exportedAt: string;
}

export class EliumKeyFileError extends Error {}

// --- Persistance locale -----------------------------------------------------

export function loadStoredIdentity(): StoredIdentity | null {
  const saved = localStorage.getItem(IDENTITY_STORAGE_KEY);
  if (!saved) return null;
  try {
    const s = JSON.parse(saved) as Partial<StoredIdentity>;
    if (s.publicKeyHex && s.fingerprint) {
      return { publicKeyHex: s.publicKeyHex, fingerprint: s.fingerprint, enc: s.enc ?? "" };
    }
  } catch { /* entrée corrompue : ignorée */ }
  return null;
}

export function saveStoredIdentity(stored: StoredIdentity): void {
  localStorage.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(stored));
}

// --- Chiffrement de la clé privée -------------------------------------------

export async function encryptPrivateKey(privateKeyHex: string, password: string): Promise<string> {
  return toHex(await EliumCryptoEngine.encodeContainer(strToU8(privateKeyHex), password));
}

export async function decryptPrivateKey(enc: string, password: string): Promise<string> {
  const { payload } = await EliumCryptoEngine.decodeContainer(fromHex(enc), password);
  const privateKeyHex = strFromU8(payload);
  if (!HEX64.test(privateKeyHex)) throw new EliumKeyFileError("Le conteneur ne contient pas une clé privée valide.");
  return privateKeyHex;
}

// --- Fichier de sauvegarde .eliumkey -----------------------------------------

export function buildKeyFile(stored: StoredIdentity): EliumKeyFile {
  return {
    format: KEYFILE_FORMAT,
    version: KEYFILE_VERSION,
    kdf: "argon2id",
    cipher: "aes-256-gcm",
    publicKeyHex: stored.publicKeyHex,
    fingerprint: stored.fingerprint,
    enc: stored.enc,
    exportedAt: new Date().toISOString(),
  };
}

export function keyFileName(fingerprint: string): string {
  return `identite-elium-${fingerprint.slice(0, 12)}.eliumkey`;
}

/** Valide et normalise un fichier .eliumkey (lève EliumKeyFileError sinon). */
export function parseKeyFile(text: string): StoredIdentity {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new EliumKeyFileError("Ce fichier n'est pas une sauvegarde .eliumkey valide (JSON illisible).");
  }
  const o = raw as Partial<EliumKeyFile>;
  if (o.format !== KEYFILE_FORMAT) {
    throw new EliumKeyFileError("Ce fichier n'est pas une sauvegarde de clé Elium (.eliumkey).");
  }
  if (o.version !== KEYFILE_VERSION) {
    throw new EliumKeyFileError(`Version de sauvegarde non prise en charge (${String(o.version)}).`);
  }
  const publicKeyHex = (o.publicKeyHex ?? "").toLowerCase();
  const fingerprint = (o.fingerprint ?? "").toLowerCase();
  const enc = (o.enc ?? "").toLowerCase();
  if (!HEX64.test(publicKeyHex) || !HEX64.test(fingerprint)) {
    throw new EliumKeyFileError("Sauvegarde corrompue : clé publique ou empreinte invalide.");
  }
  if (!enc || enc.length % 2 !== 0 || !HEX.test(enc)) {
    throw new EliumKeyFileError("Sauvegarde corrompue : conteneur chiffré invalide.");
  }
  return { publicKeyHex, fingerprint, enc };
}

/**
 * Restaure une identité depuis un .eliumkey : déchiffre avec le mot de passe,
 * vérifie la cohérence clé privée ↔ clé publique ↔ empreinte, et retourne
 * l'identité complète (clé privée en mémoire uniquement).
 */
export async function restoreFromKeyFile(
  stored: StoredIdentity,
  password: string,
): Promise<{ privateKeyHex: string; publicKeyHex: string; fingerprint: string }> {
  const privateKeyHex = await decryptPrivateKey(stored.enc, password);
  const publicKeyHex = await publicKeyHexFromPrivate(privateKeyHex);
  if (publicKeyHex !== stored.publicKeyHex) {
    throw new EliumKeyFileError("Sauvegarde incohérente : la clé privée ne correspond pas à la clé publique annoncée.");
  }
  const fingerprint = await fingerprintOf(publicKeyHex);
  if (fingerprint !== stored.fingerprint) {
    throw new EliumKeyFileError("Sauvegarde incohérente : empreinte invalide.");
  }
  return { privateKeyHex, publicKeyHex, fingerprint };
}

/** Importe une clé privée brute (64 hex) collée par l'utilisateur. */
export async function identityFromPrivateHex(
  privateKeyHex: string,
): Promise<{ privateKeyHex: string; publicKeyHex: string; fingerprint: string }> {
  const pk = privateKeyHex.trim().toLowerCase().replace(/^0x/, "");
  if (!HEX64.test(pk)) {
    throw new EliumKeyFileError("Clé privée invalide : 64 caractères hexadécimaux attendus (32 octets).");
  }
  const publicKeyHex = await publicKeyHexFromPrivate(pk);
  return { privateKeyHex: pk, publicKeyHex, fingerprint: await fingerprintOf(publicKeyHex) };
}

// --- Presse-papier ------------------------------------------------------------

/** Copie dans le presse-papier, avec repli hors contexte sécurisé. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* repli ci-dessous */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
