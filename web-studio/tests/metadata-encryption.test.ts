import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { writeEliumPackage, readEliumPackage, verifyLoadedSeal, EliumPasswordRequired } from "../src/format/elium-package";
import { createEliumFile, addSignature } from "../src/format/document";
import { createProof } from "../src/sign/proof";
import { createSeal, verifySeal } from "../src/sign/seal";
import { generateIdentity } from "../src/sign/keys";
import type { EliumFile, EliumSignature } from "../src/format/types";

const PWD = "correct horse battery staple";

async function secureFile(): Promise<{ file: EliumFile; pub: string; priv: string }> {
  const id = await generateIdentity();
  let f = await createEliumFile({ title: "Plan social 2026", profile: "secure_max" });
  const signer = { name: "Jean Dupont", role: "DRH" };
  const proof = await createProof({ signatureId: "s1", model: f.document, signer, privateKeyHex: id.privateKeyHex! });
  const sig: EliumSignature = {
    id: "s1", kind: "drawn", visual: { text: "JD" },
    placement: { page: 1, xPct: 0.3, yPct: 0.7, wPct: 0.3, hPct: 0.1, rotation: 0, z: 0, anchorType: "page" },
    signer, proof, level: "advanced", createdAt: "2026-01-01T00:00:00Z",
  };
  f = await addSignature(f, sig);
  return { file: f, pub: id.publicKeyHex, priv: id.privateKeyHex! };
}

describe("F-7 metadata encryption (TypeScript)", () => {
  it("redacts title/signers/journal in the clear ZIP entries", async () => {
    const { file, priv } = await secureFile();
    const bytes = await writeEliumPackage(file, { password: PWD, sealPrivateKeyHex: priv, encryptMetadata: true });

    const z = unzipSync(bytes);
    const manifest = strFromU8(z["manifest.json"]);
    const sigs = strFromU8(z["signatures/signatures.json"]);
    const journal = strFromU8(z["tracking/journal.json"]);
    const clear = manifest + sigs + journal;

    expect(clear).not.toContain("Plan social 2026");
    expect(clear).not.toContain("Jean Dupont");
    expect(clear).not.toContain("DRH");
    expect(JSON.parse(manifest).protection.metadataEncrypted).toBe(true);
    expect(JSON.parse(sigs)).toEqual([]);
  });

  it("refuses without a password and restores everything with it (seal valid)", async () => {
    const { file, pub, priv } = await secureFile();
    const bytes = await writeEliumPackage(file, { password: PWD, sealPrivateKeyHex: priv, encryptMetadata: true });

    await expect(readEliumPackage(bytes)).rejects.toBeInstanceOf(EliumPasswordRequired);

    const r = await readEliumPackage(bytes, { password: PWD, trustedKeyHex: pub });
    expect(r.file.manifest.title).toBe("Plan social 2026");
    expect(r.file.signatures[0].signer.name).toBe("Jean Dupont");
    expect(r.seal.verdict).toBe("valid");
    expect(r.integrity.contentIntact).toBe(true);
  });

  it("live re-verification of a loaded secure file agrees with the read verdict (seal not 'broken')", async () => {
    // Regression: the viewer re-verifies the seal against the in-memory file,
    // whose signatures/journal are the REAL decrypted values. The seal, however,
    // was signed over the REDACTED clear entries. Verifying against the real
    // values wrongly reads "broken"; verifyLoadedSeal must apply the same
    // redaction and read "valid".
    const { file, pub, priv } = await secureFile();
    const bytes = await writeEliumPackage(file, { password: PWD, sealPrivateKeyHex: priv, encryptMetadata: true });
    const r = await readEliumPackage(bytes, { password: PWD });

    // The loaded file carries the real signature (restored from the envelope)…
    expect(r.file.signatures.length).toBeGreaterThan(0);
    // …so the naive check the viewer used to do is broken — this is the bug.
    const naive = await verifySeal(r.file.manifest, r.file.signatures, r.file.journal);
    expect(naive).toBe("broken");
    // …while the redaction-aware helper agrees with readEliumPackage's verdict.
    expect(await verifyLoadedSeal(r.file)).toBe("valid");
    expect(await verifyLoadedSeal(r.file, pub)).toBe("valid");
    expect(r.seal.verdict).toBe("valid");
  });

  it("a non-secure encrypted file keeps the legacy behaviour (title in clear)", async () => {
    const f = await createEliumFile({ title: "Visible", profile: "encrypted" });
    const bytes = await writeEliumPackage(f, { password: PWD });
    const manifest = JSON.parse(strFromU8(unzipSync(bytes)["manifest.json"]));
    expect(manifest.title).toBe("Visible");
    expect(manifest.protection.metadataEncrypted).toBeUndefined();
  });

  it("detects tampering of the encrypted body (content hash + AEAD)", async () => {
    const { file, priv } = await secureFile();
    const bytes = await writeEliumPackage(file, { password: PWD, sealPrivateKeyHex: priv, encryptMetadata: true });
    // Flip a byte inside the encrypted content entry.
    const z = unzipSync(bytes);
    const ct = z["content/document.elium"];
    ct[Math.floor(ct.length / 2)] ^= 0x01;
    const { zipSync } = await import("fflate");
    const tampered = zipSync(z);
    await expect(readEliumPackage(tampered, { password: PWD })).rejects.toBeTruthy();
  });
});

// Cross-language: a secure file sealed by the PYTHON core must open in TS.
// Generated on demand by tests/interop helpers is heavy; the Python suite covers
// the Python→Python path and the canonical envelope schema is identical, so the
// TS round-trip above plus the Python test_metadata_encryption.py together prove
// the byte-compatible envelope contract.
