/**
 * PAdES-B — signature électronique PDF fondée sur un certificat X.509 (CMS/CAdES
 * détaché), en complément du sceau Ed25519 propre au format .elium.
 *
 * Méthode « placeholder + splice » (celle de @signpdf, éprouvée) — PAS de
 * ré-écriture d'xref à la main :
 *   1. on ajoute au document un dictionnaire de signature avec un /ByteRange et
 *      un /Contents de taille réservée par un dry-run du CMS pour CE certificat
 *      (voir `estimateReservedSigBytes`), pas une constante figée (via l'API
 *      bas-niveau pdf-lib) ;
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
import { PDFDocument, PDFName, PDFNumber, PDFString, PDFHexString, PDFArray, PDFDict, PDFRef } from "pdf-lib";
import type { PDFPage } from "pdf-lib";
import forge from "node-forge";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * Octets réservés pour /Contents (le DER CMS y est injecté puis complété de 0).
 * Repli si l'estimation dry-run (voir `estimateReservedSigBytes`) échoue ou
 * produit une valeur aberrante — une chaîne de certification très courte peut
 * tenir dans beaucoup moins, une très longue en demander bien plus : la
 * réservation réelle est calculée par signature, pas figée ici.
 */
const DEFAULT_RESERVED_SIG_BYTES = 16384;
/** Marge multiplicative appliquée à la taille CMS estimée par dry-run. */
const SIG_SIZE_MARGIN_FACTOR = 1.5;
/** Marge additive (encodage ASN.1, alignement) appliquée en plus de la marge multiplicative. */
const SIG_SIZE_MARGIN_BYTES = 2048;

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
}

export interface PadesVerification {
  fieldName: string;
  signerName: string;
  reason?: string;
  signedAt?: string;
  valid: boolean;
  coversWholeDocument: boolean;
  digestMatches: boolean;
  /** Le certificat du signataire est temporellement valide (fenêtre notBefore/notAfter). */
  certValidAtSigning: boolean;
  /** Certificat auto-signé (émetteur = sujet) → Adobe affichera « identité non vérifiée ». */
  selfSigned: boolean;
  /**
   * La chaîne de certificats EMBARQUÉE est cohérente et s'ancre sur un certificat
   * présent dans le CMS (best-effort : sans magasin de confiance système, cela
   * n'établit PAS la confiance, seulement la cohérence interne de la chaîne).
   */
  chainVerified: boolean;
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
    if (bag?.key) {
      key = bag.key;
      break;
    }
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
  const signer =
    certs.find((c) => {
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

/** Chaîne canonique d'un DN X.509 (pour comparer sujet et émetteur). */
function dnString(entity: forge.pki.Certificate["subject"]): string {
  return entity.attributes.map((a) => `${a.shortName ?? a.type}=${a.value}`).join(",");
}

/** Le certificat est-il dans sa fenêtre de validité à l'instant `at` ? */
function certValidAt(cert: forge.pki.Certificate, at: Date): boolean {
  const t = at.getTime();
  return cert.validity.notBefore.getTime() <= t && t <= cert.validity.notAfter.getTime();
}

/**
 * Cohérence interne de la chaîne : chaque certificat est signé par le suivant,
 * jusqu'à un ancre auto-signé PRÉSENT dans le CMS, et tous sont temporellement
 * valides. best-effort via node-forge — un échec (ancre absente, signature ou
 * dates invalides, quirk forge) renvoie simplement false, jamais d'exception.
 * N'établit PAS la confiance (pas de magasin racine système).
 */
function chainIsConsistent(certs: forge.pki.Certificate[], signer: forge.pki.Certificate): boolean {
  try {
    const caStore = forge.pki.createCaStore(certs);
    return forge.pki.verifyCertificateChain(caStore, [signer]) === true;
  } catch {
    return false;
  }
}

interface ExistingSignatureWidget {
  /** The widget's own dict — mutated in place (V/AP) rather than replaced. */
  dict: PDFDict;
  page: PDFPage;
  /** Its own /Rect — the placement chosen when the field was prepared. */
  rect: [number, number, number, number];
}

interface SignatureWidgetInfo extends ExistingSignatureWidget {
  name: string;
  /** 0-based index into `pdfDoc.getPages()` — cheaper to compare than the page object itself. */
  pageIndex: number;
}

/**
 * Enumerate every top-level `/FT /Sig` field already sitting in the AcroForm —
 * the bare, valueless widgets "Prepare form" (`ops/forms.ts::addSignatureField`)
 * drops onto the page, named by the user, well before anyone actually signs.
 * Only scans the flat `/Fields` array (never `/Kids`): every widget this
 * module or `ops/forms.ts` ever creates is a single merged field+widget dict
 * registered directly at that level, so a hierarchical lookup is not needed
 * for fields of our own making.
 */
function listSignatureWidgets(pdfDoc: PDFDocument): SignatureWidgetInfo[] {
  const acroRaw = pdfDoc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acroRaw instanceof PDFDict)) return [];
  const fieldsRaw = acroRaw.lookup(PDFName.of("Fields"));
  if (!(fieldsRaw instanceof PDFArray)) return [];

  const pages = pdfDoc.getPages();
  const out: SignatureWidgetInfo[] = [];
  for (let i = 0; i < fieldsRaw.size(); i++) {
    let dict: PDFDict;
    try {
      dict = fieldsRaw.lookup(i, PDFDict);
    } catch {
      continue;
    }
    if (dict.lookupMaybe(PDFName.of("FT"), PDFName) !== PDFName.of("Sig")) continue;
    const t = dict.lookupMaybe(PDFName.of("T"), PDFString, PDFHexString);
    const rectArr = dict.lookupMaybe(PDFName.of("Rect"), PDFArray);
    const pageRef = dict.get(PDFName.of("P"));
    const pageIndex = pageRef instanceof PDFRef ? pages.findIndex((p) => p.ref === pageRef) : -1;
    if (!t || !rectArr || rectArr.size() !== 4 || pageIndex < 0) continue;
    const r = rectArr.asRectangle();
    out.push({
      dict,
      page: pages[pageIndex]!,
      pageIndex,
      name: t.decodeText(),
      rect: [r.x, r.y, r.x + r.width, r.y + r.height],
    });
  }
  return out;
}

/** Look for a prepared `/FT /Sig` field by its exact name (see `listSignatureWidgets`). */
function findExistingSignatureWidget(pdfDoc: PDFDocument, fieldName: string): ExistingSignatureWidget | undefined {
  return listSignatureWidgets(pdfDoc).find((w) => w.name === fieldName);
}

/**
 * When the caller does not pin an exact `fieldName` (both call sites in
 * `PdfWorkspace.tsx` never do — see the commit that introduced this function),
 * decide which already-prepared `/FT /Sig` field the signature-in-progress
 * should actually land on, instead of blindly defaulting to "Signature1" and
 * leaving a same-named prepared field untouched next to a brand-new one:
 *  - no prepared field at all -> undefined (caller keeps the "Signature1" default).
 *  - exactly one -> that one, unambiguous regardless of where it sits.
 *  - several -> the one on the SAME page as the visible signature stamp
 *    (`visibleSigTarget()` in the UI) whose /Rect centre is nearest to it.
 *    A genuine tie (two equally-close candidates, or no visible stamp to
 *    compare against at all) is NOT guessed at: undefined is returned and the
 *    caller falls back to the default name rather than stapling the signature
 *    to an arbitrarily-picked field on a multi-signer document.
 */
function pickPreparedFieldName(pdfDoc: PDFDocument, visible: PadesSignOptions["visible"]): string | undefined {
  const widgets = listSignatureWidgets(pdfDoc);
  if (widgets.length === 0) return undefined;
  if (widgets.length === 1) return widgets[0]!.name;
  if (!visible) return undefined; // several candidates, nothing to disambiguate against

  const pageIndex = Math.min(Math.max(0, visible.page), pdfDoc.getPageCount() - 1);
  const samePage = widgets.filter((w) => w.pageIndex === pageIndex);
  if (samePage.length === 0) return undefined;
  if (samePage.length === 1) return samePage[0]!.name;

  // Page-space (top-left origin, y down) -> PDF point space (bottom-left
  // origin), same conversion `addSignaturePlaceholder` applies to `visible.rect`.
  const box = pdfDoc.getPage(pageIndex).getMediaBox();
  const tx1 = box.x + visible.rect.x;
  const ty1 = box.y + box.height - visible.rect.y - visible.rect.h;
  const targetCx = tx1 + visible.rect.w / 2;
  const targetCy = ty1 + visible.rect.h / 2;

  let best: { name: string; dist: number } | undefined;
  let tie = false;
  const EPS = 1e-6;
  for (const w of samePage) {
    const cx = (w.rect[0] + w.rect[2]) / 2;
    const cy = (w.rect[1] + w.rect[3]) / 2;
    const dist = Math.hypot(cx - targetCx, cy - targetCy);
    if (!best || dist < best.dist - EPS) {
      best = { name: w.name, dist };
      tie = false;
    } else if (Math.abs(dist - best.dist) <= EPS) {
      tie = true;
    }
  }
  return tie ? undefined : best?.name;
}

/** Ajoute le dictionnaire de signature + le widget + l'AcroForm (placeholder). */
async function addSignaturePlaceholder(
  pdfDoc: PDFDocument,
  opts: PadesSignOptions,
  reservedSigBytes: number,
): Promise<void> {
  const ctx = pdfDoc.context;
  const fieldName = opts.fieldName || pickPreparedFieldName(pdfDoc, opts.visible) || "Signature1";

  const byteRange = PDFArray.withContext(ctx);
  byteRange.push(PDFNumber.of(0));
  byteRange.push(PDFName.of("**********"));
  byteRange.push(PDFName.of("**********"));
  byteRange.push(PDFName.of("**********"));

  const contents = PDFHexString.of("0".repeat(reservedSigBytes * 2));

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

  // Un champ /FT /Sig déjà préparé (« Préparer le formulaire », voir
  // ops/forms.ts::addSignatureField) portant CE nom existe peut-être déjà —
  // vide, sans /V, placé par l'utilisateur à un emplacement précis. Le
  // réutiliser (sa page, son Rect) au lieu d'en fabriquer un second relie
  // enfin la signature réellement apposée à l'emplacement préparé, plutôt que
  // de créer un widget sans rapport pendant que le champ préparé reste vide.
  const existing = findExistingSignatureWidget(pdfDoc, fieldName);

  // Signature VISIBLE (widget au rectangle placé, apparence = le dessin) ou
  // INVISIBLE (champ Rect nul, comportement historique) — sauf si un widget
  // préparé existe déjà, auquel cas SON Rect/page font foi.
  const v = opts.visible;
  const pageCount = pdfDoc.getPageCount();
  const page = existing ? existing.page : pdfDoc.getPage(v ? Math.min(Math.max(0, v.page), pageCount - 1) : 0);
  let rect: [number, number, number, number] = existing ? existing.rect : [0, 0, 0, 0];
  if (!existing && v) {
    // Page space (haut-gauche, y bas) → points PDF (bas-gauche) via la mediaBox.
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

  if (existing) {
    // In place: keeps the field's identity (and its one /Annots + /Fields
    // entry) exactly as prepared — only its value (and, if a picture was
    // drawn, its appearance) actually change.
    existing.dict.set(PDFName.of("V"), sigRef);
    if (apRef) existing.dict.set(PDFName.of("AP"), ctx.obj({ N: apRef }));
    return;
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
  if (!annots) {
    annots = PDFArray.withContext(ctx);
    page.node.set(PDFName.of("Annots"), annots);
  }
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
  if (!fields) {
    fields = PDFArray.withContext(ctx);
    acro.set(PDFName.of("Fields"), fields);
  }
  fields.push(widgetRef);
}

/**
 * Construit le CMS SignedData détaché (chaîne binaire DER) sur `content`.
 *
 * NB : on utilise node-forge (structure reconnue par Adobe/Acrobat, éprouvée).
 * Une tentative de CMS « fait main » pour ajouter signing-certificate-v2 (B-B)
 * a été RETIRÉE en v4.3.8 car Adobe ne reconnaissait plus la signature (le
 * vérificateur interne l'acceptait, mais Acrobat est plus strict et on ne peut
 * pas le tester ici). À ne réintroduire qu'avec une vraie validation Acrobat
 * (ou une lib PAdES maintenue).
 */
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
 * Estime la taille (en octets) du CMS SignedData détaché que produira ce
 * matériel de signature, par un dry-run réel de `buildCmsDer` sur un contenu
 * factice — en mode détaché, le contenu signé n'est PAS réintégré dans le DER
 * (seul son empreinte SHA-256, de longueur fixe, y figure), donc la taille ne
 * dépend que de la clé et de la chaîne de certificats fournies, pas du
 * document : un contenu factice donne la même taille qu'un vrai. Une marge
 * multiplicative + additive absorbe les petites variations d'encodage ASN.1
 * (longueurs codées sur un octet de plus, etc.). Toute erreur pendant
 * l'estimation retombe sur le repli fixe `DEFAULT_RESERVED_SIG_BYTES` — mieux
 * vaut une réservation généreuse que planter la signature.
 */
function estimateReservedSigBytes(material: SignerMaterial): number {
  try {
    const dryRun = buildCmsDer(new Uint8Array(32), material);
    const estimated = Math.ceil(dryRun.length * SIG_SIZE_MARGIN_FACTOR) + SIG_SIZE_MARGIN_BYTES;
    return Math.max(DEFAULT_RESERVED_SIG_BYTES, estimated);
  } catch {
    return DEFAULT_RESERVED_SIG_BYTES;
  }
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
  const reservedSigBytes = estimateReservedSigBytes(material);
  const pdfDoc = await PDFDocument.load(finalPdfBytes, { updateMetadata: false });
  await addSignaturePlaceholder(
    pdfDoc,
    { ...opts, signerName: opts.signerName || certCommonName(material.cert) },
    reservedSigBytes,
  );
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
    fieldName: "",
    signerName: "",
    valid: false,
    coversWholeDocument: false,
    digestMatches: false,
    certValidAtSigning: false,
    selfSigned: false,
    chainVerified: false,
  };
  try {
    const a = parseInt(brMatch[1]!, 10),
      b = parseInt(brMatch[2]!, 10),
      c = parseInt(brMatch[3]!, 10),
      d = parseInt(brMatch[4]!, 10);
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
      // Validation du certificat (au-delà de la seule signature CMS) : fenêtre de
      // validité, auto-signé (identité non vérifiée), cohérence de la chaîne
      // embarquée. La validité est vérifiée à l'instant présent (un auto-signé
      // n'a pas d'horodatage de confiance qui prouverait la date de signature).
      out.certValidAtSigning = certValidAt(signerCert, new Date());
      out.selfSigned = dnString(signerCert.subject) === dnString(signerCert.issuer);
      out.chainVerified = chainIsConsistent((p7.certificates ?? []) as forge.pki.Certificate[], signerCert);
    }

    // Contenu couvert reconstruit à partir du ByteRange : [a, a+b) puis [c, c+d).
    const seg1 = buf.subarray(a, a + b);
    const seg2 = buf.subarray(c, c + d);
    const content = new Uint8Array(seg1.length + seg2.length);
    content.set(seg1, 0);
    content.set(seg2, seg1.length);
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
      try {
        sigValid = pub.verify(md.digest().getBytes(), p7.rawCapture.signature);
      } catch {
        sigValid = false;
      }
    }
    // La validité inclut désormais la fenêtre de validité du certificat : une
    // signature cryptographiquement correcte mais faite avec un certificat expiré
    // n'est plus rapportée « valide ». (selfSigned/chainVerified restent informatifs.)
    out.valid = sigValid && out.digestMatches && out.certValidAtSigning;
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
