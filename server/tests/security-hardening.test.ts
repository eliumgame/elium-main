/**
 * Correctifs de l'audit externe (SRV-07 .. SRV-17) : ré-authentification WebAuthn,
 * rejeu TOTP, SSRF du jwksUri, garde racine du déplacement, clés de stockage.
 * BD / authentification mockées (dispatch par texte SQL).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { generateKeyPairSync, sign as edSign, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const USER = "00000000-0000-4000-8000-0000000000aa";
const ORG = "00000000-0000-4000-8000-0000000000cc";
const NODE = "00000000-0000-4000-8000-0000000000dd";

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
  closePool: vi.fn(async () => {}),
}));
const requireOrgPermMock = vi.hoisted(() => vi.fn(async () => ({ orgId: "o" })));
vi.mock("../src/middleware/auth.js", () => ({
  authenticate: vi.fn(async (req: { user?: unknown }) => {
    req.user = { id: "00000000-0000-4000-8000-0000000000aa", email: "u@example.org", fingerprint: "f" };
  }),
  requireUser: vi.fn(() => ({ id: "00000000-0000-4000-8000-0000000000aa", email: "u@example.org", fingerprint: "f" })),
  requireMembership: vi.fn(async () => ({ orgId: "o" })),
  requireOrgPerm: requireOrgPermMock,
  requireNodePerm: vi.fn(async () => ({
    nodeId: "n",
    orgId: "00000000-0000-4000-8000-0000000000cc",
    kind: "file",
  })),
}));
vi.mock("../src/collab/relay.js", () => ({ kickRoom: vi.fn(), kickUser: vi.fn(), notifyOrg: vi.fn() }));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));
const wa = vi.hoisted(() => ({
  hasWebauthn: vi.fn(async () => true),
  verifyAuthentication: vi.fn(async () => true),
}));
vi.mock("../src/lib/webauthn.js", () => ({
  ...wa,
  listCredentials: vi.fn(async () => []),
  registrationOptions: vi.fn(),
  verifyRegistration: vi.fn(),
  authenticationOptions: vi.fn(async () => ({ challenge: "c" })),
  discoverableAuthenticationOptions: vi.fn(),
  verifyDiscoverableAuthentication: vi.fn(),
  createLoginChallenge: vi.fn(),
  consumeLoginChallenge: vi.fn(),
}));

import { query, queryOne, withTx } from "../src/db/pool.js";
import { ApiError } from "../src/lib/errors.js";
import { kickRoom } from "../src/collab/relay.js";
import authRoutes from "../src/routes/auth.js";
import nodeRoutes from "../src/routes/nodes.js";
import { isSafeJwksUrl } from "../src/routes/sso.js";
import { safeHttpsGet } from "../src/lib/safe-fetch.js";
import { FsStorage } from "../src/storage/fs.js";
import { matchTotpStep, base32Encode, totpNow } from "../src/lib/totp.js";
import { verifySecondFactor } from "../src/lib/second-factor.js";
import { encryptServerSecret } from "../src/lib/crypto-server.js";
import { invalidateSiteSettings } from "../src/lib/site-settings.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);

async function makeApp(register: (app: FastifyInstance) => Promise<unknown>): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: "bad_request" } });
    return reply.status(500).send({ error: { code: "internal", message: String(err) } });
  });
  await register(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidateSiteSettings();
  mQuery.mockReset().mockResolvedValue([] as never);
  mQueryOne.mockReset().mockResolvedValue(null);
  wa.hasWebauthn.mockResolvedValue(true);
  wa.verifyAuthentication.mockResolvedValue(true);
});

describe("SRV-08 : /reauth exige le 2e facteur d'un compte WebAuthn-only", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubHex = Buffer.from((publicKey.export({ format: "jwk" }) as { x: string }).x, "base64url").toString("hex");
  const nonce = "d".repeat(64);
  const body = (extra: object = {}) => ({
    challengeId: randomUUID(),
    signature: edSign(null, Buffer.from(nonce), privateKey).toString("hex"),
    ...extra,
  });
  function db() {
    mQueryOne.mockImplementation((async (sql: string) => {
      if (sql.includes("auth_sign_public_hex, mfa_enabled")) return { auth_sign_public_hex: pubHex, mfa_enabled: false };
      if (sql.includes("FROM login_challenges"))
        return { user_id: USER, nonce, expires_at: new Date(Date.now() + 60_000).toISOString(), used_at: null };
      return null;
    }) as never);
  }
  const reg = (a: FastifyInstance) => a.register(authRoutes, { prefix: "/api/auth" });

  it("403 sans réponse WebAuthn (mot de passe seul insuffisant)", async () => {
    db();
    const app = await makeApp(reg);
    const res = await app.inject({ method: "POST", url: "/api/auth/reauth", payload: body() });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("mfa_code_required");
    await app.close();
  });

  it("401 si l'assertion WebAuthn est invalide", async () => {
    db();
    wa.verifyAuthentication.mockResolvedValue(false);
    const app = await makeApp(reg);
    const res = await app.inject({ method: "POST", url: "/api/auth/reauth", payload: body({ webauthn: { id: "x" } }) });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("émet le jeton avec une assertion valide", async () => {
    db();
    const app = await makeApp(reg);
    const res = await app.inject({ method: "POST", url: "/api/auth/reauth", payload: body({ webauthn: { id: "x" } }) });
    expect(res.statusCode).toBe(200);
    expect(res.json().reauthToken).toBeTruthy();
    await app.close();
  });
});

describe("SRV-09 : anti-rejeu TOTP", () => {
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  const enc = encryptServerSecret(secret);

  it("matchTotpStep renvoie le pas du code courant", () => {
    const T = 1_700_000_000_000;
    expect(matchTotpStep(secret, totpNow(secret, T), 1, T)).toBe(Math.floor(T / 30000));
    expect(matchTotpStep(secret, "000000", 1, T)).toBeNull();
  });

  it("accepte un code une fois, refuse son rejeu", async () => {
    const code = totpNow(secret);
    let lastStep: number | null = null;
    mQueryOne.mockImplementation((async (sql: string, params: unknown[]) => {
      if (sql.includes("mfa_secret_enc")) return { mfa_secret_enc: enc.ct, mfa_secret_nonce: enc.nonce };
      if (sql.includes("SET mfa_last_step")) {
        const step = params[1] as number;
        if (lastStep !== null && lastStep >= step) return null;
        lastStep = step;
        return { id: USER };
      }
      return null; // codes de secours : aucun
    }) as never);
    expect(await verifySecondFactor(USER, code)).toBe(true);
    expect(await verifySecondFactor(USER, code)).toBe(false);
  });
});

describe("SRV-11 : garde SSRF du jwksUri", () => {
  it.each([
    "https://[::1]/jwks",
    "https://[::ffff:127.0.0.1]/jwks",
    "https://[::ffff:7f00:1]/jwks",
    "https://[fd00::1]/jwks",
    "https://[fe80::1]/jwks",
    "https://169.254.169.254/jwks",
    "https://10.0.0.1/jwks",
    "https://2130706433/jwks",
    "https://localhost/jwks",
    "https://user:pw@idp.example.com/jwks",
    "http://idp.example.com/jwks",
  ])("refuse %s", (u) => expect(isSafeJwksUrl(u)).toBe(false));

  it("accepte un https public", () => {
    expect(isSafeJwksUrl("https://login.example.com/.well-known/jwks.json")).toBe(true);
  });

  it("safeHttpsGet refuse un nom résolvant (même partiellement) vers une adresse privée (DNS rebinding)", async () => {
    const resolve = async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(safeHttpsGet("https://rebind.example.com/jwks", { resolve })).rejects.toThrow(/non autoris/);
    await expect(
      safeHttpsGet("https://v6.example.com/jwks", { resolve: async () => [{ address: "::ffff:10.0.0.1", family: 6 }] }),
    ).rejects.toThrow(/non autoris/);
  });
});

describe("SRV-13 : déplacement vers la racine = création d'espace", () => {
  const reg = (a: FastifyInstance) => a.register(nodeRoutes, { prefix: "/api/nodes" });

  it("403 si space.create est refusé et que les membres ne peuvent pas créer d'espace", async () => {
    requireOrgPermMock.mockRejectedValueOnce(new ApiError(403, "forbidden", "Accès refusé."));
    mQueryOne.mockImplementation((async (sql: string) =>
      sql.includes("FROM site_settings")
        ? { org_id: ORG, settings: { membersCanCreateSpaces: false } }
        : null) as never);
    const app = await makeApp(reg);
    const res = await app.inject({ method: "PATCH", url: `/api/nodes/${NODE}`, payload: { parentId: null } });
    expect(res.statusCode).toBe(403);
    expect(vi.mocked(withTx)).not.toHaveBeenCalled();
    await app.close();
  });

  it("éjecte les pairs dont l'accès hérité est retiré par le déplacement", async () => {
    vi.mocked(withTx).mockImplementation((async (fn: (c: unknown) => unknown) =>
      fn({
        query: async (sql: string) =>
          sql.includes("DELETE FROM node_keys")
            ? { rows: [{ node_id: NODE }], rowCount: 1 }
            : { rows: [{ id: NODE, org_id: ORG, kind: "file" }], rowCount: 1 },
      })) as never);
    const app = await makeApp(reg);
    const res = await app.inject({ method: "PATCH", url: `/api/nodes/${NODE}`, payload: { parentId: null } });
    expect(res.statusCode).toBe(200);
    expect(kickRoom).toHaveBeenCalledWith(NODE, "node-moved");
    await app.close();
  });
});

describe("SRV-17 : clés de stockage fs strictes", () => {
  it("refuse les clés hors [a-zA-Z0-9_-]{8,128} et accepte newKey()", async () => {
    const s = new FsStorage(mkdtempSync(join(tmpdir(), "elium-fs-")));
    await s.init();
    for (const bad of ["../etc/passwd", "a/b/cccccccc", "short", "ab cd ef gh", "x".repeat(129), ""]) {
      await expect(s.put(bad, Buffer.from("x"))).rejects.toThrow(/invalide/);
    }
    const k = s.newKey();
    await s.put(k, Buffer.from("ok"));
    expect((await s.get(k)).toString()).toBe("ok");
  });
});
