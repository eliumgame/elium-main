/**
 * Roles = the org's RBAC vocabulary. Each organization owns a set of role rows:
 * per-org clones of the system templates (is_system = true) plus any number of
 * custom roles (is_system = false), whose permission set is any subset of the
 * catalog in rbac/permissions.ts. System roles are immutable — the client clones
 * one to obtain an editable copy.
 *
 * Registered with prefix "/api/orgs" (see app.ts), so the routes below resolve
 * to /api/orgs/permission-catalog and /api/orgs/:orgId/roles[...]. Fully
 * authenticated. The static "/permission-catalog" path takes precedence over the
 * parametric "/:orgId/..." routes in Fastify's radix router, so there is no
 * collision.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { authenticate, requireOrgPerm, requireMembership, requireUser } from "../middleware/auth.js";
import { PERMISSIONS, sanitizePermissions } from "../rbac/permissions.js";
import { randomHex } from "../lib/crypto-server.js";
import { badRequest, forbidden, notFound, conflict } from "../lib/errors.js";
import { audit } from "../lib/audit.js";

interface RoleRow {
  id: string;
  key: string;
  name: string;
  description: string;
  color: string;
  is_system: boolean;
  permissions: string[];
}

function roleDto(r: RoleRow) {
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

const ROLE_COLUMNS = `id, key, name, description, color, is_system, permissions`;

/** A fresh custom role key, unique enough within an org (UNIQUE (org_id, key)). */
const newRoleKey = () => `custom-${randomHex(6)}`;

/** Load a role that belongs to THIS org (never a global template, org_id NULL). */
async function loadOrgRole(orgId: string, roleId: string): Promise<RoleRow | null> {
  return queryOne<RoleRow>(
    `SELECT ${ROLE_COLUMNS} FROM roles WHERE id = $1 AND org_id = $2`,
    [roleId, orgId],
  );
}

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  color: z.string().max(32).optional(),
  permissions: z.array(z.string()).max(256),
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  color: z.string().max(32).optional(),
  permissions: z.array(z.string()).max(256).optional(),
});

export default async function roleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // --- Permission catalog (static; any authenticated user) -----------------
  // Lets the client render the role editor. Static path — resolved before the
  // parametric "/:orgId/roles" routes.
  app.get("/permission-catalog", async (req) => {
    requireUser(req);
    return { permissions: PERMISSIONS };
  });

  // --- List an org's roles (system clones + custom) ------------------------
  // Any active member may read the role list (roles are not secret and are
  // needed to render sharing UIs and to attach a role to a node key). Managing
  // roles still requires role.create / role.manage below.
  app.get("/:orgId/roles", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    await requireMembership(req, orgId);

    const rows = await query<RoleRow>(
      `SELECT ${ROLE_COLUMNS} FROM roles WHERE org_id = $1 ORDER BY is_system DESC, name`,
      [orgId],
    );
    return { roles: rows.map(roleDto) };
  });

  // --- Create a custom role ------------------------------------------------
  app.post("/:orgId/roles", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const b = createSchema.parse(req.body);
    await requireOrgPerm(req, orgId, "role.create");
    const user = requireUser(req);

    const permissions = sanitizePermissions(b.permissions);
    const row = await queryOne<RoleRow>(
      `INSERT INTO roles (org_id, key, name, description, color, is_system, permissions)
       VALUES ($1, $2, $3, $4, $5, false, $6)
       RETURNING ${ROLE_COLUMNS}`,
      [orgId, newRoleKey(), b.name, b.description ?? "", b.color ?? "#1d4ed8", permissions],
    );
    if (!row) throw badRequest("Création du rôle impossible.");

    await audit(orgId, user.id, "role.create", "role", row.id, { key: row.key, name: row.name }, req.ip);
    return { role: roleDto(row) };
  });

  // --- Edit a custom role (system roles are immutable) ---------------------
  app.patch("/:orgId/roles/:roleId", async (req) => {
    const { orgId, roleId } = z
      .object({ orgId: z.string().uuid(), roleId: z.string().uuid() })
      .parse(req.params);
    const b = patchSchema.parse(req.body);
    await requireOrgPerm(req, orgId, "role.manage");
    const user = requireUser(req);

    const existing = await loadOrgRole(orgId, roleId);
    if (!existing) throw notFound("Rôle introuvable.");
    if (existing.is_system) {
      throw forbidden("Les rôles système ne sont pas modifiables — clonez-les.");
    }

    const sets: string[] = ["updated_at = now()"];
    const params: unknown[] = [roleId, orgId];
    let i = 3;
    if (b.name !== undefined) {
      sets.push(`name = $${i++}`);
      params.push(b.name);
    }
    if (b.description !== undefined) {
      sets.push(`description = $${i++}`);
      params.push(b.description);
    }
    if (b.color !== undefined) {
      sets.push(`color = $${i++}`);
      params.push(b.color);
    }
    if (b.permissions !== undefined) {
      sets.push(`permissions = $${i++}`);
      params.push(sanitizePermissions(b.permissions));
    }

    const row = await queryOne<RoleRow>(
      `UPDATE roles SET ${sets.join(", ")} WHERE id = $1 AND org_id = $2 RETURNING ${ROLE_COLUMNS}`,
      params,
    );
    if (!row) throw notFound("Rôle introuvable.");

    await audit(orgId, user.id, "role.update", "role", row.id, { key: row.key }, req.ip);
    return { role: roleDto(row) };
  });

  // --- Clone any org role (system or custom) into a new custom role --------
  app.post("/:orgId/roles/:roleId/clone", async (req) => {
    const { orgId, roleId } = z
      .object({ orgId: z.string().uuid(), roleId: z.string().uuid() })
      .parse(req.params);
    await requireOrgPerm(req, orgId, "role.create");
    const user = requireUser(req);

    const src = await loadOrgRole(orgId, roleId);
    if (!src) throw notFound("Rôle introuvable.");

    // Re-sanitize the source permissions so the clone can never inherit a key
    // that has since left the catalog.
    const permissions = sanitizePermissions(src.permissions);
    const row = await queryOne<RoleRow>(
      `INSERT INTO roles (org_id, key, name, description, color, is_system, permissions)
       VALUES ($1, $2, $3, $4, $5, false, $6)
       RETURNING ${ROLE_COLUMNS}`,
      [orgId, newRoleKey(), `${src.name} (copie)`, src.description, src.color, permissions],
    );
    if (!row) throw badRequest("Clonage du rôle impossible.");

    await audit(orgId, user.id, "role.clone", "role", row.id, { from: src.id, fromKey: src.key }, req.ip);
    return { role: roleDto(row) };
  });

  // --- Delete a custom role (only if unreferenced) -------------------------
  app.delete("/:orgId/roles/:roleId", async (req) => {
    const { orgId, roleId } = z
      .object({ orgId: z.string().uuid(), roleId: z.string().uuid() })
      .parse(req.params);
    await requireOrgPerm(req, orgId, "role.manage");
    const user = requireUser(req);

    const existing = await loadOrgRole(orgId, roleId);
    if (!existing) throw notFound("Rôle introuvable.");
    if (existing.is_system) {
      throw forbidden("Les rôles système ne sont pas supprimables — clonez-les.");
    }

    // Refuse deletion while the role is still granted to any principal, whether
    // at the org level (memberships) or on a node ACL (node_keys). Deleting it
    // would leave dangling grants (both columns are ON DELETE RESTRICT anyway).
    const refs = await queryOne<{ membership_count: number; node_key_count: number }>(
      `SELECT
         (SELECT COUNT(*) FROM memberships WHERE role_id = $1) AS membership_count,
         (SELECT COUNT(*) FROM node_keys  WHERE role_id = $1) AS node_key_count`,
      [roleId],
    );
    const memberships = Number(refs?.membership_count ?? 0);
    const nodeKeys = Number(refs?.node_key_count ?? 0);
    if (memberships > 0 || nodeKeys > 0) {
      throw conflict(
        `Rôle encore utilisé (${memberships} membre(s), ${nodeKeys} accès) — réassignez-les avant de supprimer.`,
      );
    }

    await query(`DELETE FROM roles WHERE id = $1 AND org_id = $2`, [roleId, orgId]);
    await audit(orgId, user.id, "role.delete", "role", roleId, { key: existing.key }, req.ip);
    return { ok: true };
  });
}
