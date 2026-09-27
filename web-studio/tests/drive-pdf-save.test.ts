/**
 * A Drive PDF saved from the PDF module (`saveNewVersion`, drive-cloud/ops.ts):
 * encrypted with the node's CURRENT key (re-read, so a key rotation is
 * followed), sent with its key epoch, and refused when the file changed in
 * the Drive since it was opened — unless the user chose to overwrite.
 */
import { describe, expect, it, vi } from "vitest";
import { DriveConflict, isPdfEntry, saveNewVersion, type OpsCtx } from "../src/drive-cloud/ops";
import { decryptContent, generateNodeKey, wrapNodeKeyFor } from "../src/drive-cloud/node-crypto";
import { generateRecipientKeypair } from "../src/crypto/recipients";
import { driveDestination } from "../src/pdf/core/destination";

async function setup(modifiedAt: string) {
  const kp = await generateRecipientKeypair();
  const nodeKey = generateNodeKey();
  const myWrappedKey = await wrapNodeKeyFor(nodeKey, kp.publicHex);
  const put = vi.fn(async (id: string, ciphertext: Uint8Array, nonceHex: string, keyEpoch?: number) => ({
    node: { id, modifiedAt: "2026-09-27T10:00:00.000Z", ciphertext, nonceHex, keyEpoch },
  }));
  const ctx = {
    api: {
      getNode: vi.fn(async (id: string) => ({ node: { id, modifiedAt, keyEpoch: 3 }, myWrappedKey, permissions: [] })),
      putContent: put,
    } as unknown as OpsCtx["api"],
    keys: { recipient: kp, identity: { privateKeyHex: "", publicKeyHex: "", fingerprint: "" } },
    userId: "u1",
    orgId: "org-1",
    orgPublicHex: "",
    roleIdByKey: {},
  } satisfies OpsCtx;
  return { ctx, put, nodeKey };
}

describe("PDF saved back to the Drive", () => {
  it("uploads the bytes encrypted with the node key, with the key epoch", async () => {
    const { ctx, put, nodeKey } = await setup("2026-09-27T09:00:00.000Z");
    const pdf = new TextEncoder().encode("%PDF-1.7 contenu");
    const node = await saveNewVersion(ctx, "n1", pdf, { expectedModifiedAt: "2026-09-27T09:00:00.000Z" });
    expect(node.modifiedAt).toBe("2026-09-27T10:00:00.000Z");
    const [id, ciphertext, nonceHex, epoch] = put.mock.calls[0]!;
    expect(id).toBe("n1");
    expect(epoch).toBe(3);
    expect(await decryptContent(nodeKey, nonceHex, ciphertext)).toEqual(pdf);
  });

  it("refuses to overwrite a file changed in the Drive meanwhile, unless forced", async () => {
    const { ctx, put } = await setup("2026-09-27T09:30:00.000Z");
    const pdf = new TextEncoder().encode("%PDF-1.7");
    await expect(saveNewVersion(ctx, "n1", pdf, { expectedModifiedAt: "2026-09-27T09:00:00.000Z" })).rejects.toThrow(
      DriveConflict,
    );
    expect(put).not.toHaveBeenCalled();
    await saveNewVersion(ctx, "n1", pdf, { expectedModifiedAt: "2026-09-27T09:00:00.000Z", force: true });
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("recognises PDFs and gives a persistent « drive » destination", () => {
    expect(isPdfEntry({ kind: "file", appKind: "pdf", name: "x" })).toBe(true);
    expect(isPdfEntry({ kind: "file", appKind: null, name: "Contrat.PDF" })).toBe(true);
    expect(isPdfEntry({ kind: "folder", appKind: null, name: "a.pdf" })).toBe(false);
    const dest = driveDestination({ name: "Contrat.pdf", write: async () => {} });
    expect(dest.kind).toBe("drive");
    expect(dest.persistent).toBe(true);
    expect(dest.label).toBe("Contrat.pdf (Drive)");
  });
});
