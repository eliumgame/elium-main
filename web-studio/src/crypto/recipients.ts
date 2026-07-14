/**
 * Multi-recipient encryption — byte-compatible mirror of crypto/recipients.py.
 *
 * Hybrid public-key encryption (ECDH-ES over P-256):
 *   - a random 32-byte CEK encrypts the payload once (AES-256-GCM);
 *   - per recipient, an ephemeral P-256 keypair + ECDH with the recipient's
 *     public key derives (HKDF-SHA256) a wrapping key that AES-256-GCM-wraps
 *     the CEK.
 *
 * P-256 is used because it is native to the Web Crypto API and Python's
 * `cryptography` — no extra dependency. Wire constants must match Python:
 *   - public points: raw uncompressed (0x04 || X || Y), hex
 *   - HKDF: SHA-256, salt = 32 zero bytes (RFC 5869 "no salt"), info below
 *   - AEAD additional data = the schema string
 */

import { toHex, fromHex, sha256Hex } from "../format/canonical";

export const RECIPIENTS_SCHEMA = "elium-recipients/1";
const AAD = new TextEncoder().encode(RECIPIENTS_SCHEMA);
const HKDF_INFO = new TextEncoder().encode("elium-recipients/1/wrap");
const HKDF_SALT = new Uint8Array(32); // RFC 5869: no salt → HashLen zero bytes
const EC = { name: "ECDH", namedCurve: "P-256" } as const;

export interface RecipientKeypair {
  privateHex: string; // 32-byte scalar
  publicHex: string; // 65-byte uncompressed point
}

interface RecipientEntry {
  fpr: string;
  epk: string;
  nonce: string;
  wrap: string;
}
interface RecipientEnvelope {
  schema: typeof RECIPIENTS_SCHEMA;
  alg: string;
  contentNonce: string;
  content: string;
  recipients: RecipientEntry[];
}

const subtle = () => globalThis.crypto.subtle;
function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- key helpers ----------------------------------------------------------

export async function generateRecipientKeypair(): Promise<RecipientKeypair> {
  const kp = (await subtle().generateKey(EC, true, ["deriveBits"])) as CryptoKeyPair;
  const jwk = await subtle().exportKey("jwk", kp.privateKey);
  const raw = new Uint8Array(await subtle().exportKey("raw", kp.publicKey));
  return { privateHex: toHex(b64urlToBytes(jwk.d!)), publicHex: toHex(raw) };
}

export async function publicFromPrivate(kp: RecipientKeypair): Promise<string> {
  return kp.publicHex; // public is carried alongside the private scalar
}

export function recipientFingerprint(publicHex: string): Promise<string> {
  return sha256Hex(fromHex(publicHex));
}

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Import a recipient PUBLIC key (raw uncompressed point) for ECDH. */
async function importPublic(publicHex: string): Promise<CryptoKey> {
  return subtle().importKey("raw", fromHex(publicHex) as unknown as BufferSource, EC, false, []);
}

/** Import a recipient PRIVATE key from its scalar + public point (via JWK). */
async function importPrivate(kp: RecipientKeypair): Promise<CryptoKey> {
  const pub = fromHex(kp.publicHex); // 0x04 || X(32) || Y(32)
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: b64url(fromHex(kp.privateHex)),
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65)),
    ext: true,
    key_ops: ["deriveBits"],
  };
  return subtle().importKey("jwk", jwk, EC, false, ["deriveBits"]);
}

async function ecdh(priv: CryptoKey, pub: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: pub }, priv, 256));
}

async function wrapKey(shared: Uint8Array): Promise<CryptoKey> {
  const base = await subtle().importKey("raw", shared as unknown as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT as unknown as BufferSource, info: HKDF_INFO as unknown as BufferSource },
    base,
    256,
  );
  return subtle().importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function aesKey(raw: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return subtle().importKey("raw", raw as unknown as BufferSource, { name: "AES-GCM" }, false, usage);
}

// --- encrypt / decrypt ----------------------------------------------------

export async function encryptForRecipients(payload: Uint8Array, recipientPublicHexes: string[]): Promise<Uint8Array> {
  if (!recipientPublicHexes.length) throw new Error("Aucun destinataire fourni.");

  const cek = globalThis.crypto.getRandomValues(new Uint8Array(32));
  const contentNonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const cekKey = await aesKey(cek, ["encrypt"]);
  const content = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: contentNonce as unknown as BufferSource, additionalData: AAD as unknown as BufferSource }, cekKey, payload as unknown as BufferSource),
  );

  const recipients: RecipientEntry[] = [];
  for (const pubHex of recipientPublicHexes) {
    const recipientPub = await importPublic(pubHex);
    const eph = (await subtle().generateKey(EC, true, ["deriveBits"])) as CryptoKeyPair;
    const shared = await ecdh(eph.privateKey, recipientPub);
    const wk = await wrapKey(shared);
    const nonce = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const wrapped = new Uint8Array(
      await subtle().encrypt({ name: "AES-GCM", iv: nonce as unknown as BufferSource, additionalData: AAD as unknown as BufferSource }, wk, cek as unknown as BufferSource),
    );
    const epk = new Uint8Array(await subtle().exportKey("raw", eph.publicKey));
    recipients.push({ fpr: await recipientFingerprint(pubHex), epk: toHex(epk), nonce: toHex(nonce), wrap: toHex(wrapped) });
  }

  const env: RecipientEnvelope = {
    schema: RECIPIENTS_SCHEMA,
    alg: "ecdh-es-p256+aes-256-gcm",
    contentNonce: toHex(contentNonce),
    content: toHex(content),
    recipients,
  };
  return new TextEncoder().encode(JSON.stringify(env));
}

export function listRecipientFingerprints(blob: Uint8Array): string[] {
  const env = JSON.parse(new TextDecoder().decode(blob)) as RecipientEnvelope;
  return (env.recipients ?? []).map((r) => r.fpr);
}

export async function decryptAsRecipient(blob: Uint8Array, kp: RecipientKeypair): Promise<Uint8Array> {
  let env: RecipientEnvelope;
  try {
    env = JSON.parse(new TextDecoder().decode(blob)) as RecipientEnvelope;
  } catch {
    throw new Error("Enveloppe multi-destinataires illisible.");
  }
  if (env.schema !== RECIPIENTS_SCHEMA) throw new Error("Ce n'est pas une enveloppe multi-destinataires Elium.");

  const priv = await importPrivate(kp);
  const myFpr = await recipientFingerprint(kp.publicHex);
  const ordered = [...(env.recipients ?? [])].sort((a, b) => Number(a.fpr !== myFpr) - Number(b.fpr !== myFpr));

  for (const r of ordered) {
    try {
      const shared = await ecdh(priv, await importPublic(r.epk));
      const wk = await wrapKey(shared);
      const cek = new Uint8Array(
        await subtle().decrypt({ name: "AES-GCM", iv: fromHex(r.nonce) as unknown as BufferSource, additionalData: AAD as unknown as BufferSource }, wk, fromHex(r.wrap) as unknown as BufferSource),
      );
      const cekKey = await aesKey(cek, ["decrypt"]);
      const out = await subtle().decrypt(
        { name: "AES-GCM", iv: fromHex(env.contentNonce) as unknown as BufferSource, additionalData: AAD as unknown as BufferSource },
        cekKey,
        fromHex(env.content) as unknown as BufferSource,
      );
      return new Uint8Array(out);
    } catch {
      continue;
    }
  }
  throw new Error("Aucune clé de destinataire ne permet de déchiffrer ce document.");
}
