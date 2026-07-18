/**
 * Tests for the RBAC hardening ported from the 2026-07-15 audit:
 *  - resolveNodeAccess denies ALL access when the caller has no ACTIVE org
 *    membership (SCIM-deprovisioned/suspended member) — even node ownership
 *    and leftover node_keys/ACL rows no longer grant anything.
 *  - Moving a node purges the fanned-out (inherited) node_keys rows of its
 *    subtree inside the same transaction, so a principal who only had access
 *    via the old ancestor share loses it; a rename-only PATCH does not purge.
 *
 * DB and auth middleware are mocked (SQL-text-dispatched).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { randomUUID } from "node:crypto";

const USER = "00000000-0000-4000-8000-0000000000aa";
const NODE = "00000000-0000-4000-8000-0000000000bb";
const ORG = "00000000-0000-4000-8000-0000000000cc";

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
  closePool: vi.fn(async () => {}),
}));

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: vi.fn(async (req: { user?: unknown }) => {
    req.user = { id: USER, email: "u@example.org", fingerprint: "f" };
  }),
  requireUser: vi.fn(() => ({ id: USER, email: "u@example.org", fingerprint: "f" })),
  requireOrgPerm: vi.fn(async () => ({ orgId: ORG })),
  requireMembership: vi.fn(async () => ({ orgId: ORG })),
  requireNodePerm: vi.fn(async () => ({ nodeId: NODE, orgId: ORG, kind: "folder" })),
}));

import { query, queryOne, withTx } from "../src/db/pool.js";
import { resolveNodeAccess } from "../src/rbac/engine.js";
import { ApiError } from "../src/lib/errors.js";
import nodeRoutes from "../src/routes/nodes.js";

const mockedQueryOne = vi.mocked(queryOne);
const mockedQuery = vi.mocked(query);
const mockedWithTx = vi.mocked(withTx);

const NODE_ROW = {
  id: NODE,
  org_id: ORG,
  owner_user_id: USER, // the caller OWNS the node — ownership must not survive deprovisioning
  kind: "file",
  trashed_at: null,
};

const ACTIVE_MEMBERSHIP = {
  membership_id: "m1",
  role_id: "r1",
  role_key: "member",
  permissions: [],
  org_owner: "someone-else",
};

function mockDb(opts: { activeMember: boolean }) {
  mockedQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM nodes")) return NODE_ROW as never;
    if (sql.includes("FROM memberships")) return (opts.activeMember ? ACTIVE_MEMBERSHIP : null) as never;
    return null;
  });
  mockedQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM group_members")) return [] as never;
    // Leftover fanned-out grant: would give node.view if it were honored.
    if (sql.includes("FROM node_keys")) return [{ permissions: ["node.view"] }] as never;
    return [] as never;
  });
}

beforeEach(() => {
  mockedQueryOne.mockReset().mockResolvedValue(null);
  mockedQuery.mockReset().mockResolvedValue([]);
  mockedWithTx.mockReset();
});

describe("révocation SCIM : resolveNodeAccess sans membership active", () => {
  it("zéro accès pour un membre suspendu/déprovisionné, même propriétaire avec des node_keys restantes", async () => {
    mockDb({ activeMember: false });
    const access = await resolveNodeAccess(USER, NODE);
    expect(access).not.toBeNull();
    expect(access!.accessible).toBe(false);
    expect(access!.isOwner).toBe(false);
    expect(access!.permissions.size).toBe(0);
  });

  it("contrôle positif : le même utilisateur AVEC membership active garde son accès de propriétaire", async () => {
    mockDb({ activeMember: true });
    const access = await resolveNodeAccess(USER, NODE);
    expect(access!.accessible).toBe(true);
    expect(access!.isOwner).toBe(true);
    expect(access!.permissions.has("node.view")).toBe(true);
  });
});

describe("déplacement : purge des node_keys héritées (fanned-out)", () => {
  const UPDATED_ROW = { ...NODE_ROW, parent_id: null, kind: "folder", key_epoch: 1 };

  /** withTx stub: run the callback with a client that records every SQL. */
  function captureTx(): { sqls: string[] } {
    const captured = { sqls: [] as string[] };
    mockedWithTx.mockImplementation(async (fn: (c: unknown) => Promise<unknown>) => {
      const client = {
        query: vi.fn(async (sql: string) => {
          captured.sqls.push(sql);
          if (sql.includes("UPDATE nodes SET")) return { rows: [UPDATED_ROW] };
          return { rows: [] };
        }),
      };
      return fn(client);
    });
    return captured;
  }

  async function buildApp(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    app.setErrorHandler((err, _req, reply) => {
      if (err instanceof ApiError) {
        return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
      }
      if (err instanceof ZodError) {
        return reply.status(400).send({ error: { code: "validation", message: "Requête invalide." } });
      }
      return reply.status(500).send({ error: { code: "internal", message: String(err) } });
    });
    await app.register(nodeRoutes, { prefix: "/api/nodes" });
    return app;
  }

  it("PATCH avec parentId purge les lignes inherited_from IS NOT NULL du sous-arbre, dans la transaction", async () => {
    const captured = captureTx();
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/nodes/${NODE}`,
      payload: { parentId: randomUUID() },
    });
    expect(res.statusCode).toBe(200);
    const purge = captured.sqls.find((s) => s.includes("DELETE FROM node_keys"));
    expect(purge).toBeDefined();
    expect(purge).toContain("inherited_from IS NOT NULL"); // direct grants are kept
    expect(purge).toContain("RECURSIVE"); // the whole moved subtree is purged
    await app.close();
  });

  it("PATCH de renommage seul ne purge rien", async () => {
    const captured = captureTx();
    const app = await buildApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/nodes/${NODE}`,
      payload: { nameEncrypted: "aabb", nameNonce: "ccdd" },
    });
    expect(res.statusCode).toBe(200);
    expect(captured.sqls.some((s) => s.includes("DELETE FROM node_keys"))).toBe(false);
    await app.close();
  });
});
