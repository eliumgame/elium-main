/**
 * Audit A1 — /prelogin : le leurre d'un e-mail inconnu doit être indiscernable d'un vrai
 * compte, ordre des clés JSON compris. Postgres renvoie un JSONB avec ses clés rangées par
 * longueur (`{"m","p","t","alg"}`) : la simulation de base reproduit cet ordre.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import rateLimit from "@fastify/rate-limit";

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
  closePool: vi.fn(async () => {}),
}));

import { queryOne } from "../src/db/pool.js";
import authRoutes, { canonicalKdfParams } from "../src/routes/auth.js";

const mQueryOne = vi.mocked(queryOne);

beforeEach(() => {
  mQueryOne.mockReset().mockResolvedValue(null);
});

async function prelogin(email: string): Promise<string> {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  await app.register(authRoutes, { prefix: "/api/auth" });
  const res = await app.inject({ method: "POST", url: "/api/auth/prelogin", payload: { email } });
  await app.close();
  expect(res.statusCode).toBe(200);
  return res.body;
}

/** Remplace les valeurs (sel) pour ne comparer que la FORME exacte du texte JSON. */
function shape(body: string): string {
  return body.replace(/"kdfSalt":"[0-9a-f]+"/, '"kdfSalt":"<sel>"');
}

describe("/prelogin : leurre indiscernable", () => {
  it("vrai compte (JSONB réordonné par Postgres) et leurre produisent le même texte, au sel près", async () => {
    mQueryOne.mockResolvedValueOnce({
      kdf_salt: "0123456789abcdef0123456789abcdef",
      // Ordre réel d'un JSONB relu de Postgres.
      kdf_params: JSON.parse('{"m":262144,"p":4,"t":3,"alg":"argon2id"}'),
    } as never);
    const real = await prelogin("alice@example.org");
    const decoy = await prelogin("ghost@example.org");
    expect(shape(real)).toBe(shape(decoy));
    expect(JSON.parse(real).kdfParams).toEqual({ alg: "argon2id", t: 3, m: 262144, p: 4 });
  });

  it("canonicalKdfParams garde les clés inconnues, triées après alg/t/m/p", () => {
    expect(Object.keys(canonicalKdfParams({ z: 1, m: 1, b: 2, alg: "x", p: 1, t: 1 }))).toEqual([
      "alg",
      "t",
      "m",
      "p",
      "b",
      "z",
    ]);
  });
});
