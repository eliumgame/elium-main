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
 */
import { randomUUID } from "node:crypto";
import Redis from "ioredis";
import { config } from "../config.js";

export type RelayMsg =
  | { k: "bcast"; nodeId: string; message: unknown }
  | { k: "kick"; nodeId: string; reason: string }
  | { k: "org"; orgId: string };

const CHANNEL = "elium:relay";
const ORIGIN = randomUUID();

let pub: Redis | null = null;
let sub: Redis | null = null;
let started = false;

function makeClient(): Redis {
  // maxRetriesPerRequest: null → ne rejette pas les commandes pendant une
  // coupure (ioredis rejoue à la reconnexion) ; on avale les erreurs.
  const c = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: false });
  c.on("error", () => {
    /* transitoire : ne pas crasher le process */
  });
  return c;
}

/** Démarre le backplane (idempotent). `handler` reçoit les messages DISTANTS. */
export function initBackplane(handler: (m: RelayMsg) => void): void {
  if (started || !config.redisUrl) return;
  started = true;
  pub = makeClient();
  sub = makeClient();
  void sub.subscribe(CHANNEL).catch(() => {
    /* réabonnement auto d'ioredis */
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
  void pub.publish(CHANNEL, JSON.stringify({ origin: ORIGIN, msg })).catch(() => {
    /* best-effort */
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
}
