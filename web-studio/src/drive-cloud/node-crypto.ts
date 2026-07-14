/**
 * Per-node cryptography (client-side). Each node has a random 32-byte key (CEK).
 * Content and the node name are AES-256-GCM-encrypted under it. The CEK is
 * wrapped to each principal's P-256 public key by REUSING the existing,
 * byte-compatible multi-recipient primitive (crypto/recipients.ts) — the CEK is
 * the envelope payload, so unwrapping returns the CEK.
 */
import { encryptForRecipients, decryptAsRecipient, type RecipientKeypair } from "../crypto/recipients";
import { toHex, fromHex } from "../format/canonical";

const enc = new TextEncoder();
const dec = new TextDecoder();
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;
const NODE_AAD = enc.encode("elium-drive/node/1");

/** An opaque recipients envelope (parsed JSON). Stored as JSONB server-side. */
export type WrappedKey = Record<string, unknown>;

export function generateNodeKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Wrap a node key to a single principal's P-256 public key (hex). */
export async function wrapNodeKeyFor(nodeKey: Uint8Array, publicHex: string): Promise<WrappedKey> {
  const envelope = await encryptForRecipients(nodeKey, [publicHex]);
  return JSON.parse(dec.decode(envelope)) as WrappedKey;
}

/** Unwrap a node key using the caller's P-256 recipient keypair. */
export async function unwrapNodeKey(wrapped: WrappedKey, kp: RecipientKeypair): Promise<Uint8Array> {
  const envelope = enc.encode(JSON.stringify(wrapped));
  return decryptAsRecipient(envelope, kp);
}

async function aesKey(nodeKey: Uint8Array, usage: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", buf(nodeKey), { name: "AES-GCM" }, false, usage);
}

// --- Size padding (leak reduction) -----------------------------------------
// The stored ciphertext length would otherwise reveal the plaintext size to the
// server. We pad the plaintext to a bucket BEFORE encryption, so the length
// only reveals the bucket. PADMÉ (Nikitin et al., "PURBs", PETS 2019) bounds
// the overhead to < ~12 % while collapsing many distinct sizes onto few buckets.
// Framing: [4-byte BE true length][plaintext][zero fill] → padded to padme().
const PAD_MIN = 64; // every payload is at least this big (hides tiny sizes)

export function padmeLength(len: number): number {
  if (len <= PAD_MIN) return PAD_MIN;
  const e = Math.floor(Math.log2(len));
  const s = Math.floor(Math.log2(e)) + 1;
  const z = e - s;
  if (z <= 0) return len;
  const mask = (1 << z) - 1;
  return (len + mask) & ~mask;
}

function padPlaintext(pt: Uint8Array): Uint8Array {
  const target = padmeLength(pt.length + 4);
  const out = new Uint8Array(target); // zero-filled
  new DataView(out.buffer).setUint32(0, pt.length, false); // big-endian true length
  out.set(pt, 4);
  return out;
}

function unpadPlaintext(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) return padded; // defensive (never produced by padPlaintext)
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0, false);
  if (len > padded.length - 4) return padded.subarray(4); // corrupt guard
  return padded.subarray(4, 4 + len);
}

export interface EncryptedBlob {
  nonceHex: string;
  ciphertext: Uint8Array;
}

export async function encryptContent(nodeKey: Uint8Array, plaintext: Uint8Array, pad = true): Promise<EncryptedBlob> {
  const key = await aesKey(nodeKey, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const body = pad ? padPlaintext(plaintext) : plaintext;
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(nonce), additionalData: buf(NODE_AAD) }, key, buf(body)),
  );
  return { nonceHex: toHex(nonce), ciphertext: ct };
}

export async function decryptContent(nodeKey: Uint8Array, nonceHex: string, ciphertext: Uint8Array, pad = true): Promise<Uint8Array> {
  const key = await aesKey(nodeKey, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: buf(fromHex(nonceHex)), additionalData: buf(NODE_AAD) },
    key,
    buf(ciphertext),
  );
  return pad ? unpadPlaintext(new Uint8Array(pt)) : new Uint8Array(pt);
}

export interface EncryptedName {
  nameEncrypted: string; // hex
  nameNonce: string; // hex
}

export async function encryptName(nodeKey: Uint8Array, name: string): Promise<EncryptedName> {
  const b = await encryptContent(nodeKey, enc.encode(name));
  return { nameEncrypted: toHex(b.ciphertext), nameNonce: b.nonceHex };
}

export async function decryptName(nodeKey: Uint8Array, nameEncryptedHex: string, nameNonceHex: string): Promise<string> {
  if (!nameEncryptedHex) return "";
  const pt = await decryptContent(nodeKey, nameNonceHex, fromHex(nameEncryptedHex));
  return dec.decode(pt);
}

/** Encrypt a small JSON metadata object (mime, tags, app-kind) under the node key. */
export async function encryptMeta(nodeKey: Uint8Array, meta: Record<string, unknown>): Promise<EncryptedName> {
  const b = await encryptContent(nodeKey, enc.encode(JSON.stringify(meta)));
  return { nameEncrypted: toHex(b.ciphertext), nameNonce: b.nonceHex };
}

export async function decryptMeta(nodeKey: Uint8Array, hex: string, nonceHex: string): Promise<Record<string, unknown>> {
  if (!hex) return {};
  const pt = await decryptContent(nodeKey, nonceHex, fromHex(hex));
  try {
    return JSON.parse(dec.decode(pt)) as Record<string, unknown>;
  } catch {
    return {};
  }
}
