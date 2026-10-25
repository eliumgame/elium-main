/**
 * Groups / teams = cryptographic principals. A group owns its own P-256 keypair;
 * sharing a node to a group wraps the node CEK to `group_public_hex`, and the
 * group's private key is wrapped to each member (group_members.wrapped_group_private)
 * so members can unwrap it locally. The server only stores opaque wrapped material
 * and enforces org-level authorization — it never sees a private key.
 *
 * Mounted under the /api/orgs prefix (see app.ts).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, queryOne, withTx } from "../db/pool.js";
import { authenticate, requireUser, requireOrgPerm, requireMembership } from "../middleware/auth.js";
import { badRequest, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { kickUser } from "../collab/relay.js";

const envelope = z.record(z.string(), z.unknown()); // recipients envelope (opaque JSON)

const memberInputSchema = z.object({
  userId: z.string().uuid(),
  wrappedGroupPrivate: envelope,
  isManager: z.boolean().default(false),
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  color: z.string().max(24).optional(),
  groupPublicHex: z.string().regex(/^[0-9a-f]{130}$/), // uncompressed P-256 point
  members: z.array(memberInputSchema).min(1).max(512),
});

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  wrappedGroupPrivate: envelope,
  isManager: z.boolean().default(false),
});

/** Load the group and assert it belongs to the given org (else 404). */
async function loadGroupInOrg(groupId: string, orgId: string) {
  const g = await queryOne<{
    id: string;
    org_id: string;
    name: string;
    description: string;
    color: string;
    group_public_hex: string;
    created_at: string;
  }>(`SELECT * FROM groups WHERE id = $1 AND org_id = $2`, [groupId, orgId]);
  if (!g) throw notFound();
  return g;
}

function groupDto(g: Record<string, unknown>, memberCount?: number) {
  return {
    id: g.id,
    name: g.name,
    description: g.description,
    color: g.color,
    groupPublicHex: g.group_public_hex,
    ...(memberCount !== undefined ? { memberCount } : {}),
  };
}

export default async function groupRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // --- MES équipes + ma clé d'équipe enveloppée (tout membre actif) ---------
  // Sans cela, un membre sans `group.view` (rôle « Éditeur ») ne pouvait pas déchiffrer ce qu'on partage
  // avec son équipe : la clé de l'élément est enveloppée pour l'ÉQUIPE, dont la clé privée n'est
  // enveloppée que pour ses membres. On ne renvoie QUE les équipes dont l'appelant fait partie.
  app.get("/:orgId/my-groups", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    await requireMembership(req, orgId);
    const user = requireUser(req);
    const rows = await query<{ id: string; name: string; group_public_hex: string; wrapped_group_private: unknown }>(
      `SELECT g.id, g.name, g.group_public_hex, gm.wrapped_group_private
         FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE gm.user_id = $1 AND g.org_id = $2
        ORDER BY g.name`,
      [user.id, orgId],
    );
    return {
      groups: rows.map((r) => ({
        id: r.id,
        name: r.name,
        groupPublicHex: r.group_public_hex,
        wrappedGroupPrivate: r.wrapped_group_private,
      })),
    };
  });

  // --- Clés PUBLIQUES des équipes (tout membre actif) -------------------------
  // Pour qu'un membre qui crée un élément dans un dossier partagé avec une équipe puisse aussi
  // envelopper la clé de l'élément pour cette équipe (rien de secret : clés publiques seulement).
  app.get("/:orgId/group-keys", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    await requireMembership(req, orgId);
    const rows = await query<{ id: string; group_public_hex: string }>(
      `SELECT id, group_public_hex FROM groups WHERE org_id = $1`,
      [orgId],
    );
    return { groups: rows.map((r) => ({ id: r.id, groupPublicHex: r.group_public_hex })) };
  });

  // --- List groups of the org ----------------------------------------------
  app.get("/:orgId/groups", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    await requireOrgPerm(req, orgId, "group.view");

    const rows = await query(
      `SELECT g.id, g.name, g.description, g.color, g.group_public_hex,
              COUNT(gm.user_id)::int AS member_count
         FROM groups g
         LEFT JOIN group_members gm ON gm.group_id = g.id
        WHERE g.org_id = $1
        GROUP BY g.id
        ORDER BY g.name`,
      [orgId],
    );

    return {
      groups: rows.map((r) => groupDto(r, (r.member_count as number) ?? 0)),
    };
  });

  // --- Create a group (with its initial members) ---------------------------
  app.post("/:orgId/groups", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    await requireOrgPerm(req, orgId, "group.create");
    const b = createSchema.parse(req.body);
    const user = requireUser(req);

    // The creator SHOULD keep an unwrapping key for the group they create; we
    // do not hard-fail if absent, but flag it so the client can surface a warning.
    const creatorIncluded = b.members.some((m) => m.userId === user.id);

    // Every member must be an active member of this org (a group is org-scoped).
    const userIds = [...new Set(b.members.map((m) => m.userId))];
    const valid = await query<{ user_id: string }>(
      `SELECT user_id FROM memberships WHERE org_id = $1 AND user_id = ANY($2::uuid[]) AND status = 'active'`,
      [orgId, userIds],
    );
    const validSet = new Set(valid.map((v) => v.user_id));
    for (const id of userIds) {
      if (!validSet.has(id)) throw badRequest("Un membre du groupe n'appartient pas à cette organisation.");
    }

    const result = await withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO groups (org_id, name, description, color, group_public_hex)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [orgId, b.name, b.description, b.color ?? "#0ea5e9", b.groupPublicHex],
      );
      const group = rows[0];
      const members: Array<{ user_id: string; is_manager: boolean; added_at: string }> = [];
      for (const m of b.members) {
        const { rows: mrows } = await c.query(
          `INSERT INTO group_members (group_id, user_id, wrapped_group_private, is_manager)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (group_id, user_id)
           DO UPDATE SET wrapped_group_private = EXCLUDED.wrapped_group_private,
                         is_manager = EXCLUDED.is_manager
           RETURNING user_id, is_manager, added_at`,
          [group.id, m.userId, JSON.stringify(m.wrappedGroupPrivate), m.isManager],
        );
        members.push(mrows[0]);
      }
      return { group, members };
    });

    await audit(orgId, user.id, "group.create", "group", result.group.id as string, { creatorIncluded }, req.ip);

    return {
      group: groupDto(result.group, result.members.length),
      members: result.members.map((m) => ({
        userId: m.user_id,
        isManager: m.is_manager,
        addedAt: m.added_at,
      })),
      creatorIncluded,
    };
  });

  // --- Get one group (with member identities) ------------------------------
  app.get("/:orgId/groups/:groupId", async (req) => {
    const { orgId, groupId } = z.object({ orgId: z.string().uuid(), groupId: z.string().uuid() }).parse(req.params);
    await requireOrgPerm(req, orgId, "group.view");
    const user = requireUser(req);
    const group = await loadGroupInOrg(groupId, orgId);

    // The caller's own wrapped group private key, so a manager can unwrap it
    // locally to re-wrap it for a new member (adding members client-side).
    const mine = await queryOne<{ wrapped_group_private: unknown }>(
      `SELECT wrapped_group_private FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, user.id],
    );

    const members = await query<{
      user_id: string;
      email: string;
      display_name: string;
      p256_public_hex: string;
      is_manager: boolean;
      added_at: string;
    }>(
      `SELECT gm.user_id, u.email, u.display_name, u.p256_public_hex, gm.is_manager, gm.added_at
         FROM group_members gm
         JOIN users u ON u.id = gm.user_id
        WHERE gm.group_id = $1
        ORDER BY u.display_name, u.email`,
      [groupId],
    );

    return {
      group: groupDto(group, members.length),
      myWrappedGroupPrivate: mine?.wrapped_group_private ?? null,
      members: members.map((m) => ({
        userId: m.user_id,
        email: m.email,
        displayName: m.display_name,
        p256PublicHex: m.p256_public_hex,
        isManager: m.is_manager,
        addedAt: m.added_at,
      })),
    };
  });

  // --- Add / update a member (upsert) --------------------------------------
  app.post("/:orgId/groups/:groupId/members", async (req) => {
    const { orgId, groupId } = z.object({ orgId: z.string().uuid(), groupId: z.string().uuid() }).parse(req.params);
    await requireOrgPerm(req, orgId, "group.manage");
    const b = addMemberSchema.parse(req.body);
    const user = requireUser(req);

    await loadGroupInOrg(groupId, orgId);

    // The member must belong to this organization.
    const member = await queryOne(
      `SELECT user_id FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [orgId, b.userId],
    );
    if (!member) throw badRequest("Cet utilisateur n'appartient pas à cette organisation.");

    const row = await queryOne<{ user_id: string; is_manager: boolean; added_at: string }>(
      `INSERT INTO group_members (group_id, user_id, wrapped_group_private, is_manager)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (group_id, user_id)
       DO UPDATE SET wrapped_group_private = EXCLUDED.wrapped_group_private,
                     is_manager = EXCLUDED.is_manager
       RETURNING user_id, is_manager, added_at`,
      [groupId, b.userId, JSON.stringify(b.wrappedGroupPrivate), b.isManager],
    );

    await audit(orgId, user.id, "group.member.add", "group", groupId, { userId: b.userId }, req.ip);

    return {
      member: {
        userId: row!.user_id,
        isManager: row!.is_manager,
        addedAt: row!.added_at,
      },
    };
  });

  // --- Remove a member -----------------------------------------------------
  app.delete("/:orgId/groups/:groupId/members/:userId", async (req) => {
    const { orgId, groupId, userId } = z
      .object({ orgId: z.string().uuid(), groupId: z.string().uuid(), userId: z.string().uuid() })
      .parse(req.params);
    await requireOrgPerm(req, orgId, "group.manage");
    const user = requireUser(req);

    await loadGroupInOrg(groupId, orgId);

    await query(`DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`, [groupId, userId]);
    // Un retrait de groupe peut retirer l'accès à des nœuds : coupe ses connexions
    // temps réel plutôt que de les laisser vivre jusqu'à déconnexion naturelle.
    kickUser(userId, "group-member-removed");

    await audit(orgId, user.id, "group.member.remove", "group", groupId, { userId }, req.ip);

    return { ok: true };
  });

  // --- Delete a group (members cascade) ------------------------------------
  app.delete("/:orgId/groups/:groupId", async (req) => {
    const { orgId, groupId } = z.object({ orgId: z.string().uuid(), groupId: z.string().uuid() }).parse(req.params);
    await requireOrgPerm(req, orgId, "group.manage");
    const user = requireUser(req);

    await loadGroupInOrg(groupId, orgId);

    const members = await query<{ user_id: string }>(`SELECT user_id FROM group_members WHERE group_id = $1`, [
      groupId,
    ]);
    await query(`DELETE FROM groups WHERE id = $1 AND org_id = $2`, [groupId, orgId]);
    for (const m of members) kickUser(m.user_id, "group-deleted");

    await audit(orgId, user.id, "group.delete", "group", groupId, {}, req.ip);

    return { ok: true };
  });
}
