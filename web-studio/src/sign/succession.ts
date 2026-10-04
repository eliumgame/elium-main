/**
 * Certificat de SUCCESSION : prouve qu'une nouvelle identité Ed25519 remplace
 * l'ancienne, sans autorité centrale.
 *
 * Le certificat est signé par l'ANCIENNE clé (« je désigne cette nouvelle clé »)
 * ET par la NOUVELLE (preuve de possession — personne ne peut vous « attribuer »
 * une clé que vous ne contrôlez pas). Quiconque fait déjà confiance à l'ancienne
 * clé peut transférer cette confiance après vérification (cf. trust-book.ts).
 *
 * Message signé = JSON canonique de { type, oldPublicKeyHex, newPublicKeyHex,
 * issuedAt } — miroir Python : elium/crypto/keybundle.py (verify_succession).
 */
import { canonicalJSON } from "../format/canonical";
import { signMessage, verifyMessage } from "./keys";

export const SUCCESSION_TYPE = "elium-succession/1";

export interface SuccessionCert {
  type: typeof SUCCESSION_TYPE;
  oldPublicKeyHex: string;
  newPublicKeyHex: string;
  issuedAt: string;
  /** Signature Ed25519 de l'ancienne clé (hex). */
  oldSig: string;
  /** Signature Ed25519 de la nouvelle clé (hex) : preuve de possession. */
  newSig: string;
}

function body(oldPub: string, newPub: string, issuedAt: string): string {
  return canonicalJSON({
    type: SUCCESSION_TYPE,
    oldPublicKeyHex: oldPub,
    newPublicKeyHex: newPub,
    issuedAt,
  });
}

export async function createSuccession(params: {
  oldPrivateKeyHex: string;
  oldPublicKeyHex: string;
  newPrivateKeyHex: string;
  newPublicKeyHex: string;
  issuedAt?: string;
}): Promise<SuccessionCert> {
  const issuedAt = params.issuedAt ?? new Date().toISOString();
  const msg = body(params.oldPublicKeyHex, params.newPublicKeyHex, issuedAt);
  return {
    type: SUCCESSION_TYPE,
    oldPublicKeyHex: params.oldPublicKeyHex,
    newPublicKeyHex: params.newPublicKeyHex,
    issuedAt,
    oldSig: await signMessage(msg, params.oldPrivateKeyHex),
    newSig: await signMessage(msg, params.newPrivateKeyHex),
  };
}

export async function verifySuccession(cert: SuccessionCert): Promise<boolean> {
  if (!cert || cert.type !== SUCCESSION_TYPE) return false;
  if (cert.oldPublicKeyHex === cert.newPublicKeyHex) return false;
  const msg = body(cert.oldPublicKeyHex, cert.newPublicKeyHex, cert.issuedAt);
  return (
    (await verifyMessage(cert.oldSig, msg, cert.oldPublicKeyHex)) &&
    (await verifyMessage(cert.newSig, msg, cert.newPublicKeyHex))
  );
}

/** Valide la forme d'un certificat lu depuis un fichier/stockage non fiable. */
export function isSuccessionShape(x: unknown): x is SuccessionCert {
  if (!x || typeof x !== "object") return false;
  const c = x as Record<string, unknown>;
  const hex = (v: unknown, n: number) => typeof v === "string" && new RegExp(`^[0-9a-f]{${n}}$`).test(v);
  return (
    c.type === SUCCESSION_TYPE &&
    hex(c.oldPublicKeyHex, 64) &&
    hex(c.newPublicKeyHex, 64) &&
    typeof c.issuedAt === "string" &&
    hex(c.oldSig, 128) &&
    hex(c.newSig, 128)
  );
}

/**
 * Remonte la chaîne de successions depuis `startKeyHex` jusqu'à la clé la plus
 * récente connue. Ne suit que des certificats VÉRIFIÉS et s'arrête sur un cycle.
 */
export async function resolveSuccessor(startKeyHex: string, certs: SuccessionCert[]): Promise<string> {
  let current = startKeyHex;
  const seen = new Set<string>([current]);
  for (;;) {
    const next = certs.find((c) => c.oldPublicKeyHex === current);
    if (!next || seen.has(next.newPublicKeyHex) || !(await verifySuccession(next))) return current;
    current = next.newPublicKeyHex;
    seen.add(current);
  }
}
