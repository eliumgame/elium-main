/**
 * Shared at-rest encryption for local IndexedDB caches that mirror a
 * protected document's content into THIS browser (autosave drafts, version
 * history). Uses the document's own password and/or keyfile as secret — there
 * is no separate local master password. **Argon2id** (aligné sur le reste de la
 * suite, cf. crypto/elium-crypto.ts) puis AES-256-GCM, un sel+IV aléatoire par
 * chiffrement. Les blobs écrits par l'ancienne dérivation PBKDF2-SHA256 restent
 * déchiffrables (compat descendante — cf. `decryptAtRest`).
 *
 * The password/keyfile combination mirrors `EliumCryptoEngine.deriveMasterKey`
 * (crypto/elium-crypto.ts): `password + "|KF|" + sha256(keyfile)` when a
 * keyfile is present, so a keyfile-only document (empty password) still
 * yields a real, keyfile-bound secret instead of silently falling back to
 * plaintext.
 */

import { argon2id } from "hash-wasm";

export interface VaultSecret {
  password?: string;
  keyfile?: Uint8Array;
}

// Paramètres Argon2id pour ce cache LOCAL : plus légers que la clé maîtresse d'un
// document (les brouillons/versions se sauvent souvent, ça doit rester rapide),
// mais bien supérieurs à PBKDF2-100k. ~19 Mo, 2 passes.
const A2_ITERATIONS = 2;
const A2_MEMORY_KIB = 19_456;
const A2_PARALLELISM = 1;

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

/** Dérivation ACTUELLE : Argon2id → clé AES-256-GCM. */
async function deriveKeyArgon2(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const raw = await argon2id({
    password: secret,
    salt,
    iterations: A2_ITERATIONS,
    memorySize: A2_MEMORY_KIB,
    parallelism: A2_PARALLELISM,
    hashLength: 32,
    outputType: "binary",
  });
  return crypto.subtle.importKey("raw", raw as unknown as BufferSource, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Dérivation HÉRITÉE (PBKDF2-100k) : uniquement pour déchiffrer les anciens blobs. */
async function deriveKeyPbkdf2(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations: 100_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt an arbitrary JSON-serializable value. Returns a versioned JSON
 *  envelope `{"v":2,"d":base64(salt(16)||iv(12)||ct)}` (Argon2id). */
export async function encryptAtRest(value: unknown, secret: VaultSecret): Promise<string> {
  const s = await secretString(secret);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKeyArgon2(s, salt);
  const pt = new TextEncoder().encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, key, pt));
  const out = new Uint8Array(salt.length + iv.length + ct.length);
  out.set(salt, 0);
  out.set(iv, salt.length);
  out.set(ct, salt.length + iv.length);
  return JSON.stringify({ v: 2, d: toB64(out) });
}

/** Decrypt a value produced by {@link encryptAtRest}. Accepts the v2 Argon2id
 *  envelope AND legacy PBKDF2 blobs (raw base64) written before this change. */
export async function decryptAtRest<T>(stored: string, secret: VaultSecret): Promise<T> {
  const s = await secretString(secret);
  let b64 = stored;
  let deriveKey = deriveKeyPbkdf2; // legacy par défaut
  if (stored.startsWith("{")) {
    const env = JSON.parse(stored) as { v?: number; d?: string };
    if (env.v === 2 && typeof env.d === "string") { b64 = env.d; deriveKey = deriveKeyArgon2; }
  }
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
