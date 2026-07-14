/**
 * Account key derivation for the cloud Drive (client-side, zero-knowledge).
 *
 * From the password we derive a single Argon2id `root`, then split it via HKDF
 * into INDEPENDENT secrets (distinct `info`, so one reveals nothing about the
 * others, and the server never sees `root`):
 *   - `authSignSeed` — the seed of an Ed25519 auth key. Only its PUBLIC key is
 *     ever sent (at registration). Login proves knowledge by signing a random
 *     server challenge — the server never receives a password-equivalent, so
 *     there is no login oracle (cf. the goal of SRP/OPAQUE, reached here with
 *     the vetted Ed25519 primitive rather than hand-rolled PAKE arithmetic).
 *   - `masterKey`   — AES-256 key that wraps the private-key bundle; NEVER sent.
 *   - `authSecret`  — legacy verifier value (kept for back-compat / transition).
 */
import { EliumCryptoEngine } from "../crypto/elium-crypto";
import { toHex, fromHex } from "../format/canonical";

export interface KdfParams {
  alg: "argon2id";
  t: number;
  m: number;
  p: number;
}

export const DEFAULT_KDF_PARAMS: KdfParams = { alg: "argon2id", t: 3, m: 262144, p: 4 };

const enc = new TextEncoder();
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

async function hkdf(ikm: Uint8Array, info: string, len = 32): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: buf(new Uint8Array(32)), info: buf(enc.encode(info)) },
    base,
    len * 8,
  );
  return new Uint8Array(bits);
}

export interface AccountSecrets {
  authSecret: string; // hex — legacy verifier value (transition only)
  authSignSeedHex: string; // hex — Ed25519 seed; only its PUBLIC key leaves the client
  masterKey: Uint8Array; // 32 bytes — kept in memory only
}

export async function deriveAccountSecrets(
  password: string,
  kdfSaltHex: string,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<AccountSecrets> {
  const root = await EliumCryptoEngine.deriveMasterKey(password, fromHex(kdfSaltHex), params.t, params.m, params.p);
  const [authSecret, authSignSeed, masterKey] = await Promise.all([
    hkdf(root, "elium-drive/auth/1"),
    hkdf(root, "elium-drive/auth-sign/1"),
    hkdf(root, "elium-drive/master/1"),
  ]);
  return { authSecret: toHex(authSecret), authSignSeedHex: toHex(authSignSeed), masterKey };
}

// --- Encrypted private-key bundle ------------------------------------------

export interface KeyBundle {
  v: 1;
  alg: "aes-256-gcm";
  nonce: string; // hex
  ct: string; // hex
}

const BUNDLE_AAD = enc.encode("elium-drive/bundle/1");

export async function sealKeyBundle(masterKey: Uint8Array, secrets: Record<string, string>): Promise<KeyBundle> {
  const key = await crypto.subtle.importKey("raw", buf(masterKey), { name: "AES-GCM" }, false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(nonce), additionalData: buf(BUNDLE_AAD) },
      key,
      buf(enc.encode(JSON.stringify(secrets))),
    ),
  );
  return { v: 1, alg: "aes-256-gcm", nonce: toHex(nonce), ct: toHex(ct) };
}

export async function openKeyBundle(masterKey: Uint8Array, bundle: KeyBundle): Promise<Record<string, string>> {
  const key = await crypto.subtle.importKey("raw", buf(masterKey), { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(fromHex(bundle.nonce)), additionalData: buf(BUNDLE_AAD) },
      key,
      buf(fromHex(bundle.ct)),
    ),
  );
  return JSON.parse(new TextDecoder().decode(pt)) as Record<string, string>;
}
