/**
 * Organizations — creation, membership, invitations, settings, and enterprise
 * RECOVERY. Mounted under /api/orgs. Fully authenticated.
 *
 * Zero-knowledge model reminders:
 *  - The org has its own recovery keypair. `org_public_hex` is stored in the
 *    clear; the org PRIVATE key is only ever stored WRAPPED to an admin's P-256
 *    key (org_recovery_keys.wrapped_org_private). The server never holds it.
 *  - Wrapping/unwrapping happens entirely client-side; the server treats every
 *    `wrapped_*` envelope as an opaque JSON blob.
 *  - Roles are cloned per-org from SYSTEM_ROLE_TEMPLATES so each org can tweak
 *    them; the org owner bypasses permission checks (see rbac/engine.ts).
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, queryOne, withTx } from "../db/pool.js";
import { authenticate, requireUser, requireOrgPerm } from "../middleware/auth.js";
import { SYSTEM_ROLE_TEMPLATES } from "../rbac/roles.js";
import { sha256Hex, randomToken } from "../lib/crypto-server.js";
import { badRequest, notFound, conflict } from "../lib/errors.js";
import { audit } from "../lib/audit.js";

const hex = (len?: number) => (len ? z.string().regex(new RegExp(`^[0-9a-f]{${len}}$`)) : z.string().regex(/^[0-9a-f]+$/));
const envelope = z.record(z.unknown()); // recipients envelope (opaque JSON)

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const createSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, "Slug invalide (minuscules, chiffres, tirets)."),
  orgPublicHex: hex(130),
  wrappedOrgPrivate: envelope,
});

/** Validate a role belongs to this org (or is a global template). Throws 400. */
async function validateRole(roleId: string, orgId: string): Promise<void> {
  const r = await queryOne(`SELECT id FROM roles WHERE id = $1 AND (org_id = $2 OR org_id IS NULL)`, [roleId, orgId]);
  if (!r) throw badRequest("Rôle invalide pour cette organisation.");
}

function orgDto(o: Record<string, unknown>) {
  return {
    id: o.id,
    name: o.name,
    slug: o.slug,
    orgPublicHex: o.org_public_hex,
    settings: o.settings ?? {},
    storageQuotaBytes: o.storage_quota_bytes ?? null,
  };
}

function roleDto(r: Record<string, unknown>) {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    color: r.color,
    isSystem: r.is_system,
    permissions: r.permissions ?? [],
  };
}

export default async function orgRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // --- Create an organization ----------------------------------------------
  app.post("/", async (req) => {
    const b = createSchema.parse(req.body);
    const user = requireUser(req);

    const existing = await queryOne(`SELECT id FROM organizations WHERE slug = $1`, [b.slug]);
    if (existing) throw conflict("Ce slug d'organisation est déjà utilisé.");

    const result = await withTx(async (c) => {
      // 1) Organization.
      const { rows: orgRows } = await c.query(
        `INSERT INTO organizations (name, slug, owner_user_id, org_public_hex)
         VALUES ($1,$2,$3,$4)
         RETURNING *`,
        [b.name, b.slug, user.id, b.orgPublicHex],
      );
      const org = orgRows[0];

      // 2) Clone every system role template into this org.
      const roles: Record<string, unknown>[] = [];
      let ownerRoleId: string | null = null;
      for (const t of SYSTEM_ROLE_TEMPLATES) {
        const { rows: rRows } = await c.query(
          `INSERT INTO roles (org_id, key, name, description, color, is_system, permissions)
           VALUES ($1,$2,$3,$4,$5,true,$6)
           RETURNING *`,
          [org.id, t.key, t.name, t.description, t.color, [...t.permissions]],
        );
        const role = rRows[0];
        roles.push(role);
        if (t.key === "owner") ownerRoleId = role.id as string;
      }
      if (!ownerRoleId) throw badRequest("Modèle de rôle « owner » introuvable.");

      // 3) Creator membership with the owner role.
      await c.query(
        `INSERT INTO memberships (org_id, user_id, role_id, status)
         VALUES ($1,$2,$3,'active')`,
        [org.id, user.id, ownerRoleId],
      );

      // 4) Org recovery key wrapped to the creator (first admin).
      await c.query(
        `INSERT INTO org_recovery_keys (org_id, admin_user_id, wrapped_org_private)
         VALUES ($1,$2,$3)`,
        [org.id, user.id, JSON.stringify(b.wrappedOrgPrivate)],
      );

      return { org, roles };
    });

    await audit(result.org.id as string, user.id, "org.create", "org", result.org.id as string, { slug: b.slug }, req.ip);
    return {
      org: orgDto(result.org),
      roles: result.roles.map(roleDto),
      membershipRoleKey: "owner",
    };
  });

  // --- List orgs the current user is an active member of --------------------
  app.get("/", async (req) => {
    const user = requireUser(req);
    const rows = await query(
      `SELECT o.id, o.name, o.slug, o.org_public_hex, o.settings, r.id AS role_id, r.key AS role_key
         FROM memberships m
         JOIN organizations o ON o.id = m.org_id
         JOIN roles r ON r.id = m.role_id
        WHERE m.user_id = $1 AND m.status = 'active'
        ORDER BY o.name`,
      [user.id],
    );
    return {
      organizations: rows.map((o) => ({ ...orgDto(o), roleId: o.role_id, roleKey: o.role_key })),
    };
  });

  // --- Org details for a member --------------------------------------------
  app.get("/:orgId", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    // org.settings.view is a member-level read gate; the owner bypasses it.
    const ctx = await requireOrgPerm(req, orgId, "org.settings.view");
    const org = await queryOne(`SELECT * FROM organizations WHERE id = $1`, [orgId]);
    if (!org) throw notFound();
    return {
      org: orgDto(org),
      role: { id: ctx.roleId, key: ctx.roleKey, permissions: [...ctx.permissions] },
      isOwner: ctx.isOwner,
    };
  });

  // --- List members ---------------------------------------------------------
  app.get("/:orgId/members", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    await requireOrgPerm(req, orgId, "member.view");
    const rows = await query(
      `SELECT u.id AS user_id, u.email, u.display_name, u.p256_public_hex, u.ed25519_public_hex,
              u.fingerprint, m.role_id, r.key AS role_key, m.status, m.joined_at
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         JOIN roles r ON r.id = m.role_id
        WHERE m.org_id = $1
        ORDER BY u.display_name, u.email`,
      [orgId],
    );
    return {
      members: rows.map((m) => ({
        userId: m.user_id,
        email: m.email,
        displayName: m.display_name,
        p256PublicHex: m.p256_public_hex,
        ed25519PublicHex: m.ed25519_public_hex,
        fingerprint: m.fingerprint,
        roleId: m.role_id,
        roleKey: m.role_key,
        status: m.status,
        joinedAt: m.joined_at,
      })),
    };
  });

  // --- Create an invitation -------------------------------------------------
  app.post("/:orgId/invites", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const b = z.object({ email: z.string().email().max(320), roleId: z.string().uuid() }).parse(req.body);
    const user = requireUser(req);
    await requireOrgPerm(req, orgId, "member.invite");
    await validateRole(b.roleId, orgId);

    const token = randomToken(32);
    const tokenHash = sha256Hex(token);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    const invite = await queryOne<{ id: string }>(
      `INSERT INTO invites (org_id, email, role_id, token_hash, invited_by, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [orgId, b.email, b.roleId, tokenHash, user.id, expiresAt],
    );
    if (!invite) throw badRequest("Création de l'invitation impossible.");

    await audit(orgId, user.id, "member.invite", "invite", invite.id, { email: b.email, roleId: b.roleId }, req.ip);
    return { token, expiresAt };
  });

  // --- Accept an invitation (as the current authenticated user) -------------
  app.post("/invites/accept", async (req) => {
    const { token } = z.object({ token: z.string().min(10) }).parse(req.body);
    const user = requireUser(req);
    const tokenHash = sha256Hex(token);

    const accepted = await withTx(async (c) => {
      const { rows } = await c.query(
        `SELECT id, org_id, role_id, expires_at, accepted_at
           FROM invites
          WHERE token_hash = $1
          FOR UPDATE`,
        [tokenHash],
      );
      const invite = rows[0];
      if (!invite || invite.accepted_at || new Date(invite.expires_at).getTime() < Date.now()) {
        throw badRequest("Invitation invalide, expirée ou déjà utilisée.");
      }

      // Membership for the current user with the invite's role.
      const { rows: memRows } = await c.query(
        `INSERT INTO memberships (org_id, user_id, role_id, status)
         VALUES ($1,$2,$3,'active')
         ON CONFLICT (org_id, user_id)
         DO UPDATE SET role_id = EXCLUDED.role_id, status = 'active'
         RETURNING org_id, role_id`,
        [invite.org_id, user.id, invite.role_id],
      );
      await c.query(`UPDATE invites SET accepted_at = now() WHERE id = $1`, [invite.id]);
      return memRows[0];
    });

    await audit(accepted.org_id as string, user.id, "member.invite.accept", "membership", null, {}, req.ip);
    return { orgId: accepted.org_id, roleId: accepted.role_id };
  });

  // --- Change a member's org role -------------------------------------------
  app.patch("/:orgId/members/:userId", async (req) => {
    const { orgId, userId } = z.object({ orgId: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
    const b = z.object({ roleId: z.string().uuid() }).parse(req.body);
    const actor = requireUser(req);
    await requireOrgPerm(req, orgId, "member.role.assign");
    await validateRole(b.roleId, orgId);

    const updated = await queryOne(
      `UPDATE memberships SET role_id = $3 WHERE org_id = $1 AND user_id = $2 RETURNING id, role_id`,
      [orgId, userId, b.roleId],
    );
    if (!updated) throw notFound("Membre introuvable dans cette organisation.");

    await audit(orgId, actor.id, "member.role.assign", "membership", updated.id as string, { userId, roleId: b.roleId }, req.ip);
    return { userId, roleId: updated.role_id };
  });

  // --- Remove a member ------------------------------------------------------
  app.delete("/:orgId/members/:userId", async (req) => {
    const { orgId, userId } = z.object({ orgId: z.string().uuid(), userId: z.string().uuid() }).parse(req.params);
    const actor = requireUser(req);
    await requireOrgPerm(req, orgId, "member.remove");

    const org = await queryOne<{ owner_user_id: string }>(`SELECT owner_user_id FROM organizations WHERE id = $1`, [orgId]);
    if (!org) throw notFound();
    if (org.owner_user_id === userId) throw conflict("Le propriétaire de l'organisation ne peut pas être retiré.");

    const removed = await queryOne(
      `DELETE FROM memberships WHERE org_id = $1 AND user_id = $2 RETURNING id`,
      [orgId, userId],
    );
    if (!removed) throw notFound("Membre introuvable dans cette organisation.");

    await audit(orgId, actor.id, "member.remove", "membership", removed.id as string, { userId }, req.ip);
    return { ok: true };
  });

  // --- Storage: usage + quota ----------------------------------------------
  app.get("/:orgId/usage", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    await requireOrgPerm(req, orgId, "org.settings.view");
    const row = await queryOne<{ quota: number | null; used: string; files: string }>(
      `SELECT o.storage_quota_bytes AS quota,
              COALESCE(SUM(v.size_bytes), 0) AS used,
              COUNT(v.id) AS files
         FROM organizations o
         LEFT JOIN nodes n ON n.org_id = o.id
         LEFT JOIN node_versions v ON v.node_id = n.id
        WHERE o.id = $1
        GROUP BY o.storage_quota_bytes`,
      [orgId],
    );
    if (!row) throw notFound();
    return {
      usedBytes: Number(row.used ?? 0),
      quotaBytes: row.quota ?? null,
      versionCount: Number(row.files ?? 0),
    };
  });

  // --- Storage: set the org quota (null = unlimited) ------------------------
  app.patch("/:orgId/quota", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const b = z.object({ quotaBytes: z.number().int().nonnegative().nullable() }).parse(req.body);
    const actor = requireUser(req);
    await requireOrgPerm(req, orgId, "storage.quota.manage");
    const org = await queryOne<{ storage_quota_bytes: number | null }>(
      `UPDATE organizations SET storage_quota_bytes = $2, updated_at = now() WHERE id = $1
       RETURNING storage_quota_bytes`,
      [orgId, b.quotaBytes],
    );
    if (!org) throw notFound();
    await audit(orgId, actor.id, "org.quota.update", "org", orgId, { quotaBytes: b.quotaBytes }, req.ip);
    return { quotaBytes: org.storage_quota_bytes ?? null };
  });

  // --- Settings: view -------------------------------------------------------
  app.get("/:orgId/settings", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    await requireOrgPerm(req, orgId, "org.settings.view");
    const org = await queryOne<{ settings: unknown }>(`SELECT settings FROM organizations WHERE id = $1`, [orgId]);
    if (!org) throw notFound();
    return { settings: org.settings ?? {} };
  });

  // --- Settings: manage -----------------------------------------------------
  app.patch("/:orgId/settings", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const b = z.object({ settings: z.record(z.unknown()) }).parse(req.body);
    const actor = requireUser(req);
    await requireOrgPerm(req, orgId, "org.settings.manage");

    const org = await queryOne<{ settings: unknown }>(
      `UPDATE organizations SET settings = $2, updated_at = now() WHERE id = $1 RETURNING settings`,
      [orgId, JSON.stringify(b.settings)],
    );
    if (!org) throw notFound();
    await audit(orgId, actor.id, "org.settings.update", "org", orgId, {}, req.ip);
    return { settings: org.settings ?? {} };
  });

  // --- Recovery: fetch this admin's wrapped org private key -----------------
  app.get("/:orgId/recovery-key", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const user = requireUser(req);
    await requireOrgPerm(req, orgId, "recovery.perform");

    const row = await queryOne<{ wrapped_org_private: unknown }>(
      `SELECT wrapped_org_private FROM org_recovery_keys WHERE org_id = $1 AND admin_user_id = $2`,
      [orgId, user.id],
    );
    if (!row) throw notFound("Aucune clé de recouvrement pour cet administrateur.");
    return { wrappedOrgPrivate: row.wrapped_org_private };
  });

  // --- Recovery: register/re-wrap the org private key to another admin ------
  app.post("/:orgId/recovery/admins", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const b = z.object({ adminUserId: z.string().uuid(), wrappedOrgPrivate: envelope }).parse(req.body);
    const actor = requireUser(req);
    await requireOrgPerm(req, orgId, "org.settings.manage");

    // The target must be an active member of this org.
    const member = await queryOne(
      `SELECT 1 FROM memberships WHERE org_id = $1 AND user_id = $2 AND status = 'active'`,
      [orgId, b.adminUserId],
    );
    if (!member) throw badRequest("L'administrateur cible n'est pas membre actif de l'organisation.");

    await query(
      `INSERT INTO org_recovery_keys (org_id, admin_user_id, wrapped_org_private)
       VALUES ($1,$2,$3)
       ON CONFLICT (org_id, admin_user_id)
       DO UPDATE SET wrapped_org_private = EXCLUDED.wrapped_org_private`,
      [orgId, b.adminUserId, JSON.stringify(b.wrappedOrgPrivate)],
    );
    await audit(orgId, actor.id, "recovery.admin.grant", "org", orgId, { adminUserId: b.adminUserId }, req.ip);
    return { ok: true };
  });

  // --- Recovery: grant a node's key to a user (restore departed access) -----
  app.post("/:orgId/recovery/grant", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        nodeId: z.string().uuid(),
        targetUserId: z.string().uuid(),
        roleId: z.string().uuid(),
        wrappedKey: envelope,
      })
      .parse(req.body);
    const actor = requireUser(req);
    await requireOrgPerm(req, orgId, "recovery.perform");
    await validateRole(b.roleId, orgId);

    // The node must belong to this org (don't let recovery cross org boundaries).
    const node = await queryOne<{ org_id: string }>(`SELECT org_id FROM nodes WHERE id = $1`, [b.nodeId]);
    if (!node || node.org_id !== orgId) throw notFound("Nœud introuvable dans cette organisation.");

    await query(
      `INSERT INTO node_keys (node_id, principal_type, principal_id, role_id, wrapped_key, granted_by)
       VALUES ($1,'user',$2,$3,$4,$5)
       ON CONFLICT (node_id, principal_type, principal_id)
       DO UPDATE SET role_id = EXCLUDED.role_id, wrapped_key = EXCLUDED.wrapped_key, granted_by = EXCLUDED.granted_by`,
      [b.nodeId, b.targetUserId, b.roleId, JSON.stringify(b.wrappedKey), actor.id],
    );
    await audit(orgId, actor.id, "recovery.grant", "node", b.nodeId, { targetUserId: b.targetUserId, roleId: b.roleId }, req.ip);
    return { ok: true };
  });
}
