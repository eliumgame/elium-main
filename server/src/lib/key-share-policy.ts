import type { PoolClient } from "pg";
import { config } from "../config.js";
import { badRequest, conflict, notFound } from "./errors.js";
import { clientOutdated } from "./content-preconditions.js";

type Share = { principalType: string; principalId: string; groupPublicHex?: string };

/**
 * Lock before node writes so a rotation sees every share committed under its key.
 *
 * Compatibilité transitoire (LEGACY_CLIENT_COMPAT) : un ancien client n'envoie ni
 * `orgKeyEpoch` ni `groupPublicHex`. En mode compat on retient alors l'état
 * COURANT lu sous verrou (le refus `rotation_required` reste appliqué) ; sinon
 * 428 `client_outdated`. Retourne `legacy: true` si une valeur a été déduite,
 * pour que la route pose l'en-tête de dépréciation.
 */
export async function assertFreshPrincipalKeys(
  c: PoolClient, orgId: string, shares: Share[], orgKeyEpoch?: number,
  legacyCompat: boolean = config.legacyClientCompat,
): Promise<{ legacy: boolean }> {
  let legacy = false;
  const orgShares = shares.filter(s => s.principalType === "org");
  const groupShares = shares.filter(s => s.principalType === "group");
  if (!orgShares.length && !groupShares.length) return { legacy };
  if (orgShares.some(s => s.principalId !== orgId)) throw badRequest("Part de recouvrement étrangère à l'organisation.");
  const { rows: orgs } = await c.query<{ org_key_epoch: number; rotation_required: boolean }>(
    `SELECT org_key_epoch, (settings->>'orgKeyRotationRequired')::boolean AS rotation_required
       FROM organizations WHERE id = $1 FOR SHARE`, [orgId],
  );
  if (!orgs[0]) throw notFound();
  if (orgShares.length) {
    if (orgKeyEpoch === undefined) {
      if (!legacyCompat) throw clientOutdated(428);
      legacy = true;
      orgKeyEpoch = orgs[0].org_key_epoch; // époque courante lue sous verrou
    }
    if (orgs[0].org_key_epoch !== orgKeyEpoch || orgs[0].rotation_required) throw conflict("La clé d'organisation doit être actualisée ou tournée avant ce partage.");
  }
  // Sorted locking prevents deadlocks between writers sharing to several groups.
  for (const share of [...groupShares].sort((a,b) => a.principalId.localeCompare(b.principalId))) {
    if (!share.groupPublicHex && !legacyCompat) throw clientOutdated(428);
    const { rows } = await c.query<{ group_public_hex: string; rotation_required: boolean }>(
      `SELECT group_public_hex, rotation_required FROM groups WHERE id = $1 AND org_id = $2 FOR SHARE`, [share.principalId, orgId],
    );
    if (!rows[0]) throw badRequest("Équipe étrangère à l'organisation.");
    const expected = share.groupPublicHex ?? rows[0].group_public_hex;
    if (!share.groupPublicHex) legacy = true;
    if (rows[0].group_public_hex !== expected || rows[0].rotation_required) {
      throw conflict("La clé d'équipe a changé ou doit être tournée avant ce partage.");
    }
  }
  return { legacy };
}
