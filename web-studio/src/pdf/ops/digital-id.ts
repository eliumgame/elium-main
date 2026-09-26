/**
 * Self-signed digital IDs (Acrobat's « Nouvel identifiant numérique »): an
 * RSA-2048 key made by WebCrypto — non-extractable, so it never leaves the
 * browser's key store — and an X.509 certificate for it, signed by itself.
 * Other people see the signer's identity as « non vérifiée » until they add
 * the exported certificate to their trusted identities.
 */
import { OID, bytesEqual, ctx, generalizedTime, int, oid, parseCertificate, seq, setOf, tlv, derNull } from "./der";
import type { Certificate } from "./der";
import type { SignerMaterial } from "./pades";

export interface IdentityFields {
  name: string;
  organization?: string;
  unit?: string;
  email?: string;
  country?: string;
}

const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s));
const ascii = (tag: number, s: string) => tlv(tag, new TextEncoder().encode(s));

function time(d: Date): Uint8Array {
  if (d.getUTCFullYear() >= 2050) return generalizedTime(d);
  const p = (n: number) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return ascii(0x17, s);
}

function name(f: IdentityFields): Uint8Array {
  const rdn = (type: string, value: Uint8Array) => setOf(seq(oid(type), value));
  const parts: Uint8Array[] = [];
  if (f.country) parts.push(rdn("2.5.4.6", ascii(0x13, f.country.toUpperCase().slice(0, 2))));
  if (f.organization) parts.push(rdn(OID.organization, utf8(f.organization)));
  if (f.unit) parts.push(rdn("2.5.4.11", utf8(f.unit)));
  parts.push(rdn(OID.commonName, utf8(f.name)));
  if (f.email) parts.push(rdn(OID.email, ascii(0x16, f.email)));
  return seq(...parts);
}

const extension = (id: string, critical: boolean, value: Uint8Array) =>
  seq(oid(id), ...(critical ? [tlv(0x01, new Uint8Array([0xff]))] : []), tlv(0x04, value));

/** A new self-signed ID: its key (non-extractable) and certificate. */
export async function createSelfSignedId(f: IdentityFields, years = 5): Promise<{ key: CryptoKey; cert: Certificate }> {
  const subtle = globalThis.crypto.subtle;
  const pair = (await subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    false,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  const serial = new Uint8Array(16);
  globalThis.crypto.getRandomValues(serial);
  serial[0]! &= 0x7f;
  serial[0]! |= 0x01;
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime());
  notAfter.setUTCFullYear(notAfter.getUTCFullYear() + years);
  const dn = name(f);
  const sha256Rsa = seq(oid("1.2.840.113549.1.1.11"), derNull());
  const keyId = new Uint8Array(await subtle.digest("SHA-1", spki));
  const tbs = seq(
    ctx(0, int(2)),
    int(serial),
    sha256Rsa,
    dn,
    seq(time(notBefore), time(notAfter)),
    dn,
    spki,
    ctx(
      3,
      seq(
        extension(OID.basicConstraints, true, seq()),
        // digitalSignature + nonRepudiation.
        extension(OID.keyUsage, true, tlv(0x03, new Uint8Array([0x06, 0xc0]))),
        // emailProtection, Adobe authentic documents trust.
        extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.4"), oid("1.2.840.113583.1.1.5"))),
        extension(OID.subjectKeyIdentifier, false, tlv(0x04, keyId)),
      ),
    ),
  );
  const signature = new Uint8Array(await subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, tbs.slice().buffer));
  const der = seq(tbs, sha256Rsa, tlv(0x03, new Uint8Array([0]), signature));
  return { key: pair.privateKey, cert: parseCertificate(der) };
}

/** Key material for `signPdfWith` from a kept ID. */
export function materialOf(key: CryptoKey, certDer: Uint8Array, chain: Uint8Array[] = []): SignerMaterial {
  const cert = parseCertificate(certDer);
  const ec = key.algorithm.name === "ECDSA";
  const curve = (key.algorithm as EcKeyAlgorithm).namedCurve;
  return {
    key,
    keyType: ec ? "ec" : "rsa",
    hash: ec && curve === "P-384" ? "SHA-384" : ec && curve === "P-521" ? "SHA-512" : "SHA-256",
    cert,
    chain: chain.map(parseCertificate).filter((c) => !bytesEqual(c.der, cert.der)),
  };
}

/** PEM text of a certificate (to share, so others can trust the ID). */
export function certificatePem(der: Uint8Array): string {
  let bin = "";
  for (const b of der) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/.{64}/g, "$&\n");
  return `-----BEGIN CERTIFICATE-----\n${b64.trim()}\n-----END CERTIFICATE-----\n`;
}

/** A certificate file (.cer/.crt/.pem, DER or PEM) → DER. */
export function readCertificateFile(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder("latin1").decode(bytes);
  const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(text);
  const der = m ? Uint8Array.from(atob(m[1]!.replace(/\s+/g, "")), (c) => c.charCodeAt(0)) : bytes;
  parseCertificate(der); // throws when it is not a certificate
  return der;
}
