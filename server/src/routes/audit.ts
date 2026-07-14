/**
 * Audit log reader. The audit_log table is append-only (written via lib/audit.ts)
 * and stores authorization metadata only — never plaintext content. This module
 * exposes a paginated, permission-gated view of an org's entries.
 *
 * Registered with prefix "/api/orgs" (see app.ts), so the route below resolves
 * to GET /api/orgs/:orgId/audit. Fully authenticated.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query } from "../db/pool.js";
import { authenticate, requireOrgPerm } from "../middleware/auth.js";

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  // audit_log.id is BIGSERIAL; pool.ts parses int8 to a JS number. Cursor is the
  // smallest id already seen — return rows strictly older (id < beforeId).
  beforeId: z.coerce.number().int().positive().optional(),
});

interface AuditRow {
  id: number;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: unknown;
  ip: string;
  created_at: string;
  actor_email: string | null;
  actor_display_name: string | null;
}

function auditDto(r: AuditRow) {
  return {
    id: r.id,
    actorUserId: r.actor_user_id,
    actorEmail: r.actor_email,
    actorDisplayName: r.actor_display_name ?? null,
    action: r.action,
    resourceType: r.resource_type,
    resourceId: r.resource_id,
    metadata: r.metadata ?? {},
    ip: r.ip,
    createdAt: r.created_at,
  };
}

export default async function auditRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // --- Read the org's audit log (newest first, cursor-paginated) -----------
  app.get("/:orgId/audit", async (req) => {
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.params);
    const q = listQuerySchema.parse(req.query);
    await requireOrgPerm(req, orgId, "audit.view");

    const rows = await query<AuditRow>(
      `SELECT a.id, a.actor_user_id, a.action, a.resource_type, a.resource_id,
              a.metadata, a.ip, a.created_at,
              u.email AS actor_email, u.display_name AS actor_display_name
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.org_id = $1
          AND ($2::bigint IS NULL OR a.id < $2::bigint)
        ORDER BY a.id DESC
        LIMIT $3`,
      [orgId, q.beforeId ?? null, q.limit],
    );

    // More pages exist iff we filled the page; the next cursor is the oldest id.
    const last = rows[rows.length - 1];
    const nextBeforeId = rows.length === q.limit && last ? last.id : null;

    return { entries: rows.map(auditDto), nextBeforeId };
  });
}
