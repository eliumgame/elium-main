import type { PoolClient } from "pg";
import { ApiError, badRequest, conflict, notFound } from "./errors.js";

type Share = { principalType: string; principalId: string; groupPublicHex?: string };

/** Lock before node writes so a rotation sees every share committed under its key. */
export async function assertFreshPrincipalKeys(c: PoolClient, orgId: string, shares: Share[], orgKeyEpoch?: number): Promise<void> {
  const orgShares = shares.filter(s => s.principalType === "org");
  const groupShares = shares.filter(s => s.principalType === "group");
  if (!orgShares.length && !groupShares.length) return;
  if (orgShares.some(s => s.principalId !== orgId)) throw badRequest("Part de recouvrement étrangère à l'organisation.");
  const { rows: orgs } = await c.query<{ org_key_epoch: number; rotation_required: boolean }>(
    `SELECT org_key_epoch, (settings->>'orgKeyRotationRequired')::boolean AS rotation_required
       FROM organizations WHERE id = $1 FOR SHARE`, [orgId],
  );
  if (!orgs[0]) throw notFound();
  if (orgShares.length) {
    if (orgKeyEpoch === undefined) throw new ApiError(428, "precondition_required", "L'époque de la clé d'organisation est requise.");
    if (orgs[0].org_key_epoch !== orgKeyEpoch || orgs[0].rotation_required) throw conflict("La clé d'organisation doit être actualisée ou tournée avant ce partage.");
  }
  // Sorted locking prevents deadlocks between writers sharing to several groups.
  for (const share of [...groupShares].sort((a,b) => a.principalId.localeCompare(b.principalId))) {
    if (!share.groupPublicHex) throw new ApiError(428, "precondition_required", "La clé publique d'équipe utilisée est requise.");
    const { rows } = await c.query<{ group_public_hex: string; rotation_required: boolean }>(
      `SELECT group_public_hex, rotation_required FROM groups WHERE id = $1 AND org_id = $2 FOR SHARE`, [share.principalId, orgId],
    );
    if (!rows[0]) throw badRequest("Équipe étrangère à l'organisation.");
    if (rows[0].group_public_hex !== share.groupPublicHex || rows[0].rotation_required) {
      throw conflict("La clé d'équipe a changé ou doit être tournée avant ce partage.");
    }
  }
}
