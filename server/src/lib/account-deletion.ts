/**
 * RGPD/GDPR account erasure.
 *
 * Erasing a user must satisfy the schema's two RESTRICT foreign keys
 * (organizations.owner_user_id, nodes.owner_user_id) and the polymorphic,
 * FK-less node_keys.principal_id — while preserving the tamper-evident audit
 * chain (audit_log.actor_user_id is hashed, so nulling it on existing rows would
 * break verifyAuditChain).
 *
 * Approach: instead of a physical row DELETE (which would SET NULL every past
 * audit actor reference and break the chain), the user row is kept as an
 * ANONYMIZED TOMBSTONE — all personal data + key material is wiped, the account
 * is disabled (status='deleted'), and only the opaque id survives so audit
 * references stay valid. Under GDPR this is erasure/anonymization: the remaining
 * id can no longer be linked to a person. All content the user could decrypt is
 * removed (node_keys) or transferred; every credential/session is deleted.
 *
 * Preconditions that BLOCK erasure (the caller must resolve them first):
 *  - owning an organization that still has other members → transfer ownership;
 *  - being the SOLE recovery admin of a surviving org → promote another admin.
 * Solo organizations owned by the user (no other members) are deleted outright.
 */
import type { PoolClient } from "pg";
import { withTx } from "../db/pool.js";
import { storage } from "../storage/adapter.js";

export interface DeletionBlockers {
  ownedOrgsWithMembers: { id: string; name: string }[];
  soleRecoveryAdminOrgs: { id: string; name: string }[];
}

export class AccountDeletionBlocked extends Error {
  constructor(readonly blockers: DeletionBlockers) {
    super("La suppression du compte est bloquée par des dépendances d'organisation.");
    this.name = "AccountDeletionBlocked";
  }
}

/** Read the blockers that would prevent erasing this user (empty arrays = OK). */
export async function accountDeletionBlockers(userId: string): Promise<DeletionBlockers> {
  return withTx(async (c) => readBlockers(c, userId));
}

async function readBlockers(c: PoolClient, userId: string): Promise<DeletionBlockers> {
  const owned = await c.query<{ id: string; name: string }>(
    `SELECT o.id, o.name FROM organizations o
      WHERE o.owner_user_id = $1
        AND EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.user_id <> $1)`,
    [userId],
  );
  const soleRec = await c.query<{ id: string; name: string }>(
    `SELECT o.id, o.name FROM organizations o
       JOIN org_recovery_keys k ON k.org_id = o.id AND k.admin_user_id = $1
      WHERE (SELECT count(*) FROM org_recovery_keys k2 WHERE k2.org_id = o.id) = 1
        -- a solo org owned by this user is going to be deleted anyway
        AND NOT (o.owner_user_id = $1
                 AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.user_id <> $1))`,
    [userId],
  );
  return { ownedOrgsWithMembers: owned.rows, soleRecoveryAdminOrgs: soleRec.rows };
}

export interface ErasureResult {
  deletedOrgs: number;
  transferredNodes: number;
}

/**
 * Erase the account. Throws AccountDeletionBlocked if a precondition fails.
 * Everything runs in one transaction; blob purge is best-effort afterwards.
 */
export async function eraseAccount(userId: string): Promise<ErasureResult> {
  const refsToPurge: string[] = [];
  let deletedOrgs = 0;
  let transferredNodes = 0;

  await withTx(async (c) => {
    // Re-check preconditions inside the tx (avoid TOCTOU).
    const blockers = await readBlockers(c, userId);
    if (blockers.ownedOrgsWithMembers.length || blockers.soleRecoveryAdminOrgs.length) {
      throw new AccountDeletionBlocked(blockers);
    }

    // 1) Solo-owned orgs (no other members) → delete outright (cascades nodes,
    //    node_keys, memberships, groups, share links, invites, audit, …). Gather
    //    blob refs first so they can be purged after commit.
    const soloOrgs = await c.query<{ id: string }>(
      `SELECT o.id FROM organizations o
        WHERE o.owner_user_id = $1
          AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.org_id = o.id AND m.user_id <> $1)`,
      [userId],
    );
    for (const org of soloOrgs.rows) {
      const refs = await c.query<{ content_ref: string | null }>(
        `SELECT content_ref FROM nodes WHERE org_id = $1 AND content_ref IS NOT NULL
         UNION ALL
         SELECT v.content_ref FROM node_versions v JOIN nodes n ON n.id = v.node_id WHERE n.org_id = $1`,
        [org.id],
      );
      for (const r of refs.rows) if (r.content_ref) refsToPurge.push(r.content_ref);
      await c.query(`DELETE FROM organizations WHERE id = $1`, [org.id]);
      deletedOrgs++;
    }

    // 2) Transfer nodes the user owns in SURVIVING orgs to that org's owner
    //    (who can decrypt via the org recovery key — the CEK is wrapped to the
    //    org principal on every node).
    const t = await c.query(
      `UPDATE nodes n SET owner_user_id = o.owner_user_id, modified_at = now()
         FROM organizations o
        WHERE n.org_id = o.id AND n.owner_user_id = $1 AND o.owner_user_id <> $1`,
      [userId],
    );
    transferredNodes = t.rowCount ?? 0;

    // 3) The user's polymorphic crypto-ACL rows (no FK) — remove explicitly.
    await c.query(`DELETE FROM node_keys WHERE principal_type = 'user' AND principal_id = $1`, [userId]);

    // 4) SCIM group membership is keyed by email — purge before anonymizing it.
    await c.query(`DELETE FROM scim_group_members gm USING users u WHERE gm.email = u.email AND u.id = $1`, [userId]);

    // 5) Credentials / sessions / memberships (kept-tombstone ⇒ no cascade).
    await c.query(`DELETE FROM sessions WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM login_challenges WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM mfa_backup_codes WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM webauthn_credentials WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM webauthn_challenges WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM group_members WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM org_recovery_keys WHERE admin_user_id = $1`, [userId]);
    await c.query(`DELETE FROM memberships WHERE user_id = $1`, [userId]);

    // 6) Anonymized tombstone: wipe PII + key material, disable the account, keep
    //    the opaque id so the tamper-evident audit chain stays valid.
    await c.query(
      `UPDATE users SET
         email = 'deleted-' || id || '@erased.invalid',
         display_name = '',
         ed25519_public_hex = '', p256_public_hex = '', fingerprint = '',
         auth_sign_public_hex = NULL, auth_verifier = NULL, auth_salt = NULL,
         kdf_salt = '', kdf_params = '{}'::jsonb, key_bundle = '{}'::jsonb,
         sso_subject = NULL,
         mfa_enabled = false, mfa_secret_enc = NULL, mfa_secret_nonce = NULL,
         mfa_pending_enc = NULL, mfa_pending_nonce = NULL,
         status = 'deleted', updated_at = now()
       WHERE id = $1`,
      [userId],
    );
  });

  // 7) Best-effort blob purge (outside the tx; object storage isn't FK-tracked).
  for (const ref of refsToPurge) {
    try {
      await storage().delete(ref);
    } catch {
      /* best effort — a leftover blob is harmless (unreadable ciphertext) */
    }
  }

  return { deletedOrgs, transferredNodes };
}
