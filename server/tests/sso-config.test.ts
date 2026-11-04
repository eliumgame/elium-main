/** GET /auth/sso/config : config publique minimale, mono-Drive uniquement. Base mockée. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
  closePool: vi.fn(async () => {}),
}));

import { query } from "../src/db/pool.js";
import { ApiError } from "../src/lib/errors.js";
import ssoRoutes from "../src/routes/sso.js";
import { config } from "../src/config.js";

const mockedQuery = vi.mocked(query);
const ORG = "11111111-1111-4111-8111-111111111111";
const SSO = { issuer: "https://idp.example", clientId: "app", jwks: [{ kty: "RSA" }], allowedDomains: ["x.fr"] };

async function build(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) return reply.status(err.statusCode).send({ error: { code: err.code } });
    if ((err as { statusCode?: number }).statusCode === 429) return reply.status(429).send({ error: {} });
    return reply.status(500).send({ error: {} });
  });
  await app.register(ssoRoutes, { prefix: "/api" });
  return app;
}

beforeEach(() => {
  vi.spyOn(config.site, "singleDrive", "get").mockReturnValue(true);
  mockedQuery.mockReset().mockResolvedValue([]);
});

describe("GET /auth/sso/config", () => {
  it("404 hors mono-Drive", async () => {
    vi.spyOn(config.site, "singleDrive", "get").mockReturnValue(false);
    const res = await (await build()).inject({ method: "GET", url: "/api/auth/sso/config" });
    expect(res.statusCode).toBe(404);
  });

  it("404 sans config SSO ou avec plusieurs organisations", async () => {
    const app = await build();
    mockedQuery.mockResolvedValue([{ id: ORG, sso_config: null }]);
    expect((await app.inject({ method: "GET", url: "/api/auth/sso/config" })).statusCode).toBe(404);
    mockedQuery.mockResolvedValue([
      { id: ORG, sso_config: SSO },
      { id: "x", sso_config: null },
    ]);
    expect((await app.inject({ method: "GET", url: "/api/auth/sso/config" })).statusCode).toBe(404);
  });

  it("200 avec exactement orgId, issuer, clientId", async () => {
    mockedQuery.mockResolvedValue([{ id: ORG, sso_config: SSO }]);
    const res = await (await build()).inject({ method: "GET", url: "/api/auth/sso/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ orgId: ORG, issuer: "https://idp.example", clientId: "app" });
  });

  it("limité à 30/min", async () => {
    const app = await build();
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await app.inject({ method: "GET", url: "/api/auth/sso/config" })).statusCode;
    expect(last).toBe(429);
  });
});
