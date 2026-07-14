
/**
 * Elium Crypto Engine v3 — Web Implementation
 *
 * Supports:
 *  - AES-256-GCM primary encryption
 *  - ChaCha20-Poly1305 cascade encryption (via @noble libraries)
 *  - Argon2id key derivation
 *  - HKDF-SHA256 subkey derivation
 *  - Ed25519 signatures
 *  - HMAC-SHA256 integrity
 *  - Keyfile support
 *  - zlib compression (via Compression Streams API "deflate" format)
 */

import { argon2id } from 'hash-wasm';
import * as ed from '@noble/ed25519';
import { hashes } from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

hashes.sha512 = sha512;
// @ts-ignore
hashes.sha512Sync = sha512;

// --- Constants ---
const MAGIC_V3 = new Uint8Array([0x45, 0x4C, 0x49, 0x55, 0x4D, 0x03]); // "ELIUM\x03"
const VERSION = 3;
const SALT_SIZE = 16;
const NONCE_SIZE = 12;
const KEY_SIZE = 32;
const HMAC_SIZE = 32;
const SIGNATURE_SIZE = 64;

const te = new TextEncoder();
const td = new TextDecoder("utf-8");

// --- Interfaces ---

interface EliumHeader {
  version: number;
  kdf: {
    alg: string;
    t: number;
    m: number;
    p: number;
    salt: string;
  };
  crypto: {
    cipher: string;
    cascade: string | null;
    nonce_aes: string;
    nonce_cha: string | null;
  };
  flags: {
    compressed: boolean;
    signed: boolean;
    keyfile_required: boolean;
  };
  signatures?: Array<{
    alg: string;
    signer_fp: string;
    signed_at: string;
  }>;
}

interface EliumManifest {
  generator: string;
  created_at: string;
  files: Array<{ name: string; size: number }>;
  [key: string]: unknown;
}

interface EliumIdentity {
  privateKeyHex: string;
  publicKeyHex: string;
  fingerprint: string;
}

interface EliumDecodeResult {
  payload: Uint8Array;
  manifest: EliumManifest;
  header: EliumHeader;
  signatureValid: boolean | null;
}

// --- Utility Functions ---

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const arr of arrays) {
    out.set(arr, offset);
    offset += arr.length;
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): Uint8Array {
  const matches = hex.match(/.{1,2}/g);
  if (!matches) throw new Error("Invalid hex string");
  return new Uint8Array(matches.map(b => parseInt(b, 16)));
}

// --- Crypto Helpers ---

async function hkdfSha256(master: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", master as unknown as BufferSource, "HKDF", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: info as unknown as BufferSource },
    key,
    KEY_SIZE * 8
  );
  return new Uint8Array(derived);
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", data as unknown as BufferSource);
  return toHex(new Uint8Array(hashBuffer));
}

async function computeHmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const hmacKey = await crypto.subtle.importKey(
    "raw", key as unknown as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", hmacKey, data as unknown as BufferSource);
  return new Uint8Array(mac);
}

/**
 * ChaCha20-Poly1305 encrypt using @noble/ciphers.
 * We dynamically import to keep the module optional.
 */
async function chacha20Poly1305Encrypt(
  key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array
): Promise<Uint8Array> {
  const cipher = chacha20poly1305(key, nonce, aad);
  return cipher.encrypt(plaintext);
}

async function chacha20Poly1305Decrypt(
  key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array
): Promise<Uint8Array> {
  const cipher = chacha20poly1305(key, nonce, aad);
  return cipher.decrypt(ciphertext);
}

/**
 * Compress data using the Compression Streams API (zlib/deflate format).
 * The "deflate" format in the Compression Streams API uses RFC 1950 (zlib wrapper),
 * which is compatible with Python's zlib module.
 */
async function compressData(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  // @ts-ignore
  writer.write(data);
  writer.close();
  const buffer = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buffer);
}

async function decompressData(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const writer = ds.writable.getWriter();
  // @ts-ignore
  writer.write(data);
  writer.close();
  
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let totalSize = 0;
  const MAX_SIZE = 512 * 1024 * 1024; // 512 MiB limit
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalSize += value.length;
      if (totalSize > MAX_SIZE) {
        throw new Error("Decompression bomb detected. Payload exceeds 512 MiB limit.");
      }
      chunks.push(value);
    }
  }
  
  return concat(...chunks);
}

// --- Main Engine ---

export class EliumCryptoEngine {

  /**
   * Derives a master key using Argon2id.
   * If a keyfile is provided, its SHA-256 hash is appended to the password
   * (matching the Python implementation: password + "|KF|" + sha256(keyfile)).
   */
  static async deriveMasterKey(
    password: string,
    salt: Uint8Array,
    t: number,
    m: number,
    p: number,
    keyfile?: Uint8Array
  ): Promise<Uint8Array> {
    let pwdBytes = te.encode(password);

    if (keyfile) {
      const kfHash = new Uint8Array(await crypto.subtle.digest("SHA-256", keyfile as unknown as BufferSource));
      const separator = te.encode("|KF|");
      // @ts-ignore
      pwdBytes = concat(pwdBytes, separator, kfHash);
    }

    const hashHex = await argon2id({
      password: pwdBytes,
      salt: salt,
      iterations: t,
      memorySize: m,
      parallelism: p,
      hashLength: KEY_SIZE,
      outputType: 'hex'
    });
    return fromHex(hashHex);
  }

  // --- Signature Identity ---

  static async generateIdentity(): Promise<EliumIdentity> {
    const utils = ed.utils as Record<string, unknown>;
    const randomFn = (utils.randomPrivateKey ?? utils.randomSecretKey) as () => Uint8Array;
    const privateKey = randomFn();
    const publicKey = await ed.getPublicKey(privateKey);
    const fingerprint = await sha256Hex(publicKey);
    return {
      privateKeyHex: toHex(privateKey),
      publicKeyHex: toHex(publicKey),
      fingerprint
    };
  }

  static async getFingerprint(publicKeyHex: string): Promise<string> {
    return await sha256Hex(fromHex(publicKeyHex));
  }

  // --- Encode ---

  static async encodeContainer(
    payload: Uint8Array,
    password: string,
    filename: string = "document.md",
    privateKeyHex?: string,
    keyfile?: Uint8Array,
    cascade: boolean = false
  ): Promise<Uint8Array> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_SIZE));
    const nonceAes = crypto.getRandomValues(new Uint8Array(NONCE_SIZE));
    const nonceCha = cascade ? crypto.getRandomValues(new Uint8Array(NONCE_SIZE)) : null;

    const t = 3;
    const m = 262144;
    const p = 4;

    const master = await this.deriveMasterKey(password, salt, t, m, p, keyfile);
    const kAes = await hkdfSha256(master, te.encode("elium-v3-aes-gcm"));
    const kCha = cascade ? await hkdfSha256(master, te.encode("elium-v3-chacha")) : null;
    const kMac = await hkdfSha256(master, te.encode("elium-v3-hmac"));

    // Signature identity
    let fingerprint: string | null = null;
    let privBytes: Uint8Array | null = null;
    if (privateKeyHex) {
      privBytes = fromHex(privateKeyHex);
      const pub = await ed.getPublicKey(privBytes);
      fingerprint = await sha256Hex(pub);
    }

    // Header
    const headerDict: EliumHeader = {
      version: VERSION,
      kdf: {
        alg: "argon2id",
        t, m, p,
        salt: toHex(salt)
      },
      crypto: {
        cipher: "aes-256-gcm",
        cascade: cascade ? "chacha20-poly1305" : null,
        nonce_aes: toHex(nonceAes),
        nonce_cha: nonceCha ? toHex(nonceCha) : null
      },
      flags: {
        compressed: true,
        signed: !!privateKeyHex,
        keyfile_required: !!keyfile
      }
    };

    if (fingerprint) {
      headerDict.signatures = [{
        alg: "ed25519",
        signer_fp: fingerprint,
        signed_at: new Date().toISOString()
      }];
    }

    const headerStr = JSON.stringify(headerDict);
    const headerBytes = te.encode(headerStr);

    // Manifest
    const manifestDict: EliumManifest = {
      generator: "elium-v3-web",
      created_at: new Date().toISOString(),
      files: [{ name: filename, size: payload.length }]
    };
    const manifestBytes = te.encode(JSON.stringify(manifestDict));

    const innerDv = new DataView(new ArrayBuffer(4));
    innerDv.setUint32(0, manifestBytes.length, false);
    const manifestLenBytes = new Uint8Array(innerDv.buffer);

    let innerData = concat(manifestLenBytes, manifestBytes, payload);

    // Compress (zlib format)
    innerData = await compressData(innerData);

    // Encrypt — Layer 1: AES-256-GCM
    const aesKey = await crypto.subtle.importKey("raw", kAes as unknown as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
    const ctBuffer = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonceAes as unknown as BufferSource, additionalData: headerBytes as unknown as BufferSource },
      aesKey,
      innerData as unknown as BufferSource
    );
    let ct: Uint8Array = new Uint8Array(ctBuffer);

    // Encrypt — Layer 2: ChaCha20-Poly1305 (cascade)
    if (cascade && kCha && nonceCha) {
      ct = await chacha20Poly1305Encrypt(kCha, nonceCha, ct, headerBytes);
    }

    // Assemble file
    const headerLenDv = new DataView(new ArrayBuffer(4));
    headerLenDv.setUint32(0, headerBytes.length, false);

    const ctLenDv = new DataView(new ArrayBuffer(8));
    ctLenDv.setBigUint64(0, BigInt(ct.length), false);

    // @ts-ignore
    let outBytes: any = concat(
      MAGIC_V3,
      new Uint8Array(headerLenDv.buffer),
      headerBytes,
      // @ts-ignore
      new Uint8Array(ctLenDv.buffer),
      ct
    );

    // Sign (Ed25519)
    if (privBytes) {
      const signature = await ed.signAsync(outBytes, privBytes);
      outBytes = concat(outBytes, signature);
    }

    // HMAC-SHA256
    const mac = await computeHmac(kMac, outBytes);

    return concat(outBytes, mac);
  }

  // --- Decode ---

  static async decodeContainer(
    blob: Uint8Array,
    password: string,
    publicKeyHex?: string,
    keyfile?: Uint8Array
  ): Promise<EliumDecodeResult> {
    if (blob.length < MAGIC_V3.length + 4 + 8 + HMAC_SIZE) {
      throw new Error("File too short to be a valid Elium container.");
    }

    if (!bytesEqual(blob.subarray(0, MAGIC_V3.length), MAGIC_V3)) {
      throw new Error("Invalid Magic Bytes. Not an Elium v3 file.");
    }

    let pos = MAGIC_V3.length;
    const dv = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
    const headerLen = dv.getUint32(pos, false);
    pos += 4;

    const headerBytes = blob.subarray(pos, pos + headerLen);
    pos += headerLen;
    const header: EliumHeader = JSON.parse(td.decode(headerBytes));

    if (header.version !== VERSION) {
      throw new Error(`Unsupported version ${header.version}`);
    }

    if (header.kdf.alg !== "argon2id") {
      throw new Error(`Unsupported KDF: ${header.kdf.alg}`);
    }
    const { t, m, p, salt: saltHex } = header.kdf;
    // Bounds MUST match the Python core (container.py) so a file accepted by one
    // is accepted by the other, and so a malicious header cannot request a huge
    // Argon2 allocation (memory DoS). Max m = 262144 KiB (256 MiB), t = 6.
    if (!(t >= 1 && t <= 6 && m >= 8192 && m <= 262144 && p >= 1 && p <= 16)) {
      throw new Error(`KDF parameters out of bounds (DoS protection): t=${t}, m=${m}, p=${p}`);
    }
    if (saltHex.length !== 32) {
      throw new Error("Invalid salt length");
    }

    const salt = fromHex(saltHex);
    const nonceAes = fromHex(header.crypto.nonce_aes);
    if (nonceAes.length !== 12) {
      throw new Error("Invalid AES nonce length");
    }
    
    const isCascade = header.crypto.cascade === "chacha20-poly1305";
    const nonceCha = isCascade && header.crypto.nonce_cha ? fromHex(header.crypto.nonce_cha) : null;
    if (isCascade && (!nonceCha || nonceCha.length !== 12)) {
      throw new Error("Invalid ChaCha nonce length");
    }

    if (header.flags.keyfile_required && !keyfile) {
      throw new Error("This file requires a keyfile to be decrypted.");
    }

    const ctLen = Number(dv.getBigUint64(pos, false));
    pos += 8;

    let ct = blob.subarray(pos, pos + ctLen);
    pos += ctLen;

    const isSigned = header.flags?.signed;

    let signature = new Uint8Array(0);
    if (isSigned) {
      // @ts-ignore
      signature = blob.subarray(pos, pos + SIGNATURE_SIZE);
      pos += SIGNATURE_SIZE;
    }

    const storedMac = blob.subarray(pos, pos + HMAC_SIZE);

    // Derive keys
    const master = await this.deriveMasterKey(
      password, salt, header.kdf.t, header.kdf.m, header.kdf.p, keyfile
    );
    const kAes = await hkdfSha256(master, te.encode("elium-v3-aes-gcm"));
    const kCha = isCascade ? await hkdfSha256(master, te.encode("elium-v3-chacha")) : null;
    const kMac = await hkdfSha256(master, te.encode("elium-v3-hmac"));

    // Verify HMAC (covers everything before the stored MAC)
    const macData = blob.subarray(0, pos);
    const computedMac = await computeHmac(kMac, macData);

    if (!bytesEqual(computedMac, storedMac)) {
      throw new Error("Échec de la vérification HMAC. Fichier corrompu ou mot de passe invalide.");
    }

    // Verify Signature
    let signatureValid: boolean | null = null;
    if (isSigned) {
      if (!publicKeyHex) {
        signatureValid = null;
      } else {
        const pubBytes = fromHex(publicKeyHex);
        const signedData = blob.subarray(0, pos - SIGNATURE_SIZE);
        signatureValid = await ed.verifyAsync(signature, signedData, pubBytes);
        if (!signatureValid) {
          throw new Error("Alerte Sécurité: La signature Ed25519 est invalide ! Le fichier a été altéré.");
        }
      }
    }

    // Decrypt — Layer 2: ChaCha20-Poly1305 (cascade)
    if (isCascade && kCha && nonceCha) {
      ct = await chacha20Poly1305Decrypt(kCha, nonceCha, ct, headerBytes);
    }

    // Decrypt — Layer 1: AES-256-GCM
    const aesKey = await crypto.subtle.importKey("raw", kAes as unknown as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
    const innerBuffer = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonceAes as unknown as BufferSource, additionalData: headerBytes as unknown as BufferSource },
      aesKey,
      ct as unknown as BufferSource
    );

    let innerData: Uint8Array = new Uint8Array(innerBuffer);

    // Decompress (zlib format)
    if (header.flags?.compressed) {
      innerData = await decompressData(innerData);
    }

    const innerDv = new DataView(innerData.buffer, innerData.byteOffset, innerData.byteLength);
    const manifestLen = innerDv.getUint32(0, false);
    const manifestBytes = innerData.subarray(4, 4 + manifestLen);
    // @ts-ignore
    // @ts-ignore
    const resultPayload: any = innerData.subarray(4 + manifestLen);

    const manifest: EliumManifest = JSON.parse(td.decode(manifestBytes));

    return { payload: resultPayload, manifest, header, signatureValid };
  }
}
