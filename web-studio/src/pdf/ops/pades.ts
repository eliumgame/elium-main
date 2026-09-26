/**
 * PAdES signatures (ISO 32000 §12.8, ETSI EN 319 142) — what Acrobat's
 * « Signer avec un certificat » and « Certifier » write, and what its
 * signature panel checks.
 *
 * Signing appends ONE incremental update to the file as it is (`ops/incremental.ts`):
 * the signature dictionary, the field (a new one or the prepared field being
 * signed), its appearance. Every earlier byte stays in place, so the earlier
 * signatures stay valid — a document can be signed by several people, one
 * after the other. The update is written without object streams, so the
 * signature's `/ByteRange` and `/Contents` placeholders sit in plain bytes; they
 * are located in the appended section by the signature object's number, then
 * filled at constant length.
 *
 * The CMS SignedData is built here (`ops/der.ts`), PAdES B-B: content-type,
 * message-digest and signing-certificate-v2 signed attributes, no signing-time
 * (the time is the dictionary's /M, or a RFC 3161 timestamp when a TSA is
 * given), SubFilter ETSI.CAdES.detached. Keys are used through WebCrypto:
 * RSA (PKCS #1 v1.5) and EC (P-256/384/521).
 *
 * Verification recomputes each signature's digest over its byte range, checks
 * the CMS signature and the signer certificate (by the signer identifier, at
 * the signing time), builds the certificate chain up to a trusted identity
 * (the user's list — there is no system store in a browser), and compares the
 * signed revision with the final file to tell what was changed after signing,
 * judged against the certification level (DocMDP) and field locks (FieldMDP).
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
} from "pdf-lib";
import type { PDFObject, PDFFont } from "pdf-lib";
import forge from "node-forge";
import { sha256, sha384, sha512 } from "@noble/hashes/sha2.js";
import { sha1 } from "@noble/hashes/legacy.js";
import {
  CURVE_SIZE,
  HASH_OID,
  OID,
  bytesEqual,
  children,
  content,
  ctx as ctxTag,
  derNull,
  ecdsaFromDer,
  ecdsaToDer,
  hashOfOid,
  int,
  octets,
  oid,
  oidOf,
  parseCertificate,
  raw,
  readTlv,
  selfIssued,
  seq,
  setOf,
  sigAlgOf,
  timeOf,
  tlv,
} from "./der";
import type { Certificate, HashName, Tlv } from "./der";
import { fingerprint, readXrefTail, serializeObject, trailerId0, writeIncrementalUpdate } from "./incremental";
import { openCrypt } from "./security";

export type { Certificate } from "./der";

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

/** What a visible signature shows (Acrobat's « Style d'apparence »). */
export interface SignatureLook {
  name?: boolean;
  date?: boolean;
  reason?: boolean;
  location?: boolean;
  /** « Signé numériquement par » and field labels. */
  labels?: boolean;
  /** Distinguished name of the certificate. */
  dn?: boolean;
}

export interface PadesSignOptions {
  reason?: string;
  location?: string;
  contactInfo?: string;
  signerName?: string;
  /** Exact name of the field to sign (a prepared one) or to create. */
  fieldName?: string;
  /**
   * A visible signature: a widget at `rect` — model space of page `page`
   * (crop-box relative, top-left origin, unrotated page) — showing the
   * picture and/or the signature's text.
   */
  visible?: { page: number; rect: { x: number; y: number; w: number; h: number }; imagePng?: Uint8Array };
  /** Text shown in the appearance (default: everything). `false` = picture only. */
  look?: SignatureLook | false;
  /**
   * Certify instead of approving (the first signature only): 1 = no change
   * allowed, 2 = form filling and signing, 3 = also comments.
   */
  certify?: 1 | 2 | 3;
  /** Lock the document after this signature (field lock, PDF 2.0 /P 1). */
  lockDocument?: boolean;
  /** RFC 3161 timestamp authority to countersign the signature with. */
  tsaUrl?: string;
  /** Sends the TSA request (tests, or a relay when the page cannot reach the TSA). */
  tsaFetch?: (url: string, request: Uint8Array) => Promise<Uint8Array>;
  /** Open password of a protected file. */
  password?: string;
  /** Signing time (tests). */
  now?: Date;
}

export type Trust = "trusted" | "untrusted" | "selfSigned";
export type ChangeKind = "signature" | "form" | "comment" | "neutral" | "disallowed";

export interface SignatureChange {
  kind: ChangeKind;
  /** French description (« Champ rempli : Nom »…). */
  label: string;
}

export interface CertificateInfo {
  subject: string;
  issuer: string;
  commonName: string;
  serialHex: string;
  notBefore: string;
  notAfter: string;
  der: Uint8Array;
  selfSigned: boolean;
}

export interface PadesVerification {
  /** Fully qualified field name. */
  fieldName: string;
  signerName: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  /** ISO time: the timestamp's when there is one, else the signer's claim. */
  signedAt?: string;
  timeSource: "timestamp" | "signer" | "none";
  subFilter: string;
  hash?: HashName;
  keyType?: "rsa" | "ec" | "other";
  /** The signature is mathematically correct and the signed bytes are unchanged. */
  intact: boolean;
  digestMatches: boolean;
  /** The signature covers the whole file (nothing appended after it). */
  coversWholeDocument: boolean;
  /** What changed after this signature. */
  modifications: "none" | "allowed" | "disallowed";
  changes: SignatureChange[];
  /** Overall verdict, Acrobat's green check: intact, certificate usable, no disallowed change. */
  valid: boolean;
  /** The signer certificate was within its validity period at the signing time. */
  certValidAtSigning: boolean;
  selfSigned: boolean;
  trust: Trust;
  /** The chain reaches a trusted identity (kept for older callers: same as trust === "trusted"). */
  chainVerified: boolean;
  timestamped: boolean;
  /** The timestamp authority is trusted: its time is the signing time. */
  timestampTrusted?: boolean;
  /** Time of an untrusted timestamp (shown, not relied on). */
  timestampAt?: string;
  /** Certification level when this is a certifying signature. */
  certification?: 1 | 2 | 3;
  /** Fields this signature locks (FieldMDP), "*" = all. */
  locks?: string[];
  /** 1-based revision this signature closes, and its end offset (to show the signed version). */
  revision: number;
  revisionEnd: number;
  certificate?: CertificateInfo;
  chain: CertificateInfo[];
  error?: string;
}

export interface VerifyOptions {
  password?: string;
  /** Trusted identities (DER certificates): a chain ending on one of them is trusted. */
  trusted?: Uint8Array[];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error("Chiffrement WebCrypto indisponible dans ce navigateur.");
  return s;
};

function u8ToBin(u: Uint8Array): string {
  let s = "";
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return s;
}
function binToU8(s: string): Uint8Array {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
}
function hexOf(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}
function writeAscii(buf: Uint8Array, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) buf[at + i] = text.charCodeAt(i) & 0xff;
}
const buf = (b: Uint8Array): ArrayBuffer => b.slice().buffer as ArrayBuffer;

export function digest(hash: HashName, data: Uint8Array): Uint8Array {
  switch (hash) {
    case "SHA-1":
      return sha1(data);
    case "SHA-384":
      return sha384(data);
    case "SHA-512":
      return sha512(data);
    default:
      return sha256(data);
  }
}

function pdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function parsePdfDate(s: string | undefined): Date | undefined {
  const m = s && /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/.exec(s);
  if (!m) return undefined;
  const utc = Date.UTC(+m[1]!, +(m[2] ?? 1) - 1, +(m[3] ?? 1), +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
  const off = m[7] === "+" || m[7] === "-" ? (m[7] === "+" ? 1 : -1) * (+(m[8] ?? 0) * 60 + +(m[9] ?? 0)) : 0;
  return new Date(utc - off * 60000);
}

function certInfo(c: Certificate): CertificateInfo {
  return {
    subject: c.subjectText,
    issuer: c.issuerText,
    commonName: c.commonName,
    serialHex: hexOf(c.serial),
    notBefore: c.notBefore.toISOString(),
    notAfter: c.notAfter.toISOString(),
    der: c.der,
    selfSigned: selfIssued(c),
  };
}

const text = (o: PDFObject | undefined): string | undefined =>
  o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined;

// ---------------------------------------------------------------------------
// Signer material (PKCS #12)
// ---------------------------------------------------------------------------

export interface SignerMaterial {
  key: CryptoKey;
  keyType: "rsa" | "ec";
  hash: HashName;
  cert: Certificate;
  chain: Certificate[];
}

export class Pkcs12Error extends Error {
  constructor(
    message: string,
    readonly wrongPassword = false,
  ) {
    super(message);
    this.name = "Pkcs12Error";
  }
}

async function importPrivateKey(
  pkcs8: Uint8Array,
): Promise<{ key: CryptoKey; keyType: "rsa" | "ec"; jwk: JsonWebKey }> {
  const info = children(readTlv(pkcs8));
  const alg = children(info[1]!);
  const algOid = oidOf(alg[0]!);
  if (algOid === OID.rsaEncryption) {
    const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    // An extractable copy only to read the public half; the key kept for signing is not.
    const probe = await subtle().importKey("pkcs8", buf(pkcs8), alg, true, ["sign"]);
    const key = await subtle().importKey("pkcs8", buf(pkcs8), alg, false, ["sign"]);
    return { key, keyType: "rsa", jwk: await subtle().exportKey("jwk", probe) };
  }
  if (algOid === OID.ecPublicKey) {
    const curve = alg[1]?.tag === 0x06 ? oidOf(alg[1]) : "";
    const namedCurve =
      curve === OID.prime256v1 ? "P-256" : curve === OID.secp384r1 ? "P-384" : curve === OID.secp521r1 ? "P-521" : "";
    if (!namedCurve) throw new Pkcs12Error("Courbe elliptique non prise en charge (P-256, P-384 ou P-521 attendue).");
    const probe = await subtle().importKey("pkcs8", buf(pkcs8), { name: "ECDSA", namedCurve }, true, ["sign"]);
    const key = await subtle().importKey("pkcs8", buf(pkcs8), { name: "ECDSA", namedCurve }, false, ["sign"]);
    return { key, keyType: "ec", jwk: await subtle().exportKey("jwk", probe) };
  }
  throw new Pkcs12Error("Type de clé non pris en charge (RSA ou EC attendu).");
}

/** Does the certificate carry the public half of `jwk`? */
async function certMatchesKey(cert: Certificate, jwk: JsonWebKey, keyType: "rsa" | "ec"): Promise<boolean> {
  try {
    const alg =
      keyType === "rsa"
        ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }
        : { name: "ECDSA", namedCurve: cert.curve ?? "P-256" };
    const pub = await subtle().exportKey(
      "jwk",
      await subtle().importKey("spki", buf(cert.spki), alg, true, ["verify"]),
    );
    return keyType === "rsa" ? pub.n === jwk.n : pub.x === jwk.x && pub.y === jwk.y;
  } catch {
    return false;
  }
}

/** Read a PKCS #12 (.p12/.pfx) file: the private key, its certificate and the chain. */
export async function loadPkcs12(p12Bytes: Uint8Array, password: string): Promise<SignerMaterial> {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(u8ToBin(p12Bytes)));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/password|MAC/i.test(msg)) throw new Pkcs12Error("Mot de passe du certificat incorrect.", true);
    throw new Pkcs12Error(`Fichier de certificat illisible (${msg}).`);
  }
  const keyBags = [
    ...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] ?? []),
    ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] ?? []),
  ];
  const bag = keyBags.find((b) => b.key || b.asn1);
  if (!bag) throw new Pkcs12Error("Le fichier ne contient pas de clé privée.");
  const pkcs8 = bag.key
    ? binToU8(
        forge.asn1
          .toDer(forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(bag.key as forge.pki.rsa.PrivateKey)))
          .getBytes(),
      )
    : binToU8(forge.asn1.toDer(bag.asn1!).getBytes());
  const { key, keyType, jwk } = await importPrivateKey(pkcs8);

  const certs: Certificate[] = [];
  for (const b of p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? []) {
    const der = b.cert
      ? binToU8(forge.asn1.toDer(forge.pki.certificateToAsn1(b.cert)).getBytes())
      : b.asn1
        ? binToU8(forge.asn1.toDer(b.asn1).getBytes())
        : null;
    if (der) certs.push(parseCertificate(der));
  }
  if (!certs.length) throw new Pkcs12Error("Le fichier ne contient pas de certificat.");
  let signer: Certificate | undefined;
  for (const c of certs) if (await certMatchesKey(c, jwk, keyType)) signer = c;
  if (!signer) throw new Pkcs12Error("Aucun certificat du fichier ne correspond à sa clé privée.");
  const hash: HashName =
    keyType === "ec" && signer.curve === "P-384"
      ? "SHA-384"
      : keyType === "ec" && signer.curve === "P-521"
        ? "SHA-512"
        : "SHA-256";
  return { key, keyType, hash, cert: signer, chain: certs.filter((c) => c !== signer) };
}

/** Name to show for a certificate file: its signer's common name. */
export async function pkcs12SignerName(p12Bytes: Uint8Array, password: string): Promise<string> {
  return (await loadPkcs12(p12Bytes, password)).cert.commonName;
}

// ---------------------------------------------------------------------------
// CMS SignedData
// ---------------------------------------------------------------------------

const algId = (o: string, withNull = true) => seq(oid(o), ...(withNull ? [derNull()] : []));
const attribute = (type: string, value: Uint8Array) => seq(oid(type), setOf(value));

function signatureAlgorithm(m: SignerMaterial): Uint8Array {
  if (m.keyType === "rsa") return algId(OID.rsaEncryption);
  const o = {
    "SHA-1": "1.2.840.10045.4.1",
    "SHA-256": "1.2.840.10045.4.3.2",
    "SHA-384": "1.2.840.10045.4.3.3",
    "SHA-512": "1.2.840.10045.4.3.4",
  }[m.hash];
  return algId(o, false);
}

async function signBytes(m: SignerMaterial, data: Uint8Array): Promise<Uint8Array> {
  // RSA keys are imported (or generated) for RSASSA-PKCS1-v1_5 with SHA-256, the hash used with them.
  if (m.keyType === "rsa") return new Uint8Array(await subtle().sign("RSASSA-PKCS1-v1_5", m.key, buf(data)));
  return ecdsaToDer(new Uint8Array(await subtle().sign({ name: "ECDSA", hash: m.hash }, m.key, buf(data))));
}

/** The signing-certificate-v2 attribute value (ESS, RFC 5035): binds the signer certificate. */
function signingCertificateV2(m: SignerMaterial): Uint8Array {
  const issuerSerial = seq(seq(ctxTag(4, m.cert.issuer)), int(m.cert.serial));
  const essCertId = seq(
    ...(m.hash === "SHA-256" ? [] : [algId(HASH_OID[m.hash], false)]),
    octets(digest(m.hash, m.cert.der)),
    issuerSerial,
  );
  return seq(seq(essCertId));
}

async function buildCms(m: SignerMaterial, docDigest: Uint8Array, tsa?: TsaClient): Promise<Uint8Array> {
  const attrs = [
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octets(docDigest)),
    attribute(OID.signingCertificateV2, signingCertificateV2(m)),
  ];
  const signedAttrs = setOf(...attrs);
  const signature = await signBytes(m, signedAttrs);
  const unsigned: Uint8Array[] = [];
  if (tsa) {
    const token = await tsa.stamp(digest(m.hash, signature), m.hash);
    unsigned.push(attribute(OID.timeStampToken, token));
  }
  const signerInfo = seq(
    int(1),
    seq(m.cert.issuer, int(m.cert.serial)),
    algId(HASH_OID[m.hash]),
    // [0] IMPLICIT: the SET's tag replaced, its content unchanged.
    tlv(0xa0, content(readTlv(signedAttrs))),
    signatureAlgorithm(m),
    octets(signature),
    // [1] IMPLICIT SET OF Attribute.
    ...(unsigned.length ? [tlv(0xa1, ...unsigned)] : []),
  );
  const signedData = seq(
    int(1),
    setOf(algId(HASH_OID[m.hash])),
    seq(oid(OID.data)),
    tlv(0xa0, m.cert.der, ...m.chain.map((c) => c.der)),
    setOf(signerInfo),
  );
  return seq(oid(OID.signedData), ctxTag(0, signedData));
}

function reservedBytes(m: SignerMaterial, tsa: boolean): number {
  const certs = [m.cert, ...m.chain].reduce((n, c) => n + c.der.length, 0);
  return certs + 4096 + (tsa ? 12000 : 0);
}

// ---------------------------------------------------------------------------
// RFC 3161 timestamps
// ---------------------------------------------------------------------------

interface TsaClient {
  stamp(imprint: Uint8Array, hash: HashName): Promise<Uint8Array>;
}

function tsaClient(url: string, send?: PadesSignOptions["tsaFetch"]): TsaClient {
  const post =
    send ??
    (async (u: string, body: Uint8Array) => {
      const res = await fetch(u, {
        method: "POST",
        headers: { "Content-Type": "application/timestamp-query" },
        body: buf(body),
      });
      if (!res.ok) throw new Error(`Serveur d'horodatage : HTTP ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    });
  return {
    async stamp(imprint, hash) {
      const nonce = new Uint8Array(8);
      globalThis.crypto.getRandomValues(nonce);
      nonce[0]! &= 0x7f;
      const req = seq(
        int(1),
        seq(algId(HASH_OID[hash]), octets(imprint)),
        int(nonce),
        tlv(0x01, new Uint8Array([0xff])),
      );
      let res: Uint8Array;
      try {
        res = await post(url, req);
      } catch (e) {
        throw new Error(`Horodatage impossible : ${e instanceof Error ? e.message : String(e)}`);
      }
      let token: Tlv | undefined;
      let code: number | undefined;
      try {
        const [status, t] = children(readTlv(res));
        token = t;
        code = status ? content(children(status)[0]!)[0] : 2;
      } catch {
        throw new Error("Réponse du serveur d'horodatage illisible.");
      }
      if (!token || (code !== 0 && code !== 1)) throw new Error("Le serveur d'horodatage a refusé la demande.");
      const tst = readTimestamp(raw(token));
      if (!tst || !bytesEqual(tst.imprint, imprint)) throw new Error("Réponse d'horodatage incohérente.");
      return raw(token);
    },
  };
}

/** The TSTInfo of a timestamp token: the time and the hashed imprint. */
function readTimestamp(token: Uint8Array): { time: Date; imprint: Uint8Array; hash?: HashName } | null {
  try {
    const sd = signedDataOf(token);
    if (!sd.eContent) return null;
    const info = children(readTlv(sd.eContent));
    const imprint = children(info[2]!);
    return {
      imprint: content(imprint[1]!),
      hash: hashOfOid(oidOf(children(imprint[0]!)[0]!)),
      time: timeOf(info[4]!),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

interface SigField {
  /** The field dictionary (holds /T, /V, /Lock). */
  field: PDFDict;
  /** Its widget (the same dict for a merged field/widget). */
  widget: PDFDict;
  widgetRef?: PDFRef;
  /** The field's and its signature dictionary's references (to find them in an earlier revision). */
  fieldRef?: PDFRef;
  sigRef?: PDFRef;
  name: string;
  pageIndex: number;
  rect: [number, number, number, number];
  signed: boolean;
}

function inheritedFT(d: PDFDict): string | undefined {
  for (let n: PDFDict | undefined = d, i = 0; n && i < 32; i++) {
    const ft = n.lookup(PDFName.of("FT"));
    if (ft instanceof PDFName) return ft.decodeText();
    const p: PDFObject | undefined = n.lookup(PDFName.of("Parent"));
    n = p instanceof PDFDict ? p : undefined;
  }
  return undefined;
}

/** Every signature field of the form, hierarchical names resolved. */
function signatureFields(doc: PDFDocument): SigField[] {
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict)) return [];
  const fields = acro.lookup(PDFName.of("Fields"));
  if (!(fields instanceof PDFArray)) return [];
  const pages = doc.getPages();
  const pageOf = new Map<string, number>();
  pages.forEach((p, i) => {
    const annots = p.node.lookup(PDFName.of("Annots"));
    if (annots instanceof PDFArray)
      for (let k = 0; k < annots.size(); k++) {
        const r = annots.get(k);
        if (r instanceof PDFRef) pageOf.set(r.toString(), i);
      }
  });
  const out: SigField[] = [];
  const seen = new Set<string>();
  const visit = (ref: PDFObject, prefix: string, depth: number) => {
    if (depth > 32) return;
    const node = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
    if (!(node instanceof PDFDict)) return;
    if (ref instanceof PDFRef) {
      if (seen.has(ref.toString())) return;
      seen.add(ref.toString());
    }
    const t = text(node.lookup(PDFName.of("T")));
    const name = t === undefined ? prefix : prefix ? `${prefix}.${t}` : t;
    const kids = node.lookup(PDFName.of("Kids"));
    const kidFields: PDFObject[] = [];
    const widgets: [PDFDict, PDFRef | undefined][] = [];
    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) {
        const k = kids.get(i);
        const kd = k instanceof PDFRef ? doc.context.lookup(k) : k;
        if (!(kd instanceof PDFDict)) continue;
        if (kd.has(PDFName.of("T"))) kidFields.push(k);
        else widgets.push([kd, k instanceof PDFRef ? k : undefined]);
      }
    }
    if (node.has(PDFName.of("Rect")) || node.lookup(PDFName.of("Subtype")) === PDFName.of("Widget"))
      widgets.unshift([node, ref instanceof PDFRef ? ref : undefined]);
    if (inheritedFT(node) === "Sig" && t !== undefined && widgets.length) {
      const [widget, widgetRef] = widgets[0]!;
      const r = widget.lookup(PDFName.of("Rect"));
      const rect: [number, number, number, number] =
        r instanceof PDFArray && r.size() === 4
          ? (() => {
              const n = [0, 1, 2, 3].map((i) => (r.lookup(i) as PDFNumber | undefined)?.asNumber?.() ?? 0);
              return [Math.min(n[0]!, n[2]!), Math.min(n[1]!, n[3]!), Math.max(n[0]!, n[2]!), Math.max(n[1]!, n[3]!)];
            })()
          : [0, 0, 0, 0];
      let pageIndex = widgetRef ? (pageOf.get(widgetRef.toString()) ?? -1) : -1;
      if (pageIndex < 0) {
        const p = widget.get(PDFName.of("P"));
        pageIndex = p instanceof PDFRef ? pages.findIndex((pg) => pg.ref === p) : -1;
      }
      const v = node.get(PDFName.of("V"));
      out.push({
        field: node,
        widget,
        widgetRef,
        fieldRef: ref instanceof PDFRef ? ref : undefined,
        sigRef: v instanceof PDFRef ? v : undefined,
        name,
        pageIndex,
        rect,
        signed: node.lookup(PDFName.of("V")) instanceof PDFDict,
      });
    }
    for (const k of kidFields) visit(k, name, depth + 1);
  };
  for (let i = 0; i < fields.size(); i++) visit(fields.get(i), "", 0);
  return out;
}

/** Signature fields of a document (for the UI: prepared fields to sign, signed ones). */
export async function listSignatureFields(
  bytes: Uint8Array,
  password?: string,
): Promise<
  {
    name: string;
    page: number;
    rect: [number, number, number, number];
    /** The widget in model space: crop-box relative, top-left origin, unrotated. */
    box: { x: number; y: number; w: number; h: number };
    signed: boolean;
  }[]
> {
  const doc = await loadPlain(bytes, password);
  return signatureFields(doc).map(({ name, pageIndex, rect, signed }) => {
    const crop = pageIndex >= 0 ? doc.getPage(pageIndex).getCropBox() : { x: 0, y: 0, width: 0, height: 0 };
    return {
      name,
      page: pageIndex,
      rect,
      box: { x: rect[0] - crop.x, y: crop.y + crop.height - rect[3], w: rect[2] - rect[0], h: rect[3] - rect[1] },
      signed,
    };
  });
}

/**
 * The prepared (empty) field a signature without an explicit name should
 * land on: the only one when there is no placement to compare with, else the
 * one on the placement's page nearest to it; never a guess between equals.
 */
function pickPreparedField(doc: PDFDocument, visible: PadesSignOptions["visible"]): SigField | undefined {
  const empty = signatureFields(doc).filter((f) => !f.signed && f.pageIndex >= 0);
  if (!empty.length) return undefined;
  if (!visible) return empty.length === 1 ? empty[0] : undefined;
  const pageIndex = Math.min(Math.max(0, visible.page), doc.getPageCount() - 1);
  // Only a prepared field the placed signature overlaps: the user put it there.
  const t = toPdfRect(doc, pageIndex, visible.rect);
  const meets = (f: SigField) => f.rect[0] < t[2] && t[0] < f.rect[2] && f.rect[1] < t[3] && t[1] < f.rect[3];
  const same = empty.filter((f) => f.pageIndex === pageIndex && meets(f));
  if (same.length <= 1) return same[0];
  const cx = (t[0] + t[2]) / 2;
  const cy = (t[1] + t[3]) / 2;
  const dist = (f: SigField) => Math.hypot((f.rect[0] + f.rect[2]) / 2 - cx, (f.rect[1] + f.rect[3]) / 2 - cy);
  const sorted = [...same].sort((a, b) => dist(a) - dist(b));
  return Math.abs(dist(sorted[0]!) - dist(sorted[1]!)) <= 1e-6 ? undefined : sorted[0];
}

/** Model rect (crop-box relative, top-left) → PDF user space. */
function toPdfRect(
  doc: PDFDocument,
  pageIndex: number,
  r: { x: number; y: number; w: number; h: number },
): [number, number, number, number] {
  const box = doc.getPage(pageIndex).getCropBox();
  const x1 = box.x + r.x;
  const y1 = box.y + box.height - r.y - r.h;
  return [x1, y1, x1 + r.w, y1 + r.h];
}

// ---------------------------------------------------------------------------
// Appearance
// ---------------------------------------------------------------------------

function encodable(font: PDFFont, s: string): string {
  let out = "";
  for (const ch of s) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

function localTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${sign}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`;
}

async function buildAppearance(
  doc: PDFDocument,
  w: number,
  h: number,
  rotation: number,
  lines: string[],
  imagePng: Uint8Array | undefined,
): Promise<PDFRef> {
  const ctx = doc.context;
  // The form is drawn in the displayed orientation and rotated back onto the page.
  const quarter = ((rotation % 360) + 360) % 360;
  const [dw, dh] = quarter === 90 || quarter === 270 ? [h, w] : [w, h];
  const matrix =
    quarter === 90
      ? [0, 1, -1, 0, 0, 0]
      : quarter === 180
        ? [-1, 0, 0, -1, 0, 0]
        : quarter === 270
          ? [0, -1, 1, 0, 0, 0]
          : [1, 0, 0, 1, 0, 0];
  const resources: Record<string, PDFObject> = {};
  let ops = "";
  let textX = 2;
  if (imagePng) {
    const img = await doc.embedPng(imagePng);
    const area = lines.length ? dw / 2 : dw;
    const scale = Math.min((area - 4) / img.width, (dh - 4) / img.height);
    const iw = img.width * scale;
    const ih = img.height * scale;
    ops += `q ${iw.toFixed(3)} 0 0 ${ih.toFixed(3)} ${((area - iw) / 2).toFixed(3)} ${((dh - ih) / 2).toFixed(3)} cm /Im0 Do Q\n`;
    resources.XObject = ctx.obj({ Im0: img.ref });
    textX = area + 2;
  }
  if (lines.length) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    resources.Font = ctx.obj({ Helv: font.ref });
    const avail = dw - textX - 2;
    const clean = lines.map((l) => encodable(font, l));
    let size = Math.min(12, (dh - 4) / (clean.length * 1.2));
    for (const l of clean) size = Math.min(size, avail / Math.max(1, font.widthOfTextAtSize(l, 1)));
    size = Math.max(size, 2);
    const lead = size * 1.2;
    const top = dh / 2 + (clean.length * lead) / 2 - size;
    ops += `BT /Helv ${size.toFixed(3)} Tf 0 g ${lead.toFixed(3)} TL ${textX.toFixed(3)} ${top.toFixed(3)} Td\n`;
    clean.forEach((l, i) => {
      ops += `${i ? "T* " : ""}${font.encodeText(l).toString()} Tj\n`;
    });
    ops += "ET\n";
  }
  const dict = ctx.obj({
    Type: PDFName.of("XObject"),
    Subtype: PDFName.of("Form"),
    FormType: 1,
    BBox: [0, 0, dw, dh],
    Matrix: matrix,
    Resources: ctx.obj(resources),
  });
  return ctx.register(ctx.stream(ops, dict as never));
}

function appearanceLines(opts: PadesSignOptions, name: string, dn: string, at: Date): string[] {
  if (opts.look === false) return [];
  const look: SignatureLook = {
    name: true,
    date: true,
    reason: true,
    location: true,
    labels: true,
    dn: false,
    ...opts.look,
  };
  const lines: string[] = [];
  if (look.name) lines.push(look.labels ? `Signé numériquement par ${name}` : name);
  if (look.dn) lines.push(look.labels ? `ND : ${dn}` : dn);
  if (look.date) lines.push(look.labels ? `Date : ${localTime(at)}` : localTime(at));
  if (look.reason && opts.reason) lines.push(look.labels ? `Motif : ${opts.reason}` : opts.reason);
  if (look.location && opts.location) lines.push(look.labels ? `Lieu : ${opts.location}` : opts.location);
  return lines;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

async function loadPlain(bytes: Uint8Array, password?: string): Promise<PDFDocument> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const crypt = openCrypt(doc, password ?? "");
  if (crypt) await crypt.decryptDocument(doc, bytes);
  return doc;
}

/** The certification level declared by the document (catalog /Perms /DocMDP). */
function docMdpLevel(doc: PDFDocument): 1 | 2 | 3 | null {
  const perms = doc.catalog.lookup(PDFName.of("Perms"));
  const sig = perms instanceof PDFDict ? perms.lookup(PDFName.of("DocMDP")) : undefined;
  return sig instanceof PDFDict ? (referenceOf(sig).certification ?? 2) : null;
}

function referenceOf(sig: PDFDict): { certification?: 1 | 2 | 3; locks?: { action: string; fields: string[] } } {
  const refs = sig.lookup(PDFName.of("Reference"));
  const out: ReturnType<typeof referenceOf> = {};
  if (!(refs instanceof PDFArray)) return out;
  for (let i = 0; i < refs.size(); i++) {
    const r = refs.lookup(i);
    if (!(r instanceof PDFDict)) continue;
    const method = r.lookup(PDFName.of("TransformMethod"));
    const params = r.lookup(PDFName.of("TransformParams"));
    const p = params instanceof PDFDict ? params : undefined;
    if (method === PDFName.of("DocMDP")) {
      const n = p?.lookup(PDFName.of("P"));
      const level = n instanceof PDFNumber ? n.asNumber() : 2;
      out.certification = (level === 1 || level === 3 ? level : 2) as 1 | 2 | 3;
    } else if (method === PDFName.of("FieldMDP") && p) {
      out.locks = lockOf(p);
    }
  }
  return out;
}

function lockOf(p: PDFDict): { action: string; fields: string[] } {
  const action = p.lookup(PDFName.of("Action"));
  const fields = p.lookup(PDFName.of("Fields"));
  const names: string[] = [];
  if (fields instanceof PDFArray) for (let i = 0; i < fields.size(); i++) names.push(text(fields.lookup(i)) ?? "");
  return { action: action instanceof PDFName ? action.decodeText() : "All", fields: names };
}

function lockDict(doc: PDFDocument, lock: { action: string; fields: string[] }, p?: number): PDFDict {
  const d = doc.context.obj({
    Type: PDFName.of("TransformParams"),
    Action: PDFName.of(lock.action),
    V: PDFName.of("1.2"),
  });
  if (lock.action !== "All") d.set(PDFName.of("Fields"), doc.context.obj(lock.fields.map((f) => PDFString.of(f))));
  if (p) d.set(PDFName.of("P"), PDFNumber.of(p));
  return d;
}

/**
 * Sign a PDF with a PKCS #12 certificate: the file with one more revision,
 * holding the signature. Earlier revisions (and signatures) are left intact.
 */
export async function signPdfBytes(
  pdfBytes: Uint8Array,
  p12Bytes: Uint8Array,
  password: string,
  opts: PadesSignOptions = {},
): Promise<Uint8Array> {
  return signPdfWith(pdfBytes, await loadPkcs12(p12Bytes, password), opts);
}

/** Sign with key material already at hand (a digital ID kept in the browser). */
export async function signPdfWith(
  pdfBytes: Uint8Array,
  m: SignerMaterial,
  opts: PadesSignOptions = {},
): Promise<Uint8Array> {
  const now = opts.now ?? new Date();
  const disk = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);

  const doc = await PDFDocument.load(disk, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const crypt = openCrypt(doc, opts.password ?? "");
  const encryptRaw = doc.context.trailerInfo.Encrypt;
  const encryptRef = encryptRaw instanceof PDFRef ? encryptRaw : null;
  if (crypt) {
    await crypt.decryptDocument(doc, disk);
    if (encryptRef) doc.context.delete(encryptRef);
    doc.context.trailerInfo.Encrypt = undefined;
  }
  const tail = readXrefTail(disk);
  if (!tail && crypt) throw new Error("Structure du fichier irrégulière : enregistrez-le avant de le signer.");
  const before = fingerprint(doc);
  const id0 = crypt?.id0 ?? trailerId0(doc);
  doc.context.largestObjectNumber = Math.max(doc.context.largestObjectNumber, (tail?.size ?? 0) - 1);

  const existing = signatureFields(doc);
  // A file whose end cannot be appended to would be rewritten: its signatures would be lost.
  if (!tail && existing.some((f) => f.signed))
    throw new Error(
      "La fin de ce fichier est irrégulière : le signer à nouveau effacerait les signatures existantes. Enregistrez-en une copie pour le signer.",
    );
  const level = docMdpLevel(doc);
  if (level === 1)
    throw new Error("Ce document est certifié sans modification autorisée : il ne peut plus être signé.");
  if (opts.certify && existing.some((f) => f.signed))
    throw new Error("Un document déjà signé ne peut plus être certifié : seule la première signature peut l'être.");
  if (crypt && !crypt.permissions.fillForms && !crypt.permissions.annotate && !crypt.permissions.modify)
    throw new Error("La protection du document n'autorise pas la signature.");

  const ctx = doc.context;
  const signerName = opts.signerName || m.cert.commonName;
  let target = opts.fieldName ? existing.find((f) => f.name === opts.fieldName) : pickPreparedField(doc, opts.visible);
  if (target?.signed) {
    if (opts.fieldName) throw new Error(`Le champ « ${target.name} » est déjà signé.`);
    target = undefined;
  }

  // Signature dictionary, placeholders filled after the file is written.
  const byteRange = ctx.obj([0, PDFName.of("**********"), PDFName.of("**********"), PDFName.of("**********")]);
  const reserved = reservedBytes(m, !!opts.tsaUrl);
  const sig = ctx.obj({
    Type: PDFName.of("Sig"),
    Filter: PDFName.of("Adobe.PPKLite"),
    SubFilter: PDFName.of("ETSI.CAdES.detached"),
    ByteRange: byteRange,
    Contents: PDFHexString.of("0".repeat(reserved * 2)),
    M: PDFString.of(pdfDate(now)),
    Name: PDFHexString.fromText(signerName),
  }) as PDFDict;
  if (opts.reason) sig.set(PDFName.of("Reason"), PDFHexString.fromText(opts.reason));
  if (opts.location) sig.set(PDFName.of("Location"), PDFHexString.fromText(opts.location));
  if (opts.contactInfo) sig.set(PDFName.of("ContactInfo"), PDFHexString.fromText(opts.contactInfo));
  sig.set(
    PDFName.of("Prop_Build"),
    ctx.obj({ App: ctx.obj({ Name: PDFName.of("Elium") }), Filter: ctx.obj({ Name: PDFName.of("Adobe.PPKLite") }) }),
  );

  const references: PDFDict[] = [];
  if (opts.certify) {
    references.push(
      ctx.obj({
        Type: PDFName.of("SigRef"),
        TransformMethod: PDFName.of("DocMDP"),
        TransformParams: ctx.obj({ Type: PDFName.of("TransformParams"), P: opts.certify, V: PDFName.of("1.2") }),
      }) as PDFDict,
    );
  }
  // A prepared field's own lock, or « verrouiller le document ».
  const preparedLock = target?.field.lookup(PDFName.of("Lock"));
  const lock =
    preparedLock instanceof PDFDict
      ? { ...lockOf(preparedLock), p: (preparedLock.lookup(PDFName.of("P")) as PDFNumber | undefined)?.asNumber?.() }
      : opts.lockDocument
        ? { action: "All", fields: [], p: 1 }
        : null;
  if (lock) {
    references.push(
      ctx.obj({
        Type: PDFName.of("SigRef"),
        TransformMethod: PDFName.of("FieldMDP"),
        TransformParams: lockDict(doc, lock, lock.p),
      }) as PDFDict,
    );
  }
  if (references.length) sig.set(PDFName.of("Reference"), ctx.obj(references));
  const sigRef = ctx.register(sig);

  // Field and widget.
  const pageIndex = target
    ? target.pageIndex
    : opts.visible
      ? Math.min(Math.max(0, opts.visible.page), doc.getPageCount() - 1)
      : 0;
  const page = doc.getPage(Math.max(0, pageIndex));
  const rect = target
    ? target.rect
    : opts.visible
      ? toPdfRect(doc, pageIndex, opts.visible.rect)
      : ([0, 0, 0, 0] as [number, number, number, number]);
  const w = rect[2] - rect[0];
  const h = rect[3] - rect[1];
  let apRef: PDFRef | undefined;
  if (w > 1 && h > 1) {
    const lines = appearanceLines(opts, signerName, m.cert.subjectText, now);
    if (lines.length || opts.visible?.imagePng)
      apRef = await buildAppearance(doc, w, h, page.getRotation().angle, lines, opts.visible?.imagePng);
  }

  let widget: PDFDict;
  if (target) {
    target.field.set(PDFName.of("V"), sigRef);
    widget = target.widget;
    if (apRef) widget.set(PDFName.of("AP"), ctx.obj({ N: apRef }));
    if (opts.lockDocument && !(preparedLock instanceof PDFDict))
      target.field.set(
        PDFName.of("Lock"),
        ctx.obj({ Type: PDFName.of("SigFieldLock"), Action: PDFName.of("All"), P: 1 }),
      );
  } else {
    const taken = new Set(existing.map((f) => f.name));
    let name = opts.fieldName || "Signature1";
    for (let i = 2; taken.has(name); i++) name = `Signature${i}`;
    widget = ctx.obj({
      Type: PDFName.of("Annot"),
      Subtype: PDFName.of("Widget"),
      FT: PDFName.of("Sig"),
      Rect: ctx.obj(rect),
      V: sigRef,
      T: PDFHexString.fromText(name),
      F: w > 1 && h > 1 ? 4 : 132,
      P: page.ref,
    }) as PDFDict;
    if (apRef) widget.set(PDFName.of("AP"), ctx.obj({ N: apRef }));
    if (opts.lockDocument)
      widget.set(PDFName.of("Lock"), ctx.obj({ Type: PDFName.of("SigFieldLock"), Action: PDFName.of("All"), P: 1 }));
    const widgetRef = ctx.register(widget);
    let annots = page.node.lookup(PDFName.of("Annots"));
    if (!(annots instanceof PDFArray)) {
      annots = ctx.obj([]);
      page.node.set(PDFName.of("Annots"), annots);
    }
    (annots as PDFArray).push(widgetRef);
    let acro = doc.catalog.lookup(PDFName.of("AcroForm"));
    if (!(acro instanceof PDFDict)) {
      acro = ctx.obj({ Fields: ctx.obj([]) });
      doc.catalog.set(PDFName.of("AcroForm"), ctx.register(acro as PDFDict));
    }
    let fields = (acro as PDFDict).lookup(PDFName.of("Fields"));
    if (!(fields instanceof PDFArray)) {
      fields = ctx.obj([]);
      (acro as PDFDict).set(PDFName.of("Fields"), fields);
    }
    (fields as PDFArray).push(widgetRef);
  }
  const acro = doc.catalog.lookup(PDFName.of("AcroForm")) as PDFDict;
  acro.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  // Viewers must not regenerate appearances of a signed form.
  if (acro.has(PDFName.of("NeedAppearances"))) acro.set(PDFName.of("NeedAppearances"), PDFBool.False);
  if (opts.certify) doc.catalog.set(PDFName.of("Perms"), ctx.obj({ DocMDP: sigRef }));

  await doc.flush();
  let out: Uint8Array;
  let from: number;
  if (tail) {
    const res = writeIncrementalUpdate({ disk, tail, doc, before, crypt, encryptRef, id0 });
    out = new Uint8Array(res.bytes);
    from = disk.length;
  } else {
    out = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });
    from = 0;
  }

  // Locate the placeholders inside the signature object just written.
  const s = u8ToBin(out.subarray(from));
  const head = new RegExp(`(?:^|[\\r\\n])${sigRef.objectNumber} ${sigRef.generationNumber} obj\\b`, "g");
  let objAt = -1;
  for (let mm: RegExpExecArray | null; (mm = head.exec(s));) objAt = mm.index;
  if (objAt < 0) throw new Error("Signature introuvable dans le fichier écrit.");
  const objEnd = s.indexOf("endobj", objAt);
  const brIdx = s.indexOf("/ByteRange", objAt);
  const brOpen = s.indexOf("[", brIdx);
  const brClose = s.indexOf("]", brOpen);
  const cIdx = s.indexOf("/Contents", objAt);
  const lt = s.indexOf("<", cIdx);
  const gt = s.indexOf(">", lt);
  if (brIdx < 0 || brIdx > objEnd || cIdx < 0 || cIdx > objEnd || gt < 0 || gt > objEnd)
    throw new Error("Emplacement de signature mal formé.");
  const ltAbs = from + lt;
  const gtAbs = from + gt + 1;
  const range = [0, ltAbs, gtAbs, out.length - gtAbs];
  const inner = s.slice(brOpen + 1, brClose);
  const filled = ` ${range.join(" ")} `;
  if (filled.length > inner.length) throw new Error("Emplacement /ByteRange trop court.");
  writeAscii(out, from + brOpen + 1, filled.padEnd(inner.length, " "));

  const covered = new Uint8Array(ltAbs + range[3]!);
  covered.set(out.subarray(0, ltAbs), 0);
  covered.set(out.subarray(gtAbs), ltAbs);
  const cms = await buildCms(
    m,
    digest(m.hash, covered),
    opts.tsaUrl ? tsaClient(opts.tsaUrl, opts.tsaFetch) : undefined,
  );
  const hex = hexOf(cms).toUpperCase();
  const hole = gt - lt - 1;
  if (hex.length > hole) throw new Error("Signature trop volumineuse pour l'espace réservé.");
  writeAscii(out, ltAbs + 1, hex.padEnd(hole, "0"));
  return out;
}

// ---------------------------------------------------------------------------
// Verification: CMS
// ---------------------------------------------------------------------------

interface SignedData {
  certificates: Certificate[];
  signers: Tlv[];
  eContent?: Uint8Array;
}

function signedDataOf(cms: Uint8Array): SignedData {
  const ci = children(readTlv(cms));
  if (oidOf(ci[0]!) !== OID.signedData) throw new Error("Ce n'est pas une signature CMS (SignedData).");
  const sd = children(children(ci[1]!)[0]!);
  let i = 1; // version
  i++; // digestAlgorithms
  const encap = children(sd[i++]!);
  const eContent = encap[1] ? content(children(encap[1])[0]!) : undefined;
  const certificates: Certificate[] = [];
  if (sd[i]?.tag === 0xa0) {
    for (const c of children(sd[i]!))
      if (c.tag === 0x30) {
        try {
          certificates.push(parseCertificate(raw(c)));
        } catch {
          /* an attribute certificate or unknown entry */
        }
      }
    i++;
  }
  if (sd[i]?.tag === 0xa1) i++; // crls
  return { certificates, signers: children(sd[i]!), eContent };
}

interface SignerCheck {
  cert?: Certificate;
  hash?: HashName;
  keyType?: Certificate["keyType"];
  signatureOk: boolean;
  digestOk: boolean;
  signingTime?: Date;
  timestamp?: Date;
  timestampOk?: boolean;
  /** The timestamp authority's certificate and the certificates its token carries. */
  tsaCert?: Certificate;
  tsaPool?: Certificate[];
  essOk: boolean;
}

function findSigner(sd: SignedData, sid: Tlv): Certificate | undefined {
  if (sid.tag === 0x30) {
    const [issuer, serial] = children(sid);
    return sd.certificates.find((c) => bytesEqual(c.issuer, raw(issuer!)) && bytesEqual(c.serial, content(serial!)));
  }
  if (sid.tag === 0x80) {
    const ski = content(sid);
    return sd.certificates.find((c) => c.subjectKeyId && bytesEqual(c.subjectKeyId, ski));
  }
  return undefined;
}

async function verifyRaw(
  cert: Certificate,
  sigAlgDer: Uint8Array,
  fallbackHash: HashName | undefined,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean> {
  try {
    const algT = readTlv(sigAlgDer);
    const parts = children(algT);
    const info = sigAlgOf(oidOf(parts[0]!));
    const hash = info?.hash ?? fallbackHash ?? "SHA-256";
    const s = subtle();
    if (cert.keyType === "ec") {
      if (!cert.curve) return false;
      const key = await s.importKey("spki", buf(cert.spki), { name: "ECDSA", namedCurve: cert.curve }, false, [
        "verify",
      ]);
      return await s.verify(
        { name: "ECDSA", hash },
        key,
        buf(ecdsaFromDer(signature, CURVE_SIZE[cert.curve])),
        buf(data),
      );
    }
    if (cert.keyType !== "rsa") return false;
    if (info?.key === "rsa-pss") {
      let pssHash: HashName = "SHA-1";
      let salt = 20;
      if (parts[1]) {
        for (const p of children(parts[1])) {
          if (p.tag === 0xa0) pssHash = hashOfOid(oidOf(children(children(p)[0]!)[0]!)) ?? pssHash;
          if (p.tag === 0xa2) salt = content(children(p)[0]!).reduce((n, b) => n * 256 + b, 0);
        }
      }
      const key = await s.importKey("spki", buf(cert.spki), { name: "RSA-PSS", hash: pssHash }, false, ["verify"]);
      return await s.verify({ name: "RSA-PSS", saltLength: salt }, key, buf(signature), buf(data));
    }
    const key = await s.importKey("spki", buf(cert.spki), { name: "RSASSA-PKCS1-v1_5", hash }, false, ["verify"]);
    return await s.verify("RSASSA-PKCS1-v1_5", key, buf(signature), buf(data));
  } catch {
    return false;
  }
}

/** Check one SignerInfo against the signed content (or its digest when `contentDigest` says so). */
async function checkSigner(sd: SignedData, signer: Tlv, signedContent: Uint8Array): Promise<SignerCheck> {
  const p = children(signer);
  let i = 1;
  const sid = p[i++]!;
  const hash = hashOfOid(oidOf(children(p[i++]!)[0]!));
  const attrsT = p[i]?.tag === 0xa0 ? p[i++] : undefined;
  const sigAlg = raw(p[i++]!);
  const signature = content(p[i++]!);
  const unsignedT = p[i]?.tag === 0xa1 ? p[i] : undefined;
  const cert = findSigner(sd, sid);
  const out: SignerCheck = { cert, hash, keyType: cert?.keyType, signatureOk: false, digestOk: false, essOk: true };
  if (!cert || !hash) return out;
  const docDigest = digest(hash, signedContent);
  if (attrsT) {
    let md: Uint8Array | undefined;
    for (const a of children(attrsT)) {
      const [t, vals] = children(a);
      const type = oidOf(t!);
      const v = children(vals!)[0];
      if (!v) continue;
      if (type === OID.messageDigest) md = content(v);
      else if (type === OID.signingTime) out.signingTime = timeOf(v);
      else if (type === OID.signingCertificateV2 || type === OID.signingCertificate) {
        try {
          const first = children(children(v)[0]!)[0]!;
          const e = children(first);
          const h =
            type === OID.signingCertificate
              ? "SHA-1"
              : e[0]!.tag === 0x30
                ? (hashOfOid(oidOf(children(e[0]!)[0]!)) ?? "SHA-256")
                : "SHA-256";
          const certHash = content(e.find((x) => x.tag === 0x04)!);
          out.essOk = bytesEqual(certHash, digest(h, cert.der));
        } catch {
          out.essOk = false;
        }
      }
    }
    out.digestOk = !!md && bytesEqual(md, docDigest);
    // The signature covers the attributes as a DER SET (tag 0x31).
    const set = new Uint8Array(raw(attrsT));
    set[0] = 0x31;
    out.signatureOk = await verifyRaw(cert, sigAlg, hash, signature, set);
  } else {
    out.digestOk = true;
    out.signatureOk = await verifyRaw(cert, sigAlg, hash, signature, signedContent);
  }
  if (unsignedT) {
    for (const a of children(unsignedT)) {
      const [t, vals] = children(a);
      if (oidOf(t!) !== OID.timeStampToken) continue;
      const token = raw(children(vals!)[0]!);
      const tst = readTimestamp(token);
      if (!tst) continue;
      out.timestamp = tst.time;
      const imprintOk = bytesEqual(tst.imprint, digest(tst.hash ?? "SHA-256", signature));
      let tokenOk = false;
      try {
        const tsd = signedDataOf(token);
        const tcheck = await checkSigner(tsd, tsd.signers[0]!, tsd.eContent ?? new Uint8Array());
        tokenOk = tcheck.signatureOk && tcheck.digestOk;
        out.tsaCert = tcheck.cert;
        out.tsaPool = tsd.certificates;
      } catch {
        tokenOk = false;
      }
      out.timestampOk = imprintOk && tokenOk;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verification: certificate chain
// ---------------------------------------------------------------------------

async function buildChain(
  signer: Certificate,
  pool: Certificate[],
  trusted: Certificate[],
  at: Date,
): Promise<{ trust: Trust; chain: Certificate[]; validAt: boolean }> {
  const chain: Certificate[] = [signer];
  const validIn = (c: Certificate) => c.notBefore.getTime() <= at.getTime() && at.getTime() <= c.notAfter.getTime();
  let validAt = validIn(signer);
  const isTrusted = (c: Certificate) => trusted.some((t) => bytesEqual(t.der, c.der));
  let cur = signer;
  for (let depth = 0; depth < 10; depth++) {
    if (isTrusted(cur)) return { trust: "trusted", chain, validAt };
    const candidates = [...trusted, ...pool].filter((c) => bytesEqual(c.subject, cur.issuer));
    let next: Certificate | undefined;
    for (const c of candidates) {
      if (await verifyRaw(c, cur.sigAlgDer, undefined, cur.signature, cur.tbs)) {
        next = c;
        break;
      }
    }
    if (!next || next === cur || bytesEqual(next.der, cur.der)) break;
    chain.push(next);
    validAt = validAt && validIn(next);
    cur = next;
  }
  if (isTrusted(cur)) return { trust: "trusted", chain, validAt };
  return { trust: selfIssued(signer) ? "selfSigned" : "untrusted", chain, validAt };
}

// ---------------------------------------------------------------------------
// Verification: changes after signing
// ---------------------------------------------------------------------------

// Extensions and Version: a later signer declaring the features it used (ESIC, PDF 2.0).
const ALLOWED_CATALOG_CHANGES = new Set(["/AcroForm", "/DSS", "/Metadata", "/Extensions", "/Version"]);

function dictWithout(d: PDFDict, skip: Set<string>): string {
  const parts: string[] = [];
  for (const [k, v] of d.entries()) if (!skip.has(k.asString())) parts.push(`${k.asString()} ${v.toString()}`);
  return parts.sort().join("\n");
}

function fullName(d: PDFDict): string {
  const parts: string[] = [];
  for (let n: PDFDict | undefined = d, i = 0; n && i < 32; i++) {
    const t = text(n.lookup(PDFName.of("T")));
    if (t !== undefined) parts.unshift(t);
    const p: PDFObject | undefined = n.lookup(PDFName.of("Parent"));
    n = p instanceof PDFDict ? p : undefined;
  }
  return parts.join(".");
}

/** What changed between the signed revision and the final file. */
function diffRevisions(rev: PDFDocument, fin: PDFDocument): { kind: ChangeKind; label: string; field?: string }[] {
  const out: { kind: ChangeKind; label: string; field?: string }[] = [];
  const add = (kind: ChangeKind, label: string, field?: string) => {
    if (!out.some((c) => c.kind === kind && c.label === label)) out.push({ kind, label, field });
  };
  if (rev.getPageCount() !== fin.getPageCount()) add("disallowed", "Pages ajoutées ou supprimées");

  // Objects owned by annotations (appearances, pop-ups) and by the DSS count with them.
  const owner = new Map<string, ChangeKind>();
  const claim = (o: PDFObject | undefined, kind: ChangeKind, depth = 0) => {
    if (!o || depth > 8) return;
    if (o instanceof PDFRef) {
      const k = o.toString();
      if (owner.has(k)) return;
      owner.set(k, kind);
      claim(fin.context.lookup(o), kind, depth + 1);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) claim(v, kind, depth + 1);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) claim(o.get(i), kind, depth + 1);
    } else if (o instanceof PDFStream) {
      claim((o as unknown as { dict: PDFDict }).dict, kind, depth + 1);
    }
  };
  const dss = fin.catalog.get(PDFName.of("DSS"));
  claim(dss, "neutral");
  const info = fin.context.trailerInfo.Info;
  if (info instanceof PDFRef) owner.set(info.toString(), "neutral");
  const acroRef = fin.catalog.get(PDFName.of("AcroForm"));
  if (acroRef instanceof PDFRef) owner.set(acroRef.toString(), "neutral");
  const acro = fin.catalog.lookup(PDFName.of("AcroForm"));
  if (acro instanceof PDFDict) {
    claim(acro.get(PDFName.of("DR")), "neutral");
    const f = acro.get(PDFName.of("Fields"));
    if (f instanceof PDFRef) owner.set(f.toString(), "neutral");
  }
  const kindOfAnnot = (d: PDFDict): ChangeKind => {
    if (d.lookup(PDFName.of("Subtype")) === PDFName.of("Widget") || d.has(PDFName.of("FT")))
      return inheritedFT(d) === "Sig" ? "signature" : "form";
    return "comment";
  };
  for (const p of fin.getPages()) {
    const annots = p.node.get(PDFName.of("Annots"));
    if (annots instanceof PDFRef) owner.set(annots.toString(), "neutral");
    const arr = p.node.lookup(PDFName.of("Annots"));
    if (!(arr instanceof PDFArray)) continue;
    for (let i = 0; i < arr.size(); i++) {
      const r = arr.get(i);
      const d = arr.lookup(i);
      if (!(d instanceof PDFDict)) continue;
      const kind = kindOfAnnot(d);
      for (const key of ["AP", "Popup", "MK"]) claim(d.get(PDFName.of(key)), kind);
      const v = d.get(PDFName.of("V"));
      if (v instanceof PDFRef && kind === "signature") claim(v, "signature");
      if (r instanceof PDFRef && !owner.has(r.toString())) owner.set(r.toString(), kind);
    }
  }
  // Removed annotations and fields.
  rev.getPages().forEach((p, pi) => {
    const before = p.node.lookup(PDFName.of("Annots"));
    const after = fin.getPages()[pi]?.node.lookup(PDFName.of("Annots"));
    if (!(before instanceof PDFArray)) return;
    const kept = new Set<string>();
    if (after instanceof PDFArray) for (let i = 0; i < after.size(); i++) kept.add(String(after.get(i)));
    for (let i = 0; i < before.size(); i++) {
      if (kept.has(String(before.get(i)))) continue;
      const d = before.lookup(i);
      const kind = d instanceof PDFDict ? kindOfAnnot(d) : "comment";
      add(
        kind === "comment" ? "comment" : "disallowed",
        kind === "comment" ? "Commentaire supprimé" : "Champ supprimé",
      );
    }
  });

  const catalogRef = fin.context.trailerInfo.Root;
  const pageRefs = new Set(fin.getPages().map((p) => p.ref.toString()));
  for (const [ref, obj] of fin.context.enumerateIndirectObjects()) {
    const k = ref.toString();
    const old = rev.context.lookup(ref);
    if (old && bytesEqual(serializeObject(old), serializeObject(obj))) continue;
    const isNew = !old;
    if (catalogRef instanceof PDFRef && k === catalogRef.toString()) {
      if (
        old instanceof PDFDict &&
        obj instanceof PDFDict &&
        dictWithout(old, ALLOWED_CATALOG_CHANGES) !== dictWithout(obj, ALLOWED_CATALOG_CHANGES)
      )
        add("disallowed", "Structure du document modifiée");
      continue;
    }
    if (pageRefs.has(k)) {
      if (
        old instanceof PDFDict &&
        obj instanceof PDFDict &&
        dictWithout(old, new Set(["/Annots"])) !== dictWithout(obj, new Set(["/Annots"]))
      )
        add("disallowed", "Contenu d'une page modifié");
      continue;
    }
    const d =
      obj instanceof PDFDict ? obj : obj instanceof PDFStream ? (obj as unknown as { dict: PDFDict }).dict : undefined;
    const claimed = owner.get(k);
    // A signature already made, or its signed field, must never change afterwards.
    if (old instanceof PDFDict && old.has(PDFName.of("ByteRange"))) {
      add("disallowed", "Signature existante modifiée");
      continue;
    }
    if (old instanceof PDFDict && inheritedFT(old) === "Sig" && old.lookup(PDFName.of("V")) instanceof PDFDict) {
      add("disallowed", "Champ de signature signé modifié");
      continue;
    }
    if (d && (d.lookup(PDFName.of("Type")) === PDFName.of("Sig") || d.has(PDFName.of("ByteRange")))) {
      add("signature", "Signature ajoutée");
      continue;
    }
    // A field (a markup annotation's /T is its author, not a field name).
    const subtype = d?.lookup(PDFName.of("Subtype"));
    const isField =
      !!d &&
      obj instanceof PDFDict &&
      (d.has(PDFName.of("FT")) || (d.has(PDFName.of("T")) && (!subtype || subtype === PDFName.of("Widget"))));
    if (isField || claimed === "form" || claimed === "signature") {
      const kind = isField ? (inheritedFT(d!) === "Sig" ? "signature" : "form") : claimed!;
      if (kind === "signature") add("signature", isNew ? "Champ de signature ajouté" : "Signature ajoutée");
      else {
        const name = obj instanceof PDFDict ? fullName(obj) : "";
        add("form", name ? `Champ rempli : ${name}` : "Formulaire rempli", name || undefined);
      }
      continue;
    }
    if (claimed === "comment" || (d && d.lookup(PDFName.of("Type")) === PDFName.of("Annot"))) {
      add("comment", isNew ? "Commentaire ajouté" : "Commentaire modifié");
      continue;
    }
    if (claimed === "neutral") continue;
    if (isNew) continue; // unreferenced from pages: fonts, images of new appearances
    if (d?.lookup(PDFName.of("Type")) === PDFName.of("Metadata")) continue;
    add("disallowed", obj instanceof PDFStream ? "Contenu modifié" : "Objet du document modifié");
  }
  return out;
}

function judge(
  changes: { kind: ChangeKind; label: string; field?: string }[],
  certification: 1 | 2 | 3 | null,
  locks: { action: string; fields: string[]; p?: number }[],
): SignatureChange[] {
  // A field lock's /P (PDF 2.0) restricts like a certification level.
  const level = [certification, ...locks.map((l) => l.p)].reduce<number>(
    (m, p) => (p === 1 || p === 2 || p === 3 ? Math.min(m, p) : m),
    4,
  );
  return changes.map((c) => {
    let kind = c.kind;
    if (kind === "form" || kind === "signature" || kind === "comment") {
      if (level === 1) kind = "disallowed";
      else if (level === 2 && kind === "comment") kind = "disallowed";
      if (kind === "form" && c.field) {
        for (const l of locks) {
          const hit =
            l.action === "All" || (l.action === "Include" ? l.fields.includes(c.field) : !l.fields.includes(c.field));
          if (hit) kind = "disallowed";
        }
      }
    }
    return { kind, label: c.label };
  });
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

interface FoundSig {
  name: string;
  fieldRef?: PDFRef;
  sigRef?: PDFRef;
  /** The signature dictionary; absent when found by scanning a damaged file. */
  sig?: PDFDict;
  range?: number[];
  lock?: { action: string; fields: string[]; p?: number };
}

/** Verify every signature of a PDF. */
export async function verifyPdfSignatures(
  pdfBytes: Uint8Array,
  options: VerifyOptions = {},
): Promise<PadesVerification[]> {
  const bytes = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  let fin: PDFDocument | null = null;
  try {
    fin = await loadPlain(bytes, options.password);
  } catch {
    fin = null;
  }
  const found: FoundSig[] = [];
  if (fin) {
    try {
      for (const f of signatureFields(fin)) {
        const v = f.field.lookup(PDFName.of("V"));
        if (!(v instanceof PDFDict) || !v.has(PDFName.of("ByteRange"))) continue;
        const lk = f.field.lookup(PDFName.of("Lock"));
        found.push({
          name: f.name,
          fieldRef: f.fieldRef,
          sigRef: f.sigRef,
          sig: v,
          lock:
            lk instanceof PDFDict
              ? { ...lockOf(lk), p: (lk.lookup(PDFName.of("P")) as PDFNumber | undefined)?.asNumber?.() }
              : undefined,
        });
      }
    } catch {
      found.length = 0;
    }
  }
  if (!found.length) {
    // A damaged file (or a form pdf-lib cannot walk): signatures found in the bytes.
    const s = u8ToBin(bytes);
    const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
    for (let mm: RegExpExecArray | null, i = 1; (mm = re.exec(s)); i++)
      found.push({ name: `Signature${i}`, range: [+mm[1]!, +mm[2]!, +mm[3]!, +mm[4]!] });
  }
  const trusted: Certificate[] = [];
  for (const der of options.trusted ?? []) {
    try {
      trusted.push(parseCertificate(der));
    } catch {
      /* skip */
    }
  }

  // Signed revisions, in file order.
  const entries = found
    .map((f) => {
      const br = f.sig?.lookup(PDFName.of("ByteRange"));
      const r = f.range ? [...f.range] : [];
      if (!f.range && br instanceof PDFArray)
        r.push(...[0, 1, 2, 3].map((i) => (br.lookup(i) as PDFNumber | undefined)?.asNumber?.() ?? -1));
      return { f, r };
    })
    .filter((e) => e.r.length === 4)
    .sort((a, b) => a.r[2]! + a.r[3]! - (b.r[2]! + b.r[3]!));

  const results: PadesVerification[] = [];
  const revCache = new Map<number, PDFDocument | null>();
  let certification: 1 | 2 | 3 | null = null;
  const activeLocks: { action: string; fields: string[]; p?: number }[] = [];
  for (let idx = 0; idx < entries.length; idx++) {
    const { f, r } = entries[idx]!;
    const [a, b, c, d] = r as [number, number, number, number];
    const whole = a === 0 && c + d === bytes.length;
    // The signed revision: what the signature covers. Its own dictionary, its
    // certification, its locks and its details are read there — a later
    // revision may rewrite them, and that rewrite is a change like any other.
    let rev: PDFDocument | null = whole ? fin : null;
    if (!whole && fin) {
      const end = c + d;
      if (!revCache.has(end)) {
        try {
          revCache.set(end, await loadPlain(bytes.subarray(0, end), options.password));
        } catch {
          revCache.set(end, null);
        }
      }
      rev = revCache.get(end) ?? null;
    }
    let sig = f.sig;
    let fieldLock = f.lock;
    let sigTampered = false;
    if (rev && f.sig) {
      const revField = f.fieldRef ? rev.context.lookup(f.fieldRef) : undefined;
      const fromRev = f.sigRef
        ? rev.context.lookup(f.sigRef)
        : revField instanceof PDFDict
          ? revField.lookup(PDFName.of("V"))
          : undefined;
      const revRange = fromRev instanceof PDFDict ? fromRev.lookup(PDFName.of("ByteRange")) : undefined;
      const sameRange =
        revRange instanceof PDFArray &&
        [0, 1, 2, 3].every((i) => (revRange.lookup(i) as PDFNumber | undefined)?.asNumber?.() === r[i]);
      if (fromRev instanceof PDFDict && sameRange) sig = fromRev;
      else sigTampered = true;
      const lk = revField instanceof PDFDict ? revField.lookup(PDFName.of("Lock")) : undefined;
      fieldLock =
        lk instanceof PDFDict
          ? { ...lockOf(lk), p: (lk.lookup(PDFName.of("P")) as PDFNumber | undefined)?.asNumber?.() }
          : revField instanceof PDFDict
            ? undefined
            : f.lock;
    }
    const out: PadesVerification = {
      fieldName: f.name,
      signerName: text(sig?.lookup(PDFName.of("Name"))) ?? "",
      reason: text(sig?.lookup(PDFName.of("Reason"))),
      location: text(sig?.lookup(PDFName.of("Location"))),
      contactInfo: text(sig?.lookup(PDFName.of("ContactInfo"))),
      timeSource: "none",
      subFilter: (sig?.lookup(PDFName.of("SubFilter")) as PDFName | undefined)?.decodeText?.() ?? "",
      intact: false,
      digestMatches: false,
      coversWholeDocument: whole,
      modifications: "none",
      changes: [],
      valid: false,
      certValidAtSigning: false,
      selfSigned: false,
      trust: "untrusted",
      chainVerified: false,
      timestamped: false,
      revision: idx + 1,
      revisionEnd: c + d,
      chain: [],
    };
    const ref = sig ? referenceOf(sig) : {};
    if (ref.certification) {
      out.certification = ref.certification;
      certification = certification ?? ref.certification;
    }
    const lock = ref.locks ? { ...ref.locks, p: fieldLock?.p } : fieldLock;
    if (lock) out.locks = lock.action === "All" ? ["*"] : lock.fields;
    try {
      if (sigTampered)
        throw new Error("Le dictionnaire de cette signature ne figure pas tel quel dans la version signée.");
      if (a !== 0 || b <= 0 || c <= b || c + d > bytes.length || bytes[b] !== 0x3c || bytes[c - 1] !== 0x3e)
        throw new Error("Plage d'octets signée incohérente.");
      if (/rsa_sha1/.test(out.subFilter)) throw new Error(`Format de signature non pris en charge (${out.subFilter}).`);
      const hexText = u8ToBin(bytes.subarray(b + 1, c - 1)).replace(/[^0-9A-Fa-f]/g, "");
      const der = binToU8(forge.util.hexToBytes(hexText));
      const cms = raw(readTlv(der));
      const sd = signedDataOf(cms);
      const signed = new Uint8Array(b + d);
      signed.set(bytes.subarray(0, b), 0);
      signed.set(bytes.subarray(c, c + d), b);
      // adbe.pkcs7.sha1: the CMS signs the SHA-1 of the range, carried as content.
      let target: Uint8Array = signed;
      if (out.subFilter === "adbe.pkcs7.sha1" && sd.eContent) {
        target = sd.eContent;
        if (!bytesEqual(sd.eContent, sha1(signed))) throw new Error("Empreinte SHA-1 différente.");
      }
      const check = await checkSigner(sd, sd.signers[0]!, target);
      out.hash = check.hash;
      out.keyType = check.keyType;
      out.digestMatches = check.digestOk;
      out.intact = check.signatureOk && check.digestOk && check.essOk;
      if (!check.cert) throw new Error("Certificat du signataire absent de la signature.");
      out.signerName = check.cert.commonName || out.signerName;
      out.certificate = certInfo(check.cert);
      out.selfSigned = selfIssued(check.cert);
      const claimed = check.signingTime ?? parsePdfDate(text(sig?.lookup(PDFName.of("M"))));
      // A timestamp proves the time only when its authority is trusted too.
      let tsaTrusted = false;
      if (check.timestamp && check.timestampOk && check.tsaCert) {
        const tsaChain = await buildChain(check.tsaCert, check.tsaPool ?? [], trusted, check.timestamp);
        tsaTrusted = tsaChain.trust === "trusted" && tsaChain.validAt;
      }
      out.timestampTrusted = tsaTrusted;
      const at = tsaTrusted ? check.timestamp : claimed;
      out.timestamped = !!check.timestamp && !!check.timestampOk;
      out.timeSource = tsaTrusted ? "timestamp" : at ? "signer" : "none";
      if (out.timestamped && !tsaTrusted) out.timestampAt = check.timestamp!.toISOString();
      if (at) out.signedAt = at.toISOString();
      const chain = await buildChain(check.cert, sd.certificates, trusted, at ?? new Date());
      out.trust = chain.trust;
      out.chainVerified = chain.trust === "trusted";
      out.chain = chain.chain.map(certInfo);
      out.certValidAtSigning = chain.validAt;
      if (check.timestamp && !check.timestampOk) out.error = "Horodatage invalide.";
    } catch (e) {
      out.error = e instanceof Error ? e.message : String(e);
    }

    // Changes after this signature.
    if (!out.coversWholeDocument && fin) {
      const raw = rev ? diffRevisions(rev, fin) : [{ kind: "disallowed" as const, label: "Révision signée illisible" }];
      // A later signature's own field counts as the signature it is.
      const locks = [...activeLocks, ...(lock ? [lock] : [])];
      out.changes = judge(raw, certification, locks).filter((ch) => ch.kind !== "neutral");
      out.modifications = out.changes.some((ch) => ch.kind === "disallowed")
        ? "disallowed"
        : out.changes.length
          ? "allowed"
          : "none";
    }
    if (lock) activeLocks.push(lock);
    out.valid = out.intact && out.certValidAtSigning && out.modifications !== "disallowed" && !out.error;
    results.push(out);
  }
  return results;
}

/** The bytes of the signed version (Acrobat's « Afficher la version signée »). */
export function signedVersion(bytes: Uint8Array, v: Pick<PadesVerification, "revisionEnd">): Uint8Array {
  return bytes.slice(0, v.revisionEnd);
}
