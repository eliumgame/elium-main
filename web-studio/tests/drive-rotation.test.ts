/**
 * Rotation de clé (drive-cloud/rotate.ts) — constats HIGH du lot B :
 *  - un Éditeur (sans `group.view`) ne doit plus effacer les parts des équipes ;
 *  - une part restante non ré-emballable bloque la rotation AVANT la bascule serveur ;
 *  - la compaction collab intègre les mises à jour envoyées sous la NOUVELLE clé par un co-auteur
 *    reconnecté, ne supprime jamais une entrée non intégrée, et une compaction échouée est rattrapée
 *    à la rotation suivante grâce à la fente de clé précédente.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as Y from "yjs";
import {
  compactCollabLog,
  rotateNode,
  rotateTree,
  rotationSummary,
  wrapForRemainingPrincipals,
  RotationIncomplete,
} from "../src/drive-cloud/rotate";
import type { OpsCtx, DriveEntry } from "../src/drive-cloud/ops";
import {
  encryptContent,
  decryptContent,
  generateNodeKey,
  unwrapNodeKey,
  wrapNodeKeyFor,
} from "../src/drive-cloud/node-crypto";
import { generateRecipientKeypair, type RecipientKeypair } from "../src/crypto/recipients";
import { toHex, fromHex } from "../src/format/canonical";
import { setKeyPinStorage } from "../src/drive-cloud/key-pins";
import type { KeyShareInput, ShareInfo } from "../src/drive-cloud/types";

beforeEach(() => setKeyPinStorage(null));

type LogRow = { seq: number; ciphertext: string; nonce: string; author: string | null };

function textUpdate(doc: Y.Doc, text: string): Uint8Array {
  let out: Uint8Array | null = null;
  const h = (u: Uint8Array) => (out = u);
  doc.on("update", h);
  doc.getText("t").insert(doc.getText("t").length, text);
  doc.off("update", h);
  return out!;
}

async function encUpdate(key: Uint8Array, u: Uint8Array, seq: number): Promise<LogRow> {
  const e = await encryptContent(key, u);
  return { seq, ciphertext: toHex(e.ciphertext), nonce: e.nonceHex, author: null };
}

function share(p: Partial<ShareInfo> & Pick<ShareInfo, "principalType" | "principalId">): ShareInfo {
  return {
    id: `s-${p.principalId}`,
    roleId: "r",
    roleKey: "editor",
    roleName: "Éditeur",
    name: "",
    inheritedFrom: null,
    ...p,
  };
}

interface Fixture {
  ctx: OpsCtx;
  me: RecipientKeypair;
  team: RecipientKeypair;
  oldKey: Uint8Array;
  entry: DriveEntry;
  log: LogRow[];
  rotateCalls: { keyShares: KeyShareInput[] }[];
  compactCalls: { upToSeq: number; ciphertext: string; nonce: string }[];
  api: Record<string, ReturnType<typeof vi.fn>>;
}

async function fixture(
  opts: { appKind?: string; shares?: ShareInfo[]; onRotate?: (newKey: Uint8Array) => Promise<void> } = {},
): Promise<Fixture> {
  const me = await generateRecipientKeypair();
  const team = await generateRecipientKeypair();
  const oldKey = generateNodeKey();
  const log: LogRow[] = [];
  const rotateCalls: Fixture["rotateCalls"] = [];
  const compactCalls: Fixture["compactCalls"] = [];
  const shares = opts.shares ?? [
    share({ principalType: "user", principalId: "me" }),
    share({ principalType: "group", principalId: "g-marketing", inheritedFrom: "folder-1" }),
  ];
  const api = {
    listShares: vi.fn(async () => ({ shares })),
    getUser: vi.fn(async (id: string) => {
      if (id === "me") return { user: { id, email: "me@x", p256PublicHex: me.publicHex } };
      throw new Error("réseau");
    }),
    // Éditeur : pas de group.view → 403 ; la route publique group-keys répond.
    listGroups: vi.fn(async () => {
      throw Object.assign(new Error("Forbidden"), { status: 403 });
    }),
    groupKeys: vi.fn(async () => ({ groups: [{ id: "g-marketing", groupPublicHex: team.publicHex }] })),
    myGroups: vi.fn(async () => ({ groups: [] })),
    rotateNode: vi.fn(async (_id: string, body: { keyShares: KeyShareInput[] }) => {
      rotateCalls.push(body);
      const mine = body.keyShares.find((k) => k.principalId === "me")!;
      await opts.onRotate?.(await unwrapNodeKey(mine.wrappedKey, me));
      return { node: { keyEpoch: 2 }, revokedLinks: 0 };
    }),
    listVersions: vi.fn(async () => ({ versions: [] })),
    getVersionContent: vi.fn(),
    putVersionContent: vi.fn(),
    getCollabUpdates: vi.fn(async (_id: string, since = 0) => ({
      updates: log.filter((u) => u.seq > since),
      hasMore: false,
    })),
    compactCollab: vi.fn(async (_id: string, ciphertext: string, nonce: string, upToSeq: number) => {
      compactCalls.push({ ciphertext, nonce, upToSeq });
      for (let i = log.length - 1; i >= 0; i--) if (log[i]!.seq <= upToSeq) log.splice(i, 1);
      log.unshift({ seq: 1000 + compactCalls.length, ciphertext, nonce, author: "me" });
      log.sort((a, b) => a.seq - b.seq);
      return { seq: 1000 + compactCalls.length };
    }),
  };
  const ctx = {
    api: api as unknown as OpsCtx["api"],
    keys: { recipient: me, identity: { privateKeyHex: "", publicKeyHex: "", fingerprint: "" } },
    userId: "me",
    orgId: "org-1",
    orgPublicHex: "",
    roleIdByKey: { editor: "r" },
  } satisfies OpsCtx;
  const entry = {
    id: "n1",
    orgId: "org-1",
    parentId: "folder-1",
    kind: "file",
    ownerUserId: "me",
    nameEncrypted: "",
    nameNonce: "",
    metaEncrypted: null,
    metaNonce: null,
    appKind: opts.appKind ?? null,
    sizeBytes: 0,
    hasContent: false,
    contentNonce: null,
    trashedAt: null,
    keyEpoch: 1,
    createdAt: "",
    modifiedAt: "",
    myWrappedKey: await wrapNodeKeyFor(oldKey, me.publicHex),
    name: "doc",
  } as DriveEntry;
  return { ctx, me, team, oldKey, entry, log, rotateCalls, compactCalls, api };
}

async function snapshotText(key: Uint8Array, row: { ciphertext: string; nonce: string }): Promise<string> {
  const d = new Y.Doc();
  Y.applyUpdate(d, await decryptContent(key, row.nonce, fromHex(row.ciphertext)));
  return d.getText("t").toString();
}

describe("rotation — parts des ayants droit restants", () => {
  it("un Éditeur sans group.view conserve la part de l'équipe (repli sur group-keys)", async () => {
    const f = await fixture();
    const res = await rotateNode(f.ctx, f.entry);
    expect(res.ok).toBe(true);
    const shares = f.rotateCalls[0]!.keyShares;
    const teamShare = shares.find((s) => s.principalId === "g-marketing");
    expect(teamShare).toBeDefined();
    expect(teamShare!.inheritedFrom).toBe("folder-1");
    // La part d'équipe ouvre bien la nouvelle clé.
    const mine = await unwrapNodeKey(shares.find((s) => s.principalId === "me")!.wrappedKey, f.me);
    expect(await unwrapNodeKey(teamShare!.wrappedKey, f.team)).toEqual(mine);
  });

  it("refuse la rotation (sans toucher au serveur) si une part restante ne peut pas être ré-emballée", async () => {
    const f = await fixture({
      shares: [
        share({ principalType: "user", principalId: "me" }),
        share({ principalType: "user", principalId: "bob" }),
      ],
    });
    const res = await rotateNode(f.ctx, f.entry);
    expect(res).toMatchObject({ ok: false, incomplete: true, missingPrincipals: ["user:bob"] });
    expect(f.api.rotateNode).not.toHaveBeenCalled();
    const stats = await rotateTree(f.ctx, f.entry);
    expect(stats).toMatchObject({ rotated: 0, skipped: 0, incomplete: 1 });
    expect(rotationSummary(stats)).toMatch(/rotation inachevée/);
  });

  it("wrapForRemainingPrincipals lève RotationIncomplete en listant les manquants", async () => {
    const resolver = { resolve: vi.fn(async () => null) };
    await expect(
      wrapForRemainingPrincipals([share({ principalType: "group", principalId: "g" })], generateNodeKey(), resolver),
    ).rejects.toBeInstanceOf(RotationIncomplete);
  });
});

describe("rotation — journal collaboratif", () => {
  it("intègre à l'instantané les frappes d'un co-auteur envoyées sous la NOUVELLE clé", async () => {
    const alice = new Y.Doc();
    const f = await fixture({
      appKind: "collab-doc",
      // Bob, éjecté par la rotation, se reconnecte avec la nouvelle clé et tape avant la compaction.
      onRotate: async (newKey) => {
        f.log.push(await encUpdate(newKey, textUpdate(alice, " +Bob"), 3));
      },
    });
    f.log.push(await encUpdate(f.oldKey, textUpdate(alice, "Bonjour"), 1));
    f.log.push(await encUpdate(f.oldKey, textUpdate(alice, " monde"), 2));
    const res = await rotateNode(f.ctx, f.entry);
    expect(res.ok).toBe(true);
    expect(f.compactCalls).toHaveLength(1);
    const newKey = await unwrapNodeKey(
      f.rotateCalls[0]!.keyShares.find((s) => s.principalId === "me")!.wrappedKey,
      f.me,
    );
    expect(await snapshotText(newKey, f.compactCalls[0]!)).toBe("Bonjour monde +Bob");
  });

  it("ne supprime jamais une entrée illisible : la compaction s'arrête juste avant", async () => {
    const d = new Y.Doc();
    const k = generateNodeKey();
    const stranger = generateNodeKey();
    const log: LogRow[] = [
      await encUpdate(k, textUpdate(d, "a"), 1),
      await encUpdate(stranger, textUpdate(d, "b"), 2),
      await encUpdate(k, textUpdate(d, "c"), 3),
    ];
    const compact = vi.fn(async () => ({ seq: 9 }));
    const api = { getCollabUpdates: vi.fn(async () => ({ updates: log, hasMore: false })), compactCollab: compact };
    const newKey = generateNodeKey();
    const r = await compactCollabLog(api as never, "n", [newKey, k], newKey, { retryDelayMs: 0 });
    expect(r).toMatchObject({ ok: false, kept: 1, integrated: 2 });
    expect(compact).toHaveBeenCalledTimes(1);
    expect((compact.mock.calls[0] as unknown[])[3]).toBe(1); // upToSeq = 1, l'entrée 2 (et 3) restent
  });

  it("une compaction échouée est signalée « inachevée » puis rattrapée à la rotation suivante (fente précédente)", async () => {
    const d = new Y.Doc();
    const f = await fixture({ appKind: "collab-doc" });
    f.log.push(await encUpdate(f.oldKey, textUpdate(d, "contenu ancien"), 1));
    f.api.compactCollab!.mockRejectedValue(Object.assign(new Error("413"), { status: 413 }));
    const stats = await rotateTree(f.ctx, f.entry);
    expect(stats).toMatchObject({ rotated: 0, incomplete: 1 });
    expect(f.log).toHaveLength(1); // rien d'effacé

    // Deuxième rotation : le nœud porte la nouvelle clé + la fente « clé précédente » (= oldKey).
    const body = f.rotateCalls[0]! as unknown as {
      keyShares: KeyShareInput[];
      prevKeyWrapped: string;
      prevKeyNonce: string;
    };
    const k2 = await unwrapNodeKey(body.keyShares.find((s) => s.principalId === "me")!.wrappedKey, f.me);
    const entry2 = {
      ...f.entry,
      keyEpoch: 2,
      myWrappedKey: await wrapNodeKeyFor(k2, f.me.publicHex),
      prevKeyWrapped: body.prevKeyWrapped,
      prevKeyNonce: body.prevKeyNonce,
    } as DriveEntry;
    f.api.compactCollab!.mockReset();
    const calls: { ciphertext: string; nonce: string; upToSeq: number }[] = [];
    f.api.compactCollab!.mockImplementation(async (_id: string, ciphertext: string, nonce: string, upToSeq: number) => {
      calls.push({ ciphertext, nonce, upToSeq });
      return { seq: 50 };
    });
    const res = await rotateNode(f.ctx, entry2);
    expect(res.ok).toBe(true);
    const k3 = await unwrapNodeKey(f.rotateCalls[1]!.keyShares.find((s) => s.principalId === "me")!.wrappedKey, f.me);
    expect(await snapshotText(k3, calls[0]!)).toBe("contenu ancien");
  });
});
