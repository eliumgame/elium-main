import { describe, it, expect } from "vitest";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { readEliumPackage } from "../src/format/elium-package";
import { createSeal, verifySeal } from "../src/sign/seal";
import { generateIdentity } from "../src/sign/keys";
import { emptyJournal, appendEvent } from "../src/format/journal";
import type { EliumManifest, EliumSignature } from "../src/format/types";

// A `tracked` .elium SEALED BY THE PYTHON CORE (elium-py). If the TS reader can
// verify this seal, the canonical "to-be-sealed" bytes match byte-for-byte
// across the two implementations (interop guarantee).
const PY_PUBKEY = "96dc0e0d361429ac4a11e3e28ed5aca7b5cf5001efb8981745d62e1481ac3b05";
const PY_B64 =
  "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";

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, "base64"));
}

function baseManifest(): EliumManifest {
  return {
    format: "elium",
    formatVersion: 4,
    profile: "tracked",
    generator: "test",
    createdAt: "2026-01-01T00:00:00Z",
    modifiedAt: "2026-01-01T00:00:00Z",
    title: "T",
    language: "fr",
    protection: { encrypted: false, locked: false, keyfileRequired: false, contentEntry: "content/document.json" },
    integrity: { algorithm: "sha-256", contentHash: "ab".repeat(32) },
    features: { signatures: false, tracking: true, resources: 0 },
    rgpd: { localOnly: true, storedPersonalData: [], notice: "x" },
  };
}

describe("document seal (TypeScript)", () => {
  it("round-trips and detects every tampering vector", async () => {
    const id = await generateIdentity();
    const signatures: EliumSignature[] = [];
    let journal = emptyJournal();
    journal = await appendEvent(journal, "document.created", { at: "2026-01-01T00:00:00Z" });

    const manifest = baseManifest();
    manifest.seal = await createSeal(manifest, signatures, journal, id.privateKeyHex!);

    expect(await verifySeal(manifest, signatures, journal)).toBe("valid");
    expect(await verifySeal(manifest, signatures, journal, id.publicKeyHex)).toBe("valid");
    expect(await verifySeal(manifest, signatures, journal, "00".repeat(32))).toBe("unknown_key");

    // F-2 journal rewrite
    const j2 = await appendEvent(journal, "document.locked", { at: "2026-02-02T00:00:00Z" });
    expect(await verifySeal(manifest, signatures, j2)).toBe("broken");

    // F-6 profile/badge spoof
    expect(await verifySeal({ ...manifest, profile: "secure_max" }, signatures, journal)).toBe("broken");

    // F-1 content hash swap
    const m2 = { ...manifest, integrity: { ...manifest.integrity, contentHash: "cd".repeat(32) } };
    expect(await verifySeal(m2, signatures, journal)).toBe("broken");

    // re-save changing only volatile fields must NOT break the seal
    expect(await verifySeal({ ...manifest, modifiedAt: "2099-01-01T00:00:00Z", generator: "x2" }, signatures, journal)).toBe("valid");

    // unsealed
    const { seal: _drop, ...unsealed } = manifest;
    expect(await verifySeal(unsealed as EliumManifest, signatures, journal)).toBe("unsealed");
  });

  it("the seal authenticates the access-expiry date", async () => {
    const id = await generateIdentity();
    const signatures: EliumSignature[] = [];
    const journal = emptyJournal();
    const manifest = baseManifest();
    manifest.accessExpiresAt = "2026-12-31T23:59:59Z";
    manifest.seal = await createSeal(manifest, signatures, journal, id.privateKeyHex!);

    expect(await verifySeal(manifest, signatures, journal)).toBe("valid");
    // Changing the expiry after sealing breaks the seal.
    expect(await verifySeal({ ...manifest, accessExpiresAt: "2099-01-01T00:00:00Z" }, signatures, journal)).toBe("broken");
    // Removing it entirely also breaks the seal.
    const { accessExpiresAt: _drop, ...noExpiry } = manifest;
    expect(await verifySeal(noExpiry as EliumManifest, signatures, journal)).toBe("broken");
  });

  it("a seal without expiry is unaffected (no subset drift)", async () => {
    const id = await generateIdentity();
    const journal = emptyJournal();
    const manifest = baseManifest();
    manifest.seal = await createSeal(manifest, [], journal, id.privateKeyHex!);
    // Adding an (unsigned) expiry to a seal that didn't include one breaks it.
    expect(await verifySeal({ ...manifest, accessExpiresAt: "2027-01-01T00:00:00Z" }, [], journal)).toBe("broken");
    // …but the untouched manifest still verifies.
    expect(await verifySeal(manifest, [], journal)).toBe("valid");
  });

  it("verifies a seal produced by the Python core (cross-language interop)", async () => {
    const bytes = b64ToBytes(PY_B64);
    const r = await readEliumPackage(bytes);
    expect(r.seal.verdict).toBe("valid");
    expect(r.seal.fingerprint).toBeTruthy();

    const trusted = await readEliumPackage(bytes, { trustedKeyHex: PY_PUBKEY });
    expect(trusted.seal.verdict).toBe("valid");

    const wrongKey = await readEliumPackage(bytes, { trustedKeyHex: "00".repeat(32) });
    expect(wrongKey.seal.verdict).toBe("unknown_key");
  });

  it("detects tampering of a Python-sealed file when read by TS", async () => {
    const entries = unzipSync(b64ToBytes(PY_B64));
    const manifest = JSON.parse(new TextDecoder().decode(entries["manifest.json"]));
    manifest.profile = "secure_max"; // spoof the badge, keep the seal
    const rebuilt: Record<string, Uint8Array> = {};
    for (const [name, data] of Object.entries(entries)) {
      rebuilt[name] = name === "manifest.json" ? strToU8(JSON.stringify(manifest)) : (data as Uint8Array);
    }
    const r = await readEliumPackage(zipSync(rebuilt));
    expect(r.seal.verdict).toBe("broken");
  });
});
