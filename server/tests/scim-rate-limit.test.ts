/**
 * Plafond de débit DÉDIÉ des routes SCIM (server/src/routes/scim.ts) : un jeton
 * SCIM volé/mal configuré ne doit pas pouvoir cribler le provisioning à la
 * cadence du seul plafond global (600/min/IP). `pool` mocké — pas de DB.
 * Même patron que tests/signing.test.ts (app nue + rate-limit réel enregistré).
 */
import { describe, it, expect, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";

vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTx: vi.fn(),
  pool: {},
  closePool: vi.fn(),
}));

import { query, queryOne } from "../src/db/pool.js";
import { ApiError } from "../src/lib/errors.js";
import scimRoutes from "../src/routes/scim.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);

const ORG = "00000000-0000-4000-8000-0000000000cc";

/** Mirrors app.ts's global limit, so the per-route `config.rateLimit` override
 *  (like in production) actually applies instead of being shadowed. */
async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
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
  await app.register(scimRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

describe("rate limiting : routes SCIM", () => {
  it("GET /api/scim/v2/Users limité à 100/min (pas seulement le plafond global 600/min)", async () => {
    mQueryOne.mockResolvedValue({ id: ORG }); // orgFromScim : jeton toujours valide
    mQuery.mockResolvedValue([]); // liste vide de membres

    const app = await makeApp();
    let last = 0;
    for (let i = 0; i < 101; i++) {
      const res = await app.inject({
        method: "GET",
        url: "/api/scim/v2/Users",
        headers: { authorization: "Bearer test-scim-token" },
      });
      last = res.statusCode;
      if (i < 100) expect(res.statusCode).toBe(200);
    }
    expect(last).toBe(429);
    await app.close();
  });
});
