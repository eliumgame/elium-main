/**
 * Approche A — Tranche 0 : demande de signature + écriture-retour anonyme.
 * DB et middleware d'auth mockés (dispatch par texte SQL), storage/audit/relay
 * mockés. On boote les routes sur une app Fastify nue et on injecte les requêtes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";

const USER = "00000000-0000-4000-8000-0000000000aa";
const NODE = "00000000-0000-4000-8000-0000000000bb";
const ORG = "00000000-0000-4000-8000-0000000000cc";
const ROLE = "00000000-0000-4000-8000-0000000000d1";
const LINK = "00000000-0000-4000-8000-0000000000e1";
const REQ = "00000000-0000-4000-8000-0000000000f1";
const PARTY = "00000000-0000-4000-8000-000000000a01";
const VER = "00000000-0000-4000-8000-000000000b01";
const NONCE = "0123456789abcdef01234567"; // 24 hex = 12 octets

const store = vi.hoisted(() => ({
  putStream: vi.fn(async () => 123),
  del: vi.fn(async () => {}),
  newKey: vi.fn(() => "blob-key"),
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
  requireNodePerm: vi.fn(async () => ({ nodeId: NODE, orgId: ORG, kind: "file", accessible: true })),
}));

vi.mock("../src/storage/adapter.js", () => ({
  storage: () => ({ newKey: store.newKey, putStream: store.putStream, delete: store.del, getStream: vi.fn() }),
}));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("../src/collab/relay.js", () => ({ notifyOrg: vi.fn(), kickRoom: vi.fn() }));

import { query, queryOne, withTx } from "../src/db/pool.js";
import { audit } from "../src/lib/audit.js";
import { notifyOrg } from "../src/collab/relay.js";
import { ApiError } from "../src/lib/errors.js";
import signingRoutes from "../src/routes/signing.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);
const mWithTx = vi.mocked(withTx);
const mAudit = vi.mocked(audit);
const mNotify = vi.mocked(notifyOrg);

/** Mirrors app.ts's global limit, so per-route `config.rateLimit` overrides (like in production) actually apply. */
async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addContentTypeParser("application/octet-stream", (_req, payload, done) => done(null, payload));
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "bad_request", message: "validation" } });
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({ error: { code: "rate_limited", message: "Trop de requêtes." } });
    }
    return reply.status(500).send({ error: { code: "internal", message: err.message } });
  });
  await app.register(signingRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

/** A withTx impl that dispatches client.query by SQL text and records the SQLs. */
function txDispatch(map: Array<[RegExp, { rows: unknown[] }]>, sink?: string[]) {
  return async (fn: (c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => unknown) =>
    fn({
      query: async (sql: string) => {
        sink?.push(sql);
        for (const [re, res] of map) if (re.test(sql)) return res;
        return { rows: [] };
      },
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  store.putStream.mockResolvedValue(123);
});

describe("POST /api/nodes/:id/sign-requests (création)", () => {
  it("crée un lien scellé can_sign + demande + partie, renvoie le token", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE }); // role check
    mWithTx.mockImplementation(
      txDispatch([
        [/INSERT INTO share_links/, { rows: [{ id: LINK }] }],
        [/INSERT INTO signature_requests/, { rows: [{ id: REQ }] }],
        [/INSERT INTO signature_request_parties/, { rows: [{ id: PARTY }] }],
      ]) as never,
    );

    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/nodes/${NODE}/sign-requests`,
      payload: { roleId: ROLE, ordered: false, parties: [{ label: "Direction", wrappedKey: { recipients: [], content: "ab" } }] },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requestId).toBe(REQ);
    expect(body.parties).toHaveLength(1);
    expect(body.parties[0].index).toBe(0);
    expect(body.parties[0].partyId).toBe(PARTY);
    expect(body.parties[0].token).toMatch(/^[A-Za-z0-9_-]{40,}$/); // randomToken(32) base64url
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "node.sign.request", "file", NODE, { requestId: REQ, parties: 1, ordered: false }, expect.any(String));
    await app.close();
  });

  it("crée N parties (indices 0..N-1) avec des tokens distincts + drapeau ordered", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE });
    mWithTx.mockImplementation(
      txDispatch([
        [/INSERT INTO share_links/, { rows: [{ id: LINK }] }],
        [/INSERT INTO signature_requests/, { rows: [{ id: REQ }] }],
        [/INSERT INTO signature_request_parties/, { rows: [{ id: PARTY }] }],
      ]) as never,
    );
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/nodes/${NODE}/sign-requests`,
      payload: {
        roleId: ROLE, ordered: true,
        parties: [
          { label: "Direction", wrappedKey: { c: "a" } },
          { label: "RH", wrappedKey: { c: "b" } },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.parties).toHaveLength(2);
    expect(body.parties.map((p: { index: number }) => p.index)).toEqual([0, 1]);
    expect(body.parties[0].token).not.toBe(body.parties[1].token); // un token par partie
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "node.sign.request", "file", NODE, { requestId: REQ, parties: 2, ordered: true }, expect.any(String));
    await app.close();
  });

  it("refuse un rôle étranger à l'organisation", async () => {
    mQueryOne.mockResolvedValueOnce(null); // role not found
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/nodes/${NODE}/sign-requests`,
      payload: { roleId: ROLE, parties: [{ wrappedKey: { x: 1 } }] },
    });
    expect(res.statusCode).toBe(400);
    expect(mWithTx).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuse une demande sans partie (parties vide)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/nodes/${NODE}/sign-requests`,
      payload: { roleId: ROLE, parties: [] },
    });
    expect(res.statusCode).toBe(400); // zod: min(1)
    await app.close();
  });
});

describe("rate limiting : POST /api/nodes/:id/sign-requests", () => {
  it("limité à 20/min", async () => {
    mQueryOne.mockResolvedValue({ id: ROLE }); // role check, valide à chaque itération
    mWithTx.mockImplementation(
      txDispatch([
        [/INSERT INTO share_links/, { rows: [{ id: LINK }] }],
        [/INSERT INTO signature_requests/, { rows: [{ id: REQ }] }],
        [/INSERT INTO signature_request_parties/, { rows: [{ id: PARTY }] }],
      ]) as never,
    );

    const app = await makeApp();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const res = await app.inject({
        method: "POST",
        url: `/api/nodes/${NODE}/sign-requests`,
        payload: { roleId: ROLE, parties: [{ wrappedKey: { c: "x" } }] },
      });
      last = res.statusCode;
      if (i < 20) expect(res.statusCode).toBe(200);
    }
    expect(last).toBe(429);
    await app.close();
  });
});

describe("POST /api/links/:token/sign (écriture-retour anonyme)", () => {
  const signLink = (over: Record<string, unknown> = {}) => ({
    link_id: LINK, node_id: NODE, can_sign: true, revoked_at: null, expires_at: null,
    org_id: ORG, kind: "file", party_id: PARTY, party_status: "pending",
    party_index: 0, ordered: false, deadline: null, request_id: REQ, ...over,
  });

  it("stocke la version signée, marque la partie signée, renvoie ok", async () => {
    mQueryOne.mockResolvedValueOnce(signLink()); // link resolve
    const sqls: string[] = [];
    mWithTx.mockImplementation(
      txDispatch(
        [
          [/SELECT key_epoch FROM nodes/, { rows: [{ key_epoch: 1 }] }],
          [/storage_quota_bytes/, { rows: [{ quota: null, used: 0 }] }],
          [/MAX\(version_no\)/, { rows: [{ next: 1 }] }],
          [/INSERT INTO node_versions/, { rows: [{ id: VER }] }],
        ],
        sqls,
      ) as never,
    );

    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/links/tok123/sign`,
      headers: { "content-type": "application/octet-stream", "x-content-nonce": NONCE, "x-signer-fpr": "abcdef0123456789" },
      payload: Buffer.from("ciphertext-signé"),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(store.putStream).toHaveBeenCalledTimes(1);
    // la node_version est créée SANS created_by (signataire anonyme)
    expect(sqls.some((s) => /INSERT INTO node_versions/.test(s) && /NULL/.test(s))).toBe(true);
    // la partie est marquée signée + la complétion de la demande est recalculée
    expect(sqls.some((s) => /UPDATE signature_request_parties[\s\S]*status = 'signed'/.test(s))).toBe(true);
    expect(sqls.some((s) => /UPDATE signature_requests[\s\S]*completed/.test(s))).toBe(true);
    expect(mNotify).toHaveBeenCalledWith(ORG);
    expect(mAudit).toHaveBeenCalledWith(ORG, null, "node.sign.submit", "file", NODE, { signerFpr: "abcdef0123456789" }, expect.any(String));
    await app.close();
  });

  it("circuit ordonné : refuse tant qu'une partie précédente n'a pas signé (409)", async () => {
    mQueryOne
      .mockResolvedValueOnce(signLink({ ordered: true, party_index: 1 })) // résolution du lien
      .mockResolvedValueOnce({ n: "1" }); // 1 partie d'index < 1 encore en attente
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/links/tok/sign`,
      headers: { "content-type": "application/octet-stream", "x-content-nonce": NONCE },
      payload: Buffer.from("x"),
    });
    expect(res.statusCode).toBe(409);
    expect(store.putStream).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuse la signature après l'échéance (409)", async () => {
    mQueryOne.mockResolvedValueOnce(signLink({ deadline: "2020-01-01T00:00:00Z" }));
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/links/tok/sign`,
      headers: { "content-type": "application/octet-stream", "x-content-nonce": NONCE },
      payload: Buffer.from("x"),
    });
    expect(res.statusCode).toBe(409);
    expect(store.putStream).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuse un nonce invalide (avant toute résolution)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/links/tok/sign`,
      headers: { "content-type": "application/octet-stream", "x-content-nonce": "zz" },
      payload: Buffer.from("x"),
    });
    expect(res.statusCode).toBe(400);
    expect(mQueryOne).not.toHaveBeenCalled();
    expect(store.putStream).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuse un lien non habilité à signer (can_sign=false)", async () => {
    mQueryOne.mockResolvedValueOnce(signLink({ can_sign: false }));
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/links/tok/sign`,
      headers: { "content-type": "application/octet-stream", "x-content-nonce": NONCE },
      payload: Buffer.from("x"),
    });
    expect(res.statusCode).toBe(400);
    expect(store.putStream).not.toHaveBeenCalled();
    await app.close();
  });

  it("refuse une partie déjà signée (409)", async () => {
    mQueryOne.mockResolvedValueOnce(signLink({ party_status: "signed" }));
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/links/tok/sign`,
      headers: { "content-type": "application/octet-stream", "x-content-nonce": NONCE },
      payload: Buffer.from("x"),
    });
    expect(res.statusCode).toBe(409);
    expect(store.putStream).not.toHaveBeenCalled();
    await app.close();
  });

  it("404 générique sur lien révoqué", async () => {
    mQueryOne.mockResolvedValueOnce(signLink({ revoked_at: "2026-01-01T00:00:00Z" }));
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/links/tok/sign`,
      headers: { "content-type": "application/octet-stream", "x-content-nonce": NONCE },
      payload: Buffer.from("x"),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /api/links/:token/decline (refus anonyme)", () => {
  const declineLink = (over: Record<string, unknown> = {}) => ({
    can_sign: true, revoked_at: null, node_id: NODE, org_id: ORG, party_id: PARTY, party_status: "pending", ...over,
  });

  it("marque la partie 'declined' et renvoie ok", async () => {
    mQueryOne.mockResolvedValueOnce(declineLink());
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/links/tok/decline` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mQuery).toHaveBeenCalledWith(expect.stringMatching(/UPDATE signature_request_parties[\s\S]*declined/), [PARTY]);
    expect(mNotify).toHaveBeenCalledWith(ORG);
    expect(mAudit).toHaveBeenCalledWith(ORG, null, "node.sign.decline", "file", NODE, {}, expect.any(String));
    await app.close();
  });

  it("refuse si la partie a déjà signé (409)", async () => {
    mQueryOne.mockResolvedValueOnce(declineLink({ party_status: "signed" }));
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/links/tok/decline` });
    expect(res.statusCode).toBe(409);
    await app.close();
  });
});

describe("GET /api/nodes/:id/sign-requests (suivi)", () => {
  it("regroupe les parties sous leur demande", async () => {
    mQuery.mockResolvedValueOnce([
      {
        request_id: REQ, request_status: "pending", ordered: false, deadline: null,
        created_at: "2026-08-11T00:00:00Z", completed_at: null,
        party_id: PARTY, party_index: 0, label: "Direction", party_status: "signed",
        signer_fpr: "abcd", signed_at: "2026-08-11T01:00:00Z", submission_version_id: VER,
      },
      {
        request_id: REQ, request_status: "pending", ordered: false, deadline: null,
        created_at: "2026-08-11T00:00:00Z", completed_at: null,
        party_id: "p2", party_index: 1, label: "RH", party_status: "pending",
        signer_fpr: null, signed_at: null, submission_version_id: null,
      },
    ] as never);

    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes/${NODE}/sign-requests` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].id).toBe(REQ);
    expect(body.requests[0].parties).toHaveLength(2);
    expect(body.requests[0].parties[0]).toMatchObject({ index: 0, status: "signed", signerFpr: "abcd", submissionVersionId: VER });
    expect(body.requests[0].parties[1]).toMatchObject({ index: 1, status: "pending", signerFpr: null });
    await app.close();
  });
});
