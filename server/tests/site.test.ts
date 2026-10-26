/**
 * Portail du propriétaire : routes /api/site (politique publique, réglages,
 * utilisateurs) et contrôle d'inscription (lib/site-settings.ts). BD et
 * authentification mockées, comme tests/orgs.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const MEMBER = "00000000-0000-4000-8000-0000000000a2";
const ORG = "00000000-0000-4000-8000-0000000000c1";
const ROLE_EDITOR = "00000000-0000-4000-8000-0000000000d1";

let acting = OWNER;

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(async (fn: (c: unknown) => unknown) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
  closePool: vi.fn(async () => {}),
}));
vi.mock("../src/middleware/auth.js", () => ({
  authenticate: vi.fn(async (req: { user?: unknown }) => {
    req.user = { id: acting, email: "u@example.org", fingerprint: "f", displayName: "U" };
  }),
  requireUser: vi.fn(() => ({ id: acting, email: "u@example.org", fingerprint: "f", displayName: "U" })),
}));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("../src/lib/webauthn.js", () => ({ hasWebauthn: vi.fn(async () => false) }));
vi.mock("../src/lib/second-factor.js", () => ({
  verifySecondFactor: vi.fn(async (_u: string, code: string) => code === "123456"),
}));
vi.mock("../src/collab/relay.js", () => ({ kickUser: vi.fn() }));

import { query, queryOne } from "../src/db/pool.js";
import { ApiError } from "../src/lib/errors.js";
import { audit } from "../src/lib/audit.js";
import { kickUser } from "../src/collab/relay.js";
import { invalidateSiteSettings, assertSignupAllowed, defaultSiteSettings } from "../src/lib/site-settings.js";
import siteRoutes from "../src/routes/site.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);
const mKickUser = vi.mocked(kickUser);

/** Réponses SQL par motif ; `siteRow` simule la ligne site_settings. */
function db(opts: { siteOrg?: string | null; settings?: Record<string, unknown>; mfa?: boolean; ownerId?: string }) {
  mQueryOne.mockImplementation((async (sql: string) => {
    if (sql.includes("FROM site_settings")) return { org_id: opts.siteOrg ?? null, settings: opts.settings ?? {} };
    if (sql.includes("SELECT owner_user_id FROM organizations")) return { owner_user_id: opts.ownerId ?? OWNER };
    if (sql.includes("SELECT id FROM roles WHERE org_id = $1 AND key = $2")) return { id: ROLE_EDITOR };
    if (sql.includes("SELECT mfa_enabled FROM users")) return { mfa_enabled: opts.mfa ?? false };
    if (sql.includes("SELECT storage_quota_bytes, name")) return { storage_quota_bytes: null, name: "Acme" };
    if (sql.includes("FROM node_versions v JOIN nodes n")) return { used: 10, files: 2 };
    return null;
  }) as never);
}

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError)
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    if (err instanceof ZodError) return reply.status(400).send({ error: { code: "validation" } });
    return reply.status(500).send({ error: { message: String(err) } });
  });
  await app.register(siteRoutes, { prefix: "/api/site" });
  await app.ready();
  return app;
}

const validSettings = { ...defaultSiteSettings() };

beforeEach(() => {
  vi.clearAllMocks();
  invalidateSiteSettings();
  acting = OWNER;
});

describe("GET /api/site/policy (public)", () => {
  it("expose la politique sans authentification, et signale un Drive sans propriétaire", async () => {
    db({ siteOrg: null });
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: "/api/site/policy" });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b).toMatchObject({ deployed: true, bootstrapped: false, signupMode: "open", mfaPolicy: "optional" });
    expect(b.passwordMinLength).toBeGreaterThanOrEqual(8);
  });

  it("reflète les réglages enregistrés", async () => {
    db({
      siteOrg: ORG,
      settings: { signupMode: "invite", mfaPolicy: "required", passwordMinLength: 14, backupRequired: true },
    });
    const app = await makeApp();
    const b = (await app.inject({ method: "GET", url: "/api/site/policy" })).json();
    expect(b).toMatchObject({
      bootstrapped: true,
      signupMode: "invite",
      mfaPolicy: "required",
      passwordMinLength: 14,
      backupRequired: true,
    });
  });
});

describe("routes propriétaire", () => {
  it("refuse (403) un membre qui n'est pas le propriétaire du déploiement", async () => {
    db({ siteOrg: ORG, ownerId: OWNER });
    acting = MEMBER;
    const app = await makeApp();
    for (const [method, url] of [
      ["GET", "/api/site/admin/settings"],
      ["GET", "/api/site/admin/users"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, url).toBe(403);
    }
    const put = await app.inject({
      method: "PUT",
      url: "/api/site/admin/settings",
      payload: { settings: validSettings, globalQuotaBytes: null },
    });
    expect(put.statusCode).toBe(403);
  });

  it("GET /me indique si l'on est propriétaire", async () => {
    db({ siteOrg: ORG });
    const app = await makeApp();
    expect((await app.inject({ method: "GET", url: "/api/site/me" })).json().isOwner).toBe(true);
    acting = MEMBER;
    expect((await app.inject({ method: "GET", url: "/api/site/me" })).json().isOwner).toBe(false);
  });

  it("PUT settings : enregistre, applique le quota global et journalise", async () => {
    db({ siteOrg: ORG });
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/site/admin/settings",
      payload: {
        settings: { ...validSettings, signupMode: "closed", perUserQuotaBytes: 5_000_000 },
        globalQuotaBytes: 100_000_000,
      },
    });
    expect(res.statusCode).toBe(200);
    const sqls = mQuery.mock.calls.map((c) => c[0] as string);
    expect(sqls.some((s) => s.includes("INSERT INTO site_settings"))).toBe(true);
    const quotaCall = mQuery.mock.calls.find((c) => (c[0] as string).includes("storage_quota_bytes = $2"));
    expect(quotaCall?.[1]).toEqual([ORG, 100_000_000]);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      ORG,
      OWNER,
      "site.settings.update",
      "org",
      ORG,
      expect.anything(),
      expect.anything(),
    );
  });

  it("PUT settings : valeurs invalides rejetées (mot de passe < 8, mode inconnu)", async () => {
    db({ siteOrg: ORG });
    const app = await makeApp();
    for (const bad of [{ passwordMinLength: 4 }, { signupMode: "public" }, { versionRetentionDays: -1 }]) {
      const res = await app.inject({
        method: "PUT",
        url: "/api/site/admin/settings",
        payload: { settings: { ...validSettings, ...bad }, globalQuotaBytes: null },
      });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
  });

  it("PUT settings : sauvegarde obligatoire sans espace privé par membre → 409 explicite", async () => {
    db({ siteOrg: ORG });
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/site/admin/settings",
      payload: {
        settings: { ...validSettings, backupRequired: true, membersCanCreateSpaces: false },
        globalQuotaBytes: null,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/espace privé/);
    const ok = await app.inject({
      method: "PUT",
      url: "/api/site/admin/settings",
      payload: {
        settings: { ...validSettings, backupRequired: true, membersCanCreateSpaces: true },
        globalQuotaBytes: null,
      },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("PUT settings : refuse le rôle propriétaire par défaut", async () => {
    db({ siteOrg: ORG });
    const app = await makeApp();
    const res = await app.inject({
      method: "PUT",
      url: "/api/site/admin/settings",
      payload: { settings: { ...validSettings, defaultRoleKey: "owner" }, globalQuotaBytes: null },
    });
    expect(res.statusCode).toBe(400);
  });

  it("PUT settings : impose la 2FA seulement si le propriétaire a la sienne (anti-verrouillage)", async () => {
    db({ siteOrg: ORG, mfa: false });
    const app = await makeApp();
    const payload = { settings: { ...validSettings, mfaPolicy: "required" }, globalQuotaBytes: null };
    const refused = await app.inject({ method: "PUT", url: "/api/site/admin/settings", payload });
    expect(refused.statusCode).toBe(409);
    db({ siteOrg: ORG, mfa: true });
    invalidateSiteSettings();
    const ok = await app.inject({
      method: "PUT",
      url: "/api/site/admin/settings",
      payload: { ...payload, mfaProof: "123456" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("PUT settings : imposer la 2FA exige une RÉ-AUTHENTIFICATION (code valide) — sinon 403", async () => {
    db({ siteOrg: ORG, mfa: true });
    const app = await makeApp();
    const base = { settings: { ...validSettings, mfaPolicy: "required" }, globalQuotaBytes: null };
    const none = await app.inject({ method: "PUT", url: "/api/site/admin/settings", payload: base });
    expect(none.statusCode).toBe(403);
    expect(none.json().error.code).toBe("mfa_proof_required");
    const bad = await app.inject({
      method: "PUT",
      url: "/api/site/admin/settings",
      payload: { ...base, mfaProof: "000000" },
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.json().error.code).toBe("mfa_proof_invalid");
    expect(mQuery.mock.calls.some((c) => String(c[0]).includes("INSERT INTO site_settings"))).toBe(false);
    // déjà imposée : enregistrer un autre réglage ne redemande pas de code
    invalidateSiteSettings();
    db({ siteOrg: ORG, mfa: true, settings: { mfaPolicy: "required" } });
    const again = await app.inject({ method: "PUT", url: "/api/site/admin/settings", payload: base });
    expect(again.statusCode).toBe(200);
  });

  it("POST password-reset : lien à usage unique, interdit pour soi-même, audit", async () => {
    mQueryOne.mockImplementation((async (sql: string) => {
      if (sql.includes("FROM site_settings")) return { org_id: ORG, settings: {} };
      if (sql.includes("SELECT owner_user_id FROM organizations")) return { owner_user_id: OWNER };
      if (sql.includes("FROM memberships WHERE org_id")) return { id: "m1" };
      return null;
    }) as never);
    const app = await makeApp();
    const self = await app.inject({ method: "POST", url: `/api/site/admin/users/${OWNER}/password-reset` });
    expect(self.statusCode).toBe(409);
    const res = await app.inject({ method: "POST", url: `/api/site/admin/users/${MEMBER}/password-reset` });
    expect(res.statusCode).toBe(200);
    const { token, expiresAt } = res.json();
    expect(token.length).toBeGreaterThan(20);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    const ins = mQuery.mock.calls.find((c) => String(c[0]).includes("INSERT INTO password_resets"))!;
    expect(JSON.stringify(ins[1])).not.toContain(token); // seule l'empreinte est stockée
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      ORG,
      OWNER,
      "site.user.password_reset",
      "user",
      MEMBER,
      expect.anything(),
      expect.anything(),
    );
    acting = MEMBER;
    expect(
      (await app.inject({ method: "POST", url: `/api/site/admin/users/${OWNER}/password-reset` })).statusCode,
    ).toBe(403);
  });

  it("PATCH user : le propriétaire ne peut être ni suspendu ni rétrogradé", async () => {
    mQueryOne.mockImplementation((async (sql: string) => {
      if (sql.includes("FROM site_settings")) return { org_id: ORG, settings: {} };
      if (sql.includes("SELECT owner_user_id FROM organizations WHERE id")) return { owner_user_id: OWNER };
      if (sql.includes("FROM memberships WHERE org_id")) return { id: "m1" };
      if (sql.includes("owner_user_id = $2 AS ok")) return { ok: true };
      return null;
    }) as never);
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/site/admin/users/${OWNER}`,
      payload: { suspended: true },
    });
    expect(res.statusCode).toBe(409);
  });

  it("PATCH user : suspension = statut + sessions révoquées ; quota individuel enregistré", async () => {
    mQueryOne.mockImplementation((async (sql: string) => {
      if (sql.includes("FROM site_settings")) return { org_id: ORG, settings: {} };
      if (sql.includes("SELECT owner_user_id FROM organizations WHERE id")) return { owner_user_id: OWNER };
      if (sql.includes("FROM memberships WHERE org_id")) return { id: "m1" };
      if (sql.includes("owner_user_id = $2 AS ok")) return { ok: false };
      if (sql.includes("COALESCE(SUM(v.size_bytes)")) return { used: 0 };
      return null;
    }) as never);
    const executed: string[] = [];
    const { withTx } = await import("../src/db/pool.js");
    vi.mocked(withTx).mockImplementation((async (fn: (c: { query: (s: string) => Promise<unknown> }) => unknown) =>
      fn({ query: async (s: string) => (executed.push(s), { rows: [] }) })) as never);
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/site/admin/users/${MEMBER}`,
      payload: { suspended: true, quotaBytes: 1234 },
    });
    expect(res.statusCode).toBe(200);
    expect(executed.some((s) => s.includes("UPDATE users SET status"))).toBe(true);
    expect(executed.some((s) => s.includes("UPDATE sessions SET revoked_at"))).toBe(true);
    expect(
      mQuery.mock.calls.some(
        (c) => (c[0] as string).includes("SET quota_bytes = $3") && (c[1] as unknown[])[2] === 1234,
      ),
    ).toBe(true);
    // Les jetons révoqués n'empêchent qu'un FUTUR rafraîchissement : une connexion
    // temps réel déjà admise doit aussi être coupée.
    expect(mKickUser).toHaveBeenCalledWith(MEMBER, "account-suspended");
  });

  it("PATCH user : un changement de rôle révoque aussi les connexions temps réel en cours", async () => {
    mQueryOne.mockImplementation((async (sql: string) => {
      if (sql.includes("FROM site_settings")) return { org_id: ORG, settings: {} };
      if (sql.includes("SELECT owner_user_id FROM organizations WHERE id")) return { owner_user_id: OWNER };
      if (sql.includes("FROM memberships WHERE org_id")) return { id: "m1" };
      if (sql.includes("owner_user_id = $2 AS ok")) return { ok: false };
      if (sql.includes("SELECT key FROM roles WHERE id = $1 AND org_id = $2")) return { key: "editor" };
      if (sql.includes("COALESCE(SUM(v.size_bytes)")) return { used: 0 };
      return null;
    }) as never);
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/site/admin/users/${MEMBER}`,
      payload: { roleId: ROLE_EDITOR },
    });
    expect(res.statusCode).toBe(200);
    expect(mKickUser).toHaveBeenCalledWith(MEMBER, "role-changed");
  });
});

describe("assertSignupAllowed", () => {
  it("ouvert : tout le monde ; fermé : 403 ; invitation : exige un jeton valide pour l'e-mail", async () => {
    db({ siteOrg: ORG, settings: { signupMode: "open" } });
    await expect(assertSignupAllowed("a@b.fr")).resolves.toBeUndefined();

    invalidateSiteSettings();
    db({ siteOrg: ORG, settings: { signupMode: "closed" } });
    await expect(assertSignupAllowed("a@b.fr")).rejects.toMatchObject({ statusCode: 403 });

    invalidateSiteSettings();
    db({ siteOrg: ORG, settings: { signupMode: "invite" } });
    await expect(assertSignupAllowed("a@b.fr")).rejects.toMatchObject({ statusCode: 403 });
    // jeton fourni mais aucune invitation correspondante → 403
    await expect(assertSignupAllowed("a@b.fr", "x".repeat(20))).rejects.toMatchObject({ statusCode: 403 });
    // invitation valide → autorisé
    mQueryOne.mockImplementation((async (sql: string) => {
      if (sql.includes("FROM site_settings")) return { org_id: ORG, settings: { signupMode: "invite" } };
      if (sql.includes("FROM invites")) return { id: "inv" };
      return null;
    }) as never);
    invalidateSiteSettings();
    await expect(assertSignupAllowed("a@b.fr", "x".repeat(20))).resolves.toBeUndefined();
  });

  it("avant le premier propriétaire : toujours ouvert (création du Drive)", async () => {
    db({ siteOrg: null, settings: { signupMode: "closed" } });
    await expect(assertSignupAllowed("boss@acme.fr")).resolves.toBeUndefined();
  });
});
