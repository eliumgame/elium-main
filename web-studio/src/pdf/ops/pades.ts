/**
 * PAdES-B — signature électronique PDF fondée sur un certificat X.509 (CMS/CAdES
 * détaché), en complément du sceau Ed25519 propre au format .elium.
 *
 * Méthode « placeholder + splice » (celle de @signpdf, éprouvée) — PAS de
 * ré-écriture d'xref à la main :
 *   1. on ajoute au document un dictionnaire de signature avec un /ByteRange et
 *      un /Contents de taille FIXE réservée (via l'API bas-niveau pdf-lib) ;
 *   2. on sérialise SANS object-streams pour que /Contents figure tel quel dans
 *      les octets ;
 *   3. on calcule le vrai /ByteRange, on hache les octets couverts (SHA-256), on
 *      construit un CMS SignedData détaché (node-forge) signé par la clé du
 *      PKCS#12, et on injecte le DER hex dans le trou /Contents — aucun décalage
 *      d'offset (réécriture à longueur constante).
 *
 * Portée : PAdES-B « technique » — signature CMS valide (contentType +
 * messageDigest + signingTime), SubFilter ETSI.CAdES.detached, vérifiable dans
 * un lecteur PDF. Ce n'est PAS une signature qualifiée eIDAS, et il n'y a ni
 * horodatage RFC-3161 (LTV) ni attribut signing-certificate-v2 (PAdES-B-B strict)
 * pour l'instant — évolutions futures. Flux MONO-signature (une signature par
 * document) : re-signer un PDF déjà signé via de vraies màj incrémentales est une
 * étape ultérieure.
 */
import { PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString, PDFArray, PDFDict } from "pdf-lib";
import forge from "node-forge";
import { sha256 } from "@noble/hashes/sha2.js";

/** Octets réservés pour /Contents (le DER CMS y est injecté puis complété de 0). */
const RESERVED_SIG_BYTES = 16384;

export interface PadesSignOptions {
  reason?: string;
  location?: string;
  contactInfo?: string;
  signerName?: string;
  fieldName?: string;
}

export interface PadesVerification {
  fieldName: string;
  signerName: string;
  reason?: string;
  signedAt?: string;
  valid: boolean;
  coversWholeDocument: boolean;
  digestMatches: boolean;
  error?: string;
}

// --- petits ponts Uint8Array <-> chaîne binaire (latin1) --------------------
function u8ToBin(u: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u.length; i += CHUNK) s += String.fromCharCode(...u.subarray(i, i + CHUNK));
  return s;
}
function writeAscii(buf: Uint8Array, at: number, text: string): void {
  for (let i = 0; i < text.length; i++) buf[at + i] = text.charCodeAt(i) & 0xff;
}
/** Découpe une chaîne binaire DER à la longueur réelle de sa 1re valeur ASN.1
 *  (SEQUENCE en tête), pour ignorer un éventuel padding de 0 en fin. */
function trimDer(bin: string): string {
  if (bin.length < 2) return bin;
  const lenByte = bin.charCodeAt(1);
  if (lenByte < 0x80) return bin.slice(0, 2 + lenByte);
  const n = lenByte & 0x7f;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + bin.charCodeAt(2 + i);
  return bin.slice(0, 2 + n + len);
}

function pdfDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

// --- PKCS#12 : extraire la clé du signataire + son certificat (+ chaîne) -----
interface SignerMaterial {
  key: forge.pki.PrivateKey;
  cert: forge.pki.Certificate;
  chain: forge.pki.Certificate[];
}
function loadPkcs12(p12Bytes: Uint8Array, password: string): SignerMaterial {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(u8ToBin(p12Bytes)));
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  // Clé privée (shroudée ou en clair).
  const keyBags = {
    ...p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag }),
    ...p12.getBags({ bagType: forge.pki.oids.keyBag }),
  };
  let key: forge.pki.PrivateKey | undefined;
  for (const k of Object.keys(keyBags)) {
    const bag = (keyBags as Record<string, forge.pkcs12.Bag[]>)[k]?.[0];
    if (bag?.key) { key = bag.key; break; }
  }
  if (!key) throw new Error("PKCS#12 : clé privée introuvable (mot de passe correct ?).");
  // Certificats.
  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
  const certs: forge.pki.Certificate[] = [];
  for (const k of Object.keys(certBags)) {
    for (const bag of certBags[k] ?? []) if (bag.cert) certs.push(bag.cert);
  }
  if (certs.length === 0) throw new Error("PKCS#12 : aucun certificat.");
  // Le certificat du signataire = celui dont la clé publique correspond à la clé privée.
  const rsaKey = key as forge.pki.rsa.PrivateKey;
  const signer = certs.find((c) => {
    const pub = c.publicKey as forge.pki.rsa.PublicKey;
    return pub.n && rsaKey.n && pub.n.compareTo(rsaKey.n) === 0;
  }) ?? certs[0]!;
  const chain = certs.filter((c) => c !== signer);
  return { key, cert: signer, chain };
}

function certCommonName(cert: forge.pki.Certificate): string {
  const cn = cert.subject.getField("CN");
  return (cn && cn.value) || "Signataire";
}

/** Ajoute le dictionnaire de signature + le widget + l'AcroForm (placeholder). */
function addSignaturePlaceholder(pdfDoc: PDFDocument, opts: PadesSignOptions): void {
  const ctx = pdfDoc.context;
  const fieldName = opts.fieldName || "Signature1";

  const byteRange = PDFArray.withContext(ctx);
  byteRange.push(PDFNumber.of(0));
  byteRange.push(PDFName.of("**********"));
  byteRange.push(PDFName.of("**********"));
  byteRange.push(PDFName.of("**********"));

  const contents = PDFHexString.of("0".repeat(RESERVED_SIG_BYTES * 2));

  const sigDict = ctx.obj({
    Type: PDFName.of("Sig"),
    Filter: PDFName.of("Adobe.PPKLite"),
    SubFilter: PDFName.of("ETSI.CAdES.detached"),
    ByteRange: byteRange,
    Contents: contents,
    M: PDFString.of(pdfDate(new Date())),
  });
  if (opts.reason) sigDict.set(PDFName.of("Reason"), PDFString.of(opts.reason));
  if (opts.location) sigDict.set(PDFName.of("Location"), PDFString.of(opts.location));
  if (opts.contactInfo) sigDict.set(PDFName.of("ContactInfo"), PDFString.of(opts.contactInfo));
  if (opts.signerName) sigDict.set(PDFName.of("Name"), PDFString.of(opts.signerName));
  const sigRef = ctx.register(sigDict);

  const page = pdfDoc.getPage(0);
  const widget = ctx.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Widget"),
    FT: PDFName.of("Sig"),
    Rect: ctx.obj([0, 0, 0, 0]),
    V: sigRef,
    T: PDFString.of(fieldName),
    F: PDFNumber.of(132), // Print + Locked, invisible (Rect nul)
    P: page.ref,
  });
  const widgetRef = ctx.register(widget);

  const annotsRaw = page.node.lookup(PDFName.of("Annots"));
  let annots = annotsRaw instanceof PDFArray ? annotsRaw : undefined;
  if (!annots) { annots = PDFArray.withContext(ctx); page.node.set(PDFName.of("Annots"), annots); }
  annots.push(widgetRef);

  const acroRaw = pdfDoc.catalog.lookup(PDFName.of("AcroForm"));
  let acro = acroRaw instanceof PDFDict ? acroRaw : undefined;
  if (!acro) {
    acro = ctx.obj({ Fields: ctx.obj([]), SigFlags: PDFNumber.of(3) }) as PDFDict;
    pdfDoc.catalog.set(PDFName.of("AcroForm"), ctx.register(acro));
  } else {
    acro.set(PDFName.of("SigFlags"), PDFNumber.of(3));
  }
  const fieldsRaw = acro.lookup(PDFName.of("Fields"));
  let fields = fieldsRaw instanceof PDFArray ? fieldsRaw : undefined;
  if (!fields) { fields = PDFArray.withContext(ctx); acro.set(PDFName.of("Fields"), fields); }
  fields.push(widgetRef);
}

/** Construit le CMS SignedData détaché (chaîne binaire DER) sur `content`. */
function buildCmsDer(content: Uint8Array, m: SignerMaterial): string {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(u8ToBin(content));
  p7.addCertificate(m.cert);
  for (const c of m.chain) p7.addCertificate(c);
  p7.addSigner({
    key: m.key as forge.pki.rsa.PrivateKey,
    certificate: m.cert,
    digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
      { type: forge.pki.oids.messageDigest }, // calculé automatiquement à partir du contenu
      { type: forge.pki.oids.signingTime, value: new Date() as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  return forge.asn1.toDer(p7.toAsn1()).getBytes();
}

/**
 * Signe des octets PDF finaux avec un PKCS#12 et renvoie le PDF signé (PAdES-B).
 */
export async function signPdfBytes(
  finalPdfBytes: Uint8Array,
  p12Bytes: Uint8Array,
  password: string,
  opts: PadesSignOptions = {},
): Promise<Uint8Array> {
  const material = loadPkcs12(p12Bytes, password);
  const pdfDoc = await PDFDocument.load(finalPdfBytes, { updateMetadata: false });
  addSignaturePlaceholder(pdfDoc, { ...opts, signerName: opts.signerName || certCommonName(material.cert) });
  const withPlaceholder = await pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });

  const buf = new Uint8Array(withPlaceholder); // copie mutable
  const s = u8ToBin(buf);

  const brIdx = s.indexOf("/ByteRange");
  if (brIdx < 0) throw new Error("Placeholder /ByteRange introuvable.");
  const brOpen = s.indexOf("[", brIdx);
  const brClose = s.indexOf("]", brOpen);
  const cIdx = s.indexOf("/Contents", brClose);
  const ltIdx = s.indexOf("<", cIdx);
  const gtIdx = s.indexOf(">", ltIdx);
  if (brOpen < 0 || brClose < 0 || ltIdx < 0 || gtIdx < 0) throw new Error("Placeholder de signature mal formé.");

  const contentsStart = ltIdx; // offset du '<'
  const contentsEnd = gtIdx + 1; // offset juste après '>'
  const byteRange = [0, contentsStart, contentsEnd, buf.length - contentsEnd];

  const innerOrig = s.slice(brOpen + 1, brClose);
  let innerNew = ` ${byteRange[0]} ${byteRange[1]} ${byteRange[2]} ${byteRange[3]} `;
  if (innerNew.length > innerOrig.length) throw new Error("Placeholder /ByteRange trop court.");
  innerNew = innerNew.padEnd(innerOrig.length, " ");
  writeAscii(buf, brOpen + 1, innerNew);

  // Contenu couvert = tout sauf le trou <...>.
  const seg = new Uint8Array(contentsStart + (buf.length - contentsEnd));
  seg.set(buf.subarray(0, contentsStart), 0);
  seg.set(buf.subarray(contentsEnd), contentsStart);

  const der = buildCmsDer(seg, material);
  const hex = forge.util.bytesToHex(der).toUpperCase();
  const holeHexLen = gtIdx - (ltIdx + 1);
  if (hex.length > holeHexLen) throw new Error("Signature trop volumineuse pour l'espace /Contents réservé.");
  writeAscii(buf, ltIdx + 1, hex.padEnd(holeHexLen, "0"));

  return buf;
}

// --- Vérification ------------------------------------------------------------

function verifyOne(buf: Uint8Array, s: string, brMatch: RegExpExecArray): PadesVerification {
  const out: PadesVerification = {
    fieldName: "", signerName: "", valid: false, coversWholeDocument: false, digestMatches: false,
  };
  try {
    const a = parseInt(brMatch[1]!, 10), b = parseInt(brMatch[2]!, 10), c = parseInt(brMatch[3]!, 10), d = parseInt(brMatch[4]!, 10);
    // /Contents hex entre b ('<') et c ('>' + 1) : le hex est [b+1, c-1).
    const hex = s.slice(b + 1, c - 1).replace(/[^0-9A-Fa-f]/g, "");
    // Le trou /Contents est complété de 0 : on découpe le DER à sa longueur
    // réelle (en-tête SEQUENCE) avant de parser, sinon forge rejette le padding.
    const der = trimDer(forge.util.hexToBytes(hex));
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(der));
    const p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData & {
      rawCapture: { authenticatedAttributes?: forge.asn1.Asn1[]; signature: string };
    };

    const signerCert = (p7.certificates && p7.certificates[0]) as forge.pki.Certificate | undefined;
    if (signerCert) {
      out.signerName = certCommonName(signerCert);
    }

    // Contenu couvert reconstruit à partir du ByteRange : [a, a+b) puis [c, c+d).
    const seg1 = buf.subarray(a, a + b);
    const seg2 = buf.subarray(c, c + d);
    const content = new Uint8Array(seg1.length + seg2.length);
    content.set(seg1, 0); content.set(seg2, seg1.length);
    const recomputed = sha256(content);
    out.coversWholeDocument = a === 0 && c + d === buf.length;

    // messageDigest signé.
    const attrs = p7.rawCapture.authenticatedAttributes ?? [];
    let signedDigestHex = "";
    let signingTime = "";
    for (const attr of attrs) {
      const oid = forge.asn1.derToOid((attr.value as forge.asn1.Asn1[])[0]!.value as string);
      const val = (attr.value as forge.asn1.Asn1[])[1] as forge.asn1.Asn1; // SET OF -> [value]
      const inner = (val.value as forge.asn1.Asn1[])[0];
      if (oid === forge.pki.oids.messageDigest && inner) {
        signedDigestHex = forge.util.bytesToHex(inner.value as string);
      } else if (oid === forge.pki.oids.signingTime && inner) {
        signingTime = String(inner.value);
      }
    }
    const recomputedHex = forge.util.bytesToHex(u8ToBin(recomputed));
    out.digestMatches = !!signedDigestHex && signedDigestHex.toLowerCase() === recomputedHex.toLowerCase();
    if (signingTime) out.signedAt = signingTime;

    // Vérifie la signature sur les attributs signés (ré-encodés en SET OF).
    let sigValid = false;
    if (signerCert && attrs.length) {
      const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
      const derAttrs = forge.asn1.toDer(set).getBytes();
      const md = forge.md.sha256.create();
      md.update(derAttrs);
      const pub = signerCert.publicKey as forge.pki.rsa.PublicKey;
      try { sigValid = pub.verify(md.digest().getBytes(), p7.rawCapture.signature); } catch { sigValid = false; }
    }
    out.valid = sigValid && out.digestMatches;
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

/** Vérifie toutes les signatures PAdES d'un PDF. */
export function verifyPdfSignatures(pdfBytes: Uint8Array): PadesVerification[] {
  const buf = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);
  const s = u8ToBin(buf);
  const results: PadesVerification[] = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(s))) {
    const v = verifyOne(buf, s, m);
    if (!v.fieldName) v.fieldName = `Signature${++i}`;
    results.push(v);
  }
  return results;
}
