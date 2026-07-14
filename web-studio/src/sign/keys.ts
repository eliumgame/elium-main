/**
 * Ed25519 key + signing helpers for Elium Sign.
 *
 * Mirrors the wiring used by the crypto engine so the @noble/ed25519 module
 * has its sha512 hash configured. Keys are handled as raw hex (32-byte private,
 * 32-byte public) — the same convention as Web Studio identities.
 */

import * as ed from "@noble/ed25519";
import { hashes } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { sha256Hex, toHex, fromHex } from "../format/canonical";

hashes.sha512 = sha512;
// @ts-ignore — sync variant used by some code paths
hashes.sha512Sync = sha512;

const te = new TextEncoder();

export interface EliumIdentity {
  /** Present only while unlocked in memory; never persisted in clear. */
  privateKeyHex?: string;
  publicKeyHex: string;
  fingerprint: string;
}

export async function generateIdentity(): Promise<EliumIdentity> {
  const utils = ed.utils as Record<string, unknown>;
  const randomFn = (utils.randomPrivateKey ?? utils.randomSecretKey) as () => Uint8Array;
  const privateKey = randomFn();
  const publicKey = await ed.getPublicKey(privateKey);
  return {
    privateKeyHex: toHex(privateKey),
    publicKeyHex: toHex(publicKey),
    fingerprint: await sha256Hex(publicKey),
  };
}

export async function publicKeyHexFromPrivate(privateKeyHex: string): Promise<string> {
  return toHex(await ed.getPublicKey(fromHex(privateKeyHex)));
}

export async function fingerprintOf(publicKeyHex: string): Promise<string> {
  return sha256Hex(fromHex(publicKeyHex));
}

export async function signMessage(message: string, privateKeyHex: string): Promise<string> {
  const sig = await ed.signAsync(te.encode(message), fromHex(privateKeyHex));
  return toHex(sig);
}

export async function verifyMessage(
  signatureHex: string,
  message: string,
  publicKeyHex: string,
): Promise<boolean> {
  try {
    return await ed.verifyAsync(fromHex(signatureHex), te.encode(message), fromHex(publicKeyHex));
  } catch {
    return false;
  }
}
