/**
 * Unit tests for src/routes/orgs.ts — organization lifecycle, membership,
 * invitations, settings, and the enterprise recovery flows (admin registry,
 * grant, org-keypair rotation). Mounted under /api/orgs (see app.ts).
 * DB and auth middleware are mocked, matching the style of
 * tests/signing.test.ts and tests/node-access.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const USER = "00000000-0000-4000-8000-0000000000aa"; // the acting/authenticated user
const OWNER = "00000000-0000-4000-8000-0000000000ab"; // org owner (usually distinct from USER)
const OTHER_USER = "00000000-0000-4000-8000-0000000000ac";
const ORG = "00000000-0000-4000-8000-0000000000cc";
const ROLE = "00000000-0000-4000-8000-0000000000d1";
const NODE = "00000000-0000-4000-8000-0000000000bb";

const HEX130 = "04" + "1".repeat(128); // matches hex(130)

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
    roleKey: "admin",
    permissions: new Set<string>(),
    isOwner: false,
  })),
}));

vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));

import { query, queryOne, withTx } from "../src/db/pool.js";
import { requireOrgPerm } from "../src/middleware/auth.js";
import { audit } from "../src/lib/audit.js";
import { ApiError } from "../src/lib/errors.js";
import { SYSTEM_ROLE_TEMPLATES } from "../src/rbac/roles.js";
import orgRoutes from "../src/routes/orgs.js";

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
  await app.register(orgRoutes, { prefix: "/api/orgs" });
  await app.ready();
  return app;
}

function txDispatch(map: Array<[RegExp, (params?: unknown[]) => { rows: unknown[]; rowCount?: number }]>, sink?: string[]) {
  return async (fn: (c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }> }) => unknown) =>
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
    roleKey: "admin",
    permissions: new Set<string>(),
    isOwner: false,
  } as never);
});

// =============================================================================
//  Creation
// =============================================================================

describe("POST /api/orgs", () => {
  const payload = {
    name: "Acme",
    slug: "acme",
    orgPublicHex: HEX130,
    wrappedOrgPrivate: { c: "wrapped" },
  };

  it("creates the org, clones every system role template, and makes the creator owner", async () => {
    mQueryOne.mockResolvedValueOnce(null); // slug not taken
    let roleIdx = 0;
    mWithTx.mockImplementation(
      txDispatch([
        [
          /INSERT INTO organizations/,
          (params) => ({
            rows: [
              {
                id: ORG,
                name: params![0],
                slug: params![1],
                owner_user_id: params![2],
                org_public_hex: params![3],
                settings: {},
                storage_quota_bytes: null,
              },
            ],
          }),
        ],
        [
          /INSERT INTO roles/,
          () => {
            const t = SYSTEM_ROLE_TEMPLATES[roleIdx++]!;
            return {
              rows: [
                {
                  id: `role-${t.key}`,
                  org_id: ORG,
                  key: t.key,
                  name: t.name,
                  description: t.description,
                  color: t.color,
                  is_system: true,
                  permissions: t.permissions,
                },
              ],
            };
          },
        ],
        [/INSERT INTO memberships/, () => ({ rows: [] })],
        [/INSERT INTO org_recovery_keys/, () => ({ rows: [] })],
      ]) as never,
    );

    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs`, payload });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.org).toMatchObject({ id: ORG, name: "Acme", slug: "acme", orgPublicHex: HEX130 });
    expect(body.membershipRoleKey).toBe("owner");
    expect(body.roles).toHaveLength(SYSTEM_ROLE_TEMPLATES.length);
    expect(body.roles.map((r: { key: string }) => r.key)).toEqual(SYSTEM_ROLE_TEMPLATES.map((t) => t.key));
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "org.create", "org", ORG, { slug: "acme" }, expect.any(String));
    await app.close();
  });

  it("409 when the slug is already taken", async () => {
    mQueryOne.mockResolvedValueOnce({ id: "existing-org" });
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs`, payload });
    expect(res.statusCode).toBe(409);
    expect(mWithTx).not.toHaveBeenCalled();
    await app.close();
  });

  it("400 on an invalid slug (uppercase not allowed)", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs`, payload: { ...payload, slug: "Acme-Corp" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400 on a malformed orgPublicHex (wrong length)", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs`, payload: { ...payload, orgPublicHex: "04aa" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// =============================================================================
//  Listing / details
// =============================================================================

describe("GET /api/orgs", () => {
  it("lists the orgs the user actively belongs to", async () => {
    mQuery.mockResolvedValueOnce([
      { id: ORG, name: "Acme", slug: "acme", org_public_hex: HEX130, settings: {}, role_id: ROLE, role_key: "owner" },
    ] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs` });
    expect(res.statusCode).toBe(200);
    expect(res.json().organizations).toEqual([
      { id: ORG, name: "Acme", slug: "acme", orgPublicHex: HEX130, settings: {}, storageQuotaBytes: null, roleId: ROLE, roleKey: "owner" },
    ]);
    await app.close();
  });
});

describe("GET /api/orgs/:orgId", () => {
  it("returns org details + the caller's role/permissions", async () => {
    mRequireOrgPerm.mockResolvedValueOnce({
      orgId: ORG,
      membershipId: "m1",
      roleId: ROLE,
      roleKey: "owner",
      permissions: new Set(["org.settings.view"]),
      isOwner: true,
    } as never);
    mQueryOne.mockResolvedValueOnce({ id: ORG, name: "Acme", slug: "acme", org_public_hex: HEX130, settings: {}, storage_quota_bytes: null });
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.org).toMatchObject({ id: ORG, name: "Acme" });
    expect(body.isOwner).toBe(true);
    expect(body.role).toEqual({ id: ROLE, key: "owner", permissions: ["org.settings.view"] });
    await app.close();
  });

  it("404 when the org row is gone (e.g. deleted after context load)", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 when the caller isn't a member of the org", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Vous n'êtes pas membre de cette organisation."));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /api/orgs/:orgId/members", () => {
  it("lists members with role + status", async () => {
    mQuery.mockResolvedValueOnce([
      {
        user_id: USER,
        email: "u@example.org",
        display_name: "U",
        p256_public_hex: "04aa",
        ed25519_public_hex: "bb",
        fingerprint: "f",
        role_id: ROLE,
        role_key: "editor",
        status: "active",
        joined_at: "t",
      },
    ] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/members` });
    expect(res.statusCode).toBe(200);
    expect(res.json().members).toEqual([
      {
        userId: USER,
        email: "u@example.org",
        displayName: "U",
        p256PublicHex: "04aa",
        ed25519PublicHex: "bb",
        fingerprint: "f",
        roleId: ROLE,
        roleKey: "editor",
        status: "active",
        joinedAt: "t",
      },
    ]);
    expect(mRequireOrgPerm).toHaveBeenCalledWith(expect.anything(), ORG, "member.view");
    await app.close();
  });

  it("403 when the caller lacks member.view", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/members` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// =============================================================================
//  Invitations
// =============================================================================

describe("POST /api/orgs/:orgId/invites", () => {
  it("creates an invite and returns a fresh unhashed token + expiry", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE }).mockResolvedValueOnce({ id: "invite-1" });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/invites`,
      payload: { email: "new@example.org", roleId: ROLE },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
    expect(body.expiresAt).toBeDefined();
    expect(mAudit).toHaveBeenCalledWith(
      ORG,
      USER,
      "member.invite",
      "invite",
      "invite-1",
      { email: "new@example.org", roleId: ROLE },
      expect.any(String),
    );
    await app.close();
  });

  it("400 for an invalid role", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/invites`,
      payload: { email: "new@example.org", roleId: ROLE },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400 for a malformed email", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/invites`,
      payload: { email: "not-an-email", roleId: ROLE },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("403 when the caller lacks member.invite", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/invites`,
      payload: { email: "new@example.org", roleId: ROLE },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("POST /api/orgs/invites/accept", () => {
  it("accepts a live invite and creates/updates the membership", async () => {
    mWithTx.mockImplementation(
      txDispatch([
        [
          /SELECT id, org_id, role_id, expires_at, accepted_at/,
          () => ({
            rows: [
              {
                id: "invite-1",
                org_id: ORG,
                role_id: ROLE,
                expires_at: new Date(Date.now() + 10_000).toISOString(),
                accepted_at: null,
              },
            ],
          }),
        ],
        [/INSERT INTO memberships/, () => ({ rows: [{ org_id: ORG, role_id: ROLE }] })],
        [/UPDATE invites SET accepted_at/, () => ({ rows: [] })],
      ]) as never,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/invites/accept`, payload: { token: "a-valid-token-1234" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orgId: ORG, roleId: ROLE });
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "member.invite.accept", "membership", null, {}, expect.any(String));
    await app.close();
  });

  it("400 for an unknown token", async () => {
    mWithTx.mockImplementation(txDispatch([]) as never);
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/invites/accept`, payload: { token: "unknown-token-1234" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400 for an already-accepted invite", async () => {
    mWithTx.mockImplementation(
      txDispatch([
        [
          /SELECT id, org_id, role_id, expires_at, accepted_at/,
          () => ({
            rows: [
              { id: "invite-1", org_id: ORG, role_id: ROLE, expires_at: new Date(Date.now() + 10_000).toISOString(), accepted_at: "2026-01-01T00:00:00Z" },
            ],
          }),
        ],
      ]) as never,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/invites/accept`, payload: { token: "used-token-1234567" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400 for an expired invite", async () => {
    mWithTx.mockImplementation(
      txDispatch([
        [
          /SELECT id, org_id, role_id, expires_at, accepted_at/,
          () => ({
            rows: [{ id: "invite-1", org_id: ORG, role_id: ROLE, expires_at: new Date(Date.now() - 10_000).toISOString(), accepted_at: null }],
          }),
        ],
      ]) as never,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/invites/accept`, payload: { token: "expired-token-123" } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

// =============================================================================
//  Member role changes / removal
// =============================================================================

describe("PATCH /api/orgs/:orgId/members/:userId", () => {
  it("changes a member's role", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE }).mockResolvedValueOnce({ id: "m2", role_id: ROLE });
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/orgs/${ORG}/members/${OTHER_USER}`,
      payload: { roleId: ROLE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ userId: OTHER_USER, roleId: ROLE });
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "member.role.assign", "membership", "m2", { userId: OTHER_USER, roleId: ROLE }, expect.any(String));
    await app.close();
  });

  it("404 when the target isn't a member of this org", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE }).mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/orgs/${ORG}/members/${OTHER_USER}`,
      payload: { roleId: ROLE },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400 for an invalid role", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/orgs/${ORG}/members/${OTHER_USER}`,
      payload: { roleId: ROLE },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("403 when the caller lacks member.role.assign", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/orgs/${ORG}/members/${OTHER_USER}`,
      payload: { roleId: ROLE },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("DELETE /api/orgs/:orgId/members/:userId", () => {
  it("removes a member", async () => {
    mQueryOne.mockResolvedValueOnce({ owner_user_id: OWNER }).mockResolvedValueOnce({ id: "m3" });
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/members/${OTHER_USER}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "member.remove", "membership", "m3", { userId: OTHER_USER }, expect.any(String));
    await app.close();
  });

  it("409 conflict: the org owner cannot be removed as a member", async () => {
    mQueryOne.mockResolvedValueOnce({ owner_user_id: OWNER });
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/members/${OWNER}` });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("404 when the org itself is missing", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/members/${OTHER_USER}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404 when the target isn't a member of this org", async () => {
    mQueryOne.mockResolvedValueOnce({ owner_user_id: OWNER }).mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/members/${OTHER_USER}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 when the caller lacks member.remove", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/members/${OTHER_USER}` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// =============================================================================
//  Ownership transfer (checked by literal owner_user_id, NOT requireOrgPerm)
// =============================================================================

describe("POST /api/orgs/:orgId/transfer-ownership", () => {
  it("transfers ownership to an active member and grants them the owner role", async () => {
    mQueryOne
      .mockResolvedValueOnce({ owner_user_id: USER }) // caller IS the current owner
      .mockResolvedValueOnce({ id: "m-other" }) // target is an active member
      .mockResolvedValueOnce({ id: "role-owner" }); // owner role lookup
    mWithTx.mockImplementation(txDispatch([]) as never);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/transfer-ownership`,
      payload: { newOwnerUserId: OTHER_USER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "org.ownership.transfer", "org", ORG, { newOwnerUserId: OTHER_USER }, expect.any(String));
    await app.close();
  });

  it("403 forbidden: only the CURRENT owner may transfer (requireOrgPerm is not even consulted)", async () => {
    mQueryOne.mockResolvedValueOnce({ owner_user_id: OTHER_USER }); // caller is NOT the owner
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/transfer-ownership`,
      payload: { newOwnerUserId: OTHER_USER },
    });
    expect(res.statusCode).toBe(403);
    expect(mWithTx).not.toHaveBeenCalled();
    await app.close();
  });

  it("400 when transferring to oneself", async () => {
    mQueryOne.mockResolvedValueOnce({ owner_user_id: USER });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/transfer-ownership`,
      payload: { newOwnerUserId: USER },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400 when the target isn't an active member of the org", async () => {
    mQueryOne.mockResolvedValueOnce({ owner_user_id: USER }).mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/transfer-ownership`,
      payload: { newOwnerUserId: OTHER_USER },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404 when the org doesn't exist", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/transfer-ownership`,
      payload: { newOwnerUserId: OTHER_USER },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// =============================================================================
//  Storage usage / quota
// =============================================================================

describe("GET /api/orgs/:orgId/usage", () => {
  it("returns usage + quota", async () => {
    mQueryOne.mockResolvedValueOnce({ quota: 1000, used: "500", files: "3" });
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/usage` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ usedBytes: 500, quotaBytes: 1000, versionCount: 3 });
    await app.close();
  });

  it("404 when the org doesn't exist", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/usage` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 when the caller lacks org.settings.view", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/usage` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("PATCH /api/orgs/:orgId/quota", () => {
  it("sets a new quota", async () => {
    mQueryOne.mockResolvedValueOnce({ storage_quota_bytes: 2048 });
    const app = await makeApp();
    const res = await app.inject({ method: "PATCH", url: `/api/orgs/${ORG}/quota`, payload: { quotaBytes: 2048 } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ quotaBytes: 2048 });
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "org.quota.update", "org", ORG, { quotaBytes: 2048 }, expect.any(String));
    await app.close();
  });

  it("accepts null (unlimited)", async () => {
    mQueryOne.mockResolvedValueOnce({ storage_quota_bytes: null });
    const app = await makeApp();
    const res = await app.inject({ method: "PATCH", url: `/api/orgs/${ORG}/quota`, payload: { quotaBytes: null } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ quotaBytes: null });
    await app.close();
  });

  it("400 for a negative quota", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "PATCH", url: `/api/orgs/${ORG}/quota`, payload: { quotaBytes: -1 } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404 when the org doesn't exist", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "PATCH", url: `/api/orgs/${ORG}/quota`, payload: { quotaBytes: 10 } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 when the caller lacks storage.quota.manage", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({ method: "PATCH", url: `/api/orgs/${ORG}/quota`, payload: { quotaBytes: 10 } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// =============================================================================
//  Settings
// =============================================================================

describe("GET /api/orgs/:orgId/settings", () => {
  it("returns settings", async () => {
    mQueryOne.mockResolvedValueOnce({ settings: { theme: "dark" } });
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/settings` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ settings: { theme: "dark" } });
    await app.close();
  });

  it("404 when the org doesn't exist", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/settings` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("PATCH /api/orgs/:orgId/settings", () => {
  it("updates settings", async () => {
    mQueryOne.mockResolvedValueOnce({ settings: { theme: "light" } });
    const app = await makeApp();
    const res = await app.inject({ method: "PATCH", url: `/api/orgs/${ORG}/settings`, payload: { settings: { theme: "light" } } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ settings: { theme: "light" } });
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "org.settings.update", "org", ORG, {}, expect.any(String));
    await app.close();
  });

  it("404 when the org doesn't exist", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "PATCH", url: `/api/orgs/${ORG}/settings`, payload: { settings: {} } });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 when the caller lacks org.settings.manage", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({ method: "PATCH", url: `/api/orgs/${ORG}/settings`, payload: { settings: {} } });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// =============================================================================
//  Recovery
// =============================================================================

describe("GET /api/orgs/:orgId/recovery-key", () => {
  it("returns this admin's wrapped org private key", async () => {
    mQueryOne.mockResolvedValueOnce({ wrapped_org_private: { c: "wrapped" } });
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/recovery-key` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ wrappedOrgPrivate: { c: "wrapped" } });
    await app.close();
  });

  it("404 when the caller holds no recovery key", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/recovery-key` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 when the caller lacks recovery.perform", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/recovery-key` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("POST /api/orgs/:orgId/recovery/admins", () => {
  it("registers a new recovery admin (re-wraps the org private key to them)", async () => {
    mQueryOne.mockResolvedValueOnce({ ok: 1 }); // active membership
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/recovery/admins`,
      payload: { adminUserId: OTHER_USER, wrappedOrgPrivate: { c: "x" } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "recovery.admin.grant", "org", ORG, { adminUserId: OTHER_USER }, expect.any(String));
    await app.close();
  });

  it("400 when the target isn't an active member of the org", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/recovery/admins`,
      payload: { adminUserId: OTHER_USER, wrappedOrgPrivate: { c: "x" } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("403 when the caller lacks org.settings.manage", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/recovery/admins`,
      payload: { adminUserId: OTHER_USER, wrappedOrgPrivate: { c: "x" } },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("DELETE /api/orgs/:orgId/recovery/admins/:userId", () => {
  it("revokes a recovery admin when others remain", async () => {
    mQueryOne.mockResolvedValueOnce({ n: "2" });
    mQuery.mockResolvedValueOnce([{ admin_user_id: OTHER_USER }] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/recovery/admins/${OTHER_USER}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "recovery.admin.revoke", "org", ORG, { adminUserId: OTHER_USER }, expect.any(String));
    await app.close();
  });

  it("400 edge case: refuses to remove the LAST recovery admin (would brick recovery)", async () => {
    mQueryOne.mockResolvedValueOnce({ n: "1" });
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/recovery/admins/${OTHER_USER}` });
    expect(res.statusCode).toBe(400);
    expect(mQuery).not.toHaveBeenCalled();
    await app.close();
  });

  it("404 when the target isn't a recovery admin", async () => {
    mQueryOne.mockResolvedValueOnce({ n: "2" });
    mQuery.mockResolvedValueOnce([] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/recovery/admins/${OTHER_USER}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /api/orgs/:orgId/recovery/grant", () => {
  const payload = { nodeId: NODE, targetUserId: OTHER_USER, roleId: ROLE, wrappedKey: { c: "x" } };

  it("grants a node key to a target user (restores departed access)", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE }).mockResolvedValueOnce({ org_id: ORG });
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/recovery/grant`, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mAudit).toHaveBeenCalledWith(
      ORG,
      USER,
      "recovery.grant",
      "node",
      NODE,
      { targetUserId: OTHER_USER, roleId: ROLE },
      expect.any(String),
    );
    await app.close();
  });

  it("404 when the node does not belong to this org (no cross-org recovery)", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE }).mockResolvedValueOnce({ org_id: "other-org" });
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/recovery/grant`, payload });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404 when the node doesn't exist at all", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE }).mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/recovery/grant`, payload });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400 for an invalid role", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/recovery/grant`, payload });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("403 when the caller lacks recovery.perform", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/recovery/grant`, payload });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("POST /api/orgs/:orgId/recovery/rotate-org", () => {
  const basePayload = {
    newOrgPublicHex: HEX130,
    nodeKeys: [{ nodeId: NODE, wrappedKey: { c: "new" } }],
    recoveryKeys: [{ adminUserId: USER, wrappedOrgPrivate: { c: "new-priv" } }],
  };

  it("rotates the org keypair: rewraps node keys, replaces recovery-admin copies", async () => {
    mWithTx.mockImplementation(
      txDispatch([
        [/SELECT org_key_epoch/, () => ({ rows: [{ org_key_epoch: 0 }] })],
        [/SELECT admin_user_id FROM org_recovery_keys/, () => ({ rows: [{ admin_user_id: USER }] })],
        [/UPDATE organizations SET org_public_hex/, () => ({ rows: [] })],
        [/UPDATE node_keys SET wrapped_key/, () => ({ rows: [], rowCount: 1 })],
        [/DELETE FROM org_recovery_keys/, () => ({ rows: [] })],
        [/INSERT INTO org_recovery_keys/, () => ({ rows: [] })],
      ]) as never,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/recovery/rotate-org`, payload: basePayload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, nodesRewrapped: 1 });
    expect(mRequireOrgPerm).toHaveBeenCalledWith(expect.anything(), ORG, "recovery.perform");
    expect(mRequireOrgPerm).toHaveBeenCalledWith(expect.anything(), ORG, "org.settings.manage");
    expect(mAudit).toHaveBeenCalledWith(
      ORG,
      USER,
      "recovery.org.rotate",
      "org",
      ORG,
      { nodesRewrapped: 1, admins: 1 },
      expect.any(String),
    );
    await app.close();
  });

  it("409 conflict when expectedEpoch is stale (concurrent rotation)", async () => {
    mWithTx.mockImplementation(txDispatch([[/SELECT org_key_epoch/, () => ({ rows: [{ org_key_epoch: 5 }] })]]) as never);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/recovery/rotate-org`,
      payload: { ...basePayload, expectedEpoch: 0 },
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("400 edge case: refuses a rotation that would lock out an existing recovery admin", async () => {
    mWithTx.mockImplementation(
      txDispatch([
        [/SELECT org_key_epoch/, () => ({ rows: [{ org_key_epoch: 0 }] })],
        // A current admin (OTHER_USER) is not covered by the payload's recoveryKeys.
        [/SELECT admin_user_id FROM org_recovery_keys/, () => ({ rows: [{ admin_user_id: USER }, { admin_user_id: OTHER_USER }] })],
      ]) as never,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/recovery/rotate-org`, payload: basePayload });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400 edge case: refuses a rotation that omits the acting admin themself", async () => {
    mWithTx.mockImplementation(
      txDispatch([
        [/SELECT org_key_epoch/, () => ({ rows: [{ org_key_epoch: 0 }] })],
        [/SELECT admin_user_id FROM org_recovery_keys/, () => ({ rows: [] })],
      ]) as never,
    );
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/recovery/rotate-org`,
      payload: { ...basePayload, recoveryKeys: [{ adminUserId: OTHER_USER, wrappedOrgPrivate: { c: "x" } }] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("404 when the org doesn't exist", async () => {
    mWithTx.mockImplementation(txDispatch([[/SELECT org_key_epoch/, () => ({ rows: [] })]]) as never);
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/recovery/rotate-org`, payload: basePayload });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400 when recoveryKeys is empty (zod min(1))", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/recovery/rotate-org`,
      payload: { ...basePayload, recoveryKeys: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /api/orgs/:orgId/recovery/admins", () => {
  it("lists the admins who hold a wrapped org private key", async () => {
    mQuery.mockResolvedValueOnce([{ user_id: USER, email: "u@example.org", display_name: "U", created_at: "t" }] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/recovery/admins` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ admins: [{ userId: USER, email: "u@example.org", displayName: "U", since: "t" }] });
    await app.close();
  });

  it("403 when the caller lacks recovery.perform", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/recovery/admins` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /api/orgs/:orgId/recovery/nodes", () => {
  it("lists every org node with its org-wrapped CEK, still under encryption for names", async () => {
    mQuery.mockResolvedValueOnce([
      {
        id: NODE,
        parent_id: null,
        kind: "file",
        app_kind: null,
        name_encrypted: Buffer.from("aa", "hex"),
        name_nonce: Buffer.from("bb", "hex"),
        trashed_at: null,
        org_wrapped_key: { c: "org-wrapped" },
      },
    ] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/recovery/nodes` });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes).toEqual([
      {
        id: NODE,
        parentId: null,
        kind: "file",
        appKind: null,
        nameEncrypted: "aa",
        nameNonce: "bb",
        trashed: false,
        orgWrappedKey: { c: "org-wrapped" },
      },
    ]);
    await app.close();
  });

  it("403 when the caller lacks recovery.perform", async () => {
    mRequireOrgPerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/recovery/nodes` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
