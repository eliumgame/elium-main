/**
 * Dérivation déterministe des clés du trousseau à partir du SECRET MAÎTRE (32 octets).
 *
 * Pourquoi : si toutes les clés d'un trousseau dérivent d'un seul secret, la
 * phrase de récupération de 24 mots (= ce secret), les parts Shamir et
 * l'enveloppe par passkey protègent TOUTES les clés d'un coup, sans avoir à
 * sauvegarder un fichier par clé. Une rotation consomme simplement l'index
 * suivant.
 *
 * Spécification (miroir à respecter byte pour byte) :
 *   HKDF-SHA256, sel = 32 octets nuls, ikm = secret maître.
 *   - Ed25519  : graine(i)  = HKDF(info = "elium-keyring/ed25519/<i>", 32 octets)
 *   - P-256    : d(i)       = (int_BE(HKDF(info = "elium-keyring/p256/<i>", 48 octets)) mod (n-1)) + 1
 *     (48 octets > 256 bits + 64 : biais négligeable, cf. FIPS 186-5 B.4.1)
 */
import { p256 } from "@noble/curves/nist.js";
import { toHex, fromHex } from "../format/canonical";
import { publicKeyHexFromPrivate } from "../sign/keys";

const te = new TextEncoder();
/** Ordre du sous-groupe de P-256. */
const P256_ORDER = BigInt("0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551");

export async function hkdfBytes(ikm: Uint8Array, info: string, length: number): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey("raw", ikm as unknown as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: te.encode(info) as unknown as BufferSource },
    base,
    length * 8,
  );
  return new Uint8Array(bits);
}

function bigFromBytes(b: Uint8Array): bigint {
  return BigInt("0x" + (toHex(b) || "0"));
}

export interface DerivedEd25519 {
  privateKeyHex: string;
  publicKeyHex: string;
}
export interface DerivedP256 {
  privateHex: string;
  publicHex: string;
}

function checkIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffff) throw new RangeError("Index de dérivation invalide.");
}

export async function deriveEd25519(master: Uint8Array, index: number): Promise<DerivedEd25519> {
  checkIndex(index);
  const seed = await hkdfBytes(master, `elium-keyring/ed25519/${index}`, 32);
  const privateKeyHex = toHex(seed);
  return { privateKeyHex, publicKeyHex: await publicKeyHexFromPrivate(privateKeyHex) };
}

export async function deriveP256(master: Uint8Array, index: number): Promise<DerivedP256> {
  checkIndex(index);
  const raw = await hkdfBytes(master, `elium-keyring/p256/${index}`, 48);
  const d = (bigFromBytes(raw) % (P256_ORDER - 1n)) + 1n;
  const privateHex = d.toString(16).padStart(64, "0");
  const publicHex = toHex(p256.getPublicKey(fromHex(privateHex), false));
  return { privateHex, publicHex };
}
