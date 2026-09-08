/**
 * Unit tests for src/routes/versions.ts — file version history: list, download
 * a past version's ciphertext, restore one as current. (The PUT .../content
 * re-encryption route, used only during key rotation, is exercised indirectly
 * by node-access.test.ts-style coverage elsewhere and is not duplicated here.)
 * DB, auth middleware, and storage are mocked, matching tests/orgs.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { Readable } from "node:stream";

const NODE = "00000000-0000-4000-8000-0000000000bb";
const VERSION = "00000000-0000-4000-8000-0000000000d2";
const ORG = "00000000-0000-4000-8000-0000000000cc";
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
  requireNodePerm: vi.fn(async () => ({ nodeId: NODE, orgId: ORG, kind: "file", ownerUserId: USER })),
}));

vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));

vi.mock("../src/storage/adapter.js", () => ({
  storage: vi.fn(() => ({
    getStream: vi.fn(async () => Readable.from([Buffer.from("ciphertext")])),
    newKey: vi.fn(() => "blob-new"),
    putStream: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
  })),
}));

import { query, queryOne, withTx } from "../src/db/pool.js";
import { requireNodePerm } from "../src/middleware/auth.js";
import { ApiError } from "../src/lib/errors.js";
import versionRoutes from "../src/routes/versions.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);
const mWithTx = vi.mocked(withTx);
const mRequireNodePerm = vi.mocked(requireNodePerm);

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
  await app.register(versionRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mQuery.mockResolvedValue([] as never);
  mQueryOne.mockResolvedValue(null as never);
  mRequireNodePerm.mockResolvedValue({ nodeId: NODE, orgId: ORG, kind: "file", ownerUserId: USER } as never);
});

describe("GET /api/nodes/:id/versions", () => {
  it("lists versions newest-first, mapped to camelCase DTOs", async () => {
    mQuery.mockResolvedValueOnce([
      {
        id: VERSION,
        version_no: 3,
        size_bytes: 42,
        key_epoch: 1,
        created_by: USER,
        created_at: "t1",
        created_by_email: "u@example.org",
        created_by_name: "U",
      },
    ] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes/${NODE}/versions` });
    expect(res.statusCode).toBe(200);
    expect(res.json().versions).toEqual([
      {
        id: VERSION,
        versionNo: 3,
        sizeBytes: 42,
        keyEpoch: 1,
        createdBy: USER,
        createdByEmail: "u@example.org",
        createdByName: "U",
        createdAt: "t1",
      },
    ]);
    expect(mRequireNodePerm).toHaveBeenCalledWith(expect.anything(), NODE, "node.version.view");
  });
});

describe("GET /api/nodes/:id/versions/:versionId/content", () => {
  it("streams the ciphertext with the nonce header when the version exists", async () => {
    mQueryOne.mockResolvedValueOnce({
      content_ref: "blob-1",
      content_nonce: Buffer.from("0123456789ab", "hex"),
    } as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes/${NODE}/versions/${VERSION}/content` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-nonce"]).toBe("0123456789ab");
    expect(res.headers["content-type"]).toBe("application/octet-stream");
  });

  it("404s when the version does not belong to this node", async () => {
    mQueryOne.mockResolvedValueOnce(null as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes/${NODE}/versions/${VERSION}/content` });
    expect(res.statusCode).toBe(404);
  });
});

describe("POST /api/nodes/:id/versions/:versionId/restore", () => {
  it("404s when the version does not exist", async () => {
    mQueryOne.mockResolvedValueOnce(null as never);
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/nodes/${NODE}/versions/${VERSION}/restore` });
    expect(res.statusCode).toBe(404);
    expect(mRequireNodePerm).toHaveBeenCalledWith(expect.anything(), NODE, "node.version.restore");
  });

  it("restores the version as the node's current content", async () => {
    mQueryOne.mockResolvedValueOnce({
      content_ref: "blob-1",
      content_nonce: Buffer.from("0123456789ab", "hex"),
      size_bytes: 99,
    } as never);
    mWithTx.mockImplementationOnce(async () => ({
      id: NODE,
      size_bytes: 99,
      content_nonce: Buffer.from("0123456789ab", "hex"),
      modified_at: "t2",
    }));
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/nodes/${NODE}/versions/${VERSION}/restore` });
    expect(res.statusCode).toBe(200);
    expect(res.json().node).toMatchObject({ id: NODE, sizeBytes: 99, contentNonce: "0123456789ab" });
  });

  it("404s when the update inside the transaction finds no matching node", async () => {
    mQueryOne.mockResolvedValueOnce({
      content_ref: "blob-1",
      content_nonce: Buffer.from("0123456789ab", "hex"),
      size_bytes: 99,
    } as never);
    mWithTx.mockImplementationOnce(async () => undefined);
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/nodes/${NODE}/versions/${VERSION}/restore` });
    expect(res.statusCode).toBe(404);
  });
});
