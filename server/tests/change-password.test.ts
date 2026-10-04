/**
 * POST /auth/change-password : re-wrap du key bundle sous un nouveau masterKey,
 * rotation de authSignPublicHex, ré-authentification par signature d'un défi
 * (sans jamais envoyer de mot de passe), révocation des sessions.
 * La base est simulée (dispatch sur le texte SQL) ; jetons et signatures réels.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { generateKeyPairSync, sign as edSign, randomUUID } from "node:crypto";

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
  closePool: vi.fn(async () => {}),
}));

import { query, queryOne } from "../src/db/pool.js";
import { ApiError } from "../src/lib/errors.js";
import { issueAccessToken } from "../src/lib/tokens.js";
import authRoutes from "../src/routes/auth.js";

const mockedQueryOne = vi.mocked(queryOne);
const mockedQuery = vi.mocked(query);

function keypairHex() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return {
    pubHex: Buffer.from(jwk.x, "base64url").toString("hex"),
    sign: (m: string) => edSign(null, Buffer.from(m), privateKey).toString("hex"),
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: "validation", message: "Requête invalide." } });
    return reply.status(500).send({ error: { code: "internal", message: String(err) } });
  });
  await app.register(authRoutes, { prefix: "/api/auth" });
  return app;
}

const USER_ID = "00000000-0000-4000-8000-000000000001";
const FPR = "c".repeat(64);
const EMAIL = "alice@example.org";
const NONCE = "d".repeat(64);

function setup(opts: { currentKey: ReturnType<typeof keypairHex>; challengeUser?: string; used?: boolean; expired?: boolean }) {
  mockedQueryOne.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT id, fingerprint, email, display_name, status FROM users")) {
      return { id: USER_ID, fingerprint: FPR, email: EMAIL, display_name: "Alice", status: "active" } as never;
    }
    if (sql.includes("SELECT email, auth_sign_public_hex FROM users")) {
      return { email: EMAIL, auth_sign_public_hex: opts.currentKey.pubHex } as never;
    }
    if (sql.includes("FROM login_challenges")) {
      return {
        id: "ch",
        user_id: opts.challengeUser ?? USER_ID,
        nonce: NONCE,
        expires_at: new Date(Date.now() + (opts.expired ? -1000 : 60_000)).toISOString(),
        used_at: opts.used ? new Date().toISOString() : null,
      } as never;
    }
    return null;
  });
}

function body(current: ReturnType<typeof keypairHex>, next: ReturnType<typeof keypairHex>, over: Record<string, unknown> = {}) {
  return {
    challengeId: randomUUID(),
    signature: current.sign(NONCE),
    newAuthSignPublicHex: next.pubHex,
    newAuthSignProof: next.sign(EMAIL),
    newKdfSalt: "ab".repeat(16),
    newKdfParams: { alg: "argon2id", t: 3, m: 65536, p: 1 },
    newKeyBundle: { v: 1, alg: "aes-256-gcm", nonce: "00".repeat(12), ct: "11".repeat(48) },
    ...over,
  };
}

const auth = () => ({ authorization: `Bearer ${issueAccessToken(USER_ID, FPR).token}` });

beforeEach(() => {
  mockedQueryOne.mockReset().mockResolvedValue(null);
  mockedQuery.mockReset().mockResolvedValue([]);
});

describe("POST /auth/change-password", () => {
  it("ré-enveloppe le bundle, fait tourner la clé d'authentification, révoque les sessions et en émet une nouvelle", async () => {
    const app = await buildApp();
    const cur = keypairHex();
    const next = keypairHex();
    setup({ currentKey: cur });
    const res = await app.inject({ method: "POST", url: "/api/auth/change-password", headers: auth(), payload: body(cur, next) });
    expect(res.statusCode).toBe(200);
    const out = res.json();
    expect(out.ok).toBe(true);
    expect(out.accessToken).toBeTruthy();
    expect(out.refreshToken).toBeTruthy();
    const sqls = mockedQuery.mock.calls.map((c) => String(c[0]));
    const update = mockedQuery.mock.calls.find((c) => String(c[0]).includes("UPDATE users"))!;
    expect((update[1] as unknown[])[1]).toBe(next.pubHex); // authSignPublicHex pivoté
    expect(sqls.some((s) => s.includes("UPDATE sessions SET revoked_at"))).toBe(true);
    expect(sqls.some((s) => s.includes("UPDATE login_challenges SET used_at"))).toBe(true);
  });

  it("refuse sans jeton d'accès", async () => {
    const app = await buildApp();
    const cur = keypairHex();
    setup({ currentKey: cur });
    const res = await app.inject({ method: "POST", url: "/api/auth/change-password", payload: body(cur, keypairHex()) });
    expect(res.statusCode).toBe(401);
  });

  it("refuse une signature d'une autre clé que la clé actuelle (mauvais mot de passe) sans rien écrire", async () => {
    const app = await buildApp();
    const cur = keypairHex();
    setup({ currentKey: cur });
    const wrong = keypairHex();
    const res = await app.inject({ method: "POST", url: "/api/auth/change-password", headers: auth(), payload: body(wrong, keypairHex()) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toMatch(/incorrect/);
    expect(mockedQuery.mock.calls.some((c) => String(c[0]).includes("UPDATE users"))).toBe(false);
  });

  it("refuse un défi déjà utilisé, expiré, ou émis pour un autre utilisateur", async () => {
    const app = await buildApp();
    const cur = keypairHex();
    for (const o of [{ used: true }, { expired: true }, { challengeUser: "00000000-0000-4000-8000-0000000000ff" }]) {
      setup({ currentKey: cur, ...o });
      const res = await app.inject({ method: "POST", url: "/api/auth/change-password", headers: auth(), payload: body(cur, keypairHex()) });
      expect(res.statusCode).toBe(401);
    }
    expect(mockedQuery.mock.calls.some((c) => String(c[0]).includes("UPDATE users"))).toBe(false);
  });

  it("refuse une preuve de possession de la NOUVELLE clé invalide et des paramètres KDF hors bornes", async () => {
    const app = await buildApp();
    const cur = keypairHex();
    const next = keypairHex();
    setup({ currentKey: cur });
    const badProof = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: auth(),
      payload: body(cur, next, { newAuthSignProof: keypairHex().sign(EMAIL) }),
    });
    expect(badProof.statusCode).toBe(400);
    const oob = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: auth(),
      payload: body(cur, next, { newKdfParams: { alg: "argon2id", t: 3, m: 4_000_000, p: 1 } }),
    });
    expect(oob.statusCode).toBe(400);
    const weak = await app.inject({
      method: "POST",
      url: "/api/auth/change-password",
      headers: auth(),
      payload: body(cur, next, { newKdfParams: { alg: "pbkdf2", t: 3, m: 65536, p: 1 } }),
    });
    expect(weak.statusCode).toBe(400);
    expect(mockedQuery.mock.calls.some((c) => String(c[0]).includes("UPDATE users"))).toBe(false);
  });
});
