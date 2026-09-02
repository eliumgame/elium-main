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

/**
 * État santé PAR CONNEXION (dernière transition seulement, pas de compteur par
 * tentative). `pub` (publication de NOS events vers les autres instances) et
 * `sub` (réception de LEURS events) sont deux connexions ioredis indépendantes
 * qui peuvent tomber l'une sans l'autre — typiquement `sub` coupé pendant que
 * `pub` reste up : cette instance publie encore avec succès mais ne reçoit
 * plus RIEN des autres. Un booléen partagé masquerait alors ce cas (le succès
 * de `pub` effacerait l'échec de `sub`) : on garde donc un état distinct pour
 * chacun, et l'état global exposé par `getBackplaneHealth()` est le PIRE des
 * deux (dégradé si l'un OU l'autre est en échec).
 */
interface ConnHealth {
  healthy: boolean; // optimiste jusqu'à la première erreur observée
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
}
function freshConnHealth(): ConnHealth {
  return { healthy: true, lastSuccessAt: null, lastFailureAt: null, lastError: null };
}
let pubHealth: ConnHealth = freshConnHealth();
let subHealth: ConnHealth = freshConnHealth();

function markFailure(conn: ConnHealth, label: "pub" | "sub", err: unknown): void {
  conn.lastFailureAt = Date.now();
  conn.lastError = err instanceof Error ? err.message : String(err);
  if (conn.healthy) {
    conn.healthy = false;
    logger?.warn(
      { err: conn.lastError, conn: label },
      `backplane: Redis (${label}) injoignable — bascule dégradée (temps réel inter-instances suspendu côté ${label})`,
    );
  }
}

function markSuccess(conn: ConnHealth, label: "pub" | "sub"): void {
  conn.lastSuccessAt = Date.now();
  if (!conn.healthy) {
    conn.healthy = true;
    logger?.info({ conn: label }, `backplane: Redis (${label}) rétabli — relais multi-instance de nouveau actif`);
  }
}

function latestTimestamp(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * État exposé par /api/health. `status` reflète le pire des deux connexions :
 * "ok" seulement si pub ET sub sont saines, "degraded" si l'une OU l'autre a
 * échoué (voir le commentaire sur `ConnHealth` ci-dessus). Le détail par
 * connexion reste disponible via `pub`/`sub` pour diagnostiquer LAQUELLE est
 * en cause.
 */
export function getBackplaneHealth(): {
  status: BackplaneHealth;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  lastError: string | null;
  pub: Readonly<ConnHealth>;
  sub: Readonly<ConnHealth>;
} {
  const bothHealthy = pubHealth.healthy && subHealth.healthy;
  // En cas de panne, on remonte l'erreur de la (ou d'une des) connexion(s) en
  // échec plutôt que la plus récente toutes connexions confondues — sinon un
  // succès `pub` postérieur à l'échec `sub` masquerait le message d'erreur.
  const lastError = !subHealth.healthy ? subHealth.lastError : !pubHealth.healthy ? pubHealth.lastError : null;
  return {
    status: !config.redisUrl ? "disabled" : bothHealthy ? "ok" : "degraded",
    lastSuccessAt: latestTimestamp(pubHealth.lastSuccessAt, subHealth.lastSuccessAt),
    lastFailureAt: latestTimestamp(pubHealth.lastFailureAt, subHealth.lastFailureAt),
    lastError,
    pub: { ...pubHealth },
    sub: { ...subHealth },
  };
}

function makeClient(label: "pub" | "sub"): Redis {
  const conn = label === "pub" ? pubHealth : subHealth;
  // maxRetriesPerRequest: null → ne rejette pas les commandes pendant une
  // coupure (ioredis rejoue à la reconnexion) ; on avale les erreurs.
  const c = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
  c.on("error", (err) => {
    /* transitoire : ne pas crasher le process — mais tracer la transition */
    markFailure(conn, label, err);
  });
  c.on("ready", () => markSuccess(conn, label));
  return c;
}

/** Démarre le backplane (idempotent). `handler` reçoit les messages DISTANTS. */
export function initBackplane(handler: (m: RelayMsg) => void, log?: BackplaneLogger): void {
  logger = log ?? logger;
  if (started || !config.redisUrl) return;
  started = true;
  pub = makeClient("pub");
  sub = makeClient("sub");
  void sub.subscribe(CHANNEL).catch((err: unknown) => {
    markFailure(subHealth, "sub", err); // réabonnement auto d'ioredis à la reconnexion
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
    .then(() => markSuccess(pubHealth, "pub"))
    .catch((err: unknown) => {
      markFailure(pubHealth, "pub", err); // best-effort : le chemin local n'est jamais bloqué
    });
}

export function backplaneEnabled(): boolean {
  return !!config.redisUrl;
}

/**
 * Client Redis dédié au rate-limit partagé (ou null en mono-instance).
 * Connexion INDÉPENDANTE de pub/sub (autre usage : compteur @fastify/rate-limit,
 * pas le relais collab) — délibérément PAS branchée sur `markFailure`/
 * `markSuccess` : ses pannes ne représentent pas une dégradation du relais
 * temps réel et ne doivent donc pas polluer le `collab.redis` de /api/health.
 * On garde quand même un listener "error" (sinon ioredis lève si AUCUN
 * listener n'est attaché) ; ioredis rejoue ses commandes à la reconnexion.
 */
export function createRateLimitRedis(): Redis | null {
  if (!config.redisUrl) return null;
  const c = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
  c.on("error", () => {
    /* transitoire : ne pas crasher le process — pas de suivi de santé ici */
  });
  return c;
}

/** Fermeture propre (arrêt du serveur). */
export async function closeBackplane(): Promise<void> {
  await Promise.allSettled([pub?.quit(), sub?.quit()]);
  pub = sub = null;
  started = false;
  pubHealth = freshConnHealth();
  subHealth = freshConnHealth();
}
