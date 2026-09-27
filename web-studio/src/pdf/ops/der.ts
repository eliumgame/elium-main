/**
 * Minimal DER (ASN.1) reader and writer, and the parts of X.509 and CMS a PDF
 * signature needs. Works on bytes with offsets, so a structure's exact
 * encoding (a certificate's TBS, a signer's signed attributes) is kept as
 * written — re-encoding would break the signature over it. Key types are not
 * interpreted here: signing and verifying go through WebCrypto
 * (`ops/pades.ts`), which knows RSA and EC.
 */

export interface Tlv {
  tag: number;
  /** Offset of the tag byte. */
  start: number;
  /** Offset of the first content byte. */
  body: number;
  /** Offset just past the content. */
  end: number;
  bytes: Uint8Array;
}

export class DerError extends Error {}

export function readTlv(bytes: Uint8Array, at = 0, limit = bytes.length): Tlv {
  if (at + 2 > limit) throw new DerError("DER tronqué");
  const tag = bytes[at]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError("étiquette DER longue non prise en charge");
  let len = bytes[at + 1]!;
  let body = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (!n || n > 4 || body + n > limit) throw new DerError("longueur DER invalide");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[body + i]!;
    body += n;
  }
  const end = body + len;
  if (end > limit) throw new DerError("DER tronqué");
  return { tag, start: at, body, end, bytes };
}

/** The children of a constructed value. */
export function children(t: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let at = t.body; at < t.end;) {
    const c = readTlv(t.bytes, at, t.end);
    out.push(c);
    at = c.end;
  }
  return out;
}

export const raw = (t: Tlv) => t.bytes.subarray(t.start, t.end);
export const content = (t: Tlv) => t.bytes.subarray(t.body, t.end);

export function oidOf(t: Tlv): string {
  const b = content(t);
  const parts: number[] = [];
  let v = 0;
  for (let i = 0; i < b.length; i++) {
    v = v * 128 + (b[i]! & 0x7f);
    if (!(b[i]! & 0x80)) {
      if (!parts.length) parts.push(v < 80 ? Math.floor(v / 40) : 2, v < 80 ? v % 40 : v - 80);
      else parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

/** UTCTime / GeneralizedTime. */
export function timeOf(t: Tlv): Date {
  const s = new TextDecoder("latin1").decode(content(t));
  const m =
    t.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(s);
  if (!m) throw new DerError(`date DER illisible : ${s}`);
  let year = Number(m[1]);
  if (t.tag === 0x17) year += year < 50 ? 2000 : 1900;
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
}

function stringOf(t: Tlv): string {
  const b = content(t);
  if (t.tag === 0x1e) {
    let s = "";
    for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
    return s;
  }
  return new TextDecoder(t.tag === 0x0c ? "utf-8" : "latin1").decode(b);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

function header(tag: number, len: number): number[] {
  if (len < 0x80) return [tag, len];
  const l: number[] = [];
  for (let n = len; n > 0; n = Math.floor(n / 256)) l.unshift(n & 0xff);
  return [tag, 0x80 | l.length, ...l];
}

export function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const h = header(tag, len);
  const out = new Uint8Array(h.length + len);
  out.set(h, 0);
  let at = h.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export const seq = (...p: Uint8Array[]) => tlv(0x30, ...p);
/** A SET OF, its elements sorted as DER requires. */
export function setOf(...p: Uint8Array[]): Uint8Array {
  const sorted = [...p].sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
    return a.length - b.length;
  });
  return tlv(0x31, ...sorted);
}
export const octets = (b: Uint8Array) => tlv(0x04, b);
export const ctx = (n: number, ...p: Uint8Array[]) => tlv(0xa0 | n, ...p);
export const derNull = () => new Uint8Array([0x05, 0x00]);

export function int(n: number | Uint8Array): Uint8Array {
  if (typeof n !== "number") {
    let b = n;
    let i = 0;
    while (i < b.length - 1 && b[i] === 0 && !(b[i + 1]! & 0x80)) i++;
    b = b.subarray(i);
    return tlv(0x02, ...(b[0]! & 0x80 ? [new Uint8Array([0]), b] : [b]));
  }
  const b: number[] = [];
  do {
    b.unshift(n & 0xff);
    n = Math.floor(n / 256);
  } while (n > 0);
  if (b[0]! & 0x80) b.unshift(0);
  return tlv(0x02, new Uint8Array(b));
}

export function oid(s: string): Uint8Array {
  const p = s.split(".").map(Number);
  const out: number[] = [];
  const push = (v: number) => {
    const b = [v & 0x7f];
    for (v = Math.floor(v / 128); v > 0; v = Math.floor(v / 128)) b.unshift(0x80 | (v & 0x7f));
    out.push(...b);
  };
  push(p[0]! * 40 + p[1]!);
  for (const v of p.slice(2)) push(v);
  return tlv(0x06, new Uint8Array(out));
}

export function generalizedTime(d: Date): Uint8Array {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const s = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x18, new TextEncoder().encode(s));
}

// ---------------------------------------------------------------------------
// OIDs
// ---------------------------------------------------------------------------

export const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificate: "1.2.840.113549.1.9.16.2.12",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  timeStampToken: "1.2.840.113549.1.9.16.2.14",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  rsaEncryption: "1.2.840.113549.1.1.1",
  rsaPss: "1.2.840.113549.1.1.10",
  ecPublicKey: "1.2.840.10045.2.1",
  sha1: "1.3.14.3.2.26",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  email: "1.2.840.113549.1.9.1",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  subjectKeyIdentifier: "2.5.29.14",
  prime256v1: "1.2.840.10045.3.1.7",
  secp384r1: "1.3.132.0.34",
  secp521r1: "1.3.132.0.35",
} as const;

export type HashName = "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512";

export const HASH_OID: Record<HashName, string> = {
  "SHA-1": OID.sha1,
  "SHA-256": OID.sha256,
  "SHA-384": OID.sha384,
  "SHA-512": OID.sha512,
};

/** Signature algorithm OIDs → the hash they use and the key family. */
const SIG_ALGS: Record<string, { hash?: HashName; key: "rsa" | "ec" | "rsa-pss" }> = {
  "1.2.840.113549.1.1.1": { key: "rsa" },
  "1.2.840.113549.1.1.5": { hash: "SHA-1", key: "rsa" },
  "1.2.840.113549.1.1.11": { hash: "SHA-256", key: "rsa" },
  "1.2.840.113549.1.1.12": { hash: "SHA-384", key: "rsa" },
  "1.2.840.113549.1.1.13": { hash: "SHA-512", key: "rsa" },
  "1.2.840.113549.1.1.10": { key: "rsa-pss" },
  "1.2.840.10045.4.1": { hash: "SHA-1", key: "ec" },
  "1.2.840.10045.4.3.2": { hash: "SHA-256", key: "ec" },
  "1.2.840.10045.4.3.3": { hash: "SHA-384", key: "ec" },
  "1.2.840.10045.4.3.4": { hash: "SHA-512", key: "ec" },
  "1.2.840.10045.2.1": { key: "ec" },
};

export function hashOfOid(o: string): HashName | undefined {
  return (Object.keys(HASH_OID) as HashName[]).find((h) => HASH_OID[h] === o);
}

export function sigAlgOf(o: string): { hash?: HashName; key: "rsa" | "ec" | "rsa-pss" } | undefined {
  return SIG_ALGS[o];
}

// ---------------------------------------------------------------------------
// X.509
// ---------------------------------------------------------------------------

export interface Certificate {
  der: Uint8Array;
  tbs: Uint8Array;
  serial: Uint8Array;
  /** Exact encodings of the issuer and subject names (compared byte for byte). */
  issuer: Uint8Array;
  subject: Uint8Array;
  subjectText: string;
  issuerText: string;
  commonName: string;
  notBefore: Date;
  notAfter: Date;
  spki: Uint8Array;
  keyType: "rsa" | "ec" | "other";
  /** EC named curve ("P-256"…). */
  curve?: "P-256" | "P-384" | "P-521";
  sigAlg: string;
  /** Full signatureAlgorithm AlgorithmIdentifier (RSA-PSS carries parameters). */
  sigAlgDer: Uint8Array;
  signature: Uint8Array;
  isCA: boolean;
  subjectKeyId?: Uint8Array;
}

const NAME_LABELS: Record<string, string> = {
  "2.5.4.3": "CN",
  "2.5.4.6": "C",
  "2.5.4.7": "L",
  "2.5.4.8": "ST",
  "2.5.4.10": "O",
  "2.5.4.11": "OU",
  "1.2.840.113549.1.9.1": "E",
};

function nameEntries(name: Tlv): [string, string][] {
  const out: [string, string][] = [];
  for (const rdn of children(name)) {
    for (const atv of children(rdn)) {
      const [t, v] = children(atv);
      if (t && v) out.push([oidOf(t), stringOf(v)]);
    }
  }
  return out;
}

const CURVES: Record<string, Certificate["curve"]> = {
  [OID.prime256v1]: "P-256",
  [OID.secp384r1]: "P-384",
  [OID.secp521r1]: "P-521",
};

export function parseCertificate(der: Uint8Array): Certificate {
  const cert = readTlv(der);
  const [tbsT, sigAlgT, sigT] = children(cert);
  if (!tbsT || !sigAlgT || !sigT) throw new DerError("certificat X.509 invalide");
  const tbs = children(tbsT);
  let i = 0;
  if (tbs[0]?.tag === 0xa0) i++; // version
  const serialT = tbs[i++]!;
  i++; // signature algorithm (repeated)
  const issuerT = tbs[i++]!;
  const validityT = tbs[i++]!;
  const subjectT = tbs[i++]!;
  const spkiT = tbs[i++]!;
  const [nb, na] = children(validityT);
  const spkiAlg = children(children(spkiT)[0]!);
  const keyOid = oidOf(spkiAlg[0]!);
  const subject = nameEntries(subjectT);
  const issuer = nameEntries(issuerT);
  const text = (e: [string, string][]) => e.map(([o, v]) => `${NAME_LABELS[o] ?? o}=${v}`).join(", ");
  let isCA = false;
  let subjectKeyId: Uint8Array | undefined;
  for (const t of tbs.slice(i)) {
    if (t.tag !== 0xa3) continue;
    for (const ext of children(children(t)[0]!)) {
      const parts = children(ext);
      const id = oidOf(parts[0]!);
      const value = readTlv(content(parts[parts.length - 1]!));
      if (id === OID.basicConstraints) isCA = children(value)[0]?.tag === 0x01 && content(children(value)[0]!)[0] !== 0;
      else if (id === OID.subjectKeyIdentifier) subjectKeyId = content(value);
    }
  }
  const sigBits = content(sigT);
  return {
    der: raw(cert),
    tbs: raw(tbsT),
    serial: content(serialT),
    issuer: raw(issuerT),
    subject: raw(subjectT),
    subjectText: text(subject),
    issuerText: text(issuer),
    commonName:
      subject.find(([o]) => o === OID.commonName)?.[1] ??
      subject.find(([o]) => o === OID.organization)?.[1] ??
      subject.find(([o]) => o === OID.email)?.[1] ??
      "Signataire",
    notBefore: timeOf(nb!),
    notAfter: timeOf(na!),
    spki: raw(spkiT),
    keyType:
      keyOid === OID.rsaEncryption || keyOid === OID.rsaPss ? "rsa" : keyOid === OID.ecPublicKey ? "ec" : "other",
    curve: spkiAlg[1]?.tag === 0x06 ? CURVES[oidOf(spkiAlg[1])] : undefined,
    sigAlg: oidOf(children(sigAlgT)[0]!),
    sigAlgDer: raw(sigAlgT),
    signature: sigBits.subarray(1),
    isCA,
    subjectKeyId,
  };
}

export const selfIssued = (c: Certificate) => bytesEqual(c.issuer, c.subject);

// ---------------------------------------------------------------------------
// ECDSA signature encodings
// ---------------------------------------------------------------------------

/** WebCrypto's r‖s → DER Ecdsa-Sig-Value. */
export function ecdsaToDer(p1363: Uint8Array): Uint8Array {
  const half = p1363.length / 2;
  return seq(int(p1363.subarray(0, half)), int(p1363.subarray(half)));
}

/** DER Ecdsa-Sig-Value → r‖s of `size` bytes each (WebCrypto's format). */
export function ecdsaFromDer(der: Uint8Array, size: number): Uint8Array {
  const [r, s] = children(readTlv(der));
  const out = new Uint8Array(size * 2);
  const put = (t: Tlv, at: number) => {
    let b = content(t);
    while (b.length > size && b[0] === 0) b = b.subarray(1);
    if (b.length > size) throw new DerError("signature ECDSA invalide");
    out.set(b, at + size - b.length);
  };
  put(r!, 0);
  put(s!, size);
  return out;
}

export const CURVE_SIZE: Record<NonNullable<Certificate["curve"]>, number> = { "P-256": 32, "P-384": 48, "P-521": 66 };
