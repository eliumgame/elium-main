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

// A MULTI-RECIPIENT `.elium` SEALED BY THE PYTHON CORE. Its sealed subset
// INCLUDES protection.recipients; if TS verifies it, the recipient-bound subset
// is byte-identical across the two implementations.
const PY_PUBKEY_REC = "41c4a57e97ff2603e97d3572fc0cb71dba14f63aa39fde8ef9327ac0d65b384a";
const PY_B64_REC =
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
    expect(
      await verifySeal({ ...manifest, modifiedAt: "2099-01-01T00:00:00Z", generator: "x2" }, signatures, journal),
    ).toBe("valid");

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
    expect(await verifySeal({ ...manifest, accessExpiresAt: "2099-01-01T00:00:00Z" }, signatures, journal)).toBe(
      "broken",
    );
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

  it("seals and authenticates docId (current files)", async () => {
    const id = await generateIdentity();
    const journal = emptyJournal();
    const manifest = { ...baseManifest(), docId: "doc-123" };
    manifest.seal = await createSeal(manifest, [], journal, id.privateKeyHex!);

    expect(await verifySeal(manifest, [], journal)).toBe("valid");
    // Swapping docId now breaks the seal — it can no longer be silently re-keyed
    // to dodge the local seal-TOFU (see seal-pinning).
    expect(await verifySeal({ ...manifest, docId: "doc-999" }, [], journal)).toBe("broken");
    // Removing docId entirely also breaks it.
    const { docId: _drop, ...noDoc } = manifest;
    expect(await verifySeal(noDoc as EliumManifest, [], journal)).toBe("broken");
  });

  it("legacy seal (docId not covered) still verifies via double-mode", async () => {
    const id = await generateIdentity();
    const journal = emptyJournal();
    // A seal computed BEFORE docId was covered (a file with no docId at seal time).
    const legacy = baseManifest();
    const seal = await createSeal(legacy, [], journal, id.privateKeyHex!);
    // A later app version stamped a docId onto the same file; the seal predates it.
    const manifest = { ...legacy, docId: "doc-legacy", seal } as EliumManifest;
    expect(await verifySeal(manifest, [], journal)).toBe("valid"); // fallback rescues it
  });

  it("seals and authenticates the recipient set (multi-recipient files)", async () => {
    const id = await generateIdentity();
    const journal = emptyJournal();
    const base = baseManifest();
    const manifest = {
      ...base,
      docId: "doc-r",
      protection: {
        ...base.protection,
        encrypted: true,
        contentEntry: "content/document.elium",
        recipients: ["fpra", "fprb"],
      },
    } as EliumManifest;
    manifest.seal = await createSeal(manifest, [], journal, id.privateKeyHex!);

    expect(await verifySeal(manifest, [], journal)).toBe("valid");
    const withRecipients = (recipients: string[]) =>
      ({ ...manifest, protection: { ...manifest.protection, recipients } }) as EliumManifest;
    // Removing / adding / reordering a displayed recipient all break the seal.
    expect(await verifySeal(withRecipients(["fpra"]), [], journal)).toBe("broken");
    expect(await verifySeal(withRecipients(["fpra", "fprb", "fprc"]), [], journal)).toBe("broken");
    expect(await verifySeal(withRecipients(["fprb", "fpra"]), [], journal)).toBe("broken");
    // Dropping the list entirely too.
    const prot = { ...manifest.protection };
    delete (prot as { recipients?: string[] }).recipients;
    expect(await verifySeal({ ...manifest, protection: prot }, [], journal)).toBe("broken");
  });

  it("legacy recipient seal (recipients not covered) still verifies via fallback", async () => {
    const id = await generateIdentity();
    const journal = emptyJournal();
    const base = baseManifest();
    // Seal a recipient file BEFORE recipients were covered: none present at seal
    // time, so the signature is over the recipients-free form.
    const legacy = {
      ...base,
      docId: "doc-r",
      protection: { ...base.protection, encrypted: true, contentEntry: "content/document.elium" },
    } as EliumManifest;
    const seal = await createSeal(legacy, [], journal, id.privateKeyHex!);
    // A later version stamped the recipient list onto the same file; the seal predates it.
    const manifest = {
      ...legacy,
      protection: { ...legacy.protection, recipients: ["fpra", "fprb"] },
      seal,
    } as EliumManifest;
    expect(await verifySeal(manifest, [], journal)).toBe("valid"); // recipients:false fallback rescues
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

  it("verifies a Python-sealed MULTI-RECIPIENT seal (recipients in the sealed subset)", async () => {
    const entries = unzipSync(b64ToBytes(PY_B64_REC));
    const td = new TextDecoder();
    const manifest = JSON.parse(td.decode(entries["manifest.json"]));
    const signatures = JSON.parse(td.decode(entries["signatures/signatures.json"]));
    const journal = JSON.parse(td.decode(entries["tracking/journal.json"]));
    expect(manifest.protection.recipients).toHaveLength(2);
    // Seal made by the Python core over a subset that INCLUDES recipients; if TS
    // verifies it, the recipient-bound subset is byte-identical cross-language.
    expect(await verifySeal(manifest, signatures, journal)).toBe("valid");
    expect(await verifySeal(manifest, signatures, journal, PY_PUBKEY_REC)).toBe("valid");
    // Tampering the displayed recipient list breaks the Python seal read by TS.
    const tampered = {
      ...manifest,
      protection: { ...manifest.protection, recipients: [manifest.protection.recipients[0]] },
    };
    expect(await verifySeal(tampered, signatures, journal)).toBe("broken");
  });
});
