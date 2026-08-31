/**
 * Backplane Redis OPTIONNEL pour le passage à l'échelle horizontale.
 *
 * Sans `REDIS_URL`, tout est no-op : le relais collab, le canal d'événements org
 * et le rate-limit restent en mémoire de processus (mono-instance, comportement
 * historique). Avec `REDIS_URL`, les événements « live » (broadcast d'update /
 * awareness, éjection de salle après rotation, ping d'organisation) sont publiés
 * sur un canal Redis et RE-JOUÉS sur chaque autre instance, qui les délivre à SES
 * peers locaux. La DURABILITÉ reste Postgres (`collab_updates`) — le backplane ne
 * fait QUE le fan-out temps réel entre instances ; les retardataires rattrapent
 * via le backlog REST quelle que soit l'instance.
 *
 * Anti-boucle : chaque message porte l'`origin` (id de process) ; une instance
 * ignore ses propres messages. Best-effort : une erreur Redis ne casse jamais le
 * chemin local (le serveur reste fonctionnel en dégradé, mono-instance de fait).
 *
 * Observabilité : une panne Redis ne doit jamais être TOTALEMENT silencieuse
 * (elle dégrade le service à mono-instance sans qu'aucune instance ne le sache).
 * On garde donc un état santé minimal (`getBackplaneHealth`), exposé par
 * `/api/health`, et on logge un `warn` UNIQUEMENT à la TRANSITION vers l'échec
 * (et un `info` au rétablissement) — jamais à chaque tentative/erreur, pour ne
 * pas noyer les logs pendant une coupure prolongée (ioredis retente sans cesse).
 */
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { config } from "../config.js";

export type RelayMsg =
  | { k: "bcast"; nodeId: string; message: unknown }
  | { k: "kick"; nodeId: string; reason: string }
  | { k: "org"; orgId: string };

export type BackplaneHealth = "disabled" | "ok" | "degraded";

/** Minimal structural logger — matches Fastify's `app.log` (pino). */
export interface BackplaneLogger {
  warn(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

const CHANNEL = "elium:relay";
const ORIGIN = randomUUID();

let pub: Redis | null = null;
let sub: Redis | null = null;
let started = false;
let logger: BackplaneLogger | null = null;

// État santé : dernière transition seulement (pas de compteur par tentative).
let healthy = true; // optimiste jusqu'à la première erreur observée
let lastSuccessAt: number | null = null;
let lastFailureAt: number | null = null;
let lastError: string | null = null;

function markFailure(err: unknown): void {
  lastFailureAt = Date.now();
  lastError = err instanceof Error ? err.message : String(err);
  if (healthy) {
    healthy = false;
    logger?.warn(
      { err: lastError },
      "backplane: Redis injoignable — bascule dégradée mono-instance (temps réel inter-instances suspendu)",
    );
  }
}

function markSuccess(): void {
  lastSuccessAt = Date.now();
  if (!healthy) {
    healthy = true;
    logger?.info({}, "backplane: Redis rétabli — relais multi-instance de nouveau actif");
  }
}

/** État exposé par /api/health. */
export function getBackplaneHealth(): {
  status: BackplaneHealth;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
} {
  return {
    status: !config.redisUrl ? "disabled" : healthy ? "ok" : "degraded",
    lastSuccessAt,
    lastFailureAt,
    lastError,
  };
}

function makeClient(): Redis {
  // maxRetriesPerRequest: null → ne rejette pas les commandes pendant une
  // coupure (ioredis rejoue à la reconnexion) ; on avale les erreurs.
  const c = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
  c.on("error", (err) => {
    /* transitoire : ne pas crasher le process — mais tracer la transition */
    markFailure(err);
  });
  c.on("ready", () => markSuccess());
  return c;
}

/** Démarre le backplane (idempotent). `handler` reçoit les messages DISTANTS. */
export function initBackplane(handler: (m: RelayMsg) => void, log?: BackplaneLogger): void {
  logger = log ?? logger;
  if (started || !config.redisUrl) return;
  started = true;
  pub = makeClient();
  sub = makeClient();
  void sub.subscribe(CHANNEL).catch((err: unknown) => {
    markFailure(err); // réabonnement auto d'ioredis à la reconnexion
  });
  sub.on("message", (_ch: string, raw: string) => {
    try {
      const env = JSON.parse(raw) as { origin: string; msg: RelayMsg };
      if (env.origin === ORIGIN) return; // ignorer nos propres publications
      handler(env.msg);
    } catch {
      /* message illisible : ignoré */
    }
  });
}

/** Publie un événement de relais aux autres instances (no-op sans Redis). */
export function publishRelay(msg: RelayMsg): void {
  if (!pub) return;
  void pub
    .publish(CHANNEL, JSON.stringify({ origin: ORIGIN, msg }))
    .then(() => markSuccess())
    .catch((err: unknown) => {
      markFailure(err); // best-effort : le chemin local n'est jamais bloqué
    });
}

export function backplaneEnabled(): boolean {
  return !!config.redisUrl;
}

/** Client Redis dédié au rate-limit partagé (ou null en mono-instance). */
export function createRateLimitRedis(): Redis | null {
  return config.redisUrl ? makeClient() : null;
}

/** Fermeture propre (arrêt du serveur). */
export async function closeBackplane(): Promise<void> {
  await Promise.allSettled([pub?.quit(), sub?.quit()]);
  pub = sub = null;
  started = false;
  healthy = true;
  lastSuccessAt = lastFailureAt = null;
  lastError = null;
}
