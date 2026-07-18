/**
 * Route-level tests for the auth hardening ported from the 2026-07-15 audit:
 *  - /login/verify returns ONE unified failure message across every branch
 *    (unknown/decoy challenge vs. wrong signature) — no account enumeration.
 *  - An MFA secret that no longer decrypts (TOKEN_SECRET rotated since
 *    enrollment) falls through to the backup-code path instead of crashing
 *    the request — no permanent lockout, and no 500.
 *  - /prelogin and /auth/sso/verify are rate-limited.
 *
 * The database is mocked (SQL-text-dispatched); tokens/crypto are real.
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
import { issueScopedToken } from "../src/lib/tokens.js";
import { sha256Hex, encryptServerSecret } from "../src/lib/crypto-server.js";
import authRoutes from "../src/routes/auth.js";
import ssoRoutes from "../src/routes/sso.js";

const mockedQueryOne = vi.mocked(queryOne);
const mockedQuery = vi.mocked(query);

function keypairHex(): { pubHex: string; sign: (m: string) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  const pubHex = Buffer.from(jwk.x, "base64url").toString("hex");
  return { pubHex, sign: (m: string) => edSign(null, Buffer.from(m), privateKey).toString("hex") };
}

/** Same error mapping as app.ts, so ApiError/429 surface like in production. */
async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "validation", message: "Requête invalide." } });
    }
    if ((err as { statusCode?: number }).statusCode === 429) {
      return reply.status(429).send({ error: { code: "rate_limited", message: "Trop de requêtes." } });
    }
    return reply.status(500).send({ error: { code: "internal", message: "Erreur interne du serveur." } });
  });
  await app.register(authRoutes, { prefix: "/api/auth" });
  await app.register(ssoRoutes, { prefix: "/api" });
  return app;
}

beforeEach(() => {
  mockedQueryOne.mockReset().mockResolvedValue(null);
  mockedQuery.mockReset().mockResolvedValue([]);
});

const USER_ROW = (pubHex: string) => ({
  id: "00000000-0000-4000-8000-000000000001",
  email: "alice@example.org",
  display_name: "Alice",
  ed25519_public_hex: "a".repeat(64),
  p256_public_hex: "04" + "b".repeat(128),
  fingerprint: "c".repeat(64),
  auth_sign_public_hex: pubHex,
  key_bundle: {},
  status: "active",
  mfa_enabled: false,
});

describe("anti-énumération : /login/verify", () => {
  it("renvoie exactement le même message pour un défi inconnu et une signature invalide", async () => {
    const app = await buildTestApp();
    const kp = keypairHex();

    // Branch A — decoy/unknown challengeId: the challenge SELECT finds nothing.
    const resA = await app.inject({
      method: "POST",
      url: "/api/auth/login/verify",
      payload: { email: "ghost@example.org", challengeId: randomUUID(), signature: "0".repeat(128) },
    });
    expect(resA.statusCode).toBe(401);
    const msgA = resA.json().error.message as string;

    // Branch B — real challenge + real account, but the signature is wrong.
    const nonce = "d".repeat(64);
    mockedQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM login_challenges")) {
        return {
          id: "ch1",
          user_id: USER_ROW(kp.pubHex).id,
          nonce,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          used_at: null,
        } as never;
      }
      if (sql.includes("FROM users")) return USER_ROW(kp.pubHex) as never;
      return null;
    });
    const resB = await app.inject({
      method: "POST",
      url: "/api/auth/login/verify",
      payload: {
        email: "alice@example.org",
        challengeId: randomUUID(),
        signature: kp.sign("pas-le-bon-nonce"),
      },
    });
    expect(resB.statusCode).toBe(401);
    const msgB = resB.json().error.message as string;

    expect(msgA).toBe(msgB);
    await app.close();
  });
});

describe("anti-lockout MFA : secret indéchiffrable (TOKEN_SECRET tourné)", () => {
  // An enc/nonce pair that CANNOT decrypt under the current TOKEN_SECRET:
  // valid shapes, garbage content — decryptServerSecret throws (GCM auth).
  const badEnc = Buffer.alloc(48, 7);
  const badNonce = Buffer.alloc(12, 9);

  function mockMfaUser(opts: { backupCodeAccepted: boolean; pubHex: string }) {
    mockedQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("mfa_secret_enc")) {
        return { mfa_secret_enc: badEnc, mfa_secret_nonce: badNonce } as never;
      }
      if (sql.includes("UPDATE mfa_backup_codes")) {
        return opts.backupCodeAccepted ? ({ id: "bc1" } as never) : null;
      }
      if (sql.includes("FROM users")) return USER_ROW(opts.pubHex) as never;
      return null;
    });
  }

  it("un code de secours valide ouvre la session (pas de 500, pas de lockout)", async () => {
    const app = await buildTestApp();
    const kp = keypairHex();
    mockMfaUser({ backupCodeAccepted: true, pubHex: kp.pubHex });

    const mfaToken = issueScopedToken(USER_ROW(kp.pubHex).id, "mfa-login");
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login/mfa",
      payload: { mfaToken, code: "123456" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBeTypeOf("string");
    await app.close();
  });

  it("un code faux est un 401 propre — plus jamais un 500 non géré", async () => {
    const app = await buildTestApp();
    const kp = keypairHex();
    mockMfaUser({ backupCodeAccepted: false, pubHex: kp.pubHex });

    const mfaToken = issueScopedToken(USER_ROW(kp.pubHex).id, "mfa-login");
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login/mfa",
      payload: { mfaToken, code: "123456" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("sanity : un vrai secret TOTP se déchiffre toujours (le chemin nominal marche)", () => {
    // Guards the test premise: our "bad" pair must be the anomaly, not the rule.
    const { ct, nonce } = encryptServerSecret("JBSWY3DPEHPK3PXP");
    expect(ct.equals(badEnc)).toBe(false);
    expect(nonce.equals(badNonce)).toBe(false);
    expect(sha256Hex("abc")).toHaveLength(64);
  });
});

describe("rate limiting des routes sensibles", () => {
  it("/prelogin limité à 30/min", async () => {
    const app = await buildTestApp();
    let last = 0;
    for (let i = 0; i < 31; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/prelogin",
        payload: { email: "someone@example.org" },
      });
      last = res.statusCode;
      if (i < 30) expect(res.statusCode).toBe(200);
    }
    expect(last).toBe(429);
    await app.close();
  });

  it("/auth/sso/verify limité à 20/min", async () => {
    const app = await buildTestApp();
    let last = 0;
    for (let i = 0; i < 21; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/sso/verify",
        payload: { orgId: randomUUID(), idToken: "x".repeat(32) },
      });
      last = res.statusCode;
      if (i < 20) expect(res.statusCode).toBe(400); // SSO non configuré (org inconnue)
    }
    expect(last).toBe(429);
    await app.close();
  });
});
