/**
 * Unit tests for src/routes/groups.ts — org-scoped groups (cryptographic
 * principals) and their membership. Mounted under /api/orgs (see app.ts).
 * DB and auth middleware are mocked (call-order dispatched), matching the
 * style of tests/signing.test.ts and tests/node-access.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const USER = "00000000-0000-4000-8000-0000000000aa";
const OTHER_USER = "00000000-0000-4000-8000-0000000000ab";
const ORG = "00000000-0000-4000-8000-0000000000cc";
const GROUP = "00000000-0000-4000-8000-0000000000d1";

const GROUP_PUBLIC_HEX = "04" + "1".repeat(128); // 130 hex chars, matches /^[0-9a-f]{130}$/

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
  requireOrgPerm: vi.fn(async () => ({
    orgId: ORG,
    membershipId: "m1",
    roleId: "r1",
    roleKey: "manager",
    permissions: new Set<string>(),
    isOwner: false,
  })),
}));

vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));

vi.mock("../src/collab/relay.js", () => ({ kickUser: vi.fn(), kickRoom: vi.fn(), notifyOrg: vi.fn() }));

import { query, queryOne, withTx } from "../src/db/pool.js";
import { requireOrgPerm } from "../src/middleware/auth.js";
import { audit } from "../src/lib/audit.js";
import { kickUser, kickRoom } from "../src/collab/relay.js";
import { ApiError } from "../src/lib/errors.js";
import groupRoutes from "../src/routes/groups.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);
const mWithTx = vi.mocked(withTx);
const mRequireOrgPerm = vi.mocked(requireOrgPerm);
const mAudit = vi.mocked(audit);
const mKickUser = vi.mocked(kickUser);
const mKickRoom = vi.mocked(kickRoom);
const NODE_A = "00000000-0000-4000-8000-0000000000e1";
const NEW_GROUP_HEX = "04" + "2".repeat(128);

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err instanceof Error ? err.message : String(err) } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "bad_request", message: "validation" } });
    }
    return reply.status(500).send({ error: { code: "internal", message: err instanceof Error ? err.message : String(err) } });
  });
  await app.register(groupRoutes, { prefix: "/api/orgs" });
  await app.ready();
  return app;
}

function txDispatch(map: Array<[RegExp, (params?: unknown[]) => { rows: unknown[] }]>, sink?: string[]) {
  return async (fn: (c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => unknown) =>
    fn({
      query: async (sql: string, params?: unknown[]) => {
        sink?.push(sql);
        for (const [re, res] of map) if (re.test(sql)) return res(params);
        return { rows: [] };
      },
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  mQuery.mockReset().mockResolvedValue([] as never);
  mQueryOne.mockReset().mockResolvedValue(null as never);
  mRequireOrgPerm.mockResolvedValue({
    orgId: ORG,
    membershipId: "m1",
    roleId: "r1",
    roleKey: "manager",
    permissions: new Set<string>(),
    isOwner: false,
  } as never);
});

describe("GET /api/orgs/:orgId/groups", () => {
  it("lists groups with member counts", async () => {
    mQuery.mockResolvedValueOnce([
      { id: GROUP, name: "Marketing", description: "", color: "#0ea5e9", group_public_hex: GROUP_PUBLIC_HEX, member_count: 3 },
      { id: "g2", name: "Ventes", description: "", color: "#16a34a", group_public_hex: GROUP_PUBLIC_HEX, member_count: 0 },
    ] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/groups` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groups).toHaveLength(2);
    expect(body.groups[0]).toMatchObject({ id: GROUP, name: "Marketing", memberCount: 3 });
    expect(body.groups[1].memberCount).toBe(0);
    expect(mRequireOrgPerm).toHaveBeenCalledWith(expect.anything(), ORG, "group.view");
    await app.close();
  });

  it("403 when the caller lacks group.view", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise : group.view."));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/groups` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("403 when the caller is not even a member of the org", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Vous n'êtes pas membre de cette organisation."));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/groups` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("POST /api/orgs/:orgId/groups", () => {
  const basePayload = {
    name: "Marketing",
    description: "Équipe marketing",
    groupPublicHex: GROUP_PUBLIC_HEX,
    members: [{ userId: USER, wrappedGroupPrivate: { c: "a" }, isManager: true }],
  };

  it("creates a group with its initial members and flags creatorIncluded", async () => {
    mQuery.mockResolvedValueOnce([{ user_id: USER }] as never); // active-membership check
    mWithTx.mockImplementation(
      txDispatch([
        [
          /INSERT INTO groups/,
          () => ({
            rows: [{ id: GROUP, org_id: ORG, name: "Marketing", description: "Équipe marketing", color: "#0ea5e9", group_public_hex: GROUP_PUBLIC_HEX }],
          }),
        ],
        [
          /INSERT INTO group_members/,
          () => ({ rows: [{ user_id: USER, is_manager: true, added_at: "2026-08-19T00:00:00Z" }] }),
        ],
      ]) as never,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/groups`, payload: basePayload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.group).toMatchObject({ id: GROUP, name: "Marketing", memberCount: 1 });
    expect(body.creatorIncluded).toBe(true);
    expect(body.members).toEqual([{ userId: USER, isManager: true, addedAt: "2026-08-19T00:00:00Z" }]);
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "group.create", "group", GROUP, { creatorIncluded: true }, expect.any(String));
    await app.close();
  });

  it("creatorIncluded is false when the creator omits themself from the member list", async () => {
    mQuery.mockResolvedValueOnce([{ user_id: OTHER_USER }] as never);
    mWithTx.mockImplementation(
      txDispatch([
        [/INSERT INTO groups/, () => ({ rows: [{ id: GROUP, org_id: ORG, name: "X", description: "", color: "#0ea5e9", group_public_hex: GROUP_PUBLIC_HEX }] })],
        [/INSERT INTO group_members/, () => ({ rows: [{ user_id: OTHER_USER, is_manager: false, added_at: "t" }] })],
      ]) as never,
    );
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/groups`,
      payload: { ...basePayload, members: [{ userId: OTHER_USER, wrappedGroupPrivate: { c: "b" } }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().creatorIncluded).toBe(false);
    await app.close();
  });

  it("400 when a listed member isn't an active member of the org", async () => {
    mQuery.mockResolvedValueOnce([] as never); // nobody validated as active
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/groups`, payload: basePayload });
    expect(res.statusCode).toBe(400);
    expect(mWithTx).not.toHaveBeenCalled();
    await app.close();
  });

  it("400 when members array is empty (zod min(1))", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/groups`, payload: { ...basePayload, members: [] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400 on a malformed groupPublicHex", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/groups`, payload: { ...basePayload, groupPublicHex: "nothex" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("403 when the caller lacks group.create", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise : group.create."));
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/groups`, payload: basePayload });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /api/orgs/:orgId/groups/:groupId", () => {
  it("returns the group, the caller's own wrapped key, and member identities", async () => {
    mQueryOne
      .mockResolvedValueOnce({
        id: GROUP,
        org_id: ORG,
        name: "Marketing",
        description: "",
        color: "#0ea5e9",
        group_public_hex: GROUP_PUBLIC_HEX,
        created_at: "t",
      })
      .mockResolvedValueOnce({ wrapped_group_private: { c: "mine" } });
    mQuery.mockResolvedValueOnce([
      { user_id: USER, email: "u@example.org", display_name: "U", p256_public_hex: "04aa", is_manager: true, added_at: "t1" },
    ] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/groups/${GROUP}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.group).toMatchObject({ id: GROUP, memberCount: 1 });
    expect(body.myWrappedGroupPrivate).toEqual({ c: "mine" });
    expect(body.members).toEqual([
      { userId: USER, email: "u@example.org", displayName: "U", p256PublicHex: "04aa", isManager: true, addedAt: "t1" },
    ]);
    await app.close();
  });

  it("myWrappedGroupPrivate is null when the caller isn't a member of the group", async () => {
    mQueryOne
      .mockResolvedValueOnce({ id: GROUP, org_id: ORG, name: "Marketing", description: "", color: "#0ea5e9", group_public_hex: GROUP_PUBLIC_HEX, created_at: "t" })
      .mockResolvedValueOnce(null);
    mQuery.mockResolvedValueOnce([] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/groups/${GROUP}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().myWrappedGroupPrivate).toBeNull();
    await app.close();
  });

  it("404 when the group doesn't exist in this org", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/groups/${GROUP}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 when the caller lacks group.view", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise : group.view."));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/groups/${GROUP}` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("POST /api/orgs/:orgId/groups/:groupId/members", () => {
  const payload = { expectedGroupPublicHex: GROUP_PUBLIC_HEX, userId: OTHER_USER, wrappedGroupPrivate: { c: "x" }, isManager: false };
  const groupRow = { id: GROUP, org_id: ORG, name: "g", description: "", color: "#0ea5e9", group_public_hex: GROUP_PUBLIC_HEX, created_at: "t" };

  it("refuses self-enrollment by an organization manager outside the group", async () => {
    mQueryOne.mockResolvedValueOnce(groupRow).mockResolvedValueOnce(null); // loadGroupInOrg, caller is not a group manager
    const app = await makeApp();
    const res = await app.inject({
      method: "POST", url: `/api/orgs/${ORG}/groups/${GROUP}/members`,
      payload: { ...payload, userId: USER, isManager: true },
    });
    expect(res.statusCode).toBe(403);
    expect(mWithTx).not.toHaveBeenCalled();
    await app.close();
  });

  it("400 when expectedGroupPublicHex is missing", async () => {
    const app = await makeApp();
    const withoutKey: Record<string, unknown> = { ...payload };
    delete withoutKey.expectedGroupPublicHex;
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/groups/${GROUP}/members`, payload: withoutKey });
    expect(res.statusCode).toBe(400);
    expect(mWithTx).not.toHaveBeenCalled();
    await app.close();
  });

  it("adds (upserts) a member after checking the group key is fresh, and returns their record", async () => {
    mQueryOne
      .mockResolvedValueOnce(groupRow) // loadGroupInOrg
      .mockResolvedValueOnce({ is_manager: true }) // caller manages this group
      .mockResolvedValueOnce({ user_id: OTHER_USER }); // active-membership check
    const sqls: string[] = [];
    mWithTx.mockImplementation(
      txDispatch([
        [/FROM organizations/, () => ({ rows: [{ org_key_epoch: 1, rotation_required: false }] })],
        [/FROM groups WHERE id/, () => ({ rows: [{ group_public_hex: GROUP_PUBLIC_HEX, rotation_required: false }] })],
        [/INSERT INTO group_members/, () => ({ rows: [{ user_id: OTHER_USER, is_manager: false, added_at: "t2" }] })],
      ], sqls) as never,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/groups/${GROUP}/members`, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ member: { userId: OTHER_USER, isManager: false, addedAt: "t2" } });
    expect(sqls.findIndex((q) => /FROM groups WHERE id/.test(q))).toBeLessThan(sqls.findIndex((q) => /INSERT INTO group_members/.test(q)));
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "group.member.add", "group", GROUP, { userId: OTHER_USER }, expect.any(String));
    await app.close();
  });

  it("409 when the group key changed since the client read it (nothing is inserted)", async () => {
    mQueryOne.mockResolvedValueOnce(groupRow).mockResolvedValueOnce({ is_manager: true }).mockResolvedValueOnce({ user_id: OTHER_USER });
    const sqls: string[] = [];
    mWithTx.mockImplementation(
      txDispatch([
        [/FROM organizations/, () => ({ rows: [{ org_key_epoch: 1, rotation_required: false }] })],
        [/FROM groups WHERE id/, () => ({ rows: [{ group_public_hex: NEW_GROUP_HEX, rotation_required: false }] })],
      ], sqls) as never,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/groups/${GROUP}/members`, payload });
    expect(res.statusCode).toBe(409);
    expect(sqls.some((q) => /INSERT INTO group_members/.test(q))).toBe(false);
    expect(mAudit).not.toHaveBeenCalled();
    await app.close();
  });

  it("400 when the target user isn't an active member of the org", async () => {
    mQueryOne
      .mockResolvedValueOnce(groupRow)
      .mockResolvedValueOnce({ is_manager: true })
      .mockResolvedValueOnce(null); // not an active member
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/groups/${GROUP}/members`, payload });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404 when the group doesn't exist in this org", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/groups/${GROUP}/members`, payload });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 when the caller lacks group.manage", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise : group.manage."));
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/groups/${GROUP}/members`, payload });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("DELETE /api/orgs/:orgId/groups/:groupId/members/:userId", () => {
  // Removing a member now rotates the team key: the body carries the new key, the re-wrapped
  // private key for each remaining member and the re-wrapped CEK of every node shared to the team.
  const rotation = {
    expectedGroupPublicHex: GROUP_PUBLIC_HEX,
    groupPublicHex: NEW_GROUP_HEX,
    members: [{ userId: USER, wrappedGroupPrivate: { c: "new" } }],
    nodeKeys: [] as Array<{ nodeId: string; wrappedKey: Record<string, unknown>; keyEpoch: number }>,
  };
  const membersRows = [{ user_id: USER, is_manager: true }, { user_id: OTHER_USER, is_manager: false }];

  it("removes the member, rotates the key, and kicks their live connections", async () => {
    const sqls: string[] = [];
    mWithTx.mockImplementation(
      txDispatch([
        [/FROM groups WHERE id/, () => ({ rows: [{ group_public_hex: GROUP_PUBLIC_HEX }] })],
        [/FROM group_members WHERE group_id/, () => ({ rows: membersRows })],
      ], sqls) as never,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}/members/${OTHER_USER}`, payload: rotation });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, rotationRequiredNodeIds: [] });
    expect(sqls.some((q) => /DELETE FROM group_members/.test(q))).toBe(true);
    expect(sqls.some((q) => /UPDATE groups SET group_public_hex/.test(q))).toBe(true);
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "group.member.remove", "group", GROUP, { userId: OTHER_USER }, expect.any(String));
    expect(mKickUser).toHaveBeenCalledWith(OTHER_USER, "group-member-removed");
    await app.close();
  });

  it("kicks the rooms of nodes that now require a key rotation", async () => {
    mWithTx.mockImplementation(
      txDispatch([
        [/FROM groups WHERE id/, () => ({ rows: [{ group_public_hex: GROUP_PUBLIC_HEX }] })],
        [/FROM group_members WHERE group_id/, () => ({ rows: membersRows })],
        [/FROM node_keys nk/, () => ({ rows: [{ node_id: NODE_A, key_epoch: 1 }] })],
        [/WITH RECURSIVE/, () => ({ rows: [{ id: NODE_A }] })],
      ]) as never,
    );
    const app = await makeApp();
    const res = await app.inject({
      method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}/members/${OTHER_USER}`,
      payload: { ...rotation, nodeKeys: [{ nodeId: NODE_A, wrappedKey: { c: "k" }, keyEpoch: 1 }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().rotationRequiredNodeIds).toEqual([NODE_A]);
    expect(mKickRoom).toHaveBeenCalledWith(NODE_A, "key-rotation-required");
    await app.close();
  });

  it("400 when the body carries no rotation material", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}/members/${OTHER_USER}` });
    expect(res.statusCode).toBe(400);
    expect(mWithTx).not.toHaveBeenCalled();
    expect(mKickUser).not.toHaveBeenCalled();
    await app.close();
  });

  it("404 when the group doesn't exist in this org", async () => {
    mWithTx.mockImplementation(txDispatch([]) as never); // group row not found
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}/members/${OTHER_USER}`, payload: rotation });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 when the caller lacks group.manage", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise : group.manage."));
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}/members/${OTHER_USER}`, payload: rotation });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("DELETE /api/orgs/:orgId/groups/:groupId", () => {
  const groupRow = { id: GROUP, org_id: ORG, name: "g", description: "", color: "#0ea5e9", group_public_hex: GROUP_PUBLIC_HEX, created_at: "t" };

  it("deletes the group and reports no node to rotate when it had no node key", async () => {
    mQueryOne.mockResolvedValueOnce(groupRow);
    const sqls: string[] = [];
    mWithTx.mockImplementation(txDispatch([], sqls) as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, rotationRequiredNodeIds: [] });
    expect(sqls.some((q) => /DELETE FROM groups/.test(q))).toBe(true);
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "group.delete", "group", GROUP, {}, expect.any(String));
    await app.close();
  });

  it("flags the nodes shared to the group as requiring rotation and kicks their rooms", async () => {
    mQueryOne.mockResolvedValueOnce(groupRow);
    mWithTx.mockImplementation(
      txDispatch([
        [/SELECT node_id FROM node_keys/, () => ({ rows: [{ node_id: NODE_A }] })],
        [/WITH RECURSIVE/, () => ({ rows: [{ id: NODE_A }, { id: "child" }] })],
      ]) as never,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().rotationRequiredNodeIds).toEqual([NODE_A, "child"]);
    expect(mKickRoom).toHaveBeenCalledWith(NODE_A, "key-rotation-required");
    expect(mKickRoom).toHaveBeenCalledWith("child", "key-rotation-required");
    await app.close();
  });

  it("kicks every member's live connections when the group is deleted", async () => {
    mQueryOne.mockResolvedValueOnce(groupRow);
    mQuery.mockResolvedValueOnce([{ user_id: USER }, { user_id: OTHER_USER }] as never);
    mWithTx.mockImplementation(txDispatch([]) as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}` });
    expect(res.statusCode).toBe(200);
    expect(mKickUser).toHaveBeenCalledWith(USER, "group-deleted");
    expect(mKickUser).toHaveBeenCalledWith(OTHER_USER, "group-deleted");
    await app.close();
  });

  it("404 when the group doesn't exist in this org (e.g. cross-org groupId)", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 when the caller lacks group.manage", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise : group.manage."));
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
