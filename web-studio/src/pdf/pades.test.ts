/**
 * PAdES-B : preuve de bout en bout (signature -> vérification) avec un
 * certificat auto-signé généré à la volée + un PKCS#12 en mémoire. Aucun réseau,
 * aucun fichier disque. Vérifie le /ByteRange, la correspondance du condensé, la
 * validité CMS, et qu'une altération invalide la signature.
 */
import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import forge from "node-forge";
import { signPdfBytes, verifyPdfSignatures } from "./ops/pades";
import { generateSelfSignedP12 } from "./ops/self-cert";

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
function makeP12(cn: string, password: string): Uint8Array {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.UTC(2020, 0, 1));
  cert.validity.notAfter = new Date(Date.UTC(2035, 0, 1));
  const attrs = [{ name: "commonName", value: cn }, { name: "organizationName", value: "Elium" }];
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
