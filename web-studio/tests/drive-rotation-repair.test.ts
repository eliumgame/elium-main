/**
 * Rotation interrompue (après la bascule d'ACL, avant le ré-chiffrement des blobs) :
 *  - les ayants droit lisent encore le contenu via la fente « clé précédente » ;
 *  - l'ouverture du fichier termine la rotation (versions ré-chiffrées sous la clé courante).
 */
import { describe, expect, it, vi } from "vitest";
import { decryptNodeBlob, type OpsCtx, type DriveEntry } from "../src/drive-cloud/ops";
import { repairInterruptedRotation } from "../src/drive-cloud/rotate";
import { decryptContent, encryptContent, generateNodeKey, wrapNodeKeyFor } from "../src/drive-cloud/node-crypto";
import { generateRecipientKeypair } from "../src/crypto/recipients";
import { toHex } from "../src/format/canonical";

describe("rotation interrompue", () => {
  it("decryptNodeBlob se replie sur la clé précédente", async () => {
    const oldKey = generateNodeKey();
    const newKey = generateNodeKey();
    const slot = await encryptContent(newKey, oldKey);
    const blob = await encryptContent(oldKey, new TextEncoder().encode("contrat"));
    const entry = { prevKeyWrapped: toHex(slot.ciphertext), prevKeyNonce: slot.nonceHex };
    const plain = await decryptNodeBlob(newKey, entry, blob.nonceHex, blob.ciphertext);
    expect(new TextDecoder().decode(plain)).toBe("contrat");
    await expect(decryptNodeBlob(newKey, {}, blob.nonceHex, blob.ciphertext)).rejects.toThrow();
  });

  it("repairInterruptedRotation ré-chiffre les versions restées sur l'ancienne époque", async () => {
    const me = await generateRecipientKeypair();
    const oldKey = generateNodeKey();
    const newKey = generateNodeKey();
    const slot = await encryptContent(newKey, oldKey);
    const blob = await encryptContent(oldKey, new TextEncoder().encode("v1"));
    const store: Record<string, { bytes: Uint8Array; nonceHex: string }> = {
      v1: { bytes: blob.ciphertext, nonceHex: blob.nonceHex },
    };
    const api = {
      listVersions: vi.fn(async () => ({ versions: [{ id: "v1", keyEpoch: 1 }] })),
      getVersionContent: vi.fn(async (_n: string, v: string) => store[v]!),
      putVersionContent: vi.fn(async (_n: string, v: string, bytes: Uint8Array, nonceHex: string) => {
        store[v] = { bytes, nonceHex };
      }),
      myGroups: async () => ({ groups: [] }),
    };
    const ctx = {
      api: api as unknown as OpsCtx["api"],
      keys: { recipient: me, identity: { privateKeyHex: "", publicKeyHex: "", fingerprint: "" } },
      userId: "me",
      orgId: "o",
      orgPublicHex: "",
      roleIdByKey: {},
    } satisfies OpsCtx;
    const entry = {
      id: "n",
      kind: "file",
      keyEpoch: 2,
      appKind: null,
      prevKeyWrapped: toHex(slot.ciphertext),
      prevKeyNonce: slot.nonceHex,
      myWrappedKey: await wrapNodeKeyFor(newKey, me.publicHex),
    } as unknown as DriveEntry;
    const r = await repairInterruptedRotation(ctx, entry);
    expect(r).toMatchObject({ fixed: 1, remaining: 0 });
    expect(new TextDecoder().decode(await decryptContent(newKey, store.v1!.nonceHex, store.v1!.bytes))).toBe("v1");
  });
});
