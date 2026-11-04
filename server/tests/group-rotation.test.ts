/**
 * Rotation de la clé d'équipe (POST /:orgId/groups/:groupId/rotate, retrait de membre)
 * et refus de partage vers une clé périmée (assertFreshPrincipalKeys).
 * Base, auth et relais simulés (dispatch par texte SQL), comme tests/groups.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const USER = "00000000-0000-4000-8000-0000000000aa";
const MEMBER = "00000000-0000-4000-8000-0000000000ab";
const REMOVED = "00000000-0000-4000-8000-0000000000ac";
const ORG = "00000000-0000-4000-8000-0000000000cc";
const GROUP = "00000000-0000-4000-8000-0000000000d1";
const NODE_1 = "00000000-0000-4000-8000-0000000000e1";
const NODE_2 = "00000000-0000-4000-8000-0000000000e2";
const CHILD = "00000000-0000-4000-8000-0000000000e3";

const OLD_HEX = "04" + "1".repeat(128);
const NEW_HEX = "04" + "2".repeat(128);

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
  closePool: vi.fn(async () => {}),
}));
vi.mock("../src/middleware/auth.js", () => ({
  authenticate: vi.fn(async (req: { user?: unknown }) => {
    req.user = { id: USER, email: "u@example.org", fingerprint: "f", displayName: "U" };
  }),
  requireUser: vi.fn(() => ({ id: USER, email: "u@example.org", fingerprint: "f", displayName: "U" })),
  requireOrgPerm: vi.fn(),
  requireMembership: vi.fn(async () => ({ orgId: ORG })),
}));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("../src/collab/relay.js", () => ({ kickUser: vi.fn(), kickRoom: vi.fn(), notifyOrg: vi.fn() }));

import { withTx } from "../src/db/pool.js";
import { requireOrgPerm } from "../src/middleware/auth.js";
import { kickRoom, kickUser } from "../src/collab/relay.js";
import { ApiError } from "../src/lib/errors.js";
import { assertFreshPrincipalKeys } from "../src/lib/key-share-policy.js";
import groupRoutes from "../src/routes/groups.js";

const mWithTx = vi.mocked(withTx);
const mRequireOrgPerm = vi.mocked(requireOrgPerm);
const mKickRoom = vi.mocked(kickRoom);
const mKickUser = vi.mocked(kickUser);

type Row = Record<string, unknown>;
type DbState = {
  groupHex: string;
  members: Array<{ user_id: string; is_manager: boolean }>;
  nodeKeys: Array<{ node_id: string; key_epoch: number }>;
  /** nœuds marqués par la requête récursive (nœuds de l'équipe + descendants) */
  descendants: string[];
};
const sqls: Array<{ sql: string; params?: unknown[] }> = [];

function installTx(state: DbState): void {
  mWithTx.mockImplementation((async (fn: (c: unknown) => unknown) =>
    fn({
      query: async (sql: string, params?: unknown[]) => {
        sqls.push({ sql, params });
        let rows: Row[] = [];
        if (/FROM groups WHERE id = \$1 AND org_id = \$2 FOR UPDATE/.test(sql)) rows = [{ group_public_hex: state.groupHex }];
        else if (/FROM group_members WHERE group_id = \$1 FOR UPDATE/.test(sql)) rows = state.members;
        else if (/FROM node_keys nk JOIN nodes n/.test(sql)) rows = state.nodeKeys;
        else if (/WITH RECURSIVE affected/.test(sql)) rows = state.descendants.map((id) => ({ id }));
        return { rows, rowCount: rows.length };
      },
    })) as never);
}

function ctx(isOwner: boolean) {
  return { orgId: ORG, membershipId: "m1", roleId: "r1", roleKey: "manager", permissions: new Set<string>(), isOwner };
}

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: "bad_request" } });
    return reply.status(500).send({ error: { code: "internal", message: String(err) } });
  });
  await app.register(groupRoutes, { prefix: "/api/orgs" });
  await app.ready();
  return app;
}

const rotateUrl = `/api/orgs/${ORG}/groups/${GROUP}/rotate`;
const removeUrl = `/api/orgs/${ORG}/groups/${GROUP}/members/${REMOVED}`;

function rotationBody(over: Partial<{
  expectedGroupPublicHex: string;
  groupPublicHex: string;
  members: Array<{ userId: string; wrappedGroupPrivate: Record<string, unknown> }>;
  nodeKeys: Array<{ nodeId: string; wrappedKey: Record<string, unknown>; keyEpoch: number }>;
}> = {}) {
  return {
    expectedGroupPublicHex: OLD_HEX,
    groupPublicHex: NEW_HEX,
    members: [
      { userId: USER, wrappedGroupPrivate: { c: "u" } },
      { userId: MEMBER, wrappedGroupPrivate: { c: "m" } },
    ],
    nodeKeys: [
      { nodeId: NODE_1, wrappedKey: { c: "k1" }, keyEpoch: 1 },
      { nodeId: NODE_2, wrappedKey: { c: "k2" }, keyEpoch: 4 },
    ],
    ...over,
  };
}

function baseState(over: Partial<DbState> = {}): DbState {
  return {
    groupHex: OLD_HEX,
    members: [
      { user_id: USER, is_manager: true },
      { user_id: MEMBER, is_manager: false },
    ],
    nodeKeys: [
      { node_id: NODE_1, key_epoch: 1 },
      { node_id: NODE_2, key_epoch: 4 },
    ],
    descendants: [NODE_1, NODE_2, CHILD],
    ...over,
  };
}

const wrote = (re: RegExp) => sqls.some((q) => re.test(q.sql));

beforeEach(() => {
  vi.clearAllMocks();
  sqls.length = 0;
  mRequireOrgPerm.mockReset().mockResolvedValue(ctx(false) as never);
  installTx(baseState());
});

describe("POST /api/orgs/:orgId/groups/:groupId/rotate", () => {
  it("tourne la clé : nouvelle clé publique, parts des membres, CEK des nœuds, nœuds marqués key_rotation_required", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: rotateUrl, payload: rotationBody() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, rotationRequiredNodeIds: [NODE_1, NODE_2, CHILD] });
    const upd = sqls.find((q) => /UPDATE groups SET group_public_hex/.test(q.sql));
    expect(upd?.params).toEqual([GROUP, NEW_HEX]);
    expect(sqls.filter((q) => /UPDATE group_members SET wrapped_group_private/.test(q.sql))).toHaveLength(2);
    expect(sqls.filter((q) => /UPDATE node_keys SET wrapped_key/.test(q.sql))).toHaveLength(2);
    expect(wrote(/UPDATE nodes SET key_rotation_required = true/)).toBe(true);
    for (const id of [NODE_1, NODE_2, CHILD]) expect(mKickRoom).toHaveBeenCalledWith(id, "key-rotation-required");
    expect(wrote(/DELETE FROM group_members/)).toBe(false);
    await app.close();
  });

  it("409 si un membre manque (couverture des membres incomplète)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST", url: rotateUrl,
      payload: rotationBody({ members: [{ userId: USER, wrappedGroupPrivate: { c: "u" } }] }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("des membres");
    expect(wrote(/UPDATE groups SET/)).toBe(false);
    await app.close();
  });

  it("409 si la liste contient un membre en trop ou en double", async () => {
    const app = await makeApp();
    const extra = await app.inject({
      method: "POST", url: rotateUrl,
      payload: rotationBody({ members: [
        { userId: USER, wrappedGroupPrivate: { c: "u" } },
        { userId: MEMBER, wrappedGroupPrivate: { c: "m" } },
        { userId: REMOVED, wrappedGroupPrivate: { c: "r" } },
      ] }),
    });
    expect(extra.statusCode).toBe(409);
    const dup = await app.inject({
      method: "POST", url: rotateUrl,
      payload: rotationBody({ members: [
        { userId: USER, wrappedGroupPrivate: { c: "u" } },
        { userId: USER, wrappedGroupPrivate: { c: "u2" } },
      ] }),
    });
    expect(dup.statusCode).toBe(409);
    expect(wrote(/UPDATE groups SET/)).toBe(false);
    await app.close();
  });

  it("409 si un nœud partagé avec l'équipe manque (couverture des nœuds incomplète)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST", url: rotateUrl,
      payload: rotationBody({ nodeKeys: [{ nodeId: NODE_1, wrappedKey: { c: "k1" }, keyEpoch: 1 }] }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("des nœuds");
    expect(wrote(/UPDATE node_keys/)).toBe(false);
    expect(mKickRoom).not.toHaveBeenCalled();
    await app.close();
  });

  it("409 si l'époque d'un nœud a changé pendant la préparation", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST", url: rotateUrl,
      payload: rotationBody({ nodeKeys: [
        { nodeId: NODE_1, wrappedKey: { c: "k1" }, keyEpoch: 1 },
        { nodeId: NODE_2, wrappedKey: { c: "k2" }, keyEpoch: 3 }, // la base est à 4
      ] }),
    });
    expect(res.statusCode).toBe(409);
    expect(wrote(/UPDATE groups SET/)).toBe(false);
    await app.close();
  });

  it("400 si la clé publique est inchangée", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: rotateUrl, payload: rotationBody({ groupPublicHex: OLD_HEX }) });
    expect(res.statusCode).toBe(400);
    expect(wrote(/UPDATE groups SET/)).toBe(false);
    await app.close();
  });

  it("409 si la clé attendue n'est plus la clé courante de l'équipe", async () => {
    installTx(baseState({ groupHex: "04" + "3".repeat(128) })); // déjà tournée par quelqu'un d'autre
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: rotateUrl, payload: rotationBody() });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain("a changé");
    expect(wrote(/UPDATE groups SET/)).toBe(false);
    await app.close();
  });

  it("403 pour un gestionnaire d'organisation qui n'est pas gestionnaire de l'équipe", async () => {
    installTx(baseState({ members: [{ user_id: USER, is_manager: false }, { user_id: MEMBER, is_manager: true }] }));
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: rotateUrl, payload: rotationBody() });
    expect(res.statusCode).toBe(403);
    expect(wrote(/UPDATE groups SET/)).toBe(false);
    await app.close();
  });

  it("403 pour un gestionnaire d'organisation absent de l'équipe", async () => {
    installTx(baseState({ members: [{ user_id: MEMBER, is_manager: true }, { user_id: REMOVED, is_manager: false }] }));
    const app = await makeApp();
    const res = await app.inject({
      method: "POST", url: rotateUrl,
      payload: rotationBody({ members: [
        { userId: MEMBER, wrappedGroupPrivate: { c: "m" } },
        { userId: REMOVED, wrappedGroupPrivate: { c: "r" } },
      ] }),
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("le propriétaire de l'organisation peut tourner la clé sans être membre de l'équipe", async () => {
    mRequireOrgPerm.mockResolvedValue(ctx(true) as never);
    installTx(baseState({ members: [{ user_id: MEMBER, is_manager: false }] }));
    const app = await makeApp();
    const res = await app.inject({
      method: "POST", url: rotateUrl,
      payload: rotationBody({ members: [{ userId: MEMBER, wrappedGroupPrivate: { c: "m" } }] }),
    });
    expect(res.statusCode).toBe(200);
    expect(wrote(/UPDATE groups SET group_public_hex/)).toBe(true);
    await app.close();
  });

  it("400 sur un corps invalide (clé publique mal formée, aucun membre)", async () => {
    const app = await makeApp();
    const bad = await app.inject({ method: "POST", url: rotateUrl, payload: rotationBody({ groupPublicHex: "nothex" }) });
    expect(bad.statusCode).toBe(400);
    const empty = await app.inject({ method: "POST", url: rotateUrl, payload: rotationBody({ members: [] }) });
    expect(empty.statusCode).toBe(400);
    expect(mWithTx).not.toHaveBeenCalled();
    await app.close();
  });

  it("403 sans la permission group.manage", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise : group.manage."));
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: rotateUrl, payload: rotationBody() });
    expect(res.statusCode).toBe(403);
    expect(mWithTx).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("DELETE /api/orgs/:orgId/groups/:groupId/members/:userId — rotation", () => {
  const removalState = () =>
    baseState({
      members: [
        { user_id: USER, is_manager: true },
        { user_id: MEMBER, is_manager: false },
        { user_id: REMOVED, is_manager: false },
      ],
    });

  it("supprime le membre, tourne la clé et marque les nœuds key_rotation_required", async () => {
    installTx(removalState());
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: removeUrl, payload: rotationBody() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, rotationRequiredNodeIds: [NODE_1, NODE_2, CHILD] });
    const del = sqls.find((q) => /DELETE FROM group_members/.test(q.sql));
    expect(del?.params).toEqual([GROUP, REMOVED]);
    expect(wrote(/UPDATE nodes SET key_rotation_required = true/)).toBe(true);
    expect(mKickUser).toHaveBeenCalledWith(REMOVED, "group-member-removed");
    for (const id of [NODE_1, NODE_2, CHILD]) expect(mKickRoom).toHaveBeenCalledWith(id, "key-rotation-required");
    await app.close();
  });

  it("409 si les parts fournies incluent encore le membre retiré", async () => {
    installTx(removalState());
    const app = await makeApp();
    const res = await app.inject({
      method: "DELETE", url: removeUrl,
      payload: rotationBody({ members: [
        { userId: USER, wrappedGroupPrivate: { c: "u" } },
        { userId: MEMBER, wrappedGroupPrivate: { c: "m" } },
        { userId: REMOVED, wrappedGroupPrivate: { c: "r" } },
      ] }),
    });
    expect(res.statusCode).toBe(409);
    expect(wrote(/DELETE FROM group_members/)).toBe(false);
    expect(mKickUser).not.toHaveBeenCalled();
    await app.close();
  });

  it("404 si le membre à retirer n'appartient pas à l'équipe", async () => {
    installTx(baseState()); // REMOVED absent
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: removeUrl, payload: rotationBody() });
    expect(res.statusCode).toBe(404);
    expect(wrote(/DELETE FROM group_members/)).toBe(false);
    expect(mKickUser).not.toHaveBeenCalled();
    await app.close();
  });

  it("409 si la clé attendue a changé : le membre n'est pas retiré et n'est pas expulsé", async () => {
    installTx({ ...removalState(), groupHex: "04" + "3".repeat(128) });
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: removeUrl, payload: rotationBody() });
    expect(res.statusCode).toBe(409);
    expect(wrote(/DELETE FROM group_members/)).toBe(false);
    expect(mKickUser).not.toHaveBeenCalled();
    await app.close();
  });

  it("403 pour un non-gestionnaire de l'équipe ; le propriétaire est accepté", async () => {
    installTx({ ...removalState(), members: removalState().members.map((m) => ({ ...m, is_manager: m.user_id === MEMBER })) });
    const app = await makeApp();
    const denied = await app.inject({ method: "DELETE", url: removeUrl, payload: rotationBody() });
    expect(denied.statusCode).toBe(403);
    mRequireOrgPerm.mockResolvedValue(ctx(true) as never);
    const ok = await app.inject({ method: "DELETE", url: removeUrl, payload: rotationBody() });
    expect(ok.statusCode).toBe(200);
    await app.close();
  });
});

describe("assertFreshPrincipalKeys — partage vers une équipe dont la clé a tourné", () => {
  function client(group: { group_public_hex: string; rotation_required: boolean } | null) {
    return {
      query: vi.fn(async (sql: string) => {
        if (/FROM organizations/.test(sql)) return { rows: [{ org_key_epoch: 1, rotation_required: false }] };
        if (/FROM groups/.test(sql)) return { rows: group ? [group] : [] };
        return { rows: [] };
      }),
    } as never;
  }
  const share = (hex?: string) => [{ principalType: "group", principalId: GROUP, groupPublicHex: hex }];

  it("accepte un partage chiffré pour la clé courante", async () => {
    await expect(assertFreshPrincipalKeys(client({ group_public_hex: NEW_HEX, rotation_required: false }), ORG, share(NEW_HEX))).resolves.toEqual({ legacy: false });
  });

  it("409 si le partage utilise l'ancienne clé de l'équipe (après rotation)", async () => {
    await expect(assertFreshPrincipalKeys(client({ group_public_hex: NEW_HEX, rotation_required: false }), ORG, share(OLD_HEX)))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("409 si l'équipe est marquée rotation_required, même avec la bonne clé", async () => {
    await expect(assertFreshPrincipalKeys(client({ group_public_hex: NEW_HEX, rotation_required: true }), ORG, share(NEW_HEX)))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("428 client_outdated si la clé publique d'équipe est absente et la compat désactivée", async () => {
    await expect(assertFreshPrincipalKeys(client({ group_public_hex: NEW_HEX, rotation_required: false }), ORG, share(undefined), undefined, false))
      .rejects.toMatchObject({ statusCode: 428, code: "client_outdated" });
  });

  it("compat : clé publique absente -> clé courante en base, legacy=true", async () => {
    await expect(assertFreshPrincipalKeys(client({ group_public_hex: NEW_HEX, rotation_required: false }), ORG, share(undefined), undefined, true))
      .resolves.toEqual({ legacy: true });
  });

  it("compat : clé publique absente mais équipe à rotation requise -> 409", async () => {
    await expect(assertFreshPrincipalKeys(client({ group_public_hex: NEW_HEX, rotation_required: true }), ORG, share(undefined), undefined, true))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it("400 si l'équipe n'appartient pas à l'organisation", async () => {
    await expect(assertFreshPrincipalKeys(client(null), ORG, share(NEW_HEX))).rejects.toMatchObject({ statusCode: 400 });
  });
});
