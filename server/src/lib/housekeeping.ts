/**
 * Balayage périodique des tables ÉPHÉMÈRES : défis d'authentification et sessions
 * expirés. Sans ce ménage, ces tables ne cessent de croître (chaque tentative de
 * connexion laisse un défi, chaque session une ligne). On NE touche PAS
 * `collab_updates` : c'est le journal CRDT (la compaction s'en charge, le purger
 * casserait les rejoins tardifs).
 *
 * Best-effort : une erreur de purge ne doit jamais faire tomber le serveur.
 * Démarré depuis `server.ts` uniquement (pas depuis `buildApp`, pour ne pas
 * laisser tourner un timer dans les tests).
 */
import type { FastifyInstance } from "fastify";
import { query } from "../db/pool.js";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 min

async function sweepOnce(app: FastifyInstance): Promise<void> {
  const statements: [string, string][] = [
    ["login_challenges", `DELETE FROM login_challenges WHERE expires_at < now()`],
    ["webauthn_challenges", `DELETE FROM webauthn_challenges WHERE expires_at < now()`],
    ["webauthn_login_challenges", `DELETE FROM webauthn_login_challenges WHERE expires_at < now()`],
    // Sessions expirées OU révoquées depuis > 7 jours (on garde brièvement les
    // révoquées pour l'auditabilité, puis on nettoie).
    ["sessions", `DELETE FROM sessions WHERE expires_at < now() OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`],
    // Invitations expirées non consommées.
    ["invites", `DELETE FROM invites WHERE expires_at < now() AND accepted_at IS NULL`],
  ];
  for (const [label, sql] of statements) {
    try {
      const rows = await query(sql);
      if (rows.length) app.log.debug({ table: label, purged: rows.length }, "housekeeping: purge");
    } catch (err) {
      // Une table absente (schéma partiel) ou une erreur transitoire ne doit pas
      // interrompre les autres purges ni le serveur.
      app.log.warn({ err, table: label }, "housekeeping: purge échouée (ignorée)");
    }
  }
}

/** Démarre le balayage périodique ; renvoie une fonction d'arrêt. */
export function startHousekeeping(app: FastifyInstance): () => void {
  // Premier passage décalé (laisse le boot se stabiliser), puis toutes les 15 min.
  const timer = setInterval(() => void sweepOnce(app), SWEEP_INTERVAL_MS);
  // `unref` : ce timer ne doit pas empêcher le process de se terminer.
  timer.unref?.();
  return () => clearInterval(timer);
}
