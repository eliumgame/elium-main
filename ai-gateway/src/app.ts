/**
 * API de la passerelle — compatible OpenAI, donc utilisable avec n'importe quel SDK OpenAI
 * (`baseURL = https://<passerelle>/v1`, `apiKey = eai_…`, `model = <id d'assistant>`).
 *
 *   GET  /health                 — sonde (sans authentification)
 *   GET  /v1/models              — assistants autorisés pour la clé
 *   POST /v1/chat/completions    — conversation (réponse complète ou flux SSE)
 *   GET  /v1/usage               — consommation du mois et limites de la clé
 *
 * Confidentialité : le contenu des messages n'est JAMAIS journalisé. Une ligne `ai_request` par
 * appel ne contient que des métadonnées (client, assistant, fournisseur, tokens, durée, statut).
 */
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import { authenticate, buildKeyIndex, canUseAssistant, extractKey, type AuthedClient } from "./auth.js";
import type { GatewayConfig, RouteStep } from "./config.js";
import { openUpstream, UpstreamFailure, type FetchLike } from "./upstream.js";
import { UsageTracker } from "./usage.js";

const TextPart = z.object({ type: z.literal("text"), text: z.string() });
const ImagePart = z.object({
  type: z.literal("image_url"),
  image_url: z.object({ url: z.string().max(3_000_000), detail: z.enum(["auto", "low", "high"]).optional() }),
});
const Message = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.union([
    z.string(),
    z
      .array(z.union([TextPart, ImagePart]))
      .min(1)
      .max(20),
  ]),
});

/** Seuls ces champs sont transmis au fournisseur : tout le reste (`n`, `tools`…) est écarté. */
const ChatRequest = z.object({
  model: z.string().min(1).max(64),
  messages: z.array(Message).min(1),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().gt(0).max(1).optional(),
  max_tokens: z.number().int().positive().optional(),
  max_completion_tokens: z.number().int().positive().optional(),
  stop: z.union([z.string().max(200), z.array(z.string().max(200)).max(4)]).optional(),
  response_format: z
    .union([
      z.object({ type: z.literal("text") }),
      z.object({ type: z.literal("json_object") }),
      z.object({ type: z.literal("json_schema"), json_schema: z.record(z.string(), z.unknown()) }),
    ])
    .optional(),
  stream: z.boolean().optional(),
});
type ChatRequest = z.infer<typeof ChatRequest>;

export interface AppDeps {
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  usage?: UsageTracker;
  logger?: boolean | { level: string };
}

function sendError(reply: FastifyReply, status: number, message: string, code: string) {
  const type = status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "invalid_request_error";
  return reply.code(status).send({ error: { message, type, code } });
}

function textLength(messages: ChatRequest["messages"]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") n += m.content.length;
    else for (const p of m.content) if (p.type === "text") n += p.text.length;
  }
  return n;
}

/** Estimation grossière (≈ 4 caractères par token) quand le fournisseur ne renvoie pas `usage`. */
const estimateTokens = (chars: number) => Math.ceil(chars / 4);

function cost(step: RouteStep, prompt: number, completion: number): number {
  return ((step.priceInPerMTok ?? 0) * prompt + (step.priceOutPerMTok ?? 0) * completion) / 1_000_000;
}

interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

export function buildApp(cfg: GatewayConfig, deps: AppDeps = {}): FastifyInstance {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const env = deps.env ?? process.env;
  const usage = deps.usage ?? new UsageTracker(null);
  const keys = buildKeyIndex(cfg);

  const app = Fastify({
    logger: deps.logger ?? false,
    bodyLimit: 8 * 1024 * 1024, // images en data-URL comprises
    trustProxy: true,
  });

  app.decorateRequest("authed", null);

  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/health") return;
    const authed = authenticate(keys, extractKey(req.headers));
    if (!authed) return sendError(reply, 401, "clé d'API absente ou invalide", "invalid_api_key");
    (req as unknown as { authed: AuthedClient }).authed = authed;
  });

  const who = (req: unknown) => (req as { authed: AuthedClient }).authed;

  app.get("/health", async () => ({ ok: true }));

  app.get("/v1/models", async (req) => {
    const { client } = who(req);
    const data = Object.entries(cfg.assistants)
      .filter(([id]) => canUseAssistant(client, id))
      .map(([id, a]) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "elium-ai",
        name: a.name,
        description: a.description,
      }));
    return { object: "list", data };
  });

  app.get("/v1/usage", async (req) => {
    const { id, client } = who(req);
    return {
      client: id,
      month: usage.get(id),
      limits: { requestsPerMinute: client.requestsPerMinute, monthlyTokenQuota: client.monthlyTokenQuota },
    };
  });

  app.post("/v1/chat/completions", async (req, reply) => {
    const { id: clientId, client } = who(req);
    const parsed = ChatRequest.safeParse(req.body);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return sendError(reply, 400, `requête invalide : ${first?.path.join(".")} ${first?.message}`, "invalid_request");
    }
    const r = parsed.data;
    const assistant = cfg.assistants[r.model];
    if (!assistant || !canUseAssistant(client, r.model)) {
      return sendError(reply, 404, `assistant inconnu : ${r.model}`, "model_not_found");
    }
    if (r.messages.length > cfg.limits.maxMessages) {
      return sendError(reply, 400, `trop de messages (max ${cfg.limits.maxMessages})`, "too_many_messages");
    }
    const inputChars = textLength(r.messages) + assistant.systemPrompt.length;
    if (inputChars > cfg.limits.maxInputChars) {
      return sendError(reply, 413, `texte trop long (max ${cfg.limits.maxInputChars} caractères)`, "input_too_long");
    }
    if (!usage.hasQuota(clientId, client.monthlyTokenQuota)) {
      return sendError(reply, 429, "quota mensuel de tokens atteint", "quota_exceeded");
    }
    if (!usage.takeRequestSlot(clientId, client.requestsPerMinute)) {
      reply.header("retry-after", "60");
      return sendError(reply, 429, "trop de requêtes, réessayez dans une minute", "rate_limited");
    }

    const messages = assistant.systemPrompt
      ? [{ role: "system" as const, content: assistant.systemPrompt }, ...r.messages]
      : r.messages;
    const wanted = r.max_completion_tokens ?? r.max_tokens ?? assistant.maxTokens;
    const body: Record<string, unknown> = { messages, max_tokens: Math.min(wanted, assistant.maxTokens) };
    const temperature = r.temperature ?? assistant.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    if (r.top_p !== undefined) body.top_p = r.top_p;
    if (r.stop !== undefined) body.stop = r.stop;
    if (r.response_format !== undefined) body.response_format = r.response_format;
    const stream = r.stream === true;
    if (stream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }

    const started = Date.now();
    const clientGone = new AbortController();
    // Côté RÉPONSE : sur la requête, « close » part dès que le corps est lu (Node ≥ 16), pas à la déconnexion.
    reply.raw.on("close", () => {
      if (!reply.raw.writableFinished) clientGone.abort();
    });

    const logLine = (extra: Record<string, unknown>) =>
      req.log.info(
        { event: "ai_request", client: clientId, assistant: r.model, stream, ms: Date.now() - started, ...extra },
        "ai_request",
      );

    let opened;
    try {
      opened = await openUpstream({ cfg, route: assistant.route, body, env, fetchImpl, signal: clientGone.signal });
    } catch (err) {
      if (err instanceof UpstreamFailure) {
        logLine({ status: err.status, attempts: err.attempts });
        if (err.status === 499) return reply;
        return sendError(reply, err.status, err.clientMessage, "upstream_error");
      }
      throw err;
    }
    const { response, step, attempts } = opened;
    reply.header("x-gateway-provider", step.provider);
    reply.header("x-gateway-model", step.model);

    if (!stream) {
      let json: { usage?: Usage; model?: string; choices?: { message?: { content?: unknown } }[] };
      try {
        json = (await response.json()) as typeof json;
      } catch {
        logLine({ status: 502, attempts, provider: step.provider });
        return sendError(reply, 502, "réponse illisible du fournisseur", "upstream_error");
      }
      const outText = String(json.choices?.[0]?.message?.content ?? "");
      const promptTokens = json.usage?.prompt_tokens ?? estimateTokens(inputChars);
      const completionTokens = json.usage?.completion_tokens ?? estimateTokens(outText.length);
      usage.record(clientId, promptTokens, completionTokens, cost(step, promptTokens, completionTokens));
      logLine({ status: 200, attempts, provider: step.provider, model: step.model, promptTokens, completionTokens });
      return { ...json, model: r.model };
    }

    // ---- Flux SSE : relayé tel quel, en relevant `usage` au passage (dernier fragment). ----
    reply.hijack();
    const out = reply.raw;
    out.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      "x-gateway-provider": step.provider,
      "x-gateway-model": step.model,
    });
    let seenUsage: Usage | null = null;
    let outChars = 0;
    let pending = "";
    const decoder = new TextDecoder();
    const inspect = (chunk: string) => {
      pending += chunk;
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).trim();
        pending = pending.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const j = JSON.parse(data) as { usage?: Usage | null; choices?: { delta?: { content?: unknown } }[] };
          if (j.usage) seenUsage = j.usage;
          const c = j.choices?.[0]?.delta?.content;
          if (typeof c === "string") outChars += c.length;
        } catch {}
      }
    };
    let status = 200;
    try {
      const reader = response.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          inspect(decoder.decode(value, { stream: true }));
          if (!out.write(value)) await new Promise<void>((res) => out.once("drain", () => res()));
        }
      }
    } catch {
      status = clientGone.signal.aborted ? 499 : 502;
    } finally {
      opened.abort();
      out.end();
    }
    const u = seenUsage as Usage | null;
    const promptTokens = u?.prompt_tokens ?? estimateTokens(inputChars);
    const completionTokens = u?.completion_tokens ?? estimateTokens(outChars);
    usage.record(clientId, promptTokens, completionTokens, cost(step, promptTokens, completionTokens));
    logLine({ status, attempts, provider: step.provider, model: step.model, promptTokens, completionTokens });
    return reply;
  });

  return app;
}
