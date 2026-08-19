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

import { query, queryOne, withTx } from "../src/db/pool.js";
import { requireOrgPerm } from "../src/middleware/auth.js";
import { audit } from "../src/lib/audit.js";
import { ApiError } from "../src/lib/errors.js";
import groupRoutes from "../src/routes/groups.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);
const mWithTx = vi.mocked(withTx);
const mRequireOrgPerm = vi.mocked(requireOrgPerm);
const mAudit = vi.mocked(audit);

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "bad_request", message: "validation" } });
    }
    return reply.status(500).send({ error: { code: "internal", message: err.message } });
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
  mQuery.mockResolvedValue([] as never);
  mQueryOne.mockResolvedValue(null as never);
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
  const payload = { userId: OTHER_USER, wrappedGroupPrivate: { c: "x" }, isManager: false };

  it("adds (upserts) a member and returns their record", async () => {
    mQueryOne
      .mockResolvedValueOnce({ id: GROUP, org_id: ORG, name: "g", description: "", color: "#0ea5e9", group_public_hex: GROUP_PUBLIC_HEX, created_at: "t" }) // loadGroupInOrg
      .mockResolvedValueOnce({ user_id: OTHER_USER }) // active-membership check
      .mockResolvedValueOnce({ user_id: OTHER_USER, is_manager: false, added_at: "t2" }); // upsert RETURNING
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/groups/${GROUP}/members`, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ member: { userId: OTHER_USER, isManager: false, addedAt: "t2" } });
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "group.member.add", "group", GROUP, { userId: OTHER_USER }, expect.any(String));
    await app.close();
  });

  it("400 when the target user isn't an active member of the org", async () => {
    mQueryOne
      .mockResolvedValueOnce({ id: GROUP, org_id: ORG, name: "g", description: "", color: "#0ea5e9", group_public_hex: GROUP_PUBLIC_HEX, created_at: "t" })
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
  it("removes the member (idempotent — no existence check on the membership row)", async () => {
    mQueryOne.mockResolvedValueOnce({ id: GROUP, org_id: ORG, name: "g", description: "", color: "#0ea5e9", group_public_hex: GROUP_PUBLIC_HEX, created_at: "t" });
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}/members/${OTHER_USER}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mQuery).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM group_members/), [GROUP, OTHER_USER]);
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "group.member.remove", "group", GROUP, { userId: OTHER_USER }, expect.any(String));
    await app.close();
  });

  it("404 when the group doesn't exist in this org", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}/members/${OTHER_USER}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 when the caller lacks group.manage", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise : group.manage."));
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}/members/${OTHER_USER}` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("DELETE /api/orgs/:orgId/groups/:groupId", () => {
  it("deletes the group", async () => {
    mQueryOne.mockResolvedValueOnce({ id: GROUP, org_id: ORG, name: "g", description: "", color: "#0ea5e9", group_public_hex: GROUP_PUBLIC_HEX, created_at: "t" });
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/groups/${GROUP}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mQuery).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM groups/), [GROUP, ORG]);
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "group.delete", "group", GROUP, {}, expect.any(String));
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
