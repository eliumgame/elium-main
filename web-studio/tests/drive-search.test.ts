/**
 * Unit tests for `searchDriveTree` (drive-cloud/ops.ts) — recursive,
 * client-side Drive search (constat P2 de l'audit Drive & Parapheur : pas
 * d'index chiffré serveur, donc la recherche parcourt + déchiffre l'arbre
 * depuis le navigateur, dossier par dossier, comme `listFolder`).
 *
 * Names are end-to-end encrypted, so this builds a REAL encrypted mini-tree
 * (same crypto helpers as production — node-crypto.ts / crypto/recipients.ts)
 * behind a mocked `ctx.api.listChildren`, keyed by parentId — same pattern as
 * tests/a11y.spec.ts's `mockSignLink` for building genuine ciphertext without
 * a real server.
 */
import { describe, it, expect, vi } from "vitest";
import { searchDriveTree, type OpsCtx } from "../src/drive-cloud/ops";
import { generateNodeKey, wrapNodeKeyFor, encryptName } from "../src/drive-cloud/node-crypto";
import { generateRecipientKeypair } from "../src/crypto/recipients";
import type { NodeMeta } from "../src/drive-cloud/types";

const ORG = "org-1";

async function makeNode(over: {
  id: string;
  parentId: string | null;
  name: string;
  kind?: "folder" | "file";
  recipientPublicHex: string;
}): Promise<NodeMeta> {
  const nodeKey = generateNodeKey();
  const enc = await encryptName(nodeKey, over.name);
  const myWrappedKey = await wrapNodeKeyFor(nodeKey, over.recipientPublicHex);
  return {
    id: over.id,
    orgId: ORG,
    parentId: over.parentId,
    kind: over.kind ?? "file",
    ownerUserId: "u1",
    nameEncrypted: enc.nameEncrypted,
    nameNonce: enc.nameNonce,
    metaEncrypted: null,
    metaNonce: null,
    appKind: null,
    sizeBytes: 0,
    hasContent: over.kind !== "folder",
    contentNonce: null,
    trashedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    myWrappedKey,
  };
}

/**
 * A small encrypted org tree:
 *   / Contrats/                      (F1)
 *       Résumé.pdf                   (A)
 *       Archive/                     (F2)
 *           Résumé ancien.pdf        (B)
 *   / Résumé.docx                    (C)
 *   / Secret/                        (F3, listChildren rejects — no ACL)
 */
async function buildCtx(): Promise<OpsCtx> {
  const kp = await generateRecipientKeypair();
  const pub = kp.publicHex;

  const root = [
    await makeNode({ id: "F1", parentId: null, name: "Contrats", kind: "folder", recipientPublicHex: pub }),
    await makeNode({ id: "C", parentId: null, name: "Résumé.docx", recipientPublicHex: pub }),
    await makeNode({ id: "F3", parentId: null, name: "Secret", kind: "folder", recipientPublicHex: pub }),
  ];
  const f1 = [
    await makeNode({ id: "A", parentId: "F1", name: "Résumé.pdf", recipientPublicHex: pub }),
    await makeNode({ id: "F2", parentId: "F1", name: "Archive", kind: "folder", recipientPublicHex: pub }),
  ];
  const f2 = [await makeNode({ id: "B", parentId: "F2", name: "Résumé ancien.pdf", recipientPublicHex: pub })];

  const listChildren = vi.fn(async (_orgId: string, parentId?: string) => {
    if (parentId === undefined) return { nodes: root };
    if (parentId === "F1") return { nodes: f1 };
    if (parentId === "F2") return { nodes: f2 };
    if (parentId === "F3") throw new Error("403 forbidden");
    return { nodes: [] };
  });

  return {
    api: { listChildren } as unknown as OpsCtx["api"],
    keys: { recipient: kp, identity: { privateKeyHex: "", publicKeyHex: "", fingerprint: "" } },
    userId: "u1",
    orgId: ORG,
    orgPublicHex: "",
    roleIdByKey: {},
  };
}

describe("searchDriveTree", () => {
  it("finds matches across every folder, accent/case-insensitively, with the right ancestor path", async () => {
    const ctx = await buildCtx();
    const hits = await searchDriveTree(ctx, "resume"); // no accent, no case match
    const byId = new Map(hits.map((h) => [h.id, h]));

    expect(byId.size).toBe(3);
    expect(byId.get("A")?.parentPath).toEqual([{ id: "F1", name: "Contrats" }]);
    expect(byId.get("B")?.parentPath).toEqual([
      { id: "F1", name: "Contrats" },
      { id: "F2", name: "Archive" },
    ]);
    expect(byId.get("C")?.parentPath).toEqual([]);
  });

  it("skips a folder it can't list (403/ACL) instead of aborting the whole search", async () => {
    const ctx = await buildCtx();
    // "Secret" itself doesn't match "resume", but confirms the throwing branch
    // (F3) doesn't stop the walk from finding the rest.
    const hits = await searchDriveTree(ctx, "resume");
    expect(hits.some((h) => h.parentPath.some((p) => p.id === "F3"))).toBe(false);
    expect(hits.length).toBeGreaterThan(0);
  });

  it("returns [] for an empty/whitespace-only query without listing anything", async () => {
    const ctx = await buildCtx();
    const listChildren = ctx.api.listChildren as unknown as ReturnType<typeof vi.fn>;
    expect(await searchDriveTree(ctx, "   ")).toEqual([]);
    expect(listChildren).not.toHaveBeenCalled();
  });

  it("caps traversal at maxFolders", async () => {
    const ctx = await buildCtx();
    // 1 folder budget: only the root call happens, "Contrats"/"Secret" are
    // queued but never visited — so their content ("Résumé.pdf" etc.) is
    // absent, while the root-level "Résumé.docx" is still found.
    const hits = await searchDriveTree(ctx, "resume", { maxFolders: 1 });
    expect(hits.map((h) => h.id)).toEqual(["C"]);
    const listChildren = ctx.api.listChildren as unknown as ReturnType<typeof vi.fn>;
    expect(listChildren).toHaveBeenCalledTimes(1);
  });
});
