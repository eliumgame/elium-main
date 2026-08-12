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
 * `docId` and the recipient set (`protection.recipients`) are authenticated too,
 * but only when present AND requested. They were added to the sealed subset at
 * different times, so verifySeal falls back to the older forms (dropping the
 * newest field first) to keep already-sealed files valid. A field absent from
 * the manifest is never added, so files that never carried it seal byte-identical
 * to before — only files that DO carry it gain the extra tamper-evidence.
 */
interface SubsetOpts {
  docId: boolean;
  recipients: boolean;
}

function manifestSubset(m: EliumManifest, opts: SubsetOpts): Record<string, unknown> {
  return {
    format: m.format,
    formatVersion: m.formatVersion,
    profile: m.profile,
    title: m.title,
    language: m.language,
    createdAt: m.createdAt,
    // Included only when set, so existing seals (no expiry/docId) stay byte-identical.
    ...(m.accessExpiresAt ? { accessExpiresAt: m.accessExpiresAt } : {}),
    ...(opts.docId && m.docId ? { docId: m.docId } : {}),
    protection: {
      encrypted: m.protection.encrypted,
      locked: m.protection.locked,
      keyfileRequired: m.protection.keyfileRequired,
      contentEntry: m.protection.contentEntry,
      // Binds the "who can read this" list of a sealed multi-recipient file, so a
      // displayed recipient fingerprint cannot be silently added or removed.
      // Present only on recipient files → non-recipient seals are unchanged.
      ...(opts.recipients && m.protection.recipients?.length ? { recipients: m.protection.recipients } : {}),
    },
    integrity: {
      algorithm: m.integrity.algorithm,
      contentHash: m.integrity.contentHash,
    },
  };
}

const FULL_SUBSET: SubsetOpts = { docId: true, recipients: true };

/** The exact canonical string that gets signed (identical in TS and Python). */
export async function sealMessage(
  manifest: EliumManifest,
  signatures: EliumSignature[],
  journal: Journal,
  opts: SubsetOpts = FULL_SUBSET,
): Promise<string> {
  return canonicalJSON({
    v: 1,
    manifest: manifestSubset(manifest, opts),
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

  // Multi-mode: the sealed subset gained optional fields over time (docId, then
  // the recipient set). Accept a seal that matches the current full form OR an
  // older form, dropping the newest optional field first. Safe — the signature
  // is over exactly ONE form, so a file whose docId/recipient set is tampered
  // matches NONE and reads "broken"; the fallbacks only rescue genuinely older
  // seals, never a modified current one. Fields absent from the manifest are not
  // toggled, so a non-recipient (or docId-less legacy) file keeps its old form.
  const recipientForms = manifest.protection.recipients?.length ? [true, false] : [false];
  const docIdForms = manifest.docId ? [true, false] : [false];
  let authentic = false;
  outer: for (const recipients of recipientForms) {
    for (const docId of docIdForms) {
      const message = await sealMessage(manifest, signatures, journal, { docId, recipients });
      if (await verifyMessage(seal.signatureHex, message, seal.publicKeyHex)) { authentic = true; break outer; }
    }
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
