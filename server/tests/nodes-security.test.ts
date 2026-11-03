/**
 * Durcissements des routes de nœuds (audit 2026-11, lot A2) :
 *  - POST /:id/rotate : la part de recouvrement d'organisation ne peut pas
 *    disparaître d'une rotation quand elle existait.
 * DB, auth, relais, stockage simulés (dispatch par texte SQL).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const USER = "00000000-0000-4000-8000-0000000000aa";
const OWNER = "00000000-0000-4000-8000-0000000000ab";
const NODE = "00000000-0000-4000-8000-0000000000bb";
const ORG = "00000000-0000-4000-8000-0000000000cc";
const ROLE = "00000000-0000-4000-8000-0000000000d1";

const store = vi.hoisted(() => ({
  getStream: vi.fn(),
  newKey: vi.fn(() => "blob-new"),
  putStream: vi.fn(async () => 5),
  delete: vi.fn(async () => {}),
}));

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
  requireNodePerm: vi.fn(async () => ({ nodeId: NODE, orgId: ORG, kind: "file", ownerUserId: OWNER })),
}));
vi.mock("../src/collab/relay.js", () => ({ kickRoom: vi.fn(), notifyOrg: vi.fn() }));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("../src/storage/adapter.js", () => ({ storage: () => store }));
vi.mock("../src/lib/disk.js", () => ({ assertDiskSpace: vi.fn(async () => {}) }));
vi.mock("../src/lib/site-settings.js", () => ({
  assertUserQuota: vi.fn(async () => {}),
  getSiteSettings: vi.fn(async () => ({})),
}));

import { query, queryOne, withTx } from "../src/db/pool.js";
import { ApiError } from "../src/lib/errors.js";
import nodeRoutes from "../src/routes/nodes.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);
const mWithTx = vi.mocked(withTx);

type Row = Record<string, unknown>;
function tx(map: Array<[RegExp, Row[]]>, sink: string[]) {
  mWithTx.mockImplementation((async (fn: (c: unknown) => unknown) =>
    fn({
      query: async (sql: string) => {
        sink.push(sql);
        for (const [re, rows] of map) if (re.test(sql)) return { rows, rowCount: rows.length };
        return { rows: [], rowCount: 0 };
      },
    })) as never);
}

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: "bad_request" } });
    return reply.status(500).send({ error: { code: "internal", message: String(err) } });
  });
  await app.register(nodeRoutes, { prefix: "/api/nodes" });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mQuery.mockResolvedValue([] as never);
  mQueryOne.mockResolvedValue(null as never);
});

describe("purge du sous-arbre", () => {
  it("supprime les blobs descendants et versions après la cascade, une seule fois", async () => {
    mQueryOne.mockResolvedValue({ trashed_at: "2026-01-01", content_ref: null });
    const order: string[] = [];
    mQuery.mockImplementation(async (sql, params) => {
      expect(params).toEqual([NODE]);
      if (sql.includes("WITH RECURSIVE")) {
        expect(sql).toContain("n.parent_id = s.id");
        expect(sql).toContain("v.node_id = s.id");
        return [{ content_ref: null }, { content_ref: "child" }, { content_ref: "version" }, { content_ref: "child" }];
      }
      if (sql.startsWith("DELETE FROM nodes")) order.push("db");
      return [];
    });
    store.delete.mockImplementation(async () => { order.push("blob"); });
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/purge` });
    expect(res.statusCode).toBe(200);
    expect(order).toEqual(["db", "blob", "blob"]);
    expect(store.delete).toHaveBeenCalledWith("child");
    expect(store.delete).toHaveBeenCalledWith("version");
    await app.close();
  });

  it("ne supprime aucun blob si la suppression SQL échoue", async () => {
    mQueryOne.mockResolvedValue({ trashed_at: "2026-01-01", content_ref: null });
    mQuery.mockImplementation(async (sql) => {
      if (sql.includes("WITH RECURSIVE")) return [{ content_ref: "child" }];
      throw new Error("database unavailable");
    });
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/purge` });
    expect(res.statusCode).toBe(500);
    expect(store.delete).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("POST /api/nodes/:id/rotate — part de recouvrement d'organisation", () => {
  const ownerShare = { principalType: "user", principalId: OWNER, roleId: ROLE, wrappedKey: { r: 1 } };
  const orgShare = { principalType: "org", principalId: ORG, roleId: ROLE, wrappedKey: { r: 2 } };
  const body = (keyShares: unknown[]) => ({ nameEncrypted: "abcd", nameNonce: "abcd", keyShares });

  it("400 si la part 'org' existante est omise : aucune part n'est supprimée", async () => {
    mQuery.mockResolvedValueOnce([{ id: ROLE }] as never); // rôles valides
    const sqls: string[] = [];
    tx(
      [
        [/SELECT key_epoch FROM nodes/, [{ key_epoch: 1 }]],
        [/principal_type = 'org'/, [{ "?column?": 1 }]],
      ],
      sqls,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/nodes/${NODE}/rotate`, payload: body([ownerShare]) });
    expect(res.statusCode).toBe(400);
    expect(sqls.some((s) => /DELETE FROM node_keys/.test(s))).toBe(false);
    await app.close();
  });

  it("accepte la rotation quand la part 'org' est conservée", async () => {
    mQuery.mockResolvedValueOnce([{ id: ROLE }] as never);
    const sqls: string[] = [];
    tx(
      [
        [/SELECT key_epoch FROM nodes/, [{ key_epoch: 1 }]],
        [/principal_type = 'org'/, [{ "?column?": 1 }]],
        [/UPDATE nodes/, [{ id: NODE, key_epoch: 2, kind: "file" }]],
      ],
      sqls,
    );
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/nodes/${NODE}/rotate`,
      payload: body([ownerShare, orgShare]),
    });
    expect(res.statusCode).toBe(200);
    expect(sqls.some((s) => /DELETE FROM node_keys/.test(s))).toBe(true);
    await app.close();
  });

  it("un nœud sans part 'org' (organisation sans clé) tourne sans elle", async () => {
    mQuery.mockResolvedValueOnce([{ id: ROLE }] as never);
    const sqls: string[] = [];
    tx(
      [
        [/SELECT key_epoch FROM nodes/, [{ key_epoch: 1 }]],
        [/UPDATE nodes/, [{ id: NODE, key_epoch: 2, kind: "file" }]],
      ],
      sqls,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/nodes/${NODE}/rotate`, payload: body([ownerShare]) });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
