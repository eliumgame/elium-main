/**
 * Shared at-rest encryption for local IndexedDB caches that mirror a
 * protected document's content into THIS browser (autosave drafts, version
 * history). Uses the document's own password and/or keyfile as secret — there
 * is no separate local master password. PBKDF2-SHA256 (100k iterations) then
 * AES-256-GCM, one random salt+IV per encryption call.
 *
 * The password/keyfile combination mirrors `EliumCryptoEngine.deriveMasterKey`
 * (crypto/elium-crypto.ts): `password + "|KF|" + sha256(keyfile)` when a
 * keyfile is present, so a keyfile-only document (empty password) still
 * yields a real, keyfile-bound secret instead of silently falling back to
 * plaintext.
 */

export interface VaultSecret {
  password?: string;
  keyfile?: Uint8Array;
}

/** True when there is an actual secret to encrypt with (non-empty password and/or a keyfile). */
export function hasVaultSecret(secret?: VaultSecret): secret is VaultSecret {
  return !!secret && ((secret.password ?? "") !== "" || !!secret.keyfile);
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as unknown as BufferSource));
  return Array.from(digest).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function secretString(secret: VaultSecret): Promise<string> {
  const pwd = secret.password ?? "";
  return secret.keyfile ? `${pwd}|KF|${await sha256Hex(secret.keyfile)}` : pwd;
}

async function deriveKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: 100_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt an arbitrary JSON-serializable value. Returns base64(salt(16) || iv(12) || ciphertext). */
export async function encryptAtRest(value: unknown, secret: VaultSecret): Promise<string> {
  const s = await secretString(secret);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(s, salt);
  const pt = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, pt));
  const out = new Uint8Array(salt.length + iv.length + ct.length);
  out.set(salt, 0);
  out.set(iv, salt.length);
  out.set(ct, salt.length + iv.length);
  return toB64(out);
}

/** Decrypt a value produced by {@link encryptAtRest}. Throws if the secret is wrong or the blob is corrupt. */
export async function decryptAtRest<T>(b64: string, secret: VaultSecret): Promise<T> {
  const s = await secretString(secret);
  const bin = fromB64(b64);
  const salt = bin.slice(0, 16);
  const iv = bin.slice(16, 28);
  const ct = bin.slice(28);
  const key = await deriveKey(s, salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, ct);
  return JSON.parse(new TextDecoder().decode(new Uint8Array(pt))) as T;
}

/**
 * Encrypt raw bytes (e.g. a sealed `.elium` package) rather than a JSON value.
 * Base64-encodes first so `encryptAtRest`'s `JSON.stringify` wraps a plain
 * string instead of serialising the Uint8Array as a `{"0":.., "1":..}` object.
 */
export async function encryptBytesAtRest(bytes: Uint8Array, secret: VaultSecret): Promise<string> {
  return encryptAtRest(toB64(bytes), secret);
}

/** Decrypt bytes produced by {@link encryptBytesAtRest}. */
export async function decryptBytesAtRest(b64: string, secret: VaultSecret): Promise<Uint8Array> {
  return fromB64(await decryptAtRest<string>(b64, secret));
}
