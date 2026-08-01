/**
 * Tests for the startup/body hardening ported from the 2026-07-15 audit:
 *  - JSON request bodies get their own cap (config.maxJsonBytes) instead of
 *    inheriting the 2 GiB blob bodyLimit — 413 on oversized JSON, 400 (not
 *    500) on malformed JSON.
 *  - In production, config refuses the repo's placeholder TOKEN_SECRET and
 *    default/example DATABASE_URL passwords at startup.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
  closePool: vi.fn(async () => {}),
}));

describe("cap JSON (maxJsonBytes) sur la vraie app", () => {
  it("un body JSON au-delà du cap est refusé en 413 ; un JSON malformé est un 400", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();

    // > 1 MiB (default MAX_JSON_BYTES) but far below the 2 GiB blob bodyLimit.
    const oversized = JSON.stringify({ email: "a".repeat(1024 * 1024 + 64) });
    const resBig = await app.inject({
      method: "POST",
      url: "/api/auth/prelogin",
      headers: { "content-type": "application/json" },
      payload: oversized,
    });
    expect(resBig.statusCode).toBe(413);

    const resBad = await app.inject({
      method: "POST",
      url: "/api/auth/prelogin",
      headers: { "content-type": "application/json" },
      payload: "{pas du json",
    });
    expect(resBad.statusCode).toBe(400);

    // Sanity: a normal-size, well-formed body still goes through the parser.
    const resOk = await app.inject({
      method: "POST",
      url: "/api/auth/prelogin",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "user@example.org" }),
    });
    expect(resOk.statusCode).toBe(200);

    await app.close();
  });
});

describe("validation des secrets au démarrage (production)", () => {
  const ENV_KEYS = ["NODE_ENV", "TOKEN_SECRET", "DATABASE_URL"] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it("refuse un TOKEN_SECRET resté sur la valeur d'exemple", async () => {
    process.env.NODE_ENV = "production";
    process.env.TOKEN_SECRET = "CHANGE_ME_generate_a_real_random_secret_string";
    process.env.DATABASE_URL = "postgres://elium:S3cure-R3al-P4ss@db:5432/elium";
    vi.resetModules();
    await expect(import("../src/config.js")).rejects.toThrow(/valeur d'exemple/);
  });

  it("refuse une DATABASE_URL au mot de passe par défaut/exemple", async () => {
    process.env.NODE_ENV = "production";
    process.env.TOKEN_SECRET = "b".repeat(48);
    process.env.DATABASE_URL = "postgres://elium:elium@db:5432/elium";
    vi.resetModules();
    await expect(import("../src/config.js")).rejects.toThrow(/mot de passe par défaut/);
  });

  it("accepte des vrais secrets de production", async () => {
    process.env.NODE_ENV = "production";
    process.env.TOKEN_SECRET = "b".repeat(48);
    process.env.DATABASE_URL = "postgres://elium:S3cure-R3al-P4ss@db:5432/elium";
    vi.resetModules();
    const { config } = await import("../src/config.js");
    expect(config.isProd).toBe(true);
    expect(config.tokenSecret).toBe("b".repeat(48));
  });
});

describe("en-têtes de sécurité (helmet durci)", () => {
  it("sert une CSP verrouillée + Referrer-Policy + CORP sur une réponse d'API", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    const csp = res.headers["content-security-policy"];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-site");
    // helmet retire l'empreinte de pile.
    expect(res.headers["x-powered-by"]).toBeUndefined();
    await app.close();
  });
});

describe("trustProxy — anti-usurpation d'IP (rate-limit)", () => {
  it("parse TRUST_PROXY : défaut = proxys privés/loopback, jamais `true` implicite", async () => {
    const { parseTrustProxy, TRUSTED_LOCAL_PROXIES } = await import("../src/config.js");
    expect(parseTrustProxy(undefined)).toEqual(TRUSTED_LOCAL_PROXIES); // défaut sûr
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("127.0.0.1, 10.0.0.0/8")).toEqual(["127.0.0.1", "10.0.0.0/8"]);
  });

  it("un X-Forwarded-For d'une connexion PUBLIQUE directe est ignoré (IP réelle conservée)", async () => {
    const { buildApp } = await import("../src/app.js");
    const app = await buildApp();
    app.get("/__ip", async (req) => ({ ip: req.ip }));

    // Client public direct qui tente d'usurper une IP via X-Forwarded-For :
    // avec le défaut (confiance aux seuls proxys privés), l'en-tête est ignoré.
    const spoof = await app.inject({
      method: "GET", url: "/__ip",
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    expect(spoof.json().ip).toBe("203.0.113.9"); // IP réelle, pas l'usurpée

    // Un proxy interne (loopback) est de confiance : son X-Forwarded-For compte.
    const viaProxy = await app.inject({
      method: "GET", url: "/__ip",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.7" },
    });
    expect(viaProxy.json().ip).toBe("198.51.100.7");

    await app.close();
  });
});
