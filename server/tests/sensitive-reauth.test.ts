/**
 * Audit A1 — opérations sensibles du compte sans ré-authentification forte :
 * un jeton d'accès volé ne doit pas suffire à poser une 2FA (verrouillage de la victime).
 * La base est simulée (dispatch sur le texte SQL) ; jetons réels.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";

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
import { issueReauthToken } from "../src/lib/reauth.js";
import authRoutes from "../src/routes/auth.js";

const mQueryOne = vi.mocked(queryOne);
const mQuery = vi.mocked(query);

const USER_ID = "00000000-0000-4000-8000-000000000001";
const FPR = "c".repeat(64);
const EMAIL = "alice@example.org";

beforeEach(() => {
  mQuery.mockReset().mockResolvedValue([]);
  mQueryOne.mockReset().mockImplementation((async (sql: string) => {
    if (sql.includes("SELECT id, fingerprint, email, display_name, status, token_epoch FROM users")) {
      return {
        id: USER_ID,
        fingerprint: FPR,
        email: EMAIL,
        display_name: "Alice",
        status: "active",
        token_epoch: new Date(Date.now() - 3600_000).toISOString(),
      };
    }
    if (sql.includes("SELECT token_epoch FROM users")) {
      return { token_epoch: new Date(Date.now() - 3600_000).toISOString() };
    }
    return null;
  }) as never);
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.statusCode).send({ error: { code: err.code } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: "validation" } });
    return reply.status(500).send({ error: { code: "internal", message: String(err) } });
  });
  await app.register(authRoutes, { prefix: "/api/auth" });
  return app;
}

const bearer = () => ({ authorization: `Bearer ${issueAccessToken(USER_ID, FPR).token}` });

describe("POST /auth/mfa/setup : ré-authentification exigée", () => {
  it("refuse un simple jeton d'accès (403 reauth_required) sans écrire de secret en attente", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "POST", url: "/api/auth/mfa/setup", headers: bearer(), payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("reauth_required");
    expect(mQuery.mock.calls.some(([sql]) => String(sql).includes("mfa_pending_enc"))).toBe(false);
    await app.close();
  });

  it("accepte avec un jeton de ré-authentification valide", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/setup",
      headers: { ...bearer(), "x-reauth-token": issueReauthToken(USER_ID) },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    await app.close();
  });

  it("refuse le jeton de ré-authentification d'un autre compte", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/mfa/setup",
      headers: { ...bearer(), "x-reauth-token": issueReauthToken("00000000-0000-4000-8000-000000000002") },
      payload: {},
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});
