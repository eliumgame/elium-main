import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { generateKey } from "../src/auth.js";
import { loadConfigFile, parseConfig, type GatewayConfig } from "../src/config.js";
import type { FetchLike } from "../src/upstream.js";
import { UsageTracker } from "../src/usage.js";

const elium = generateKey();
const other = generateKey();

function makeConfig(overrides: Partial<Record<string, unknown>> = {}): GatewayConfig {
  return parseConfig({
    providers: {
      a: { baseUrl: "https://a.example/v1", apiKeyEnv: "A_KEY" },
      b: { baseUrl: "https://b.example/v1/", apiKeyEnv: "B_KEY" },
    },
    assistants: {
      redac: {
        name: "Rédaction",
        systemPrompt: "Tu reformules.",
        route: [
          { provider: "a", model: "model-a", reasoningEffort: "none", priceInPerMTok: 1, priceOutPerMTok: 2 },
          { provider: "b", model: "model-b" },
        ],
        maxTokens: 500,
        temperature: 0.3,
      },
      brut: { name: "Brut", route: [{ provider: "b", model: "model-b" }] },
    },
    clients: {
      elium: { name: "Elium", keySha256: elium.keySha256, assistants: ["redac", "brut"], requestsPerMinute: 3 },
      autre: { name: "Autre", keySha256: other.keySha256, assistants: ["brut"], monthlyTokenQuota: 10 },
    },
    ...overrides,
  });
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Faux fournisseurs : `plan` donne, par URL d'hôte, la réponse à renvoyer. */
function fakeFetch(plan: Record<string, () => Response>, calls: Call[]): FetchLike {
  return async (url, init) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    const host = new URL(url).host;
    const make = plan[host];
    if (!make) throw new TypeError("fetch failed");
    return make();
  };
}

const okCompletion = (content = "Bonjour reformulé", usage = { prompt_tokens: 12, completion_tokens: 5 }) =>
  new Response(
    JSON.stringify({
      id: "x",
      object: "chat.completion",
      model: "model-a",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage,
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const env = { A_KEY: "secret-a", B_KEY: "secret-b" };
const auth = (k: string) => ({ authorization: `Bearer ${k}` });

describe("configuration", () => {
  it("l'exemple livré est valide", () => {
    const cfg = loadConfigFile(join(import.meta.dirname, "..", "config", "gateway.example.json"));
    expect(Object.keys(cfg.assistants)).toContain("elium-redaction");
    expect(cfg.assistants["elium-redaction"]?.route[0]?.model).toBe("mistral-medium-3.5-128b");
  });

  it("refuse un fournisseur inconnu, un assistant inconnu et une clé partagée", () => {
    expect(() =>
      makeConfig({
        assistants: { x: { name: "X", route: [{ provider: "zzz", model: "m" }] } },
        clients: {
          c1: { name: "1", keySha256: elium.keySha256, assistants: ["nope"] },
          c2: { name: "2", keySha256: elium.keySha256, assistants: ["*"] },
        },
      }),
    ).toThrow(/fournisseur inconnu « zzz »[\s\S]*assistant inconnu « nope »[\s\S]*même clé/);
  });
});

describe("authentification et catalogue", () => {
  it("/health est public, le reste exige une clé valide", async () => {
    const app = buildApp(makeConfig(), { env });
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/v1/models" })).statusCode).toBe(401);
    const bad = await app.inject({ url: "/v1/models", headers: auth("eai_inconnue") });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe("invalid_api_key");
  });

  it("/v1/models ne liste que les assistants autorisés", async () => {
    const app = buildApp(makeConfig(), { env });
    const res = await app.inject({ url: "/v1/models", headers: auth(other.key) });
    expect(res.json().data.map((m: { id: string }) => m.id)).toEqual(["brut"]);
  });

  it("un assistant non autorisé répond comme inexistant", async () => {
    const app = buildApp(makeConfig(), { env, fetchImpl: fakeFetch({}, []) });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(other.key),
      payload: { model: "redac", messages: [{ role: "user", content: "x" }] },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("conversation", () => {
  it("ajoute la consigne, borne max_tokens, filtre les champs, masque le fournisseur", async () => {
    const calls: Call[] = [];
    const usage = new UsageTracker(null);
    const app = buildApp(makeConfig(), {
      env,
      usage,
      fetchImpl: fakeFetch({ "a.example": () => okCompletion() }, calls),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(elium.key),
      payload: { model: "redac", messages: [{ role: "user", content: "bonjour" }], max_tokens: 99999, n: 50 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().model).toBe("redac");
    expect(res.json().choices[0].message.content).toBe("Bonjour reformulé");
    expect(res.headers["x-gateway-provider"]).toBe("a");

    const call = calls[0]!;
    expect(call.url).toBe("https://a.example/v1/chat/completions");
    expect(call.headers.authorization).toBe("Bearer secret-a");
    expect(call.body).toEqual({
      model: "model-a",
      reasoning_effort: "none",
      messages: [
        { role: "system", content: "Tu reformules." },
        { role: "user", content: "bonjour" },
      ],
      max_tokens: 500,
      temperature: 0.3,
    });
    expect(usage.get("elium")).toEqual({ requests: 1, promptTokens: 12, completionTokens: 5, costEur: 0.000022 });
  });

  it("bascule sur le fournisseur suivant en cas de panne, sans clé ni barre oblique en double", async () => {
    const calls: Call[] = [];
    const app = buildApp(makeConfig(), {
      env,
      fetchImpl: fakeFetch(
        { "a.example": () => new Response("indisponible", { status: 503 }), "b.example": () => okCompletion() },
        calls,
      ),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(elium.key),
      payload: { model: "redac", messages: [{ role: "user", content: "x" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-gateway-provider"]).toBe("b");
    expect(calls.map((c) => c.url)).toEqual([
      "https://a.example/v1/chat/completions",
      "https://b.example/v1/chat/completions",
    ]);
    expect(calls[1]!.body.reasoning_effort).toBeUndefined();
  });

  it("bascule aussi sur erreur réseau et sur fournisseur sans clé", async () => {
    const calls: Call[] = [];
    const app = buildApp(makeConfig(), {
      env: { B_KEY: "secret-b" },
      fetchImpl: fakeFetch({ "b.example": () => okCompletion() }, calls),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(elium.key),
      payload: { model: "redac", messages: [{ role: "user", content: "x" }] },
    });
    expect(res.statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("ne rejoue pas une 400 ailleurs et relaie le message du fournisseur", async () => {
    const calls: Call[] = [];
    const app = buildApp(makeConfig(), {
      env,
      fetchImpl: fakeFetch(
        {
          "a.example": () => new Response(JSON.stringify({ error: { message: "context too long" } }), { status: 400 }),
          "b.example": () => okCompletion(),
        },
        calls,
      ),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(elium.key),
      payload: { model: "redac", messages: [{ role: "user", content: "x" }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain("context too long");
    expect(calls).toHaveLength(1);
  });

  it("503 explicite quand aucune clé de fournisseur n'est configurée", async () => {
    const app = buildApp(makeConfig(), { env: {}, fetchImpl: fakeFetch({}, []) });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(elium.key),
      payload: { model: "redac", messages: [{ role: "user", content: "x" }] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.message).toMatch(/clé d'API manquante/);
  });

  it("refuse une requête mal formée", async () => {
    const app = buildApp(makeConfig(), { env });
    const res = await app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(elium.key),
      payload: { model: "redac", messages: [{ role: "tool", content: "x" }] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("limites", () => {
  const ask = (app: ReturnType<typeof buildApp>, key: string, model: string) =>
    app.inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth(key),
      payload: { model, messages: [{ role: "user", content: "x" }] },
    });

  it("applique le débit par minute", async () => {
    let t = 1_000_000;
    const usage = new UsageTracker(null, () => t);
    const app = buildApp(makeConfig(), { env, usage, fetchImpl: fakeFetch({ "a.example": () => okCompletion() }, []) });
    for (let i = 0; i < 3; i++) expect((await ask(app, elium.key, "redac")).statusCode).toBe(200);
    const limited = await ask(app, elium.key, "redac");
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe("rate_limited");
    t += 61_000;
    expect((await ask(app, elium.key, "redac")).statusCode).toBe(200);
  });

  it("applique le quota mensuel de tokens", async () => {
    const usage = new UsageTracker(null);
    const app = buildApp(makeConfig(), { env, usage, fetchImpl: fakeFetch({ "b.example": () => okCompletion() }, []) });
    expect((await ask(app, other.key, "brut")).statusCode).toBe(200); // 17 tokens > quota de 10
    const res = await ask(app, other.key, "brut");
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("quota_exceeded");
    const u = await app.inject({ url: "/v1/usage", headers: auth(other.key) });
    expect(u.json().month.promptTokens + u.json().month.completionTokens).toBe(17);
  });
});

describe("flux SSE", () => {
  let app: ReturnType<typeof buildApp> | null = null;
  afterEach(async () => {
    await app?.close();
    app = null;
  });

  it("relaie le flux et comptabilise l'usage du dernier fragment", async () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"Bon"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"jour"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n";
    const calls: Call[] = [];
    const usage = new UsageTracker(null);
    app = buildApp(makeConfig(), {
      env,
      usage,
      fetchImpl: fakeFetch(
        { "a.example": () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }) },
        calls,
      ),
    });
    const base = await app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { ...auth(elium.key), "content-type": "application/json" },
      body: JSON.stringify({ model: "redac", stream: true, messages: [{ role: "user", content: "x" }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(await res.text()).toBe(sse);
    expect(calls[0]!.body.stream).toBe(true);
    expect(calls[0]!.body.stream_options).toEqual({ include_usage: true });
    expect(usage.get("elium")).toMatchObject({ requests: 1, promptTokens: 7, completionTokens: 2 });
  });
});

describe("persistance de la consommation", () => {
  it("survit à un redémarrage", () => {
    const dir = mkdtempSync(join(tmpdir(), "eai-"));
    try {
      const file = join(dir, "sub", "usage.json");
      const u1 = new UsageTracker(file);
      u1.record("elium", 100, 50, 0.01);
      u1.flush();
      expect(JSON.parse(readFileSync(file, "utf8"))).toBeTruthy();
      const u2 = new UsageTracker(file);
      expect(u2.get("elium")).toEqual({ requests: 1, promptTokens: 100, completionTokens: 50, costEur: 0.01 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
