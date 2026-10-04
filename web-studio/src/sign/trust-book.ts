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
import { verifySuccession, type SuccessionCert } from "./succession";

const STORAGE_KEY = "elium_trust_book";
const REVOCATIONS_KEY = "elium_trust_revocations";
const LEGACY_KEY = "elium_trusted_key";

/** Ed25519 public key = 32 octets = 64 caractères hexadécimaux. */
const KEY_RE = /^[0-9a-f]{64}$/;
/** P-256 public point non compressé = 65 octets = 130 hexadécimaux (clé de réception). */
const RECIPIENT_KEY_RE = /^04[0-9a-f]{128}$/;

/**
 * Niveau de confiance d'un contact — du plus faible au plus fort :
 *  - `unverified` : clé collée/ajoutée sans vérification hors-bande ;
 *  - `tofu`       : vue pour la première fois et mémorisée (trust-on-first-use) ;
 *  - `verified`   : empreinte comparée par mots de sécurité / QR avec la personne ;
 *  - `org-attested` : attestée par l'organisation (annuaire Drive d'entreprise).
 */
export type TrustLevel = "unverified" | "tofu" | "verified" | "org-attested";
export const TRUST_LEVEL_ORDER: readonly TrustLevel[] = ["unverified", "tofu", "verified", "org-attested"];
export const TRUST_LEVEL_LABELS: Record<TrustLevel, string> = {
  unverified: "Non vérifié",
  tofu: "Première vue (TOFU)",
  verified: "Vérifié par mots de sécurité",
  "org-attested": "Attesté par l'organisation",
};

/** Rôle de la clé : vérifier des signatures, ou chiffrer des documents POUR ce contact. */
export type ContactKind = "signer" | "recipient";

export interface TrustedContact {
  name: string;
  /** Clé publique, normalisée en minuscules : Ed25519 (64 hex) si `kind` = signer, P-256 (130 hex) si recipient. */
  publicKeyHex: string;
  /** sha256 des octets de la clé publique (affichage / safety-words). */
  fingerprint: string;
  addedAt: string;
  /** Absent sur les anciennes entrées → « non vérifié ». */
  level?: TrustLevel;
  /** Absent sur les anciennes entrées → « signer ». */
  kind?: ContactKind;
  notes?: string;
  /** Date au-delà de laquelle la clé de ce contact n'est plus acceptée. */
  expiresAt?: string;
  verifiedAt?: string;
}

export const levelOf = (c: Pick<TrustedContact, "level">): TrustLevel => c.level ?? "unverified";
export const kindOf = (c: Pick<TrustedContact, "kind">): ContactKind => c.kind ?? "signer";

/** Raison d'une révocation : seule `compromised` est une alerte de sécurité. */
export type RevocationReason = "compromised" | "superseded" | "other";

export interface Revocation {
  publicKeyHex: string;
  revokedAt: string;
  reason: RevocationReason;
  note?: string;
  /** Clé qui la remplace (rotation), si connue. */
  successorKeyHex?: string;
}

/** True si `hex` a la forme d'une clé de réception P-256. */
export function isRecipientKeyHex(hex: string): boolean {
  return RECIPIENT_KEY_RE.test(normalizeKeyHex(hex));
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
export interface TrustOptions {
  level?: TrustLevel;
  kind?: ContactKind;
  notes?: string;
  expiresAt?: string | null;
  verifiedAt?: string;
}

export async function trustContact(
  name: string,
  publicKeyHex: string,
  opts: TrustOptions = {},
): Promise<TrustedContact[]> {
  const k = normalizeKeyHex(publicKeyHex);
  const kind: ContactKind = opts.kind ?? (isRecipientKeyHex(k) ? "recipient" : "signer");
  if (kind === "signer" && !isTrustKeyHex(k)) {
    throw new Error("Clé de confiance invalide (64 caractères hexadécimaux Ed25519 attendus).");
  }
  if (kind === "recipient" && !isRecipientKeyHex(k)) {
    throw new Error("Clé de réception invalide (130 caractères hexadécimaux P-256 attendus).");
  }
  const cleanName = name.trim() || "Sans nom";
  const existing = findContact(readRaw(), k);
  const level = opts.level ?? existing?.level;
  const expiresAt = opts.expiresAt === null ? undefined : (opts.expiresAt ?? existing?.expiresAt);
  const notes = opts.notes !== undefined ? opts.notes.trim() || undefined : existing?.notes;
  const contact: TrustedContact = {
    name: cleanName,
    publicKeyHex: k,
    fingerprint: await fingerprintOf(k),
    addedAt: existing?.addedAt ?? new Date().toISOString(),
    ...(level ? { level } : {}),
    kind,
    ...(notes ? { notes } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    ...(opts.verifiedAt ?? existing?.verifiedAt ? { verifiedAt: opts.verifiedAt ?? existing?.verifiedAt } : {}),
  };
  const next = upsertContact(readRaw(), contact);
  writeRaw(next);
  return next;
}

/** Marque un contact « vérifié par mots de sécurité » (après comparaison hors-bande). */
export function markContactVerified(publicKeyHex: string, now: Date = new Date()): TrustedContact[] {
  const list = readRaw();
  const c = findContact(list, publicKeyHex);
  if (!c) return list;
  const next = upsertContact(list, { ...c, level: "verified", verifiedAt: now.toISOString() });
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

// --- Révocations & état d'une clé ------------------------------------------

/** Cherche une révocation pour une clé. Pur. */
export function findRevocation(list: Revocation[], publicKeyHex: string): Revocation | undefined {
  const k = normalizeKeyHex(publicKeyHex);
  return list.find((r) => r.publicKeyHex === k);
}

/** Ajoute (ou remplace) une révocation. Pur : renvoie une NOUVELLE liste. */
export function withRevocation(list: Revocation[], rev: Revocation): Revocation[] {
  const k = normalizeKeyHex(rev.publicKeyHex);
  return [...list.filter((r) => r.publicKeyHex !== k), { ...rev, publicKeyHex: k }];
}

export function withoutRevocation(list: Revocation[], publicKeyHex: string): Revocation[] {
  const k = normalizeKeyHex(publicKeyHex);
  return list.filter((r) => r.publicKeyHex !== k);
}

export interface KeyTrustState {
  revoked?: Revocation;
  /** True si le contact correspondant a une date d'expiration dépassée. */
  expired: boolean;
  expiresAt?: string;
  contact?: TrustedContact;
}

/**
 * État de confiance d'une clé vis-à-vis du carnet : révoquée ? expirée ? Pur et
 * indépendant du DOM, pour que les vérificateurs puissent l'afficher à côté de
 * l'état TOFU (seal-pinning.ts).
 */
export function keyTrustState(
  publicKeyHex: string,
  contacts: TrustedContact[],
  revocations: Revocation[],
  now: number = Date.now(),
): KeyTrustState {
  const contact = findContact(contacts, publicKeyHex);
  const revoked = findRevocation(revocations, publicKeyHex);
  const expiresAt = contact?.expiresAt;
  return {
    ...(revoked ? { revoked } : {}),
    expired: !!expiresAt && Date.parse(expiresAt) <= now,
    ...(expiresAt ? { expiresAt } : {}),
    ...(contact ? { contact } : {}),
  };
}

const fmtDate = (iso: string) => iso.slice(0, 10);

/** Message d'affichage (FR) + gravité pour un état de clé, ou null si rien à signaler. */
export function describeKeyState(s: KeyTrustState | undefined): { severity: "danger" | "warning"; text: string } | null {
  if (!s) return null;
  if (s.revoked) {
    const d = fmtDate(s.revoked.revokedAt);
    if (s.revoked.reason === "compromised") {
      return { severity: "danger", text: `clé RÉVOQUÉE le ${d} (compromise déclarée) — ne lui faites plus confiance` };
    }
    if (s.revoked.reason === "superseded") {
      return {
        severity: "warning",
        text: `clé remplacée le ${d}${s.revoked.successorKeyHex ? " par une nouvelle clé (succession vérifiée)" : ""}`,
      };
    }
    return { severity: "warning", text: `clé révoquée le ${d}${s.revoked.note ? ` (${s.revoked.note})` : ""}` };
  }
  if (s.expired && s.expiresAt) return { severity: "warning", text: `clé expirée le ${fmtDate(s.expiresAt)}` };
  return null;
}

/**
 * Applique un certificat de SUCCESSION VÉRIFIÉ : si l'ancienne clé est un contact,
 * la nouvelle hérite du nom/des notes mais redescend à `tofu` (la confiance se
 * transmet par la signature de l'ancienne clé, pas par une vérification humaine
 * de la nouvelle) ; l'ancienne est révoquée avec la raison « remplacée ».
 * Retourne null si le certificat est invalide ou si l'ancienne clé est inconnue.
 */
export async function applySuccession(
  contacts: TrustedContact[],
  revocations: Revocation[],
  cert: SuccessionCert,
  now: Date = new Date(),
): Promise<{ contacts: TrustedContact[]; revocations: Revocation[] } | null> {
  if (!(await verifySuccession(cert))) return null;
  const old = findContact(contacts, cert.oldPublicKeyHex);
  if (!old) return null;
  const heir: TrustedContact = {
    ...old,
    publicKeyHex: cert.newPublicKeyHex,
    fingerprint: await fingerprintOf(cert.newPublicKeyHex),
    addedAt: now.toISOString(),
    level: "tofu",
    notes: [old.notes, `Succède à ${old.fingerprint.slice(0, 12)}… (certificat du ${cert.issuedAt.slice(0, 10)})`]
      .filter(Boolean)
      .join(" — "),
  };
  delete heir.verifiedAt;
  return {
    contacts: upsertContact(contacts, heir),
    revocations: withRevocation(revocations, {
      publicKeyHex: cert.oldPublicKeyHex,
      revokedAt: now.toISOString(),
      reason: "superseded",
      successorKeyHex: cert.newPublicKeyHex,
    }),
  };
}

function readRevocations(): Revocation[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(REVOCATIONS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is Revocation =>
        !!r &&
        typeof r === "object" &&
        typeof (r as Revocation).publicKeyHex === "string" &&
        typeof (r as Revocation).revokedAt === "string",
    );
  } catch {
    return [];
  }
}

export function loadRevocations(): Revocation[] {
  return readRevocations();
}

/** Révoque une clé (liste de révocation locale du carnet). */
export function revokeTrustedKey(
  publicKeyHex: string,
  reason: RevocationReason = "compromised",
  note?: string,
  now: Date = new Date(),
): Revocation[] {
  const next = withRevocation(readRevocations(), {
    publicKeyHex: normalizeKeyHex(publicKeyHex),
    revokedAt: now.toISOString(),
    reason,
    ...(note?.trim() ? { note: note.trim() } : {}),
  });
  localStorage.setItem(REVOCATIONS_KEY, JSON.stringify(next));
  return next;
}

export function unrevokeTrustedKey(publicKeyHex: string): Revocation[] {
  const next = withoutRevocation(readRevocations(), publicKeyHex);
  localStorage.setItem(REVOCATIONS_KEY, JSON.stringify(next));
  return next;
}

/** Applique une succession au carnet persistant. Renvoie false si invalide / inconnue. */
export async function applySuccessionToBook(cert: SuccessionCert): Promise<boolean> {
  const res = await applySuccession(readRaw(), readRevocations(), cert);
  if (!res) return false;
  writeRaw(res.contacts);
  localStorage.setItem(REVOCATIONS_KEY, JSON.stringify(res.revocations));
  return true;
}

/** État de confiance d'une clé d'après le carnet persistant. */
export function currentKeyTrustState(publicKeyHex: string, now: number = Date.now()): KeyTrustState {
  return keyTrustState(publicKeyHex, readRaw(), readRevocations(), now);
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
