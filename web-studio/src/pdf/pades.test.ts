/**
 * PAdES-B : preuve de bout en bout (signature -> vérification) avec un
 * certificat auto-signé généré à la volée + un PKCS#12 en mémoire. Aucun réseau,
 * aucun fichier disque. Vérifie le /ByteRange, la correspondance du condensé, la
 * validité CMS, et qu'une altération invalide la signature.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, PDFSignature, StandardFonts } from "pdf-lib";
import forge from "node-forge";
import { signPdfBytes, verifyPdfSignatures } from "./ops/pades";
import { generateSelfSignedP12 } from "./ops/self-cert";
import { createFields } from "./ops/forms";

const binToU8 = (s: string): Uint8Array => {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
};

// 1×1 PNG transparent (apparence de signature de test).
const TINY_PNG = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

/** Certificat auto-signé RSA + PKCS#12 (DER) protégé par mot de passe. */
function makeP12(
  cn: string,
  password: string,
  validity: { notBefore: Date; notAfter: Date } = {
    notBefore: new Date(Date.UTC(2020, 0, 1)),
    notAfter: new Date(Date.UTC(2035, 0, 1)),
  },
): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = validity.notBefore;
  cert.validity.notAfter = validity.notAfter;
  const attrs = [
    { name: "commonName", value: cn },
    { name: "organizationName", value: "Elium" },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], password, { algorithm: "3des" });
  return binToU8(forge.asn1.toDer(p12Asn1).getBytes());
}

async function makePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([320, 200]);
  page.drawText("Document a signer — Elium PAdES", { x: 20, y: 120, size: 12 });
  return doc.save({ useObjectStreams: false });
}

describe("PAdES-B (sign + verify)", () => {
  it("signe un PDF puis le vérifie (byte range, condensé, CMS, signataire)", async () => {
    const p12 = makeP12("Alice Test", "s3cret");
    const pdf = await makePdf();

    const signed = await signPdfBytes(pdf, p12, "s3cret", { reason: "Approbation", signerName: "Alice Test" });

    // Le résultat reste un PDF valide (se recharge).
    await expect(PDFDocument.load(signed)).resolves.toBeTruthy();

    const res = verifyPdfSignatures(signed);
    expect(res).toHaveLength(1);
    expect(res[0]!.digestMatches).toBe(true);
    expect(res[0]!.coversWholeDocument).toBe(true);
    expect(res[0]!.valid).toBe(true);
    expect(res[0]!.signerName).toBe("Alice Test");
    expect(res[0]!.error).toBeUndefined();
    // Le certificat est temporellement valide et auto-signé (émetteur = sujet).
    expect(res[0]!.certValidAtSigning).toBe(true);
    expect(res[0]!.selfSigned).toBe(true);
  }, 30000);

  it("rejette une signature dont le certificat est hors de sa période de validité", async () => {
    // Certificat DÉJÀ expiré : le CMS est cryptographiquement correct, mais la
    // signature ne doit plus être rapportée « valide » (validation du certificat).
    const p12 = makeP12("Expired", "pw", {
      notBefore: new Date(Date.UTC(2000, 0, 1)),
      notAfter: new Date(Date.UTC(2001, 0, 1)),
    });
    const pdf = await makePdf();
    const signed = await signPdfBytes(pdf, p12, "pw");
    const res = verifyPdfSignatures(signed);
    expect(res[0]!.digestMatches).toBe(true);
    expect(res[0]!.certValidAtSigning).toBe(false);
    expect(res[0]!.valid).toBe(false);
  }, 30000);

  it("détecte une altération du document (signature invalide)", async () => {
    const p12 = makeP12("Bob Test", "pw");
    const pdf = await makePdf();
    const signed = await signPdfBytes(pdf, p12, "pw");

    // Altère un octet dans le premier segment couvert (avant /Contents).
    const tampered = new Uint8Array(signed);
    tampered[30] = tampered[30] === 65 ? 66 : 65;

    const res = verifyPdfSignatures(tampered);
    expect(res).toHaveLength(1);
    expect(res[0]!.valid).toBe(false);
  }, 30000);

  it("rejette un mot de passe PKCS#12 incorrect", async () => {
    const p12 = makeP12("Carol", "bonne");
    const pdf = await makePdf();
    await expect(signPdfBytes(pdf, p12, "mauvaise")).rejects.toBeTruthy();
  }, 30000);

  it("signe avec un certificat AUTO-SIGNÉ généré dans l'app (self-cert)", async () => {
    const pw = "auto-pw";
    const p12 = generateSelfSignedP12("Signature Elium (auto-signée)", pw);
    const pdf = await makePdf();
    const signed = await signPdfBytes(pdf, p12, pw, { reason: "Approbation" });
    const res = verifyPdfSignatures(signed);
    expect(res).toHaveLength(1);
    expect(res[0]!.valid).toBe(true);
    expect(res[0]!.signerName).toBe("Signature Elium (auto-signée)");
    expect(res[0]!.selfSigned).toBe(true);
    expect(res[0]!.certValidAtSigning).toBe(true);
  }, 30000);

  it("signature VISIBLE : widget non nul + apparence /AP, et reste valide", async () => {
    const pw = "vis";
    const p12 = generateSelfSignedP12("Alice", pw);
    const pdf = await makePdf();
    // Page 320×200 (origine 0,0) ; rect page-space {x:40,y:40,w:200,h:80}
    // → points PDF [40, 200-40-80, 240, 200-40] = [40, 80, 240, 160].
    const signed = await signPdfBytes(pdf, p12, pw, {
      signerName: "Alice",
      visible: { page: 0, rect: { x: 40, y: 40, w: 200, h: 80 }, imagePng: TINY_PNG },
    });
    // Toujours un PDF chargeable et une signature cryptographiquement valide.
    await expect(PDFDocument.load(signed)).resolves.toBeTruthy();
    const res = verifyPdfSignatures(signed);
    expect(res[0]!.valid).toBe(true);
    // L'apparence a bien été émise (form XObject + image), et le widget porte un
    // /Rect non nul (sinon Adobe ne montre rien à l'emplacement).
    const s = binToU8Str(signed);
    expect(s.includes("/AP")).toBe(true);
    expect(s.includes("/Subtype /Form") || s.includes("/Subtype/Form")).toBe(true);
    expect(/\/Rect\s*\[\s*40\b/.test(s)).toBe(true);
  }, 30000);
});

function binToU8Str(u: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < u.length; i += CHUNK) s += String.fromCharCode(...u.subarray(i, i + CHUNK));
  return s;
}

/** Lit le /ByteRange brut d'un PDF signé et renvoie la taille du trou /Contents
 *  réservé (c - b), pour comparer la réservation entre deux signatures. */
function reservedContentsSpan(signed: Uint8Array): number {
  const s = binToU8Str(signed);
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(s);
  if (!m) throw new Error("/ByteRange introuvable");
  return parseInt(m[3]!, 10) - parseInt(m[2]!, 10);
}

/** PKCS#12 avec un signataire + une longue liste de certificats de "chaîne"
 *  factices (auto-signés, sans lien de confiance réel — seule leur taille DER
 *  compte ici) pour gonfler artificiellement le CMS bien au-delà de l'ancienne
 *  réservation fixe de 16 Kio. Réutilise la MÊME paire de clés pour éviter de
 *  regénérer du RSA à chaque certificat (coûteux) : seule la signature de
 *  certificat (rapide) varie. */
function makeP12WithLongChain(cn: string, password: string, fillerCount: number): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const makeCert = (name: string, serial: string) => {
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = serial;
    cert.validity.notBefore = new Date(Date.UTC(2020, 0, 1));
    cert.validity.notAfter = new Date(Date.UTC(2035, 0, 1));
    const attrs = [
      { name: "commonName", value: name },
      { name: "organizationName", value: "Elium" },
    ];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey, forge.md.sha256.create());
    return cert;
  };
  const signerCert = makeCert(cn, "01");
  const filler = Array.from({ length: fillerCount }, (_, i) => makeCert(`Filler CA ${i}`, String(i + 2)));
  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [signerCert, ...filler], password, {
    algorithm: "3des",
  });
  return binToU8(forge.asn1.toDer(p12Asn1).getBytes());
}

describe("PAdES-B — dimensionnement dynamique du placeholder /Contents", () => {
  it("réserve plus d'espace pour une longue chaîne de certification qu'un signataire seul", async () => {
    const pdf = await makePdf();

    const shortChainP12 = makeP12WithLongChain("Alice", "pw", 0);
    const signedShort = await signPdfBytes(pdf, shortChainP12, "pw");
    expect(verifyPdfSignatures(signedShort)[0]!.valid).toBe(true);

    const longChainP12 = makeP12WithLongChain("Alice", "pw", 60);
    const signedLong = await signPdfBytes(pdf, longChainP12, "pw");
    expect(verifyPdfSignatures(signedLong)[0]!.valid).toBe(true);

    // La réservation suit la taille réelle du CMS (certificats embarqués), pas
    // une constante : une chaîne longue obtient un trou /Contents plus large.
    expect(reservedContentsSpan(signedLong)).toBeGreaterThan(reservedContentsSpan(signedShort));
  }, 30000);

  it("signe avec succès une chaîne de certification trop longue pour l'ancienne réservation fixe (16 Kio)", async () => {
    // ~60 certificats auto-signés supplémentaires embarqués dans le CMS
    // dépassent largement 16 Kio de DER une fois sérialisés — avec la
    // constante figée d'origine, la signature échouait tard (après saisie du
    // mot de passe) avec « Signature trop volumineuse pour l'espace /Contents
    // réservé. ». Le dimensionnement dynamique doit absorber ce cas.
    const p12 = makeP12WithLongChain("Dave", "pw", 60);
    const pdf = await makePdf();
    const signed = await signPdfBytes(pdf, p12, "pw");
    const res = verifyPdfSignatures(signed);
    expect(res).toHaveLength(1);
    expect(res[0]!.digestMatches).toBe(true);
    expect(res[0]!.valid).toBe(true);
  }, 30000);
});

/** A PDF whose only form field is a bare, never-signed /FT /Sig widget — what
 *  "Prepare form" (ops/forms.ts::addSignatureField) leaves behind, named by
 *  the user, before anyone actually signs. */
async function makePdfWithPreparedSignatureField(
  name: string,
  rect: { x: number; y: number; w: number; h: number },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([320, 200]);
  createFields({ doc, font }, [{ id: "s1", pageId: "p1", name, kind: "signature", rect }], () => ({
    page,
    height: 200,
  }));
  return doc.save({ useObjectStreams: false });
}

describe("PAdES-B — réutilisation d'un champ /FT /Sig déjà préparé", () => {
  it("relie la signature au widget préparé (même nom) au lieu d'en créer un second", async () => {
    const pw = "prep";
    const p12 = generateSelfSignedP12("Alice", pw);
    // Emplacement choisi par l'utilisateur lors de la préparation du formulaire.
    const preparedRect = { x: 40, y: 40, w: 150, h: 40 };
    const pdf = await makePdfWithPreparedSignatureField("signature_1", preparedRect);

    // Un seul champ, vide, avant signature.
    const before = await PDFDocument.load(pdf);
    expect(before.getForm().getFields()).toHaveLength(1);
    expect(before.getForm().getField("signature_1")).toBeInstanceOf(PDFSignature);

    const signed = await signPdfBytes(pdf, p12, pw, { fieldName: "signature_1", signerName: "Alice" });

    const after = await PDFDocument.load(signed);
    const fields = after.getForm().getFields();
    // Toujours un seul champ : pas de second widget créé à côté du préparé.
    expect(fields).toHaveLength(1);
    expect(fields[0]!.getName()).toBe("signature_1");

    // Le Rect reste celui choisi à la préparation, pas [0,0,0,0].
    const sigField = after.getForm().getSignature("signature_1");
    const rect = sigField.acroField.getWidgets()[0]!.getRectangle();
    expect(Math.round(rect.width)).toBe(150);
    expect(Math.round(rect.height)).toBe(40);

    const res = verifyPdfSignatures(signed);
    expect(res).toHaveLength(1);
    expect(res[0]!.valid).toBe(true);
    expect(res[0]!.signerName).toBe("Alice");
  }, 30000);

  it("crée quand même un widget si aucun champ préparé ne porte ce nom", async () => {
    const pw = "pw";
    const p12 = generateSelfSignedP12("Bob", pw);
    const pdf = await makePdf();
    const signed = await signPdfBytes(pdf, p12, pw, { fieldName: "AutreNom" });
    const after = await PDFDocument.load(signed);
    expect(after.getForm().getFields()).toHaveLength(1);
    expect(after.getForm().getField("AutreNom")).toBeInstanceOf(PDFSignature);
  }, 30000);
});

/** Comme `makePdfWithPreparedSignatureField`, mais avec plusieurs champs
 *  préparés d'un coup, tous sur la même page — pour les scénarios de
 *  désambiguïsation. */
async function makePdfWithPreparedSignatureFields(
  fields: { name: string; rect: { x: number; y: number; w: number; h: number } }[],
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([320, 200]);
  createFields(
    { doc, font },
    fields.map((f, i) => ({ id: `s${i}`, pageId: "p1", name: f.name, kind: "signature" as const, rect: f.rect })),
    () => ({ page, height: 200 }),
  );
  return doc.save({ useObjectStreams: false });
}

describe("PAdES-B — résolution automatique du champ préparé (fieldName non fourni)", () => {
  // `PdfWorkspace.tsx` (onP12Pick / signSelfSigned) n'a JAMAIS passé `fieldName`
  // à `signPdfBytes` — seulement `visible` (+ reason/signerName). Avant le
  // correctif, `addSignaturePlaceholder` retombait donc toujours sur le nom
  // figé "Signature1", qui ne correspond quasi jamais au nom choisi par
  // l'utilisateur lors de la préparation du champ ("signature_1" ici) :
  // `findExistingSignatureWidget` ne le trouvait pas et un SECOND widget
  // "Signature1" était créé à côté du champ préparé, qui restait vide.
  it("relie la signature au champ préparé SANS fieldName explicite (reproduit l'appel réel de PdfWorkspace.tsx)", async () => {
    const pw = "auto1";
    const p12 = generateSelfSignedP12("Alice", pw);
    const preparedRect = { x: 40, y: 40, w: 150, h: 40 };
    const pdf = await makePdfWithPreparedSignatureFields([{ name: "signature_1", rect: preparedRect }]);

    // Mêmes options que les deux call sites de PdfWorkspace.tsx : reason +
    // visible (signature dessinée au même endroit que le champ préparé),
    // JAMAIS fieldName.
    const signed = await signPdfBytes(pdf, p12, pw, {
      reason: "Signé avec Elium",
      signerName: "Alice",
      visible: { page: 0, rect: preparedRect, imagePng: TINY_PNG },
    });

    const after = await PDFDocument.load(signed);
    const fields = after.getForm().getFields();
    // Un seul champ : pas de "Signature1" créé à côté du champ préparé resté vide.
    expect(fields).toHaveLength(1);
    expect(fields[0]!.getName()).toBe("signature_1");

    const res = verifyPdfSignatures(signed);
    expect(res).toHaveLength(1);
    expect(res[0]!.valid).toBe(true);
  }, 30000);

  it("avec plusieurs champs préparés sur la même page, choisit celui dont le rect est le plus proche de la signature visible", async () => {
    const pw = "auto2";
    const p12 = generateSelfSignedP12("Bob", pw);
    const near = { x: 40, y: 40, w: 100, h: 30 };
    const far = { x: 200, y: 140, w: 100, h: 30 };
    const pdf = await makePdfWithPreparedSignatureFields([
      { name: "signature_far", rect: far },
      { name: "signature_near", rect: near },
    ]);

    // Signature visible placée à quelques points de "signature_near", loin de "signature_far".
    const signed = await signPdfBytes(pdf, p12, pw, {
      visible: { page: 0, rect: { x: 45, y: 42, w: 100, h: 30 }, imagePng: TINY_PNG },
    });

    const after = await PDFDocument.load(signed);
    // Toujours 2 champs : aucun 3e widget créé pour porter la signature.
    expect(after.getForm().getFields()).toHaveLength(2);

    const nearField = after.getForm().getSignature("signature_near");
    const farField = after.getForm().getSignature("signature_far");
    // Le champ le plus proche porte la valeur de signature (/V) ...
    expect(nearField.acroField.dict.get(PDFName.of("V"))).toBeDefined();
    // ... l'autre reste vide, tel que préparé.
    expect(farField.acroField.dict.get(PDFName.of("V"))).toBeUndefined();

    const res = verifyPdfSignatures(signed);
    expect(res).toHaveLength(1);
    expect(res[0]!.valid).toBe(true);
  }, 30000);

  it("avec plusieurs champs préparés et aucune signature visible pour désambiguïser, ne devine pas : retombe sur le nom par défaut", async () => {
    const pw = "auto3";
    const p12 = generateSelfSignedP12("Carol", pw);
    const pdf = await makePdfWithPreparedSignatureFields([
      { name: "signature_a", rect: { x: 10, y: 10, w: 80, h: 20 } },
      { name: "signature_b", rect: { x: 200, y: 100, w: 80, h: 20 } },
    ]);

    // Aucun `visible` : rien pour choisir entre les deux champs préparés.
    const signed = await signPdfBytes(pdf, p12, pw, {});

    const after = await PDFDocument.load(signed);
    const fields = after.getForm().getFields();
    // Un 3e widget ("Signature1", le repli par défaut) porte la signature —
    // plutôt que de deviner lequel des deux champs préparés utiliser.
    expect(fields).toHaveLength(3);
    expect(fields.some((f) => f.getName() === "Signature1")).toBe(true);
    expect(after.getForm().getSignature("signature_a").acroField.dict.get(PDFName.of("V"))).toBeUndefined();
    expect(after.getForm().getSignature("signature_b").acroField.dict.get(PDFName.of("V"))).toBeUndefined();
  }, 30000);

  it("un unique champ préparé sur une AUTRE page que la signature visible n'est pas récupéré aveuglément", async () => {
    // Trouvé par revue adversariale de la 1ère version de ce correctif : le cas
    // "un seul champ préparé" sautait la vérification de page que le cas
    // "plusieurs champs" applique pourtant — un champ résiduel d'une session
    // antérieure, sur une autre page que celle où l'utilisateur signe
    // réellement aujourd'hui, absorbait silencieusement la signature au
    // mauvais endroit (signature cryptographiquement valide, mais placée là où
    // l'utilisateur ne l'a jamais mise). Reproduit ci-dessous, doit désormais
    // retomber sur le nom par défaut plutôt que d'utiliser ce champ éloigné.
    const pw = "auto4";
    const p12 = generateSelfSignedP12("Dave", pw);

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    doc.addPage([320, 200]); // page 0 : où la signature visible est réellement placée
    const page1 = doc.addPage([320, 200]);
    const preparedRect = { x: 40, y: 40, w: 150, h: 40 };
    createFields(
      { doc, font },
      [{ id: "s0", pageId: "p2", name: "signature_page2", kind: "signature", rect: preparedRect }],
      (id) => (id === "p2" ? { page: page1, height: 200 } : null),
    );
    const pdf = await doc.save({ useObjectStreams: false });

    // Signature visible dessinée sur la PREMIÈRE page (index 0), pas celle du
    // champ préparé (page index 1).
    const signed = await signPdfBytes(pdf, p12, pw, {
      visible: { page: 0, rect: { x: 45, y: 42, w: 100, h: 30 }, imagePng: TINY_PNG },
    });

    const after = await PDFDocument.load(signed);
    const fields = after.getForm().getFields();
    // Un 2e widget ("Signature1", le repli par défaut) porte la signature, sur
    // la page 0 où l'utilisateur a réellement signé — le champ préparé de la
    // page 1 reste vide, tel quel, plutôt que d'être réutilisé à tort.
    expect(fields).toHaveLength(2);
    expect(fields.some((f) => f.getName() === "Signature1")).toBe(true);
    expect(after.getForm().getSignature("signature_page2").acroField.dict.get(PDFName.of("V"))).toBeUndefined();

    const sigField = after.getForm().getSignature("Signature1");
    const sigPageRef = sigField.acroField.dict.get(PDFName.of("P"));
    expect(after.getPages().findIndex((p) => p.ref === sigPageRef)).toBe(0);
  }, 30000);
});
