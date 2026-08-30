/**
 * Unit tests for the link-signature crypto chain (drive-cloud/ops.ts):
 * `openSignLink` (resolve → unwrap the node CEK → decrypt name/content) and
 * `submitSignedElium` (re-encrypt the signed artifact under the SAME CEK →
 * submit). This chain has no server involved and is only ever exercised
 * indirectly through Playwright's mocked HTTP routes (tests/a11y.spec.ts) —
 * this covers it directly, at the crypto level, matching the pattern already
 * used for the local circuit bridge in tests/parapheur-bridge.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { openSignLink, submitSignedElium } from "../src/drive-cloud/ops";
import {
  generateNodeKey,
  wrapNodeKeyFor,
  encryptName,
  encryptContent,
  decryptContent,
} from "../src/drive-cloud/node-crypto";
import { generateRecipientKeypair } from "../src/crypto/recipients";
import type { DriveApi } from "../src/drive-cloud/api";
import type { NodeMeta } from "../src/drive-cloud/types";

async function baseNode(over: Partial<NodeMeta> = {}): Promise<{ nodeKey: Uint8Array; node: NodeMeta }> {
  const nodeKey = generateNodeKey();
  const enc = await encryptName(nodeKey, "Contrat.elium");
  const node: NodeMeta = {
    id: "n1",
    orgId: "org-1",
    parentId: null,
    kind: "file",
    ownerUserId: "u1",
    nameEncrypted: enc.nameEncrypted,
    nameNonce: enc.nameNonce,
    metaEncrypted: null,
    metaNonce: null,
    appKind: "elium",
    sizeBytes: 0,
    hasContent: true,
    contentNonce: null,
    trashedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
  return { nodeKey, node };
}

describe("openSignLink", () => {
  it("resolves the link, unwraps the node CEK, and decrypts name + content", async () => {
    const kp = await generateRecipientKeypair(); // le keypair PROPRE au lien (issu du fragment #k=)
    const { nodeKey, node } = await baseNode();
    const wrappedKey = await wrapNodeKeyFor(nodeKey, kp.publicHex);
    const plaintext = new TextEncoder().encode("contenu du document signable");
    const content = await encryptContent(nodeKey, plaintext);

    const resolveLink = vi.fn(async () => ({ node, wrappedKey, hasPassword: false, roleKey: "signer" }));
    const getLinkContent = vi.fn(async () => ({ bytes: content.ciphertext, nonceHex: content.nonceHex }));
    const api = { resolveLink, getLinkContent } as unknown as DriveApi;

    const opened = await openSignLink(api, "tok-1", kp.privateHex, kp.publicHex);

    expect(resolveLink).toHaveBeenCalledWith("tok-1");
    expect(getLinkContent).toHaveBeenCalledWith("tok-1");
    expect(opened.name).toBe("Contrat.elium");
    expect(opened.kind).toBe("file");
    expect(opened.hasContent).toBe(true);
    expect(opened.bytes).toEqual(plaintext);
    expect(opened.nodeKey).toEqual(nodeKey);
  });

  it("does not fetch content for a folder link, or a file link with no content yet", async () => {
    const kp = await generateRecipientKeypair();
    const { nodeKey, node } = await baseNode({ kind: "folder", hasContent: false });
    const wrappedKey = await wrapNodeKeyFor(nodeKey, kp.publicHex);
    const getLinkContent = vi.fn();
    const api = {
      resolveLink: vi.fn(async () => ({ node, wrappedKey, hasPassword: false, roleKey: "signer" })),
      getLinkContent,
    } as unknown as DriveApi;

    const opened = await openSignLink(api, "tok-2", kp.privateHex, kp.publicHex);
    expect(getLinkContent).not.toHaveBeenCalled();
    expect(opened.bytes).toEqual(new Uint8Array(0));
  });

  it("rejects when the fragment's private key doesn't match the wrapped key's recipient", async () => {
    const kp = await generateRecipientKeypair();
    const wrongKp = await generateRecipientKeypair();
    const { nodeKey, node } = await baseNode();
    const wrappedKey = await wrapNodeKeyFor(nodeKey, kp.publicHex); // wrappé pour `kp`...

    const api = {
      resolveLink: vi.fn(async () => ({ node, wrappedKey, hasPassword: false, roleKey: "signer" })),
      getLinkContent: vi.fn(),
    } as unknown as DriveApi;

    // ...mais on tente de déverrouiller avec `wrongKp` : ne doit jamais réussir
    // silencieusement à produire une fausse clé.
    await expect(openSignLink(api, "tok-3", wrongKp.privateHex, wrongKp.publicHex)).rejects.toThrow();
  });
});

describe("submitSignedElium", () => {
  it("re-encrypts the signed artifact under the SAME node CEK and posts it back", async () => {
    const { nodeKey } = await baseNode();
    const signedBytes = new TextEncoder().encode("document signé (octets .elium re-scellés)");
    const submitSignature = vi.fn(async () => ({ ok: true }));
    const api = { submitSignature } as unknown as DriveApi;

    await submitSignedElium(api, "tok-4", nodeKey, signedBytes, "deadbeef");

    expect(submitSignature).toHaveBeenCalledTimes(1);
    const [token, ciphertext, nonceHex, fpr] = submitSignature.mock.calls[0]!;
    expect(token).toBe("tok-4");
    expect(fpr).toBe("deadbeef");
    // Le ciphertext posté doit redéchiffrer, sous la MÊME CEK, exactement
    // l'artefact signé — pas une autre clé, pas un contenu tronqué/altéré.
    expect(await decryptContent(nodeKey, nonceHex as string, ciphertext as Uint8Array)).toEqual(signedBytes);
  });

  it("forwards no signer fingerprint when none is given", async () => {
    const { nodeKey } = await baseNode();
    const submitSignature = vi.fn(async () => ({ ok: true }));
    const api = { submitSignature } as unknown as DriveApi;

    await submitSignedElium(api, "tok-5", nodeKey, new Uint8Array([1, 2, 3]));

    const [, , , fpr] = submitSignature.mock.calls[0]!;
    expect(fpr).toBeUndefined();
  });
});
