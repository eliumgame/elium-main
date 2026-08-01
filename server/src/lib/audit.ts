/** Append an entry to the audit log. Never throws into the request path. */
import { withTx } from "../db/pool.js";
import { auditEntryHash, GENESIS, type AuditFields } from "./audit-chain.js";

// Espace de nom du verrou consultatif transactionnel qui sérialise l'écriture de
// la chaîne PAR ORGANISATION : deux entrées concurrentes de la même org ne
// peuvent pas lire le même prev_hash et forker la chaîne.
const AUDIT_LOCK_NS = 4711;

export async function audit(
  orgId: string | null,
  actorUserId: string | null,
  action: string,
  resourceType = "",
  resourceId: string | null = null,
  metadata: Record<string, unknown> = {},
  ip = "",
): Promise<void> {
  const cleanIp = ip.slice(0, 64);
  try {
    await withTx(async (c) => {
      // Sérialise la chaîne de cette org (org_id NULL → clé "").
      await c.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [AUDIT_LOCK_NS, orgId ?? ""]);
      const prev = await c.query<{ entry_hash: Buffer | null }>(
        `SELECT entry_hash FROM audit_log
          WHERE org_id IS NOT DISTINCT FROM $1
          ORDER BY id DESC LIMIT 1`,
        [orgId],
      );
      const prevHash = prev.rows[0]?.entry_hash ?? GENESIS;
      const createdAt = new Date().toISOString();
      const fields: AuditFields = {
        orgId, actorUserId, action, resourceType, resourceId, metadata, ip: cleanIp, createdAt,
      };
      const entryHash = auditEntryHash(prevHash, fields);
      await c.query(
        `INSERT INTO audit_log (org_id, actor_user_id, action, resource_type, resource_id, metadata, ip, created_at, prev_hash, entry_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [orgId, actorUserId, action, resourceType, resourceId, JSON.stringify(metadata), cleanIp, createdAt, prevHash, entryHash],
      );
    });
  } catch {
    // Auditing must never break the operation it records.
  }
}
