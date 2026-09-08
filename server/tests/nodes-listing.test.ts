/**
 * Tests for GET /api/nodes (folder listing) — specifically the keyset cursor
 * pagination added alongside the anti-N+1 rotation batching. Until now this
 * had no coverage at all: unlike its sibling (audit-chain.ts's pagination,
 * which has a dedicated multi-page test suite), encodeListCursor/
 * decodeListCursor, the 3-column WHERE clause, and the invalid-cursor 400
 * were never exercised. DB and auth middleware are mocked (SQL-text
 * dispatch), matching the style of tests/node-access.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const USER = "00000000-0000-4000-8000-0000000000aa";
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
  requireMembership: vi.fn(async () => ({ orgId: ORG })),
  requireOrgPerm: vi.fn(async () => ({ orgId: ORG })),
  requireNodePerm: vi.fn(async () => ({ nodeId: "n", orgId: ORG, kind: "folder" })),
}));

vi.mock("../src/collab/relay.js", () => ({ kickRoom: vi.fn(), notifyOrg: vi.fn() }));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));

import { query } from "../src/db/pool.js";
import { ApiError } from "../src/lib/errors.js";
import nodeRoutes from "../src/routes/nodes.js";

const mQuery = vi.mocked(query);

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
  await app.register(nodeRoutes, { prefix: "/api/nodes" });
  await app.ready();
  return app;
}

function nodeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "node-1",
    org_id: ORG,
    parent_id: null,
    kind: "file",
    owner_user_id: USER,
    name_encrypted: null,
    name_nonce: null,
    meta_encrypted: null,
    meta_nonce: null,
    app_kind: null,
    size_bytes: 0,
    content_ref: null,
    content_nonce: null,
    trashed_at: null,
    key_epoch: 1,
    prev_key_wrapped: null,
    prev_key_nonce: null,
    created_at: "2026-01-01T00:00:00.000Z",
    modified_at: "2026-01-01T00:00:00.000Z",
    my_wrapped_key: { c: "w" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mQuery.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM group_members")) return [] as never;
    return [] as never;
  });
});

describe("GET /api/nodes — keyset pagination", () => {
  it("returns nextCursor only when the page came back exactly full", async () => {
    const rows = [nodeRow({ id: "n1" }), nodeRow({ id: "n2" })];
    mQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM group_members")) return [] as never;
      if (sql.includes("FROM nodes")) return rows as never;
      return [] as never;
    });
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes?orgId=${ORG}&limit=2` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.nodes).toHaveLength(2);
    expect(body.nextCursor).toEqual(expect.any(String));

    // The cursor must decode back to the LAST row's (kind, created_at, id).
    const decoded = JSON.parse(Buffer.from(body.nextCursor, "base64url").toString("utf8"));
    expect(decoded).toEqual({ k: "file", c: "2026-01-01T00:00:00.000Z", i: "n2" });
  });

  it("omits nextCursor when the page comes back short of the limit (last page)", async () => {
    mQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM group_members")) return [] as never;
      if (sql.includes("FROM nodes")) return [nodeRow()] as never; // 1 row, limit defaults to 1000
      return [] as never;
    });
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes?orgId=${ORG}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().nextCursor).toBeNull();
  });

  it("round-trips a real cursor into the next page's query params", async () => {
    const captured: unknown[][] = [];
    mQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM group_members")) return [] as never;
      if (sql.includes("FROM nodes")) {
        captured.push(params ?? []);
        return [] as never;
      }
      return [] as never;
    });
    const cursor = Buffer.from(JSON.stringify({ k: "file", c: "2026-01-01T00:00:00.000Z", i: "n2" }), "utf8").toString(
      "base64url",
    );
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes?orgId=${ORG}&cursor=${cursor}` });
    expect(res.statusCode).toBe(200);
    // Params order: [userId, orgId, parentId, groupIds, cursor.k, cursor.c, cursor.i, limit]
    expect(captured[0]).toEqual([USER, ORG, null, [], "file", "2026-01-01T00:00:00.000Z", "n2", 1000]);
  });

  it("400s on a malformed cursor instead of a raw crash", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes?orgId=${ORG}&cursor=not-valid-base64url-json` });
    expect(res.statusCode).toBe(400);
  });

  it("400s on a well-formed base64url payload that isn't the expected cursor shape", async () => {
    const bogus = Buffer.from(JSON.stringify({ foo: "bar" }), "utf8").toString("base64url");
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes?orgId=${ORG}&cursor=${bogus}` });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a limit above the hard cap (5000) via schema validation", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes?orgId=${ORG}&limit=5001` });
    expect(res.statusCode).toBe(400);
  });
});
