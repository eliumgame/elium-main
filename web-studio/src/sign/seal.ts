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
 * A seal is NEVER a qualified electronic signature. See la Documentation (§7).
 */

import { canonicalJSON, sha256Hex, nowIso } from "../format/canonical";
import type { DocumentSeal, EliumManifest, EliumSignature, Journal } from "../format/types";
import { fingerprintOf, publicKeyHexFromPrivate, signMessage, verifyMessage } from "./keys";

export type SealVerdict = "unsealed" | "valid" | "unknown_key" | "broken";
export type { DocumentSeal };

/**
 * The integrity-critical manifest fields the seal protects (matches seal.py).
 *
 * `docId` is authenticated too (so an attacker cannot silently swap it to
 * confuse the local seal-TOFU / version indices), but only when present AND
 * requested — legacy seals were computed without it, so verifySeal falls back
 * to the docId-free subset to keep those files valid (see verifySeal).
 */
function manifestSubset(m: EliumManifest, includeDocId: boolean): Record<string, unknown> {
  return {
    format: m.format,
    formatVersion: m.formatVersion,
    profile: m.profile,
    title: m.title,
    language: m.language,
    createdAt: m.createdAt,
    // Included only when set, so existing seals (no expiry/docId) stay byte-identical.
    ...(m.accessExpiresAt ? { accessExpiresAt: m.accessExpiresAt } : {}),
    ...(includeDocId && m.docId ? { docId: m.docId } : {}),
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
  includeDocId = true,
): Promise<string> {
  return canonicalJSON({
    v: 1,
    manifest: manifestSubset(manifest, includeDocId),
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

  // Double-mode: current seals cover docId; legacy seals did not. Accept a seal
  // that matches EITHER canonical form. This is safe — the signature is over
  // exactly one of the two messages, so a v2 (docId-covered) file whose docId is
  // tampered matches NEITHER form and reads "broken"; the fallback only rescues
  // genuinely legacy seals, never a modified current one.
  const withDocId = await sealMessage(manifest, signatures, journal, true);
  let authentic = await verifyMessage(seal.signatureHex, withDocId, seal.publicKeyHex);
  if (!authentic && manifest.docId) {
    const withoutDocId = await sealMessage(manifest, signatures, journal, false);
    authentic = await verifyMessage(seal.signatureHex, withoutDocId, seal.publicKeyHex);
  }
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
