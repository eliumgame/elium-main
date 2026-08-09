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
  /**
   * Rend la signature VISIBLE à un emplacement (au lieu d'un champ invisible) :
   * un widget /Sig au rectangle donné, avec le PNG comme apparence /AP — c'est
   * ce qu'Adobe affiche comme « signature » là où l'utilisateur l'a placée.
   * `rect` est en ESPACE PAGE du modèle (origine haut-gauche, y vers le bas) sur
   * la page `page` (0-based) ; la conversion en points PDF utilise la mediaBox.
   */
  visible?: { page: number; rect: { x: number; y: number; w: number; h: number }; imagePng?: Uint8Array };
  /** URL d'une autorité d'horodatage RFC-3161 (TSA). Si fournie, un horodatage
   *  de confiance est ajouté (best-effort : ignoré si la TSA est injoignable). */
  tsaUrl?: string;
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
async function addSignaturePlaceholder(pdfDoc: PDFDocument, opts: PadesSignOptions): Promise<void> {
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

  // Signature VISIBLE (widget au rectangle placé, apparence = le dessin) ou
  // INVISIBLE (champ Rect nul, comportement historique).
  const v = opts.visible;
  const pageCount = pdfDoc.getPageCount();
  const pageIndex = v ? Math.min(Math.max(0, v.page), pageCount - 1) : 0;
  const page = pdfDoc.getPage(pageIndex);
  // Page space (haut-gauche, y bas) → points PDF (bas-gauche) via la mediaBox.
  let rect: [number, number, number, number] = [0, 0, 0, 0];
  if (v) {
    const box = page.getMediaBox();
    const x1 = box.x + v.rect.x;
    const y1 = box.y + box.height - v.rect.y - v.rect.h;
    rect = [x1, y1, x1 + v.rect.w, y1 + v.rect.h];
  }

  // Apparence /AP : un form XObject dessinant le PNG dans le rectangle.
  let apRef: ReturnType<typeof ctx.register> | undefined;
  if (v?.imagePng) {
    const img = await pdfDoc.embedPng(v.imagePng);
    const w = Math.max(1, rect[2] - rect[0]);
    const h = Math.max(1, rect[3] - rect[1]);
    const apDict = ctx.obj({
      Type: PDFName.of("XObject"),
      Subtype: PDFName.of("Form"),
      FormType: PDFNumber.of(1),
      BBox: ctx.obj([0, 0, w, h]),
      Matrix: ctx.obj([1, 0, 0, 1, 0, 0]),
      Resources: ctx.obj({ XObject: ctx.obj({ Im0: img.ref }) }),
    });
    apRef = ctx.register(ctx.stream(`q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`, apDict as never));
  }

  const widget = ctx.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Widget"),
    FT: PDFName.of("Sig"),
    Rect: ctx.obj(rect),
    V: sigRef,
    T: PDFString.of(fieldName),
    F: PDFNumber.of(v ? 4 : 132), // visible: Print ; invisible: Print + Locked (Rect nul)
    P: page.ref,
    ...(apRef ? { AP: ctx.obj({ N: apRef }) } : {}),
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

// --- CMS SignedData construit à la main (pour l'attribut signé ESS
// signing-certificate-v2, que node-forge ne sait pas encoder) + horodatage
// RFC-3161 optionnel (attribut NON signé). Vérifié par verifyOne ci-dessous. ---

const OID_SIGNING_CERT_V2 = "1.2.840.113549.1.9.16.2.47"; // id-aa-signingCertificateV2
const OID_TIMESTAMP_TOKEN = "1.2.840.113549.1.9.16.2.14"; // id-aa-timeStampToken

const A = forge.asn1;
const _oid = (s: string) => A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer(s).getBytes());
const _octet = (bytes: string) => A.create(A.Class.UNIVERSAL, A.Type.OCTETSTRING, false, bytes);
const _seq = (items: forge.asn1.Asn1[]) => A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, items);
const _set = (items: forge.asn1.Asn1[]) => A.create(A.Class.UNIVERSAL, A.Type.SET, true, items);
const _int = (n: number) => A.create(A.Class.UNIVERSAL, A.Type.INTEGER, false, A.integerToDer(n).getBytes());
const _null = () => A.create(A.Class.UNIVERSAL, A.Type.NULL, false, "");
const _algSha256 = () => _seq([_oid(forge.pki.oids.sha256), _null()]);
const _algRsa = () => _seq([_oid(forge.pki.oids.rsaEncryption), _null()]);
/** Attribute ::= SEQ { type OID, values SET OF value }. */
const _attr = (typeOid: string, value: forge.asn1.Asn1) => _seq([_oid(typeOid), _set([value])]);
const _ctx = (tag: number, items: forge.asn1.Asn1[]) => A.create(A.Class.CONTEXT_SPECIFIC, tag, true, items);

function binToU8(s: string): Uint8Array {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
}

/**
 * Horodatage RFC-3161 : interroge une TSA sur sha256(signatureValue) et renvoie
 * le TimeStampToken (ContentInfo ASN.1) à placer en attribut NON signé, ou null
 * en cas d'échec (best-effort — la signature reste valide sans horodatage).
 */
async function requestTimestampToken(tsaUrl: string, signatureValue: string): Promise<forge.asn1.Asn1 | null> {
  try {
    const md = forge.md.sha256.create();
    md.update(signatureValue);
    const req = _seq([
      _int(1), // version
      _seq([_seq([_oid(forge.pki.oids.sha256), _null()]), _octet(md.digest().getBytes())]), // messageImprint
      A.create(A.Class.UNIVERSAL, A.Type.BOOLEAN, false, String.fromCharCode(0xff)), // certReq TRUE
    ]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let respBytes: Uint8Array;
    try {
      const resp = await fetch(tsaUrl, {
        method: "POST",
        headers: { "Content-Type": "application/timestamp-query" },
        body: binToU8(A.toDer(req).getBytes()) as unknown as BodyInit,
        signal: controller.signal,
      });
      if (!resp.ok) return null;
      respBytes = new Uint8Array(await resp.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
    // TimeStampResp ::= SEQ { status PKIStatusInfo, timeStampToken ContentInfo OPTIONAL }
    const respAsn1 = A.fromDer(forge.util.createBuffer(u8ToBin(respBytes)));
    const parts = respAsn1.value as forge.asn1.Asn1[];
    // status PKIStatus 0=granted, 1=grantedWithMods ; le token est le 2e élément.
    const status = parts?.[0]?.value ? (parts[0].value as forge.asn1.Asn1[])[0] : undefined;
    const code = status ? A.derToInteger(status.value as string) : 0;
    if (code !== 0 && code !== 1) return null;
    return parts.length >= 2 ? parts[1]! : null;
  } catch {
    return null;
  }
}

/**
 * Construit le CMS SignedData détaché (chaîne binaire DER) sur `content`, avec
 * les attributs signés contentType + signingTime + messageDigest +
 * signing-certificate-v2 (ESS, PAdES-B-B), et optionnellement un horodatage
 * RFC-3161 (attribut non signé). Construit main pour couvrir signingCertV2.
 */
async function buildCmsDer(content: Uint8Array, m: SignerMaterial, tsaUrl?: string): Promise<string> {
  const contentMd = forge.md.sha256.create();
  contentMd.update(u8ToBin(content));
  const messageDigest = contentMd.digest().getBytes();

  const certAsn1 = forge.pki.certificateToAsn1(m.cert);
  const certHashMd = forge.md.sha256.create();
  certHashMd.update(A.toDer(certAsn1).getBytes());
  // ESSCertIDv2 ::= SEQ { certHash } (hashAlgorithm omis = SHA-256 par défaut, DER).
  const signingCertV2 = _seq([_seq([_seq([_octet(certHashMd.digest().getBytes())])])]);

  // Ordre fixe des attributs signés (identique à la re-vérification de verifyOne).
  const signedAttrs = [
    _attr(forge.pki.oids.contentType, _oid(forge.pki.oids.data)),
    _attr(forge.pki.oids.signingTime, A.create(A.Class.UNIVERSAL, A.Type.UTCTIME, false, A.dateToUtcTime(new Date()))),
    _attr(forge.pki.oids.messageDigest, _octet(messageDigest)),
    _attr(OID_SIGNING_CERT_V2, signingCertV2),
  ];
  // La signature couvre le DER des attributs avec le tag SET OF explicite (0x31),
  // et non le tag [0] IMPLICIT du SignerInfo (règle CMS).
  const attrsDer = A.toDer(_set(signedAttrs)).getBytes();
  const sigMd = forge.md.sha256.create();
  sigMd.update(attrsDer);
  const signatureValue = (m.key as forge.pki.rsa.PrivateKey).sign(sigMd);

  // Horodatage RFC-3161 optionnel (best-effort) → attribut NON signé.
  let unsignedAttrs: forge.asn1.Asn1[] | null = null;
  if (tsaUrl) {
    const token = await requestTimestampToken(tsaUrl, signatureValue);
    if (token) unsignedAttrs = [_attr(OID_TIMESTAMP_TOKEN, token)];
  }

  // issuerAndSerialNumber depuis l'ASN.1 du certificat (tbs: [ [0]ver, serial, sigAlg, issuer, … ]).
  const tbsVals = (certAsn1.value as forge.asn1.Asn1[])[0]!.value as forge.asn1.Asn1[];
  const hasVersion = tbsVals[0]!.tagClass === A.Class.CONTEXT_SPECIFIC;
  const serialNode = hasVersion ? tbsVals[1]! : tbsVals[0]!;
  const issuerNode = hasVersion ? tbsVals[3]! : tbsVals[2]!;

  const signerInfoItems: forge.asn1.Asn1[] = [
    _int(1), // version (issuerAndSerialNumber ⇒ v1)
    _seq([issuerNode, serialNode]), // issuerAndSerialNumber
    _algSha256(), // digestAlgorithm
    _ctx(0, signedAttrs), // [0] IMPLICIT signedAttrs
    _algRsa(), // signatureAlgorithm
    _octet(signatureValue),
  ];
  if (unsignedAttrs) signerInfoItems.push(_ctx(1, unsignedAttrs)); // [1] IMPLICIT unsignedAttrs
  const signerInfo = _seq(signerInfoItems);

  const certNodes = [certAsn1, ...m.chain.map((c) => forge.pki.certificateToAsn1(c))];
  const signedData = _seq([
    _int(1), // version
    _set([_algSha256()]), // digestAlgorithms
    _seq([_oid(forge.pki.oids.data)]), // encapContentInfo (détaché)
    _ctx(0, certNodes), // certificates [0] IMPLICIT
    _set([signerInfo]),
  ]);
  const contentInfo = _seq([_oid(forge.pki.oids.signedData), _ctx(0, [signedData])]);
  return A.toDer(contentInfo).getBytes();
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
  await addSignaturePlaceholder(pdfDoc, { ...opts, signerName: opts.signerName || certCommonName(material.cert) });
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

  const der = await buildCmsDer(seg, material, opts.tsaUrl);
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
