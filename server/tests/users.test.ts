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

// Ré-authentification simulée : seul le jeton « good-reauth » est accepté.
vi.mock("../src/lib/reauth.js", async () => {
  const { ApiError: E } = await vi.importActual<typeof import("../src/lib/errors.js")>("../src/lib/errors.js");
  return {
    requireReauth: vi.fn(async (req: { headers: Record<string, unknown> }) => {
      if (req.headers["x-reauth-token"] !== "good-reauth") throw new E(403, "reauth_required", "reauth");
    }),
  };
});

vi.mock("../src/collab/relay.js", () => ({ kickUser: vi.fn() }));

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
import { kickUser } from "../src/collab/relay.js";
import { ApiError } from "../src/lib/errors.js";
import userRoutes from "../src/routes/users.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);
const mVerifyEd25519 = vi.mocked(verifyEd25519);
const mAccountDeletionBlockers = vi.mocked(accountDeletionBlockers);
const mEraseAccount = vi.mocked(eraseAccount);
const mKickUser = vi.mocked(kickUser);

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err instanceof Error ? err.message : String(err) } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "bad_request", message: "validation" } });
    }
    return reply.status(500).send({ error: { code: "internal", message: err instanceof Error ? err.message : String(err) } });
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

  it("restreint la recherche aux comptes partageant une organisation active avec l'appelant", async () => {
    mQueryOne.mockResolvedValueOnce(userRow() as never);
    const app = await makeApp();
    await app.inject({ method: "GET", url: "/api/users/lookup?email=u@example.org" });
    await app.inject({ method: "GET", url: `/api/users/lookup?fingerprint=${HEX64}` });
    for (const call of mQueryOne.mock.calls.slice(-2)) {
      const sql = String(call[0]);
      expect(sql).toMatch(/FROM memberships mine JOIN memberships theirs ON theirs.org_id = mine.org_id/);
      expect(sql).toMatch(/mine.status = 'active'/);
      expect(sql).toMatch(/theirs.status = 'active'/);
      expect((call[1] as unknown[])[1]).toBe(USER); // l'appelant
    }
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

  it("refuse de remplacer les clés, le paquet de clés ou le vérificateur (changement de mot de passe = change-password)", async () => {
    const app = await makeApp();
    for (const payload of [
      { authSignPublicHex: HEX64, authSignProof: HEX128 },
      { keyBundle: { x: 1 } },
      { kdfSalt: "abcdefgh12345678" },
      { kdfParams: { alg: "argon2id", t: 1, m: 8192, p: 1 } },
    ]) {
      const res = await app.inject({ method: "PATCH", url: "/api/users/me", payload });
      expect(res.statusCode, JSON.stringify(Object.keys(payload))).toBe(400);
    }
    expect(mQueryOne).not.toHaveBeenCalledWith(expect.stringMatching(/UPDATE users/), expect.anything());
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

  it("DELETE /me exige une ré-authentification fraîche (403 sans jeton)", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: "/api/users/me", payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("reauth_required");
    expect(mEraseAccount).not.toHaveBeenCalled();
  });

  it("DELETE /me refuse l'ancienne preuve statique rejouable (signature de la chaîne constante)", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: "/api/users/me", payload: { proof: HEX128 } });
    expect(res.statusCode).toBe(403);
    expect(mEraseAccount).not.toHaveBeenCalled();
  });

  it("DELETE /me erases the account with a valid reauth token", async () => {
    mQueryOne.mockResolvedValueOnce({ id: USER } as never);
    const app = await makeApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/users/me",
      headers: { "x-reauth-token": "good-reauth" },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(mEraseAccount).toHaveBeenCalledWith(USER);
    expect(mKickUser).toHaveBeenCalledWith(USER, "account-erased");
  });

  it("DELETE /me surfaces a 409 when erasure is blocked (ownership/recovery)", async () => {
    mQueryOne.mockResolvedValueOnce({ id: USER } as never);
    mEraseAccount.mockRejectedValueOnce(
      new AccountDeletionBlocked({ ownedOrgsWithMembers: ["org1"], soleRecoveryAdminOrgs: [] } as never),
    );
    const app = await makeApp();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/users/me",
      headers: { "x-reauth-token": "good-reauth" },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(mKickUser).not.toHaveBeenCalled();
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
