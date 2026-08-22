/**
 * Balayage périodique des tables ÉPHÉMÈRES : défis d'authentification et sessions
 * expirés. Sans ce ménage, ces tables ne cessent de croître (chaque tentative de
 * connexion laisse un défi, chaque session une ligne). On NE touche PAS
 * `collab_updates` : c'est le journal CRDT (la compaction s'en charge, le purger
 * casserait les rejoins tardifs).
 *
 * Le même balayage porte aussi deux housekeepings supplémentaires (voir plus
 * bas) : la purge des blobs orphelins de la corbeille, et le déclenchement
 * (au sens : signalement) de la rotation planifiée de la clé d'organisation.
 *
 * Best-effort : une erreur de purge ne doit jamais faire tomber le serveur.
 * Démarré depuis `server.ts` uniquement (pas depuis `buildApp`, pour ne pas
 * laisser tourner un timer dans les tests).
 */
import type { FastifyInstance } from "fastify";
import { query } from "../db/pool.js";
import { storage } from "../storage/adapter.js";
import { audit } from "./audit.js";
import { orgRotationPreconditionMet, flagOrgKeyRotationDue } from "../routes/orgs.js";

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 min

async function sweepEphemeralTables(app: FastifyInstance): Promise<void> {
  const statements: [string, string][] = [
    ["login_challenges", `DELETE FROM login_challenges WHERE expires_at < now()`],
    ["webauthn_challenges", `DELETE FROM webauthn_challenges WHERE expires_at < now()`],
    ["webauthn_login_challenges", `DELETE FROM webauthn_login_challenges WHERE expires_at < now()`],
    // Sessions expirées OU révoquées depuis > 7 jours (on garde brièvement les
    // révoquées pour l'auditabilité, puis on nettoie).
    [
      "sessions",
      `DELETE FROM sessions WHERE expires_at < now() OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')`,
    ],
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

// ============================================================================
// Purge des blobs orphelins (corbeille au-delà de la fenêtre de rétention)
//
// Un blob peut devenir orphelin quand un upload est interrompu en cours de
// route ou qu'un crash laisse une écriture node_versions partielle/incohérente
// avec ce qui a réellement été stocké côté storage (voir PUT /:id/content dans
// routes/nodes.ts : le blob est écrit AVANT la transaction DB qui l'enregistre
// — un crash entre les deux laisse un blob sans ligne qui le référence).
//
// L'abstraction de storage (fs / S3, voir storage/adapter.ts) n'expose aucun
// moyen bon marché de LISTER tous les blobs existants : un vrai scan "blob sans
// ligne qui le référence" obligerait à parcourir tout le bucket/répertoire, ce
// qui risquerait de supprimer un blob tout juste écrit par un upload encore en
// vol (dont la transaction DB n'a pas encore committé). C'est exactement le
// scénario dangereux à éviter — une purge plus étroite mais sûre vaut mieux
// qu'une purge large mais risquée.
//
// On prend donc l'approche plus étroite : les nœuds explicitement mis à la
// corbeille (trashed_at IS NOT NULL) et qui y sont depuis plus longtemps que la
// fenêtre de rétention ne peuvent PAS être la cible d'un upload en vol (on
// n'upload jamais dans un nœud déjà trashé depuis des jours) — leurs blobs
// (nœud + toutes ses versions) peuvent donc être purgés sans risque, exactement
// comme le fait déjà `DELETE /:id/purge` à la demande. (Le schéma actuel n'a
// pas d'état "échoué/incomplet" distinct sur node_versions ; s'il en apparaît
// un jour, l'ajouter au WHERE ci-dessous suffira.)
const TRASH_BLOB_RETENTION_DAYS = 30;
// Un lot par passage : le sweep tourne toutes les 15 min, il rattrape son
// retard sans jamais verrouiller la table trop longtemps d'un coup.
const TRASH_PURGE_BATCH_LIMIT = 200;

interface TrashedNodeRow {
  id: string;
  org_id: string;
  kind: string;
  content_ref: string | null;
}

async function purgeOrphanedTrashBlobs(app: FastifyInstance): Promise<void> {
  let candidates: TrashedNodeRow[];
  try {
    candidates = await query<TrashedNodeRow>(
      `SELECT id, org_id, kind, content_ref FROM nodes
        WHERE trashed_at IS NOT NULL AND trashed_at < now() - interval '${TRASH_BLOB_RETENTION_DAYS} days'
        ORDER BY trashed_at ASC
        LIMIT ${TRASH_PURGE_BATCH_LIMIT}`,
    );
  } catch (err) {
    app.log.warn({ err }, "housekeeping: sélection des nœuds corbeillés échouée (ignorée)");
    return;
  }

  let purged = 0;
  for (const node of candidates) {
    try {
      const versions = await query<{ content_ref: string }>(
        `SELECT content_ref FROM node_versions WHERE node_id = $1`,
        [node.id],
      );
      const refs = new Set<string>();
      if (node.content_ref) refs.add(node.content_ref);
      for (const v of versions) refs.add(v.content_ref);

      // On supprime la ligne DB (cascade node_versions / node_keys) D'ABORD, et
      // seulement APRÈS on touche le storage — même ordre défensif que
      // `eraseAccount` (lib/account-deletion.ts) : si le process meurt entre les
      // deux, on ne laisse jamais un content_ref pointer vers un blob déjà
      // supprimé (moins grave : un blob orphelin en plus, que ce même sweep
      // rattrapera... sauf qu'ici la ligne est déjà partie — le pire cas est un
      // blob orphelin qui traîne, jamais une référence cassée).
      await query(`DELETE FROM nodes WHERE id = $1`, [node.id]);

      const store = storage();
      for (const ref of refs) await store.delete(ref).catch(() => {});

      await audit(
        node.org_id,
        null,
        "node.purge.auto",
        node.kind,
        node.id,
        { reason: "trash-retention", retentionDays: TRASH_BLOB_RETENTION_DAYS, blobsPurged: refs.size },
        "",
      );
      purged++;
    } catch (err) {
      app.log.warn({ err, node: node.id }, "housekeeping: purge d'un nœud corbeillé échouée (ignorée)");
    }
  }
  if (purged) app.log.debug({ purged }, "housekeeping: purge des blobs orphelins (corbeille)");
}

// ============================================================================
// Rotation planifiée (opt-in) de la clé d'organisation
//
// `organizations.settings.keyRotationDays` (0/absent = désactivé — les orgs
// existantes ne se mettent JAMAIS à tourner toutes seules) déclenche, une fois
// la fenêtre écoulée depuis la dernière rotation, un SIGNALEMENT — pas la
// rotation elle-même.
//
// Pourquoi pas la rotation elle-même : la clé d'organisation est zero-knowledge
// (voir l'en-tête de routes/orgs.ts) — le serveur ne détient JAMAIS la clé
// privée de l'org. Une vraie rotation exige qu'un CLIENT (1) génère une nouvelle
// paire de clés, (2) déchiffre puis re-chiffre le CEK de chaque nœud avec
// l'ANCIENNE clé privée qu'il tient en mémoire, et (3) re-chiffre la nouvelle
// clé privée pour chaque administrateur de recouvrement. Rien de tout cela
// n'est possible depuis une tâche de fond sans utilisateur connecté — c'est un
// invariant cryptographique, pas une limitation qu'on pourrait contourner sans
// faire tenir un secret au serveur (ce qui casserait le modèle zero-knowledge).
//
// Le sweep ne fait donc que ce qui est sûr et possible sans aucune clé :
// vérifier la précondition que l'endpoint manuel exige déjà (tous les
// administrateurs de recouvrement actuels ont une clé publique utilisable) et,
// si elle est remplie, poser un marqueur crypto-free (settings + une entrée
// d'audit) via les fonctions exportées par routes/orgs.ts — les mêmes que
// `POST /:orgId/recovery/rotate-org` utiliserait pour vérifier/appliquer une
// vraie rotation cliente. Si la précondition n'est pas remplie, on journalise
// et on réessaie au prochain passage (on ne fait jamais échouer tout le sweep).
interface RotationCandidateOrg {
  id: string;
  created_at: string;
  settings: { keyRotationDays?: number; keyRotationLastRotatedAt?: string } | null;
}

async function sweepScheduledKeyRotation(app: FastifyInstance): Promise<void> {
  let orgs: RotationCandidateOrg[];
  try {
    orgs = await query<RotationCandidateOrg>(
      `SELECT id, created_at, settings FROM organizations
        WHERE (settings->>'keyRotationDays') ~ '^[0-9]+$'
          AND (settings->>'keyRotationDays')::int > 0`,
    );
  } catch (err) {
    app.log.warn({ err }, "housekeeping: sélection des orgs à vérifier pour rotation échouée (ignorée)");
    return;
  }

  const now = Date.now();
  for (const org of orgs) {
    try {
      const settings = org.settings ?? {};
      const days = Number(settings.keyRotationDays ?? 0);
      if (!Number.isFinite(days) || days <= 0) continue; // désactivé — re-check défensif

      const lastRotatedMs = settings.keyRotationLastRotatedAt
        ? new Date(settings.keyRotationLastRotatedAt).getTime()
        : new Date(org.created_at).getTime();
      const ageMs = now - lastRotatedMs;
      if (!Number.isFinite(lastRotatedMs) || ageMs < days * 24 * 60 * 60 * 1000) continue; // pas encore due

      const ready = await orgRotationPreconditionMet(org.id);
      if (!ready) {
        app.log.warn(
          { org: org.id },
          "housekeeping: rotation de clé due mais un administrateur de recouvrement n'a pas de clé publique — reporté",
        );
        continue; // on retentera au prochain passage
      }

      const justFlagged = await flagOrgKeyRotationDue(org.id);
      if (justFlagged) {
        await audit(org.id, null, "org.recovery.rotation.due", "org", org.id, { keyRotationDays: days }, "");
        app.log.warn({ org: org.id, days }, "housekeeping: rotation de clé signalée comme due (action admin requise)");
      }
    } catch (err) {
      app.log.warn(
        { err, org: org.id },
        "housekeeping: vérification de rotation de clé échouée pour cette org (ignorée)",
      );
    }
  }
}

async function sweepOnce(app: FastifyInstance): Promise<void> {
  await sweepEphemeralTables(app);
  // Chacune de ces étapes journalise et avale ses propres erreurs ; l'appel
  // direct suffit, mais on garde un filet ceinture-bretelles au cas où une
  // erreur inattendue échapperait quand même à la fonction.
  try {
    await purgeOrphanedTrashBlobs(app);
  } catch (err) {
    app.log.warn({ err }, "housekeeping: purge des blobs orphelins échouée (ignorée)");
  }
  try {
    await sweepScheduledKeyRotation(app);
  } catch (err) {
    app.log.warn({ err }, "housekeeping: vérification de rotation de clé échouée (ignorée)");
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

// Exportées pour les tests (server/tests/housekeeping.test.ts) : chaque étape
// se teste indépendamment sans devoir attendre l'intervalle de 15 min.
export { sweepEphemeralTables, purgeOrphanedTrashBlobs, sweepScheduledKeyRotation, TRASH_BLOB_RETENTION_DAYS };
