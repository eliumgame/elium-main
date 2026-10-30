import { describe, expect, it } from "vitest";
import forge from "node-forge";
import { generateSelfSignedP12, generateSelfSignedP12Async } from "../src/pdf/ops/self-cert";

describe("self-cert PKCS#12", () => {
  it("la variante asynchrone produit un PKCS#12 3DES lisible, comme la synchrone", async () => {
    const p12 = await generateSelfSignedP12Async("Alice", "pw");
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(String.fromCharCode(...p12)));
    const parsed = forge.pkcs12.pkcs12FromAsn1(asn1, "pw");
    const bags = parsed.getBags({ bagType: forge.pki.oids.certBag });
    const cert = bags[forge.pki.oids.certBag]![0]!.cert!;
    expect(cert.subject.getField("CN").value).toBe("Alice");
    expect(() => forge.pkcs12.pkcs12FromAsn1(asn1, "mauvais")).toThrow();
  }, 60_000);

  it("la variante synchrone reste fonctionnelle", () => {
    expect(generateSelfSignedP12("Bob", "pw").length).toBeGreaterThan(500);
  }, 60_000);
});
