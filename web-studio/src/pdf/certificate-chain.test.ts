import { beforeAll, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import forge from "node-forge";
import { signPdfBytes, verifyPdfSignatures } from "./ops/pades";

const bytes = (value: string) => Uint8Array.from(value, (c) => c.charCodeAt(0));
let keys: forge.pki.rsa.KeyPair[];
let pdf: Uint8Array;
beforeAll(async () => {
  keys = Array.from({ length: 3 }, () => forge.pki.rsa.generateKeyPair(2048));
  const doc = await PDFDocument.create();
  doc.addPage().drawText("Certificate constraints");
  pdf = await doc.save({ useObjectStreams: false });
});

it.each([
  { name: "keyCertSign absent", keyCertSign: undefined, pathLen: 0, intermediate: false, trusted: true },
  { name: "keyCertSign refusé", keyCertSign: false, pathLen: 1, intermediate: false, trusted: false },
  { name: "CA directe pathLen=0", keyCertSign: true, pathLen: 0, intermediate: false, trusted: true },
  { name: "intermédiaire interdit pathLen=0", keyCertSign: true, pathLen: 0, intermediate: true, trusted: false },
  { name: "intermédiaire autorisé pathLen=1", keyCertSign: true, pathLen: 1, intermediate: true, trusted: true },
])("applique les contraintes de chaîne : $name", async (scenario) => {
  const make = (
    id: number,
    issuer: forge.pki.Certificate | undefined,
    issuerKey: forge.pki.rsa.PrivateKey,
    extensions: object[],
  ) => {
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys[id]!.publicKey;
    cert.serialNumber = `0${id + 1}`;
    cert.validity.notBefore = new Date("2020-01-01T00:00:00Z");
    cert.validity.notAfter = new Date("2035-01-01T00:00:00Z");
    cert.setSubject([{ name: "commonName", value: `Certificate ${id}` }]);
    cert.setIssuer(issuer?.subject.attributes ?? cert.subject.attributes);
    cert.setExtensions(extensions);
    cert.sign(issuerKey, forge.md.sha256.create());
    return cert;
  };
  const constraints: object[] = [{ name: "basicConstraints", cA: true, pathLenConstraint: scenario.pathLen }];
  if (scenario.keyCertSign !== undefined)
    constraints.push({ name: "keyUsage", digitalSignature: true, keyCertSign: scenario.keyCertSign });
  const root = make(0, undefined, keys[0]!.privateKey, constraints);
  const intermediate = scenario.intermediate
    ? make(1, root, keys[0]!.privateKey, [
        { name: "basicConstraints", cA: true },
        { name: "keyUsage", keyCertSign: true },
      ])
    : undefined;
  const leaf = make(2, intermediate ?? root, keys[intermediate ? 1 : 0]!.privateKey, [
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true },
  ]);
  const chain = intermediate ? [leaf, intermediate, root] : [leaf, root];
  const p12 = bytes(forge.asn1.toDer(forge.pkcs12.toPkcs12Asn1(keys[2]!.privateKey, chain, "pw")).getBytes());
  const signed = await signPdfBytes(pdf, p12, "pw");
  const der = (cert: forge.pki.Certificate) => bytes(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes());
  const [v] = await verifyPdfSignatures(signed, { trusted: [der(root)] });
  expect(v!.intact).toBe(true);
  expect(v!.chainVerified).toBe(scenario.trusted);
  expect(v!.trust === "trusted").toBe(scenario.trusted);
  // Explicitly trusting the exact leaf must still work, without granting it CA powers.
  expect((await verifyPdfSignatures(signed, { trusted: [der(leaf)] }))[0]!.trust).toBe("trusted");
});
