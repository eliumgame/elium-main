/**
 * Cryptographic proof for a signature (optional "advanced" layer).
 *
 * Two independent facts are checked at verification time:
 *   1. Authenticity — does the Ed25519 signature verify against the embedded
 *      public key? (and, if a trusted key is supplied, does it match?)
 *   2. Integrity   — is the document still identical to what was signed?
 *
 * A signature is NEVER a qualified electronic signature. See la Documentation (§7).
 */

import { canonicalJSON, sha256Hex, nowIso } from "../format/canonical";
import type {
  EliumDocumentModel,
  EliumSignature,
  SignaturePlacement,
  SignatureProof,
  SignatureVerdict,
  SignatureVisual,
  SignerInfo,
} from "../format/types";
import { fingerprintOf, publicKeyHexFromPrivate, signMessage, verifyMessage } from "./keys";

/** Hash of the canonical document model (page settings + body). */
export async function computeContentHash(model: EliumDocumentModel): Promise<string> {
  return sha256Hex(canonicalJSON(model));
}

/**
 * The exact bytes that get signed — a stable, self-describing structure.
 * `signedPlacement`/`signedVisual` are included only when provided, so legacy
 * proofs (created before placement/visual were bound) reconstruct byte-identical.
 */
function toBeSigned(
  signatureId: string,
  signedContentHash: string,
  signer: SignerInfo,
  signedAt: string,
  placement?: SignaturePlacement,
  visual?: SignatureVisual,
): string {
  return canonicalJSON({
    v: 1,
    signatureId,
    signedContentHash,
    signer,
    signedAt,
    ...(placement ? { signedPlacement: placement } : {}),
    ...(visual ? { signedVisual: visual } : {}),
  });
}

export async function createProof(opts: {
  signatureId: string;
  model: EliumDocumentModel;
  signer: SignerInfo;
  privateKeyHex: string;
  /** Bind the signature's placement & appearance into the proof (recommended). */
  placement?: SignaturePlacement;
  visual?: SignatureVisual;
}): Promise<SignatureProof> {
  const publicKeyHex = await publicKeyHexFromPrivate(opts.privateKeyHex);
  const signedContentHash = await computeContentHash(opts.model);
  const signedAt = nowIso();
  const message = toBeSigned(opts.signatureId, signedContentHash, opts.signer, signedAt, opts.placement, opts.visual);
  const signatureHex = await signMessage(message, opts.privateKeyHex);

  return {
    alg: "ed25519",
    publicKeyHex,
    fingerprint: await fingerprintOf(publicKeyHex),
    contentHashAlg: "sha-256",
    signedContentHash,
    signatureHex,
    signedAt,
    ...(opts.placement ? { signedPlacement: opts.placement } : {}),
    ...(opts.visual ? { signedVisual: opts.visual } : {}),
    timestamp: {
      type: "local",
      at: signedAt,
      note: "Horodatage local non qualifié (pas d'autorité de temps).",
    },
  };
}

/**
 * @param signature the full signature (its `id` is part of the signed message)
 * @param model     the current document (to detect post-signature changes)
 * @param trustedKeyHex optional expected signer key for attribution
 */
export async function verifyProof(
  signature: EliumSignature,
  model: EliumDocumentModel,
  trustedKeyHex?: string,
): Promise<SignatureVerdict> {
  const proof = signature.proof;
  if (!proof) return "visual_only";

  // Reconstruct against the SNAPSHOTS embedded in the proof (present ⇒ v2, the
  // proof binds placement/visual; absent ⇒ legacy, it doesn't). Their presence
  // changes the signed bytes, so an attacker can neither strip nor forge them
  // without the signature failing.
  const message = toBeSigned(
    signature.id,
    proof.signedContentHash,
    signature.signer,
    proof.signedAt,
    proof.signedPlacement,
    proof.signedVisual,
  );
  const authentic = await verifyMessage(proof.signatureHex, message, proof.publicKeyHex);
  if (!authentic) return "invalid";

  if (trustedKeyHex && trustedKeyHex.trim().toLowerCase() !== proof.publicKeyHex.toLowerCase()) {
    return "unknown_key";
  }

  if ((await computeContentHash(model)) !== proof.signedContentHash) return "modified";
  // A v2 proof also detects the signature being moved or its appearance altered.
  if (proof.signedPlacement && canonicalJSON(signature.placement) !== canonicalJSON(proof.signedPlacement))
    return "modified";
  if (proof.signedVisual && canonicalJSON(signature.visual) !== canonicalJSON(proof.signedVisual)) return "modified";
  return "valid";
}

const VERDICT_LABELS: Record<SignatureVerdict, string> = {
  valid: "Signature valide",
  modified: "Document modifié après signature",
  invalid: "Signature invalide",
  unknown_key: "Clé inconnue (non vérifiée)",
  visual_only: "Signature visuelle uniquement",
};

export function verdictLabel(v: SignatureVerdict): string {
  return VERDICT_LABELS[v];
}
