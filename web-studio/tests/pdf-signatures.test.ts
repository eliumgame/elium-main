import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, StandardFonts } from "pdf-lib";
import {
  listSignatureFields,
  loadPkcs12,
  signPdfBytes,
  signedVersion,
  verifyPdfSignatures,
} from "../src/pdf/ops/pades";
import { fingerprint, readXrefTail, writeIncrementalUpdate } from "../src/pdf/ops/incremental";
import { ALL_PERMISSIONS, protectDocument } from "../src/pdf/ops/security";

/**
 * PAdES signing and verification: several signatures in a row (incremental),
 * RSA and EC keys from OpenSSL 3 PKCS #12 files, certification, field locks,
 * changes after signing judged the way Acrobat does, trusted identities.
 * The fixtures (tests/fixtures/sig, password « pw ») are signed by a test CA
 * (ca.pem).
 */

const fx = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/sig/${name}`, import.meta.url)));
const RSA = fx("rsa.p12");
const EC = fx("ec.p12");
const EC384 = fx("ec384.p12");
const CA = (() => {
  const pem = new TextDecoder().decode(fx("ca.pem"));
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
})();

async function makePdf(withField = false): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Contrat", { x: 40, y: 340, size: 20, font });
  if (withField) {
    const form = doc.getForm();
    form.createTextField("Nom").addToPage(page, { x: 40, y: 280, width: 200, height: 20 });
  }
  return doc.save({ useObjectStreams: false });
}

/** Append one incremental update made by `edit` (what a later « Enregistrer » writes). */
async function update(bytes: Uint8Array, edit: (doc: PDFDocument) => void | Promise<void>): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const before = fingerprint(doc);
  await edit(doc);
  await doc.flush();
  return writeIncrementalUpdate({ disk: bytes, tail: readXrefTail(bytes)!, doc, before }).bytes;
}

const box = { page: 0, rect: { x: 40, y: 200, w: 220, h: 60 } };

describe("PAdES signing", () => {
  it("reads OpenSSL 3 PKCS #12 files, RSA and EC; a wrong password is named as such", async () => {
    expect((await loadPkcs12(RSA, "pw")).cert.commonName).toBe("Alice Martin");
    const ec = await loadPkcs12(EC384, "pw");
    expect(ec.keyType).toBe("ec");
    expect(ec.hash).toBe("SHA-384");
    expect(ec.cert.commonName).toBe("Chloé P384");
    await expect(loadPkcs12(RSA, "faux")).rejects.toMatchObject({ wrongPassword: true });
  });

  it("a second signature is appended: both stay valid, the first reports it", async () => {
    const pdf = await makePdf();
    const one = await signPdfBytes(pdf, RSA, "pw", { reason: "Accord", visible: box });
    expect(one.subarray(0, pdf.length)).toEqual(pdf);
    const two = await signPdfBytes(one, EC, "pw", { reason: "Contreseing" });
    expect(two.subarray(0, one.length)).toEqual(one);
    const three = await signPdfBytes(two, EC384, "pw");
    const v = await verifyPdfSignatures(three);
    expect(v.map((x) => [x.fieldName, x.signerName, x.valid, x.keyType])).toEqual([
      ["Signature1", "Alice Martin", true, "rsa"],
      ["Signature2", "Bruno EC", true, "ec"],
      ["Signature3", "Chloé P384", true, "ec"],
    ]);
    expect(v[0]!.modifications).toBe("allowed");
    expect(v[0]!.changes.every((c) => c.kind === "signature")).toBe(true);
    expect(v[2]!.coversWholeDocument).toBe(true);
    expect(v[0]!.reason).toBe("Accord");
    // The signed version is the first revision exactly.
    expect(signedVersion(three, v[0]!)).toEqual(one);
  });

  it("PAdES B-B: signing-certificate-v2, no signing-time, /M carries the time", async () => {
    const now = new Date(Date.UTC(2026, 3, 1, 10, 0, 0));
    const signed = await signPdfBytes(await makePdf(), RSA, "pw", { now });
    const text = new TextDecoder("latin1").decode(signed);
    expect(text).toContain("/SubFilter /ETSI.CAdES.detached");
    expect(text).toContain("/M (D:20260401100000Z)");
    const hex = /\/Contents <([0-9A-F]+)>/.exec(text)![1]!.replace(/(00)+$/, "");
    expect(hex).toContain("060B2A864886F70D010910022F"); // id-aa-signingCertificateV2
    expect(hex).not.toContain("06092A864886F70D010905"); // signingTime
    const [v] = await verifyPdfSignatures(signed);
    expect(v!.signedAt).toBe(now.toISOString());
    expect(v!.timeSource).toBe("signer");
  });

  it("changes after signing: form filling and comments allowed, page content not", async () => {
    const signed = await signPdfBytes(await makePdf(true), RSA, "pw");
    const filled = await update(signed, (doc) => doc.getForm().getTextField("Nom").setText("Durand"));
    let [v] = await verifyPdfSignatures(filled);
    expect(v!.valid).toBe(true);
    expect(v!.changes.map((c) => c.label)).toContain("Champ rempli : Nom");

    const commented = await update(signed, (doc) => {
      const page = doc.getPage(0);
      const note = doc.context.register(
        doc.context.obj({
          Type: "Annot",
          Subtype: "Text",
          Rect: [10, 10, 30, 30],
          Contents: PDFHexString.fromText("Vu"),
          T: PDFHexString.fromText("Relecteur"),
        }),
      );
      const annots = page.node.lookup(PDFName.of("Annots"));
      if (annots instanceof PDFArray) annots.push(note);
      else page.node.set(PDFName.of("Annots"), doc.context.obj([note]));
    });
    [v] = await verifyPdfSignatures(commented);
    expect(v!.modifications).toBe("allowed");
    expect(v!.changes.map((c) => c.kind)).toEqual(["comment"]);

    const tampered = await update(signed, async (doc) => {
      const font = await doc.embedFont(StandardFonts.Helvetica);
      doc.getPage(0).drawText("Montant : 1 000 000 €".replace("€", "EUR"), { x: 40, y: 100, font });
    });
    [v] = await verifyPdfSignatures(tampered);
    expect(v!.intact).toBe(true);
    expect(v!.modifications).toBe("disallowed");
    expect(v!.valid).toBe(false);
  });

  it("certification: level 1 refuses any later signature, level 2 refuses comments", async () => {
    const pdf = await makePdf(true);
    const locked = await signPdfBytes(pdf, RSA, "pw", { certify: 1 });
    await expect(signPdfBytes(locked, EC, "pw")).rejects.toThrow(/certifié/);
    const cert2 = await signPdfBytes(pdf, RSA, "pw", { certify: 2 });
    const [c] = await verifyPdfSignatures(cert2);
    expect(c!.certification).toBe(2);
    // Signing and filling stay allowed.
    const cosigned = await signPdfBytes(
      await update(cert2, (doc) => doc.getForm().getTextField("Nom").setText("Durand")),
      EC,
      "pw",
    );
    expect((await verifyPdfSignatures(cosigned)).map((x) => x.valid)).toEqual([true, true]);
    const commented = await update(cert2, (doc) => {
      const note = doc.context.register(doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 9, 9] }));
      doc.getPage(0).node.set(PDFName.of("Annots"), doc.context.obj([note]));
    });
    const [after] = await verifyPdfSignatures(commented);
    expect(after!.modifications).toBe("disallowed");
    // Only the first signature may certify.
    const approved = await signPdfBytes(pdf, RSA, "pw");
    await expect(signPdfBytes(approved, EC, "pw", { certify: 2 })).rejects.toThrow(/première/);
  });

  it("locking the document: a later form change breaks the locking signature", async () => {
    const signed = await signPdfBytes(await makePdf(true), RSA, "pw", { lockDocument: true });
    const [v] = await verifyPdfSignatures(signed);
    expect(v!.locks).toEqual(["*"]);
    const filled = await update(signed, (doc) => doc.getForm().getTextField("Nom").setText("X"));
    expect((await verifyPdfSignatures(filled))[0]!.modifications).toBe("disallowed");
  });

  it("trust: the CA as a trusted identity gives a trusted chain; unknown otherwise", async () => {
    const signed = await signPdfBytes(await makePdf(), RSA, "pw");
    const [plain] = await verifyPdfSignatures(signed);
    expect(plain!.trust).toBe("untrusted");
    expect(plain!.chainVerified).toBe(false);
    expect(plain!.chain.map((c) => c.commonName)).toEqual(["Alice Martin", "Elium Test CA"]);
    const [trusted] = await verifyPdfSignatures(signed, { trusted: [CA] });
    expect(trusted!.trust).toBe("trusted");
    expect(trusted!.valid).toBe(true);
  });

  it("signs a prepared field in place, and an encrypted file keeps its protection", { timeout: 30_000 }, async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 400]);
    const field = doc.context.register(
      doc.context.obj({
        Type: "Annot",
        Subtype: "Widget",
        FT: "Sig",
        T: PDFHexString.fromText("Client"),
        Rect: [50, 50, 250, 110],
        P: page.ref,
      }),
    );
    page.node.set(PDFName.of("Annots"), doc.context.obj([field]));
    doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [field] }));
    const prepared = await doc.save({ useObjectStreams: false });
    const signed = await signPdfBytes(prepared, RSA, "pw", { visible: box });
    expect(await listSignatureFields(signed)).toEqual([
      { name: "Client", page: 0, rect: [50, 50, 250, 110], box: { x: 50, y: 290, w: 200, h: 60 }, signed: true },
    ]);
    const re = await PDFDocument.load(signed);
    const acro = re.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
    expect(acro.get(PDFName.of("SigFlags"))?.toString()).toBe("3");

    const src = await PDFDocument.load(await makePdf());
    const protectedPdf = await protectDocument(src, {
      userPassword: "",
      ownerPassword: "own",
      permissions: ALL_PERMISSIONS,
    });
    const s2 = await signPdfBytes(protectedPdf, RSA, "pw", { reason: "Accord chiffré" });
    expect(new TextDecoder("latin1").decode(s2)).toMatch(/\/Encrypt \d+ 0 R/);
    const [v] = await verifyPdfSignatures(s2);
    expect(v!.valid).toBe(true);
    expect(v!.reason).toBe("Accord chiffré");
  });

  it("a timestamp authority's refusal or a malformed reply stops the signature with a clear message", async () => {
    const pdf = await makePdf();
    await expect(
      signPdfBytes(pdf, RSA, "pw", {
        tsaUrl: "https://tsa.example/",
        tsaFetch: async () => {
          throw new Error("HTTP 503");
        },
      }),
    ).rejects.toThrow(/Horodatage impossible : HTTP 503/);
    await expect(
      signPdfBytes(pdf, RSA, "pw", {
        tsaUrl: "https://tsa.example/",
        tsaFetch: async () => new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x02]),
      }),
    ).rejects.toThrow(/horodatage/i);
  });
});
