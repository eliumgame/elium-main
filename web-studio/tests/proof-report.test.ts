import { describe, it, expect } from "vitest";
import { createEliumFile, addSignature } from "../src/format/document";
import { buildProofReport } from "../src/export/exporters";
import { createProof } from "../src/sign/proof";
import { generateIdentity } from "../src/sign/keys";
import type { EliumSignature } from "../src/format/types";

const PLACEMENT = { page: 1, xPct: 0.3, yPct: 0.7, wPct: 0.3, hPct: 0.1, rotation: 0, z: 0, anchorType: "page" as const };

describe("export — buildProofReport", () => {
  it("aggregates integrity, journal validity and signature verdicts + proof detail", async () => {
    const id = await generateIdentity();
    let file = await createEliumFile({ title: "Rapport", profile: "signed" });
    const proof = await createProof({ signatureId: "s1", model: file.document, signer: { name: "Alice" }, privateKeyHex: id.privateKeyHex! });
    const sig: EliumSignature = {
      id: "s1", kind: "typed", visual: { text: "Alice" }, placement: PLACEMENT,
      signer: { name: "Alice" }, proof, level: "advanced", createdAt: proof.signedAt,
    };
    file = await addSignature(file, sig);

    const report = await buildProofReport(file, { s1: "valid" });
    expect(report.report).toBe("elium-proof-report");
    expect(report.version).toBe(1);
    expect((report.document as { title: string }).title).toBe("Rapport");
    expect((report.journal as { valid: boolean }).valid).toBe(true);
    const sigs = report.signatures as Array<{ verdict: string; proof: { fingerprint: string } | null }>;
    expect(sigs).toHaveLength(1);
    expect(sigs[0].verdict).toBe("valid");
    expect(sigs[0].proof?.fingerprint).toBe(id.fingerprint);
  });

  it("defaults unknown/unsigned entries to visual_only and reports document meta", async () => {
    const file = await createEliumFile({ title: "Sans signature", profile: "standard" });
    const report = await buildProofReport(file, {});
    expect((report.document as { title: string }).title).toBe("Sans signature");
    expect(report.signatures).toEqual([]);
    expect(String(report.notice)).toContain("eIDAS");
  });
});
