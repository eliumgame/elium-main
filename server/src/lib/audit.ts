/** Append an entry to the audit log. Never throws into the request path. */
import { query } from "../db/pool.js";

export async function audit(
  orgId: string | null,
  actorUserId: string | null,
  action: string,
  resourceType = "",
  resourceId: string | null = null,
  metadata: Record<string, unknown> = {},
  ip = "",
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (org_id, actor_user_id, action, resource_type, resource_id, metadata, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [orgId, actorUserId, action, resourceType, resourceId, JSON.stringify(metadata), ip.slice(0, 64)],
    );
  } catch {
    // Auditing must never break the operation it records.
  }
}
