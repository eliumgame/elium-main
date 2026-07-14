/**
 * Document seal — one Ed25519 anchor that authenticates the integrity-critical
 * parts of a `.elium` file as a whole (byte-for-byte mirror of seal.py).
 *
 * `manifest.json`, `signatures/signatures.json` and `tracking/journal.json` are
 * clear-text ZIP entries, and the manifest's content hash is NOT keyed — so an
 * attacker can edit any of them and recompute the hash (silent tampering).
 *
 * The seal signs a canonical digest of
 *   { manifest integrity subset, sha256(signatures), sha256(journal) }.
 * Any later change to those parts makes the seal fail to verify, unless the
 * attacker re-signs with a different key (which changes the visible fingerprint).
 * This is the strongest tamper-evidence achievable without a PKI.
 *
 * A seal is NEVER a qualified electronic signature. See DOCUMENTATION.md (§7).
 */

import { canonicalJSON, sha256Hex, nowIso } from "../format/canonical";
import type { DocumentSeal, EliumManifest, EliumSignature, Journal } from "../format/types";
import { fingerprintOf, publicKeyHexFromPrivate, signMessage, verifyMessage } from "./keys";

export type SealVerdict = "unsealed" | "valid" | "unknown_key" | "broken";
export type { DocumentSeal };

/** The integrity-critical manifest fields the seal protects (matches seal.py). */
function manifestSubset(m: EliumManifest): Record<string, unknown> {
  return {
    format: m.format,
    formatVersion: m.formatVersion,
    profile: m.profile,
    title: m.title,
    language: m.language,
    createdAt: m.createdAt,
    // Included only when set, so existing seals (no expiry) stay byte-identical.
    ...(m.accessExpiresAt ? { accessExpiresAt: m.accessExpiresAt } : {}),
    protection: {
      encrypted: m.protection.encrypted,
      locked: m.protection.locked,
      keyfileRequired: m.protection.keyfileRequired,
      contentEntry: m.protection.contentEntry,
    },
    integrity: {
      algorithm: m.integrity.algorithm,
      contentHash: m.integrity.contentHash,
    },
  };
}

/** The exact canonical string that gets signed (identical in TS and Python). */
export async function sealMessage(
  manifest: EliumManifest,
  signatures: EliumSignature[],
  journal: Journal,
): Promise<string> {
  return canonicalJSON({
    v: 1,
    manifest: manifestSubset(manifest),
    signaturesHash: await sha256Hex(canonicalJSON(signatures)),
    journalHash: await sha256Hex(canonicalJSON(journal)),
  });
}

export async function createSeal(
  manifest: EliumManifest,
  signatures: EliumSignature[],
  journal: Journal,
  privateKeyHex: string,
): Promise<DocumentSeal> {
  const message = await sealMessage(manifest, signatures, journal);
  const publicKeyHex = await publicKeyHexFromPrivate(privateKeyHex);
  return {
    alg: "ed25519",
    publicKeyHex,
    fingerprint: await fingerprintOf(publicKeyHex),
    sealedAt: nowIso(),
    signatureHex: await signMessage(message, privateKeyHex),
  };
}

export async function verifySeal(
  manifest: EliumManifest,
  signatures: EliumSignature[],
  journal: Journal,
  trustedKeyHex?: string,
): Promise<SealVerdict> {
  const seal = manifest.seal;
  if (!seal) return "unsealed";

  const message = await sealMessage(manifest, signatures, journal);
  const authentic = await verifyMessage(seal.signatureHex, message, seal.publicKeyHex);
  if (!authentic) return "broken";

  if (trustedKeyHex && trustedKeyHex.trim().toLowerCase() !== seal.publicKeyHex.toLowerCase()) {
    return "unknown_key";
  }
  return "valid";
}

const SEAL_LABELS: Record<SealVerdict, string> = {
  unsealed: "Non scellé",
  valid: "Sceau valide",
  unknown_key: "Sceau valide (clé non vérifiée)",
  broken: "Sceau rompu — fichier altéré",
};

export function sealLabel(v: SealVerdict): string {
  return SEAL_LABELS[v];
}
