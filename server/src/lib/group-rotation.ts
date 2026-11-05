import type { PoolClient } from "pg";
import { z } from "zod";
import { badRequest, conflict, forbidden, notFound } from "./errors.js";

const pubkey = z.string().regex(/^04[0-9a-f]{128}$/);
const envelope = z.record(z.string(), z.unknown());
export const groupRotationSchema = z.object({
  expectedGroupPublicHex: pubkey,
  groupPublicHex: pubkey,
  members: z
    .array(z.object({ userId: z.string().uuid(), wrappedGroupPrivate: envelope }))
    .min(1)
    .max(512),
  nodeKeys: z
    .array(z.object({ nodeId: z.string().uuid(), wrappedKey: envelope, keyEpoch: z.number().int().positive() }))
    .max(100000),
});

function exactCoverage(ids: string[], expected: string[], label: string): void {
  const set = new Set(ids);
  if (set.size !== ids.length || set.size !== expected.length || expected.some((id) => !set.has(id))) {
    throw conflict(`La liste ${label} a changé ou est incomplète. Rechargez avant la rotation.`);
  }
}

export async function markRequiredNodeRotations(c: PoolClient, nodeIds: string[]): Promise<string[]> {
  if (!nodeIds.length) return [];
  const { rows } = await c.query<{ id: string }>(
    `WITH RECURSIVE affected AS (
       SELECT id FROM nodes WHERE id = ANY($1::uuid[])
       UNION SELECT n.id FROM nodes n JOIN affected a ON n.parent_id = a.id
     ) UPDATE nodes SET key_rotation_required = true WHERE id IN (SELECT id FROM affected) RETURNING id`,
    [nodeIds],
  );
  return rows.map((n) => n.id);
}

/** Group rewrap preserves access; affected CEKs remain blocked until individually rotated. */
export async function applyGroupKeyRotation(
  c: PoolClient,
  orgId: string,
  groupId: string,
  actorId: string,
  isOwner: boolean,
  b: z.infer<typeof groupRotationSchema>,
  removeUserId?: string,
): Promise<string[]> {
  await c.query(`SELECT id FROM organizations WHERE id = $1 FOR SHARE`, [orgId]);
  const { rows: groups } = await c.query<{ group_public_hex: string }>(
    `SELECT group_public_hex FROM groups WHERE id = $1 AND org_id = $2 FOR UPDATE`,
    [groupId, orgId],
  );
  if (!groups[0]) throw notFound();
  if (groups[0].group_public_hex !== b.expectedGroupPublicHex) throw conflict("La clé d'équipe a changé.");
  if (b.groupPublicHex === b.expectedGroupPublicHex)
    throw badRequest("La rotation nécessite une nouvelle clé d'équipe.");
  const { rows: members } = await c.query<{ user_id: string; is_manager: boolean }>(
    `SELECT user_id, is_manager FROM group_members WHERE group_id = $1 FOR UPDATE`,
    [groupId],
  );
  if (!isOwner && !members.some((m) => m.user_id === actorId && m.is_manager))
    throw forbidden("Seul un gestionnaire de cette équipe peut tourner sa clé.");
  if (removeUserId && !members.some((m) => m.user_id === removeUserId)) throw notFound("Membre d'équipe introuvable.");
  exactCoverage(
    b.members.map((m) => m.userId),
    members.filter((m) => m.user_id !== removeUserId).map((m) => m.user_id),
    "des membres",
  );
  const { rows: keys } = await c.query<{ node_id: string; key_epoch: number }>(
    `SELECT nk.node_id, n.key_epoch FROM node_keys nk JOIN nodes n ON n.id = nk.node_id
       WHERE nk.principal_type = 'group' AND nk.principal_id = $1 AND n.org_id = $2
       ORDER BY nk.node_id FOR UPDATE OF nk, n`,
    [groupId, orgId],
  );
  exactCoverage(
    b.nodeKeys.map((k) => k.nodeId),
    keys.map((k) => k.node_id),
    "des nœuds",
  );
  const epochs = new Map(keys.map((k) => [k.node_id, k.key_epoch]));
  if (b.nodeKeys.some((k) => epochs.get(k.nodeId) !== k.keyEpoch))
    throw conflict("Une clé de nœud a changé pendant la préparation.");
  await c.query(`UPDATE groups SET group_public_hex = $2, rotation_required = false WHERE id = $1`, [
    groupId,
    b.groupPublicHex,
  ]);
  if (removeUserId)
    await c.query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, removeUserId]);
  for (const m of b.members)
    await c.query(`UPDATE group_members SET wrapped_group_private = $3 WHERE group_id = $1 AND user_id = $2`, [
      groupId,
      m.userId,
      JSON.stringify(m.wrappedGroupPrivate),
    ]);
  for (const k of b.nodeKeys)
    await c.query(
      `UPDATE node_keys SET wrapped_key = $3 WHERE node_id = $1 AND principal_type = 'group' AND principal_id = $2`,
      [k.nodeId, groupId, JSON.stringify(k.wrappedKey)],
    );
  return markRequiredNodeRotations(
    c,
    keys.map((k) => k.node_id),
  );
}
