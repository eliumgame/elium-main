/**
 * Enterprise org-key RECOVERY — the client-side cryptography for wielding the
 * organization recovery key. This is the org's most sensitive secret, so the
 * design is deliberately conservative:
 *
 *  - The org PRIVATE key never touches the server. It is stored only WRAPPED to
 *    each recovery admin's P-256 key (`org_recovery_keys.wrapped_org_private`),
 *    an opaque recipients envelope the server treats as a blob.
 *  - To use it, the current admin unwraps it from THEIR keypair inside a single
 *    scoped operation (`withOrgKey`), and the raw scalar is zeroized the moment
 *    the operation finishes. JS strings cannot be wiped, so the scalar is kept
 *    as bytes as long as possible and the hex form is confined to that scope.
 *    (The threat model — DOCUMENTATION §8 — already excludes a compromised
 *    endpoint / RAM scraping; this is defense in depth, not a new guarantee.)
 *  - All wrapping/unwrapping reuses the audited multi-recipient primitive
 *    (crypto/recipients.ts) exactly as org creation and node sharing do — no new
 *    crypto is invented here. The org private key is a P-256 scalar, so it wraps
 *    and unwraps with the very same envelope format as a node CEK.
 *
 * Two operations, mirroring the two server endpoints:
 *  - promoteRecoveryAdmin → re-wrap the org private key to another admin so they
 *    can recover too (POST /orgs/:id/recovery/admins).
 *  - restoreNodeAccess → recover a node's CEK from its org key-share and re-wrap
 *    it to a target member (POST /orgs/:id/recovery/grant).
 */
import type { DriveApi } from "./api";
import type { RecipientKeypair } from "../crypto/recipients";
import { decryptAsRecipient } from "../crypto/recipients";
import { wrapNodeKeyFor, unwrapNodeKey, decryptName, type WrappedKey } from "./node-crypto";
import { toHex, fromHex } from "../format/canonical";

const enc = new TextEncoder();

/** Best-effort overwrite of sensitive byte buffers (defense in depth). */
export function wipe(...bufs: (Uint8Array | null | undefined)[]): void {
  for (const b of bufs) if (b) b.fill(0);
}

export interface RecoveryContext {
  api: DriveApi;
  orgId: string;
  /** The org's PUBLIC key (hex) — pairs with the unwrapped private scalar. */
  orgPublicHex: string;
  /** The CURRENT admin's recipient keypair (from the session; in memory only). */
  adminKeys: RecipientKeypair;
}

/**
 * Unwrap the org private key for the current admin, run `fn` with the org
 * keypair, then guarantee the private material is dropped. The org keypair MUST
 * NOT escape `fn` — treat it as valid only for the duration of the callback.
 */
export async function withOrgKey<T>(ctx: RecoveryContext, fn: (orgKp: RecipientKeypair) => Promise<T>): Promise<T> {
  const { wrappedOrgPrivate } = await ctx.api.getRecoveryKey(ctx.orgId);
  const envelope = enc.encode(JSON.stringify(wrappedOrgPrivate));
  const privBytes = await decryptAsRecipient(envelope, ctx.adminKeys); // 32-byte P-256 scalar
  const orgKp: RecipientKeypair = { privateHex: toHex(privBytes), publicHex: ctx.orgPublicHex };
  try {
    return await fn(orgKp);
  } finally {
    wipe(privBytes);
    orgKp.privateHex = ""; // drop the reference (best-effort; string bytes linger until GC)
  }
}

/** Re-wrap the org private key to another admin so they can perform recovery. */
export async function promoteRecoveryAdmin(
  ctx: RecoveryContext,
  target: { userId: string; publicHex: string },
): Promise<void> {
  await withOrgKey(ctx, async (orgKp) => {
    const privBytes = fromHex(orgKp.privateHex);
    try {
      const wrappedOrgPrivate = await wrapNodeKeyFor(privBytes, target.publicHex);
      await ctx.api.addRecoveryAdmin(ctx.orgId, { adminUserId: target.userId, wrappedOrgPrivate });
    } finally {
      wipe(privBytes);
    }
  });
}

/**
 * Restore a member's cryptographic access to a node using the org key. The
 * node's CEK is recovered from its org key-share (`orgWrappedKey`), then
 * re-wrapped to the target member under the given role.
 */
export async function restoreNodeAccess(
  ctx: RecoveryContext,
  params: {
    nodeId: string;
    orgWrappedKey: WrappedKey;
    targetUserId: string;
    targetPublicHex: string;
    roleId: string;
  },
): Promise<void> {
  await withOrgKey(ctx, async (orgKp) => {
    const cek = await unwrapNodeKey(params.orgWrappedKey, orgKp);
    try {
      const wrappedKey = await wrapNodeKeyFor(cek, params.targetPublicHex);
      await ctx.api.recoveryGrant(ctx.orgId, {
        nodeId: params.nodeId,
        targetUserId: params.targetUserId,
        roleId: params.roleId,
        wrappedKey,
      });
    } finally {
      wipe(cek);
    }
  });
}

/**
 * Decrypt the (encrypted) names of recovery nodes using the org key, in a single
 * scoped unwrap. Returns a map nodeId → clear name; nodes whose CEK or name
 * can't be decrypted are simply omitted. The org key is dropped before return.
 */
export async function decryptRecoveryNodeNames(
  ctx: RecoveryContext,
  nodes: { id: string; nameEncrypted: string; nameNonce: string; orgWrappedKey: WrappedKey }[],
): Promise<Map<string, string>> {
  return withOrgKey(ctx, async (orgKp) => {
    const names = new Map<string, string>();
    for (const n of nodes) {
      let cek: Uint8Array | null = null;
      try {
        cek = await unwrapNodeKey(n.orgWrappedKey, orgKp);
        names.set(n.id, await decryptName(cek, n.nameEncrypted, n.nameNonce));
      } catch {
        /* a node with no decryptable org share — skip it */
      } finally {
        wipe(cek);
      }
    }
    return names;
  });
}
