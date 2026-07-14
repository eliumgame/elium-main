/**
 * TOTP (RFC 6238) second factor — dependency-free, Node crypto only.
 *
 * The shared secret is a random 20-byte value, Base32-encoded for authenticator
 * apps (Google Authenticator, Aegis, 1Password…). Codes are 6 digits over a
 * 30-second step, HMAC-SHA1 (the algorithm every authenticator app implements).
 *
 * The secret is a SECOND factor, unrelated to the zero-knowledge content keys:
 * it never touches the master key or any private key. It is nonetheless stored
 * ENCRYPTED at rest (see mfa-crypto below) so a database-only leak does not hand
 * an attacker a working authenticator seed.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const DIGITS = 6;
const STEP_SECONDS = 30;

// --- Base32 (RFC 4648, no padding) -----------------------------------------
const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Base32 invalide.");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 20-byte TOTP secret, Base32-encoded. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The HOTP/TOTP code for a given counter (RFC 4226 dynamic truncation). */
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter (safe integer range covers year ~ 9e9).
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = createHmac("sha1", secret).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return (bin % 10 ** DIGITS).toString().padStart(DIGITS, "0");
}

/** The current TOTP code for a Base32 secret (used by tests and QR previews). */
export function totpNow(secretB32: string, atMs = Date.now()): string {
  return hotp(base32Decode(secretB32), Math.floor(atMs / 1000 / STEP_SECONDS));
}

/**
 * Constant-time verify of a 6-digit code, tolerating ±`window` steps of clock
 * drift (default ±1 → a 90-second acceptance window).
 */
export function verifyTotp(secretB32: string, code: string, window = 1, atMs = Date.now()): boolean {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const secret = base32Decode(secretB32);
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  for (let w = -window; w <= window; w++) {
    const expected = hotp(secret, counter + w);
    const a = Buffer.from(expected);
    const b = Buffer.from(normalized);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/** The `otpauth://` URI an authenticator app scans (issuer + account label). */
export function otpauthUri(secretB32: string, account: string, issuer = "Elium"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// --- Backup codes -----------------------------------------------------------
/** N single-use backup codes (formatted xxxx-xxxx, from the base32 alphabet). */
export function generateBackupCodes(n = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    const raw = base32Encode(randomBytes(5)).slice(0, 8).toLowerCase();
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4, 8)}`);
  }
  return codes;
}
