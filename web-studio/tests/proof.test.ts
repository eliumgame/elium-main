import { describe, it, expect } from "vitest";
import { createProof, verifyProof } from "../src/sign/proof";
import { generateIdentity } from "../src/sign/keys";
import { createEliumFile } from "../src/format/document";
import type { EliumDocumentModel, EliumSignature, SignatureProof, SignaturePlacement, SignatureVisual } from "../src/format/types";

const PLACEMENT: SignaturePlacement = { page: 1, xPct: 0.3, yPct: 0.7, wPct: 0.3, hPct: 0.1, rotation: 0, z: 0, anchorType: "page" };

function sig(proof: SignatureProof, placement: SignaturePlacement, visual: SignatureVisual): EliumSignature {
  return { id: "sig-1", kind: "typed", visual, placement, signer: { name: "Bob" }, proof, level: "advanced", createdAt: proof.signedAt };
}

async function setup() {
  const { document: model } = await createEliumFile({ title: "T", profile: "signed" });
  const id = await generateIdentity();
  return { model, id };
}

describe("signature proof binds placement + visual (v2)", () => {
  it("is valid when placement & visual are unchanged", async () => {
    const { model, id } = await setup();
    const proof = await createProof({ signatureId: "sig-1", model, signer: { name: "Bob" }, privateKeyHex: id.privateKeyHex!, placement: PLACEMENT, visual: { text: "Bob" } });
    expect(proof.signedPlacement).toBeTruthy(); // v2
    expect(await verifyProof(sig(proof, PLACEMENT, { text: "Bob" }), model)).toBe("valid");
  });

  it("is 'modified' when the signature is moved", async () => {
    const { model, id } = await setup();
    const proof = await createProof({ signatureId: "sig-1", model, signer: { name: "Bob" }, privateKeyHex: id.privateKeyHex!, placement: PLACEMENT, visual: { text: "Bob" } });
    expect(await verifyProof(sig(proof, { ...PLACEMENT, xPct: 0.9, page: 2 }, { text: "Bob" }), model)).toBe("modified");
  });

  it("is 'modified' when the appearance is altered", async () => {
    const { model, id } = await setup();
    const proof = await createProof({ signatureId: "sig-1", model, signer: { name: "Bob" }, privateKeyHex: id.privateKeyHex!, placement: PLACEMENT, visual: { text: "Bob" } });
    expect(await verifyProof(sig(proof, PLACEMENT, { text: "Eve" }), model)).toBe("modified");
  });

  it("still detects a document body change", async () => {
    const { model, id } = await setup();
    const proof = await createProof({ signatureId: "sig-1", model, signer: { name: "Bob" }, privateKeyHex: id.privateKeyHex!, placement: PLACEMENT, visual: { text: "Bob" } });
    const changed = { ...model, page: { ...model.page, numberedHeadings: !model.page.numberedHeadings } } as EliumDocumentModel;
    expect(await verifyProof(sig(proof, PLACEMENT, { text: "Bob" }), changed)).toBe("modified");
  });

  it("legacy proof (no snapshots) does NOT cover placement/visual (backward compat)", async () => {
    const { model, id } = await setup();
    const legacy = await createProof({ signatureId: "sig-1", model, signer: { name: "Bob" }, privateKeyHex: id.privateKeyHex! }); // v1: no placement/visual
    expect(legacy.signedPlacement).toBeUndefined();
    // Moving / re-skinning a legacy signature stays "valid" — its proof never bound them.
    expect(await verifyProof(sig(legacy, { ...PLACEMENT, xPct: 0.95 }, { text: "Zzz" }), model)).toBe("valid");
  });

  it("cannot be downgraded by stripping the snapshot from a v2 proof", async () => {
    const { model, id } = await setup();
    const proof = await createProof({ signatureId: "sig-1", model, signer: { name: "Bob" }, privateKeyHex: id.privateKeyHex!, placement: PLACEMENT, visual: { text: "Bob" } });
    const stripped: SignatureProof = { ...proof };
    delete stripped.signedPlacement;
    delete stripped.signedVisual;
    // Removing the snapshots changes the reconstructed message → signature no longer verifies.
    expect(await verifyProof(sig(stripped, PLACEMENT, { text: "Bob" }), model)).toBe("invalid");
  });
});
