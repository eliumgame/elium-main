/**
 * Un déprovisionnement SCIM (suspension PATCH active:false, ou DELETE) doit
 * couper immédiatement les connexions temps réel de l'utilisateur, pas
 * seulement marquer son adhésion suspendue en base (voir src/collab/relay.ts
 * `kickUser`). DB et relay mockés, même patron que tests/scim-rate-limit.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const ORG = "00000000-0000-4000-8000-0000000000cc";
const TARGET_USER = "00000000-0000-4000-8000-0000000000a9";

vi.mock("../src/db/pool.js", () => ({
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
  pool: {},
  closePool: vi.fn(),
}));

vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("../src/collab/relay.js", () => ({ kickUser: vi.fn() }));

import { query, queryOne } from "../src/db/pool.js";
import { kickUser } from "../src/collab/relay.js";
import { ApiError } from "../src/lib/errors.js";
import scimRoutes from "../src/routes/scim.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);
const mKickUser = vi.mocked(kickUser);

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "bad_request", message: "validation" } });
    }
    return reply.status(500).send({ error: { code: "internal", message: err.message } });
  });
  await app.register(scimRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

const AUTH = { authorization: "Bearer test-scim-token" };
const member = { id: TARGET_USER, email: "u@example.org", display_name: "U", status: "active", membership_status: "active" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/scim/v2/Users/:id (active:false)", () => {
  it("kicks the user's live connections when suspended", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ORG }).mockResolvedValueOnce(member);
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/scim/v2/Users/${TARGET_USER}`,
      headers: AUTH,
      payload: { Operations: [{ op: "replace", path: "active", value: false }] },
    });
    expect(res.statusCode).toBe(200);
    expect(mKickUser).toHaveBeenCalledWith(TARGET_USER, "scim-deprovisioned");
    await app.close();
  });

  it("does NOT kick when reactivating (active:true)", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ORG }).mockResolvedValueOnce(member);
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/scim/v2/Users/${TARGET_USER}`,
      headers: AUTH,
      payload: { Operations: [{ op: "replace", path: "active", value: true }] },
    });
    expect(res.statusCode).toBe(200);
    expect(mKickUser).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("DELETE /api/scim/v2/Users/:id", () => {
  it("kicks the user's live connections on de-provision", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ORG });
    mQuery.mockResolvedValueOnce([{ id: "m1" }] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/scim/v2/Users/${TARGET_USER}`, headers: AUTH });
    expect(res.statusCode).toBe(204);
    expect(mKickUser).toHaveBeenCalledWith(TARGET_USER, "scim-deprovisioned");
    await app.close();
  });

  it("does not kick when the user isn't a member (404)", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ORG });
    mQuery.mockResolvedValueOnce([] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/scim/v2/Users/${TARGET_USER}`, headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(mKickUser).not.toHaveBeenCalled();
    await app.close();
  });
});
