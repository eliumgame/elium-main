/**
 * PUT /api/nodes/:id/versions/:versionId/content — réécriture d'un blob de
 * version, RÉSERVÉE à une rotation de clé en cours (audit 2026-11) :
 *  - refusée (409) quand la version est déjà sous l'époque courante du nœud,
 *    sans toucher au stockage ni supprimer l'ancien blob ;
 *  - acceptée pendant une rotation (époque de version < époque du nœud).
 * DB, auth et stockage sont simulés (dispatch par texte SQL).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const NODE = "00000000-0000-4000-8000-0000000000bb";
const VERSION = "00000000-0000-4000-8000-0000000000d2";
const ORG = "00000000-0000-4000-8000-0000000000cc";
const USER = "00000000-0000-4000-8000-0000000000aa";
const NONCE = "0123456789abcdef01234567";

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
    req.user = { id: USER, email: "u@example.org", fingerprint: "f", displayName: "U" };
  }),
  requireUser: vi.fn(() => ({ id: USER, email: "u@example.org", fingerprint: "f", displayName: "U" })),
  requireNodePerm: vi.fn(async () => ({ nodeId: NODE, orgId: ORG, kind: "file", ownerUserId: USER })),
}));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("../src/storage/adapter.js", () => ({ storage: () => store }));
vi.mock("../src/lib/disk.js", () => ({ assertDiskSpace: vi.fn(async () => {}) }));
vi.mock("../src/lib/site-settings.js", () => ({ assertUserQuota: vi.fn(async () => {}) }));

import { withTx } from "../src/db/pool.js";
import { ApiError } from "../src/lib/errors.js";
import versionRoutes from "../src/routes/versions.js";

const mWithTx = vi.mocked(withTx);

type Row = Record<string, unknown>;
/** withTx simulé : chaque requête est dispatchée par motif SQL ; les SQL sont enregistrés. */
const calls: { sql: string; params: unknown[] }[] = [];
function tx(map: Array<[RegExp, Row[]]>, sink: string[]) {
  mWithTx.mockImplementation((async (fn: (c: unknown) => unknown) =>
    fn({
      query: async (sql: string, params: unknown[] = []) => {
        sink.push(sql);
        calls.push({ sql, params });
        for (const [re, rows] of map) if (re.test(sql)) return { rows, rowCount: rows.length };
        return { rows: [], rowCount: 0 };
      },
    })) as never);
}

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err instanceof Error ? err.message : String(err) } });
    }
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: "bad_request" } });
    return reply.status(500).send({ error: { code: "internal", message: err instanceof Error ? err.message : String(err) } });
  });
  await app.register(versionRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

const put = (app: FastifyInstance) =>
  app.inject({
    method: "PUT",
    url: `/api/nodes/${NODE}/versions/${VERSION}/content`,
    headers: { "content-type": "application/octet-stream", "x-content-nonce": NONCE },
    payload: Buffer.from("hello"),
  });

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  store.putStream.mockResolvedValue(5);
});

describe("PUT /api/nodes/:id/versions/:versionId/content — garde d'époque", () => {
  it("409 hors rotation (version déjà sous l'époque courante) : l'ancien blob n'est PAS supprimé", async () => {
    const sqls: string[] = [];
    tx(
      [
        [/FROM nodes WHERE id = \$1 FOR UPDATE/, [{ key_epoch: 2, current_version_id: VERSION }]],
        [/FROM node_versions WHERE id = \$1/, [{ content_ref: "blob-old", key_epoch: 2, size_bytes: 5 }]],
      ],
      sqls,
    );
    const app = await makeApp();
    const res = await put(app);
    expect(res.statusCode).toBe(409);
    expect(sqls.some((s) => /UPDATE node_versions/.test(s))).toBe(false);
    // Seul le nouveau blob (jamais référencé) est nettoyé — pas l'historique.
    expect(store.delete).toHaveBeenCalledWith("blob-new");
    expect(store.delete).not.toHaveBeenCalledWith("blob-old");
    await app.close();
  });

  it("accepte la réécriture pendant une rotation (époque de version < époque du nœud)", async () => {
    const sqls: string[] = [];
    tx(
      [
        [/FROM nodes WHERE id = \$1 FOR UPDATE/, [{ key_epoch: 3, current_version_id: "other" }]],
        [/FROM node_versions WHERE id = \$1/, [{ content_ref: "blob-old", key_epoch: 2, size_bytes: 5 }]],
      ],
      sqls,
    );
    const app = await makeApp();
    const res = await put(app);
    expect(res.statusCode).toBe(200);
    expect(sqls.some((s) => /UPDATE node_versions/.test(s))).toBe(true);
    expect(store.delete).toHaveBeenCalledWith("blob-old");
    await app.close();
  });
});

describe("PUT /api/nodes/:id/versions/:versionId/content — taille et quota", () => {
  it("met à jour size_bytes (version ET nœud courant) avec la taille réelle écrite", async () => {
    store.putStream.mockResolvedValueOnce(5);
    tx(
      [
        [/FROM nodes WHERE id = \$1 FOR UPDATE/, [{ key_epoch: 3, current_version_id: VERSION, owner_user_id: USER }]],
        [/FROM node_versions WHERE id = \$1/, [{ content_ref: "blob-old", key_epoch: 2, size_bytes: 5 }]],
      ],
      [],
    );
    const app = await makeApp();
    const res = await put(app);
    expect(res.statusCode).toBe(200);
    const v = calls.find((c) => /UPDATE node_versions/.test(c.sql))!;
    expect(v.sql).toMatch(/size_bytes = \$6/);
    expect(v.params[5]).toBe(5);
    const n = calls.find((c) => /UPDATE nodes SET/.test(c.sql))!;
    expect(n.sql).toMatch(/size_bytes = \$5/);
    expect(n.params[4]).toBe(5);
    await app.close();
  });

  it("507 quand la nouvelle taille fait dépasser le quota d'organisation : nouveau blob supprimé, historique intact", async () => {
    store.putStream.mockResolvedValueOnce(1000);
    tx(
      [
        [/FROM nodes WHERE id = \$1 FOR UPDATE/, [{ key_epoch: 3, current_version_id: "other", owner_user_id: USER }]],
        [/FROM node_versions WHERE id = \$1/, [{ content_ref: "blob-old", key_epoch: 2, size_bytes: 1 }]],
        [/FROM organizations o/, [{ quota: 500, used: 10 }]],
      ],
      [],
    );
    const app = await makeApp();
    const res = await put(app);
    expect(res.statusCode).toBe(507);
    expect(calls.some((c) => /pg_advisory_xact_lock/.test(c.sql))).toBe(true);
    expect(calls.some((c) => /UPDATE node_versions/.test(c.sql))).toBe(false);
    expect(store.delete).toHaveBeenCalledWith("blob-new");
    expect(store.delete).not.toHaveBeenCalledWith("blob-old");
    await app.close();
  });
});
