/**
 * Server-side cryptography — deliberately minimal. In a zero-knowledge design
 * the server never touches plaintext content or private keys. It only needs to:
 *   - hash lookup tokens (sha256),
 *   - generate random tokens/nonces,
 *   - verify Ed25519 signatures (login challenge proofs) using Node's built-in
 *     WebCrypto-compatible KeyObject (no external dependency),
 *   - store/verify the login "auth secret" via scrypt (the secret is itself an
 *     Argon2id output computed client-side; scrypt here is defense in depth).
 */
import {
  createHash,
  randomBytes,
  timingSafeEqual,
  createPublicKey,
  verify as nodeVerify,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
} from "node:crypto";
import { config } from "../config.js";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** URL-safe random token (base64url), `bytes` of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString("hex");
}

// --- Ed25519 signature verification ----------------------------------------
/**
 * Verify an Ed25519 signature over `message` given a raw 32-byte public key
 * (hex). Node builds the key from a JWK (kty=OKP, crv=Ed25519, x=raw pubkey).
 */
export function verifyEd25519(messageUtf8: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const raw = Buffer.from(publicKeyHex, "hex");
    if (raw.length !== 32) return false;
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    });
    const sig = Buffer.from(signatureHex, "hex");
    return nodeVerify(null, Buffer.from(messageUtf8, "utf8"), key, sig);
  } catch {
    return false;
  }
}

// --- Server-side secret encryption (MFA seeds at rest) ---------------------
// AES-256-GCM under a key derived from TOKEN_SECRET via HKDF. Used for values
// the server MUST be able to read back (e.g. TOTP seeds) but that should not sit
// in the database as plaintext: a DB-only leak yields ciphertext, not seeds.
const SERVER_AEAD_KEY = Buffer.from(
  hkdfSync("sha256", Buffer.from(config.tokenSecret), Buffer.alloc(32), Buffer.from("elium/server-secret/1"), 32),
);

export function encryptServerSecret(plaintext: string): { ct: Buffer; nonce: Buffer } {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", SERVER_AEAD_KEY, nonce);
  const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { ct: Buffer.concat([enc, tag]), nonce };
}

export function decryptServerSecret(ct: Buffer, nonce: Buffer): string {
  const tag = ct.subarray(ct.length - 16);
  const body = ct.subarray(0, ct.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", SERVER_AEAD_KEY, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

export { timingSafeEqual };
