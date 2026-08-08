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

const binToU8 = (s: string): Uint8Array => {
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff;
  return u;
};

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
});
