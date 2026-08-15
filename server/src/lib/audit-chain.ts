/**
 * Intégrité chaînée du journal d'audit (append-only, tamper-evident).
 *
 * Chaque entrée porte `entry_hash = SHA-256(prev_hash || champs canoniques)`, où
 * `prev_hash` est l'`entry_hash` de l'entrée précédente de la MÊME chaîne (une
 * chaîne par organisation ; `org_id NULL` = chaîne système). Conséquence :
 *   • altérer un champ d'une entrée change son `entry_hash` → cassure ;
 *   • supprimer une entrée casse le maillon `prev_hash` de la suivante ;
 *   • réordonner casse la chaîne.
 * `verifyAuditChain` rejoue la chaîne et signale le premier maillon rompu. Le
 * serveur ne peut pas empêcher un DBA d'écrire dans la table, mais il rend toute
 * écriture hors-flux DÉTECTABLE — c'est l'objectif d'un journal à intégrité.
 */
import { createHash } from "node:crypto";
import { query } from "../db/pool.js";

/** Racine de chaîne (aucune entrée précédente) : 32 octets à zéro. */
export const GENESIS = Buffer.alloc(32);

/** Sérialisation stable (clés triées récursivement) pour hacher les métadonnées. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export interface AuditFields {
  orgId: string | null;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  metadata: unknown;
  ip: string;
  createdAt: string; // ISO 8601 (UTC)
}

/** `entry_hash` d'une entrée à partir du hash précédent et de ses champs. */
export function auditEntryHash(prevHash: Buffer, f: AuditFields): Buffer {
  const payload = JSON.stringify([
    prevHash.toString("hex"),
    f.orgId ?? "",
    f.actorUserId ?? "",
    f.action,
    f.resourceType,
    f.resourceId ?? "",
    stableStringify(f.metadata ?? {}),
    f.ip,
    f.createdAt,
  ]);
  return createHash("sha256").update(payload).digest();
}

export interface AuditVerifyResult {
  ok: boolean;
  total: number; // entrées totales dans la chaîne
  hashed: number; // entrées effectivement chaînées (les anciennes peuvent être sans hash)
  brokenAtId?: string; // id de la première entrée dont le maillon est rompu
}

interface AuditRow {
  id: string;
  org_id: string | null;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata: unknown;
  ip: string;
  created_at: Date;
  prev_hash: Buffer | null;
  entry_hash: Buffer | null;
}

/**
 * Rejoue la chaîne d'une organisation (org_id NULL = chaîne système) et vérifie
 * chaque maillon. Les entrées héritées SANS hash (antérieures à la
 * fonctionnalité) sont comptées mais non vérifiées ; la vérification porte sur la
 * queue chaînée. Rend `ok:false` + l'id du premier maillon rompu sinon.
 */
export async function verifyAuditChain(orgId: string | null): Promise<AuditVerifyResult> {
  const rows = await query<AuditRow>(
    `SELECT id, org_id, actor_user_id, action, resource_type, resource_id, metadata, ip, created_at, prev_hash, entry_hash
       FROM audit_log
      WHERE org_id IS NOT DISTINCT FROM $1
      ORDER BY id ASC`,
    [orgId],
  );
  let hashed = 0;
  let expectedPrev: Buffer = GENESIS;
  let started = false;
  for (const r of rows) {
    if (r.entry_hash == null) {
      // Entrée héritée non chaînée : on ne vérifie pas, et elle ne fixe pas le
      // maillon (la chaîne démarre à la première entrée hachée, dont prev = GENESIS).
      continue;
    }
    hashed++;
    const prev = Buffer.from(r.prev_hash ?? GENESIS);
    const entryHash = Buffer.from(r.entry_hash);
    const fields: AuditFields = {
      orgId: r.org_id,
      actorUserId: r.actor_user_id,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      metadata: r.metadata,
      ip: r.ip,
      createdAt: new Date(r.created_at).toISOString(),
    };
    const recomputed = auditEntryHash(prev, fields);
    const prevOk = !started ? prev.equals(GENESIS) : prev.equals(expectedPrev);
    if (!prevOk || !recomputed.equals(entryHash)) {
      return { ok: false, total: rows.length, hashed, brokenAtId: r.id };
    }
    expectedPrev = entryHash;
    started = true;
  }
  return { ok: true, total: rows.length, hashed };
}
