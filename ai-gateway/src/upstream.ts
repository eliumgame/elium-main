/**
 * Appel des fournisseurs (API compatibles OpenAI) avec bascule automatique.
 *
 * Les étapes de la route d'un assistant sont essayées dans l'ordre. On passe à la suivante sur
 * panne réseau, délai dépassé, 401/403 (clé du fournisseur invalide), 404 (modèle retiré chez ce
 * fournisseur), 408, 409, 429 ou 5xx. Une 400 (requête refusée : contexte trop long, paramètre
 * invalide…) n'est PAS rejouée ailleurs : elle échouerait pareil, on la renvoie au client.
 * La bascule n'a lieu qu'AVANT le premier octet de réponse : un flux commencé n'est jamais recousu.
 */
import type { GatewayConfig, RouteStep } from "./config.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface Attempt {
  provider: string;
  model: string;
  outcome: number | "timeout" | "network" | "no-key";
}

export class UpstreamFailure extends Error {
  constructor(
    readonly attempts: Attempt[],
    /** Statut à renvoyer au client. */
    readonly status: number,
    /** Message sûr à montrer au client (jamais de secret). */
    readonly clientMessage: string,
  ) {
    super(clientMessage);
  }
}

const RETRYABLE = new Set([401, 403, 404, 408, 409, 425, 429]);
const isRetryable = (s: number) => RETRYABLE.has(s) || s >= 500;

/** Extrait un message d'erreur court d'une réponse fournisseur (format OpenAI ou texte brut). */
async function upstreamErrorMessage(res: Response): Promise<string> {
  const text = (await res.text().catch(() => "")).slice(0, 4000);
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    const m = (typeof j.error === "object" && j.error ? j.error.message : j.error) ?? j.message ?? j.detail ?? text;
    return String(typeof m === "string" ? m : JSON.stringify(m)).slice(0, 500);
  } catch {
    return text.slice(0, 500) || `HTTP ${res.status}`;
  }
}

export interface OpenedUpstream {
  response: Response;
  step: RouteStep;
  attempts: Attempt[];
  /** Annule l'appel en cours (client parti). */
  abort: () => void;
}

export async function openUpstream(opts: {
  cfg: GatewayConfig;
  route: RouteStep[];
  /** Corps OpenAI sans `model` ni `reasoning_effort` (ajoutés par étape). */
  body: Record<string, unknown>;
  env: NodeJS.ProcessEnv;
  fetchImpl: FetchLike;
  /** Signal du client : s'il se déconnecte, on coupe l'appel au fournisseur. */
  signal?: AbortSignal;
}): Promise<OpenedUpstream> {
  const attempts: Attempt[] = [];
  let lastClientError: { status: number; message: string } | null = null;

  for (const step of opts.route) {
    const provider = opts.cfg.providers[step.provider];
    if (!provider) continue; // impossible : validé au chargement
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
    if (provider.apiKeyEnv) {
      const key = opts.env[provider.apiKeyEnv];
      if (!key) {
        attempts.push({ provider: step.provider, model: step.model, outcome: "no-key" });
        continue;
      }
      headers.authorization = `Bearer ${key}`;
    }
    const body: Record<string, unknown> = { ...opts.body, model: step.model };
    if (step.reasoningEffort) body.reasoning_effort = step.reasoningEffort;

    const ctrl = new AbortController();
    const onClientAbort = () => ctrl.abort();
    opts.signal?.addEventListener("abort", onClientAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, provider.timeoutMs);

    let res: Response;
    try {
      res = await opts.fetchImpl(`${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onClientAbort);
      if (opts.signal?.aborted) throw new UpstreamFailure(attempts, 499, "requête annulée par le client");
      attempts.push({ provider: step.provider, model: step.model, outcome: timedOut ? "timeout" : "network" });
      continue;
    }
    clearTimeout(timer); // en-têtes reçus : la lecture du corps (flux) n'est plus bornée par ce délai

    if (res.ok) {
      attempts.push({ provider: step.provider, model: step.model, outcome: res.status });
      return {
        response: res,
        step,
        attempts,
        abort: () => {
          opts.signal?.removeEventListener("abort", onClientAbort);
          ctrl.abort();
        },
      };
    }

    opts.signal?.removeEventListener("abort", onClientAbort);
    attempts.push({ provider: step.provider, model: step.model, outcome: res.status });
    const message = await upstreamErrorMessage(res);
    if (!isRetryable(res.status)) {
      lastClientError = { status: res.status, message };
      break;
    }
  }

  if (lastClientError) {
    const status = lastClientError.status >= 400 && lastClientError.status < 500 ? lastClientError.status : 502;
    throw new UpstreamFailure(attempts, status, `refusé par le fournisseur : ${lastClientError.message}`);
  }
  const allRateLimited = attempts.length > 0 && attempts.every((a) => a.outcome === 429);
  if (allRateLimited) {
    throw new UpstreamFailure(attempts, 503, "fournisseurs saturés, réessayez dans un instant");
  }
  if (attempts.length > 0 && attempts.every((a) => a.outcome === "no-key")) {
    throw new UpstreamFailure(attempts, 503, "aucun fournisseur configuré (clé d'API manquante côté passerelle)");
  }
  throw new UpstreamFailure(attempts, 502, "aucun fournisseur n'a pu répondre");
}
