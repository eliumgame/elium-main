/**
 * Unit tests for src/routes/users.ts — public directory lookup, self-service
 * profile/password updates, session management, and RGPD erasure. DB, auth
 * middleware, crypto verification, and account-deletion are mocked, matching
 * the style of tests/orgs.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const USER = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000ab";
const SESSION = "00000000-0000-4000-8000-0000000000cc";
const HEX64 = "a".repeat(64);
const HEX128 = "b".repeat(128);

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
}));

vi.mock("../src/lib/crypto-server.js", () => ({ verifyEd25519: vi.fn(() => true) }));

vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));

vi.mock("../src/lib/account-deletion.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/account-deletion.js")>(
    "../src/lib/account-deletion.js",
  );
  return {
    AccountDeletionBlocked: actual.AccountDeletionBlocked,
    accountDeletionBlockers: vi.fn(async () => ({ ownedOrgsWithMembers: [], soleRecoveryAdminOrgs: [] })),
    eraseAccount: vi.fn(async () => ({ deletedOrgs: 0, transferredNodes: 0 })),
  };
});

import { query, queryOne } from "../src/db/pool.js";
import { verifyEd25519 } from "../src/lib/crypto-server.js";
import { accountDeletionBlockers, eraseAccount, AccountDeletionBlocked } from "../src/lib/account-deletion.js";
import { ApiError } from "../src/lib/errors.js";
import userRoutes from "../src/routes/users.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);
const mVerifyEd25519 = vi.mocked(verifyEd25519);
const mAccountDeletionBlockers = vi.mocked(accountDeletionBlockers);
const mEraseAccount = vi.mocked(eraseAccount);

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
  await app.register(userRoutes, { prefix: "/api/users" });
  await app.ready();
  return app;
}

function userRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: USER,
    email: "u@example.org",
    display_name: "U",
    ed25519_public_hex: HEX64,
    p256_public_hex: HEX64,
    fingerprint: HEX64,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mQuery.mockResolvedValue([] as never);
  mQueryOne.mockResolvedValue(null as never);
  mVerifyEd25519.mockReturnValue(true);
});

describe("GET /api/users/lookup", () => {
  it("looks up by email", async () => {
    mQueryOne.mockResolvedValueOnce(userRow() as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/users/lookup?email=u@example.org" });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe("u@example.org");
    // Never leaks private fields (verifier/salt/KDF/key bundle).
    expect(res.json().user).not.toHaveProperty("kdf_salt");
    expect(res.json().user).not.toHaveProperty("key_bundle");
  });

  it("looks up by fingerprint", async () => {
    mQueryOne.mockResolvedValueOnce(userRow() as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/users/lookup?fingerprint=${HEX64}` });
    expect(res.statusCode).toBe(200);
  });

  it("rejects when both or neither of email/fingerprint are given", async () => {
    const app = await makeApp();
    const both = await app.inject({ method: "GET", url: `/api/users/lookup?email=u@example.org&fingerprint=${HEX64}` });
    expect(both.statusCode).toBe(400);
    const neither = await app.inject({ method: "GET", url: "/api/users/lookup" });
    expect(neither.statusCode).toBe(400);
  });

  it("404s when no active user matches", async () => {
    mQueryOne.mockResolvedValueOnce(null as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/users/lookup?email=nope@example.org" });
    expect(res.statusCode).toBe(404);
  });
});

describe("PATCH /api/users/me", () => {
  it("updates the display name", async () => {
    mQueryOne.mockResolvedValueOnce(userRow({ display_name: "New Name" }) as never);
    const app = await makeApp();
    const res = await app.inject({ method: "PATCH", url: "/api/users/me", payload: { displayName: "New Name" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.displayName).toBe("New Name");
  });

  it("rejects a password-change request without a valid proof of possession", async () => {
    mVerifyEd25519.mockReturnValueOnce(false);
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/users/me",
      payload: { authSignPublicHex: HEX64, authSignProof: HEX128 },
    });
    expect(res.statusCode).toBe(400);
    expect(mQueryOne).not.toHaveBeenCalledWith(expect.stringMatching(/UPDATE users/), expect.anything());
  });

  it("accepts a password change backed by a valid proof", async () => {
    mQueryOne.mockResolvedValueOnce(userRow() as never);
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: "/api/users/me",
      payload: { authSignPublicHex: HEX64, authSignProof: HEX128 },
    });
    expect(res.statusCode).toBe(200);
    expect(mVerifyEd25519).toHaveBeenCalledWith("u@example.org", HEX128, HEX64);
  });
});

describe("session management", () => {
  it("lists own sessions", async () => {
    mQuery.mockResolvedValueOnce([
      { id: SESSION, user_agent: "UA", ip: "1.2.3.4", created_at: "t1", expires_at: "t2", revoked_at: null },
    ] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/users/me/sessions" });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions).toHaveLength(1);
  });

  it("revokes one of its own sessions", async () => {
    mQueryOne.mockResolvedValueOnce({ id: SESSION } as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/users/me/sessions/${SESSION}` });
    expect(res.statusCode).toBe(200);
  });

  it("404s revoking a session that isn't the caller's", async () => {
    mQueryOne
      .mockResolvedValueOnce(null as never) // UPDATE ... RETURNING (no match: wrong owner or already revoked)
      .mockResolvedValueOnce(null as never); // existence check
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/users/me/sessions/${SESSION}` });
    expect(res.statusCode).toBe(404);
  });
});

describe("RGPD account erasure", () => {
  it("deletion-preflight reports blockers from accountDeletionBlockers", async () => {
    mAccountDeletionBlockers.mockResolvedValueOnce({
      ownedOrgsWithMembers: ["org1"],
      soleRecoveryAdminOrgs: [],
    } as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/users/me/deletion-preflight" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ canDelete: false, ownedOrgsWithMembers: ["org1"] });
  });

  it("DELETE /me rejects an invalid proof of possession", async () => {
    mQueryOne.mockResolvedValueOnce({ auth_sign_public_hex: HEX64 } as never);
    mVerifyEd25519.mockReturnValueOnce(false);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: "/api/users/me", payload: { proof: HEX128 } });
    expect(res.statusCode).toBe(400);
    expect(mEraseAccount).not.toHaveBeenCalled();
  });

  it("DELETE /me erases the account on a valid proof", async () => {
    mQueryOne.mockResolvedValueOnce({ auth_sign_public_hex: HEX64 } as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: "/api/users/me", payload: { proof: HEX128 } });
    expect(res.statusCode).toBe(200);
    expect(mEraseAccount).toHaveBeenCalledWith(USER);
  });

  it("DELETE /me surfaces a 409 when erasure is blocked (ownership/recovery)", async () => {
    mQueryOne.mockResolvedValueOnce({ auth_sign_public_hex: HEX64 } as never);
    mEraseAccount.mockRejectedValueOnce(
      new AccountDeletionBlocked({ ownedOrgsWithMembers: ["org1"], soleRecoveryAdminOrgs: [] } as never),
    );
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: "/api/users/me", payload: { proof: HEX128 } });
    expect(res.statusCode).toBe(409);
  });
});

describe("GET /api/users/:id", () => {
  it("returns public identity material for an active user", async () => {
    mQueryOne.mockResolvedValueOnce(userRow({ id: OTHER }) as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/users/${OTHER}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(OTHER);
  });
});
