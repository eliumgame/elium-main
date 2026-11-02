/**
 * Audit A1 — second facteur forçable : verrouillage PAR COMPTE (indépendant de l'IP et du
 * mfaToken). La base est simulée : l'état (compteur, échéance du verrou) reproduit la
 * sémantique de l'UPDATE de réservation de lib/second-factor.ts.
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
import { issueScopedToken } from "../src/lib/tokens.js";
import { encryptServerSecret } from "../src/lib/crypto-server.js";
import { base32Encode, totpNow } from "../src/lib/totp.js";
import { MFA_MAX_FAILURES, verifySecondFactor } from "../src/lib/second-factor.js";
import authRoutes from "../src/routes/auth.js";

const mQueryOne = vi.mocked(queryOne);
const mQuery = vi.mocked(query);

const USER = "00000000-0000-4000-8000-000000000001";
const secret = base32Encode(Buffer.from("12345678901234567890"));
const enc = encryptServerSecret(secret);

let failed = 0;
let lockedUntil: number | null = null;
let lastStep: number | null = null;

function installDb() {
  failed = 0;
  lockedUntil = null;
  lastStep = null;
  mQueryOne.mockImplementation((async (sql: string, params: unknown[] = []) => {
    if (sql.includes("SET mfa_failed_count = CASE")) {
      const now = Date.now();
      if (lockedUntil !== null && lockedUntil > now) return null;
      const expired = lockedUntil !== null && lockedUntil <= now;
      failed = expired ? 1 : failed + 1;
      lockedUntil = failed >= (params[1] as number) ? now + (params[2] as number) * 1000 : null;
      return { count: failed, locked: lockedUntil !== null };
    }
    if (sql.includes("SET mfa_failed_count = 0")) {
      failed = 0;
      lockedUntil = null;
      return { id: USER };
    }
    if (sql.includes("mfa_secret_enc")) return { mfa_secret_enc: enc.ct, mfa_secret_nonce: enc.nonce };
    if (sql.includes("SET mfa_last_step")) {
      const step = params[1] as number;
      if (lastStep !== null && lastStep >= step) return null;
      lastStep = step;
      return { id: USER };
    }
    if (sql.includes("UPDATE mfa_backup_codes")) return null;
    if (sql.includes("FROM users")) {
      return {
        id: USER,
        email: "alice@example.org",
        display_name: "Alice",
        ed25519_public_hex: "a".repeat(64),
        p256_public_hex: "04" + "b".repeat(128),
        fingerprint: "c".repeat(64),
        key_bundle: {},
        status: "active",
        token_epoch: new Date(Date.now() - 3600_000).toISOString(),
      };
    }
    return null;
  }) as never);
}

beforeEach(() => {
  mQueryOne.mockReset();
  mQuery.mockReset().mockResolvedValue([]);
  installDb();
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

describe("verrouillage du second facteur par compte", () => {
  it(`verrouille après ${MFA_MAX_FAILURES} échecs, même pour un code juste ensuite`, async () => {
    for (let i = 0; i < MFA_MAX_FAILURES; i++) expect(await verifySecondFactor(USER, "000000")).toBe(false);
    // Un code VALIDE est refusé tant que le verrou court : sinon le forçage continuerait.
    await expect(verifySecondFactor(USER, totpNow(secret))).rejects.toMatchObject({
      statusCode: 429,
      code: "mfa_locked",
    });
  });

  it("une réussite remet le compteur à zéro", async () => {
    for (let i = 0; i < MFA_MAX_FAILURES - 1; i++) await verifySecondFactor(USER, "000000");
    expect(failed).toBe(MFA_MAX_FAILURES - 1);
    expect(await verifySecondFactor(USER, totpNow(secret))).toBe(true);
    expect(failed).toBe(0);
    expect(lockedUntil).toBeNull();
  });

  it("le verrou vaut pour tous les mfaToken du compte (un jeton neuf ne relance pas les essais)", async () => {
    const app = await buildApp();
    const codes: number[] = [];
    for (let i = 0; i < MFA_MAX_FAILURES + 2; i++) {
      // Nouveau mfaToken à chaque essai, comme un attaquant qui repasse par /login/verify.
      const mfaToken = issueScopedToken(USER, "mfa-login");
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login/mfa",
        payload: { mfaToken, code: "000000" },
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, MFA_MAX_FAILURES)).toEqual(Array(MFA_MAX_FAILURES).fill(401));
    expect(codes.slice(MFA_MAX_FAILURES)).toEqual([429, 429]);
    await app.close();
  });

  it("le verrou échu réarme le compteur (un essai, pas un re-verrouillage immédiat)", async () => {
    for (let i = 0; i < MFA_MAX_FAILURES; i++) await verifySecondFactor(USER, "000000");
    lockedUntil = Date.now() - 1; // le quart d'heure est passé
    expect(await verifySecondFactor(USER, "000000")).toBe(false);
    expect(failed).toBe(1);
    expect(lockedUntil).toBeNull();
  });
});
