/**
 * Unit tests for src/routes/roles.ts — HTTP layer of RBAC role management
 * (permission catalog, list/create/patch/clone/delete). rbac/engine.ts and
 * rbac/permissions.ts are covered by tests/rbac.test.ts; this file exercises
 * the route handlers themselves (authorization gating, request/response
 * shape, the "owner role is undeletable" and "still-referenced role" guards).
 * DB and auth middleware are mocked, matching the style of tests/orgs.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const ORG = "00000000-0000-4000-8000-0000000000cc";
const ROLE = "00000000-0000-4000-8000-0000000000d1";
const USER = "00000000-0000-4000-8000-0000000000aa";

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
  requireMembership: vi.fn(async () => ({ orgId: ORG, membershipId: "m1", roleId: "r1" })),
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

import { query, queryOne } from "../src/db/pool.js";
import { ApiError } from "../src/lib/errors.js";
import { PERMISSIONS } from "../src/rbac/permissions.js";
import roleRoutes from "../src/routes/roles.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);

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
  await app.register(roleRoutes, { prefix: "/api/orgs" });
  await app.ready();
  return app;
}

function roleRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ROLE,
    key: "custom-abc123",
    name: "Reviewer",
    description: "",
    color: "#1d4ed8",
    is_system: false,
    permissions: ["node.read"],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mQuery.mockResolvedValue([] as never);
  mQueryOne.mockResolvedValue(null as never);
});

describe("GET /api/orgs/permission-catalog", () => {
  it("returns the static permission catalog for any authenticated user", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/orgs/permission-catalog" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ permissions: PERMISSIONS });
  });
});

describe("GET /api/orgs/:orgId/roles", () => {
  it("lists roles ordered by system-first, mapped to camelCase DTOs", async () => {
    mQuery.mockResolvedValueOnce([roleRow(), roleRow({ id: "r2", key: "owner", is_system: true })] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/orgs/${ORG}/roles` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.roles).toHaveLength(2);
    expect(body.roles[0]).toMatchObject({ id: ROLE, isSystem: false, permissions: ["node.read"] });
  });
});

describe("POST /api/orgs/:orgId/roles", () => {
  it("creates a custom role (is_system=false) and audits it", async () => {
    mQueryOne.mockResolvedValueOnce(roleRow() as never);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/orgs/${ORG}/roles`,
      payload: { name: "Reviewer", permissions: ["node.read"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role).toMatchObject({ name: "Reviewer", isSystem: false });
    expect(mQueryOne).toHaveBeenCalledWith(expect.stringMatching(/INSERT INTO roles/), expect.any(Array));
  });
});

describe("PATCH /api/orgs/:orgId/roles/:roleId", () => {
  it("404s when the role does not belong to this org", async () => {
    mQueryOne.mockResolvedValueOnce(null as never); // loadOrgRole
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/orgs/${ORG}/roles/${ROLE}`,
      payload: { name: "New name" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("updates only the provided fields", async () => {
    mQueryOne
      .mockResolvedValueOnce(roleRow() as never) // loadOrgRole
      .mockResolvedValueOnce(roleRow({ name: "New name" }) as never); // UPDATE ... RETURNING
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/orgs/${ORG}/roles/${ROLE}`,
      payload: { name: "New name" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().role.name).toBe("New name");
  });
});

describe("POST /api/orgs/:orgId/roles/:roleId/clone", () => {
  it("404s on an unknown source role", async () => {
    mQueryOne.mockResolvedValueOnce(null as never);
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/roles/${ROLE}/clone` });
    expect(res.statusCode).toBe(404);
  });

  it("clones a role into a new custom (non-system) role", async () => {
    mQueryOne
      .mockResolvedValueOnce(roleRow({ is_system: true, key: "owner", name: "Propriétaire" }) as never) // source
      .mockResolvedValueOnce(roleRow({ id: "clone1", name: "Propriétaire (copie)" }) as never); // INSERT ... RETURNING
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/orgs/${ORG}/roles/${ROLE}/clone` });
    expect(res.statusCode).toBe(200);
    expect(res.json().role.name).toBe("Propriétaire (copie)");
  });
});

describe("DELETE /api/orgs/:orgId/roles/:roleId", () => {
  it("forbids deleting the owner role", async () => {
    mQueryOne.mockResolvedValueOnce(roleRow({ key: "owner" }) as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/roles/${ROLE}` });
    expect(res.statusCode).toBe(403);
  });

  it("refuses to delete a role still granted to a member or a node ACL", async () => {
    mQueryOne
      .mockResolvedValueOnce(roleRow() as never) // loadOrgRole
      .mockResolvedValueOnce({ membership_count: 2, node_key_count: 0 } as never); // refs count
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/roles/${ROLE}` });
    expect(res.statusCode).toBe(409);
  });

  it("deletes an unreferenced custom role", async () => {
    mQueryOne
      .mockResolvedValueOnce(roleRow() as never)
      .mockResolvedValueOnce({ membership_count: 0, node_key_count: 0 } as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/orgs/${ORG}/roles/${ROLE}` });
    expect(res.statusCode).toBe(200);
    expect(mQuery).toHaveBeenCalledWith(expect.stringMatching(/DELETE FROM roles/), [ROLE, ORG]);
  });
});
