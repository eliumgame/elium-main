import { describe, it, expect } from "vitest";
import { createEliumFile } from "../src/format/document";
import {
  writeEliumPackage, readEliumPackage, looksLikeV4Package, EliumPasswordRequired,
} from "../src/format/elium-package";
import { appendEvent, emptyJournal, verifyJournal } from "../src/format/journal";
import { createDocumentModel } from "../src/format/document";
import { generateIdentity } from "../src/sign/keys";
import { createProof, verifyProof } from "../src/sign/proof";
import type { EliumSignature } from "../src/format/types";

describe("elium package (v4)", () => {
  it("round-trips a standard document", async () => {
    const file = await createEliumFile({ title: "Mon document", profile: "standard" });
    const blob = await writeEliumPackage(file);

    expect(looksLikeV4Package(blob)).toBe(true);
    const { file: out, integrity } = await readEliumPackage(blob);

    expect(out.manifest.profile).toBe("standard");
    expect(out.manifest.format).toBe("elium");
    expect(out.manifest.formatVersion).toBe(4);
    expect(out.document).toEqual(file.document);
    expect(integrity.contentIntact).toBe(true);
  });

  it("requires the correct password for an encrypted document", async () => {
    const file = await createEliumFile({ title: "Secret", profile: "encrypted" });
    const blob = await writeEliumPackage(file, { password: "pw-correct" });

    await expect(readEliumPackage(blob)).rejects.toBeInstanceOf(EliumPasswordRequired);
    await expect(readEliumPackage(blob, { password: "mauvais" })).rejects.toThrow();

    const { file: out } = await readEliumPackage(blob, { password: "pw-correct" });
    expect(out.document).toEqual(file.document);
    expect(out.manifest.protection.encrypted).toBe(true);
  }, 15000);
});

describe("journal", () => {
  it("validates an intact chain and detects tampering", async () => {
    let j = emptyJournal();
    j = await appendEvent(j, "document.created", { data: { title: "x" } });
    j = await appendEvent(j, "signature.added", { actor: { name: "Alice" } });

    const ok = await verifyJournal(j);
    expect(ok.valid).toBe(true);
    expect(ok.count).toBe(2);

    j.events[0].data = { title: "y" }; // tamper
    const bad = await verifyJournal(j);
    expect(bad.valid).toBe(false);
    expect(bad.brokenAt).toBe(0);
  });
});

describe("signature proof", () => {
  const signer = { name: "Alice", role: "Directrice", date: "2026-06-09" };

  async function sign() {
    const model = createDocumentModel();
    const id = await generateIdentity();
    const proof = await createProof({ signatureId: "sig_1", model, signer, privateKeyHex: id.privateKeyHex });
    const sig: EliumSignature = {
      id: "sig_1", kind: "typed", visual: { text: "Alice" },
      placement: { page: 1, xPct: 0, yPct: 0, wPct: 0.3, hPct: 0.1, rotation: 0, z: 0, anchorType: "page" },
      signer, proof, level: "advanced", createdAt: "2026-06-09T00:00:00Z",
    };
    return { model, id, sig };
  }

  it("verifies a valid proof", async () => {
    const { model, sig } = await sign();
    expect(await verifyProof(sig, model)).toBe("valid");
  });

  it("attributes trust to the right key", async () => {
    const { model, id, sig } = await sign();
    expect(await verifyProof(sig, model, id.publicKeyHex)).toBe("valid");
    expect(await verifyProof(sig, model, "00".repeat(32))).toBe("unknown_key");
  });

  it("detects modification after signing", async () => {
    const { sig } = await sign();
    const changed = createDocumentModel({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "changé" }] }] });
    expect(await verifyProof(sig, changed)).toBe("modified");
  });

  it("rejects a tampered signature", async () => {
    const { model, sig } = await sign();
    const tampered: EliumSignature = { ...sig, proof: { ...sig.proof!, signatureHex: "00" + sig.proof!.signatureHex.slice(2) } };
    expect(await verifyProof(tampered, model)).toBe("invalid");
  });

  it("reports visual-only signatures", async () => {
    const model = createDocumentModel();
    const sig: EliumSignature = {
      id: "v", kind: "drawn", visual: { image: "data:," },
      placement: { page: 1, xPct: 0, yPct: 0, wPct: 0.3, hPct: 0.1, rotation: 0, z: 0, anchorType: "page" },
      signer: {}, proof: null, level: "visual", createdAt: "2026-06-09T00:00:00Z",
    };
    expect(await verifyProof(sig, model)).toBe("visual_only");
  });
});
