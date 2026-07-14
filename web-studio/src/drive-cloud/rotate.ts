/**
 * Key rotation on revocation (Phase 2 hardening). Revoking a share removes the
 * AUTHORIZATION, but a principal who once held the node key (CEK) may have
 * cached it — the server cannot take a key back. Rotation makes that cached key
 * worthless: a fresh CEK re-encrypts the name, metadata, current content, every
 * historical version blob and the collaboration log, and is re-wrapped to the
 * REMAINING principals only. Active share links are revoked by the server
 * (their wrapped keys hold the old CEK; envelopes carry only fingerprints, so
 * they cannot be re-wrapped).
 *
 * Everything here is client-driven: in the zero-knowledge model the server
 * never sees a CEK, so only a member holding the current key can rotate.
 *
 * Crash resilience: the old CEK travels encrypted UNDER the new CEK
 * (`prevKeyWrapped` on the node). If a rotation is interrupted after the ACL
 * swap but before every blob is re-encrypted, any current key holder can
 * finish the job (`catchUpStaleVersions`) — the revoked principal never
 * obtains the new CEK, so the slot discloses nothing to them.
 */
import * as Y from "yjs";
import type { OpsCtx, DriveEntry } from "./ops";
import { listFolder, nodeKeyFrom } from "./ops";
import {
  generateNodeKey,
  wrapNodeKeyFor,
  encryptName,
  encryptMeta,
  decryptMeta,
  encryptContent,
  decryptContent,
} from "./node-crypto";
import type { KeyShareInput, ShareInfo, VersionInfo } from "./types";
import { toHex, fromHex } from "../format/canonical";

export interface RotationStats {
  rotated: number;
  skipped: number;
  revokedLinks: number;
}

export type RotationProgress = (label: string, stats: RotationStats) => void;

/** Resolve the P-256 public key a share's principal wraps to. */
async function principalPublicKey(
  ctx: OpsCtx,
  share: ShareInfo,
  groupsCache: { current: { id: string; groupPublicHex: string }[] | null },
): Promise<string | null> {
  try {
    if (share.principalType === "user") return (await ctx.api.getUser(share.principalId)).user.p256PublicHex;
    if (share.principalType === "group") {
      groupsCache.current ??=
        ((await ctx.api.listGroups(ctx.orgId)).groups as { id: string; groupPublicHex: string }[]) ?? [];
      return groupsCache.current.find((g) => g.id === share.principalId)?.groupPublicHex ?? null;
    }
    return ctx.orgPublicHex || null;
  } catch {
    return null;
  }
}

/**
 * Finish a previously interrupted rotation: re-encrypt version blobs whose
 * epoch lags the node's, using the prev-key slot to read them. Returns the
 * number of versions brought up to date.
 */
export async function catchUpStaleVersions(ctx: OpsCtx, entry: DriveEntry, currentKey: Uint8Array): Promise<number> {
  if (entry.kind !== "file" || !entry.prevKeyWrapped || !entry.prevKeyNonce) return 0;
  const epoch = entry.keyEpoch ?? 1;
  const { versions } = (await ctx.api.listVersions(entry.id)) as unknown as { versions: VersionInfo[] };
  const stale = versions.filter((v) => v.keyEpoch < epoch);
  if (!stale.length) return 0;
  const prevKey = await decryptContent(currentKey, entry.prevKeyNonce, fromHex(entry.prevKeyWrapped));
  let fixed = 0;
  for (const v of stale) {
    try {
      const { bytes, nonceHex } = await ctx.api.getVersionContent(entry.id, v.id);
      const plain = await decryptContent(prevKey, nonceHex, bytes);
      const enc = await encryptContent(currentKey, plain);
      await ctx.api.putVersionContent(entry.id, v.id, enc.ciphertext, enc.nonceHex);
      fixed++;
    } catch {
      /* a version we cannot read (older epoch than the prev slot) stays as-is */
    }
  }
  return fixed;
}

/**
 * Rotate one node's CEK: new key, new crypto-ACL (current principals only —
 * call AFTER revoking), re-encrypted name/meta/content/versions/collab log.
 */
export async function rotateNode(ctx: OpsCtx, entry: DriveEntry): Promise<{ ok: boolean; revokedLinks: number }> {
  const oldKey = await nodeKeyFrom(ctx, entry.myWrappedKey);
  if (!oldKey) return { ok: false, revokedLinks: 0 }; // cannot rotate what we cannot decrypt

  // Level any stragglers from an interrupted previous rotation first, so no
  // version ever ends up more than one epoch behind the prev-key slot.
  await catchUpStaleVersions(ctx, entry, oldKey).catch(() => 0);

  const newKey = generateNodeKey();

  // 1. Wrap the fresh CEK to every REMAINING principal of the node.
  const { shares } = (await ctx.api.listShares(entry.id)) as unknown as { shares: ShareInfo[] };
  const groupsCache = { current: null as { id: string; groupPublicHex: string }[] | null };
  const keyShares: KeyShareInput[] = [];
  for (const s of shares) {
    const pub = await principalPublicKey(ctx, s, groupsCache);
    if (!pub) continue;
    keyShares.push({
      principalType: s.principalType,
      principalId: s.principalId,
      roleId: s.roleId,
      wrappedKey: await wrapNodeKeyFor(newKey, pub),
      inheritedFrom: s.inheritedFrom ?? null,
    });
  }

  // 2. Name, metadata and the prev-key slot under the new key.
  const encNameV = await encryptName(newKey, entry.name);
  let metaFields: { metaEncrypted?: string; metaNonce?: string } = {};
  if (entry.metaEncrypted && entry.metaNonce) {
    const meta = await decryptMeta(oldKey, entry.metaEncrypted, entry.metaNonce);
    const m = await encryptMeta(newKey, meta);
    metaFields = { metaEncrypted: m.nameEncrypted, metaNonce: m.nameNonce };
  }
  const prevSlot = await encryptContent(newKey, oldKey);

  // 3. Atomic ACL swap + epoch bump + link revocation (server-side).
  const { node, revokedLinks } = await ctx.api.rotateNode(entry.id, {
    nameEncrypted: encNameV.nameEncrypted,
    nameNonce: encNameV.nameNonce,
    ...metaFields,
    prevKeyWrapped: toHex(prevSlot.ciphertext),
    prevKeyNonce: prevSlot.nonceHex,
    ...(entry.keyEpoch !== undefined ? { expectedEpoch: entry.keyEpoch } : {}),
    keyShares,
  });

  if (entry.kind === "file") {
    // 4. Re-encrypt every version blob still on an older epoch (this includes
    //    the current content — it is just the version the node points at).
    const newEpoch = node.keyEpoch ?? Number.MAX_SAFE_INTEGER;
    const { versions } = (await ctx.api.listVersions(entry.id)) as unknown as { versions: VersionInfo[] };
    for (const v of versions) {
      if (v.keyEpoch >= newEpoch) continue;
      const { bytes, nonceHex } = await ctx.api.getVersionContent(entry.id, v.id);
      const plain = await decryptContent(oldKey, nonceHex, bytes);
      const enc = await encryptContent(newKey, plain);
      await ctx.api.putVersionContent(entry.id, v.id, enc.ciphertext, enc.nonceHex);
    }

    // 5. Collab log → ONE snapshot under the new key; the relay then kicks the
    //    room so every peer reconnects and re-fetches its wrapped key.
    if (entry.appKind?.startsWith("collab-")) {
      const { updates } = await ctx.api.getCollabUpdates(entry.id, 0);
      if (updates.length) {
        const doc = new Y.Doc();
        for (const u of updates) {
          try {
            Y.applyUpdate(doc, await decryptContent(oldKey, u.nonce, fromHex(u.ciphertext)));
          } catch {
            /* an update from a newer key (already compacted) — skip */
          }
        }
        const snapshot = Y.encodeStateAsUpdate(doc);
        doc.destroy();
        const encSnap = await encryptContent(newKey, snapshot);
        await ctx.api.compactCollab(entry.id, toHex(encSnap.ciphertext), encSnap.nonceHex);
      }
    }
  }

  return { ok: true, revokedLinks };
}

/**
 * Rotate a whole subtree (folder + every decryptable descendant, trash
 * included). Skips nodes the caller cannot decrypt — those keep their key and
 * are reported in `skipped`.
 */
export async function rotateTree(ctx: OpsCtx, entry: DriveEntry, onProgress?: RotationProgress): Promise<RotationStats> {
  const stats: RotationStats = { rotated: 0, skipped: 0, revokedLinks: 0 };
  try {
    const res = await rotateNode(ctx, entry);
    if (res.ok) {
      stats.rotated++;
      stats.revokedLinks += res.revokedLinks;
    } else {
      stats.skipped++;
    }
  } catch {
    stats.skipped++;
  }
  onProgress?.(entry.name, stats);

  if (entry.kind === "folder") {
    const children = [
      ...(await listFolder(ctx, entry.id).catch(() => [] as DriveEntry[]))
      , ...(await listFolder(ctx, entry.id, true).catch(() => [] as DriveEntry[]))
    ];
    for (const child of children) {
      const sub = await rotateTree(ctx, child, onProgress);
      stats.rotated += sub.rotated;
      stats.skipped += sub.skipped;
      stats.revokedLinks += sub.revokedLinks;
    }
  }
  return stats;
}

/**
 * The complete revocation: drop the principal's authorization (deep on
 * folders), then rotate the subtree's keys so any CEK they cached is dead.
 */
export async function revokeShareWithRotation(
  ctx: OpsCtx,
  entry: DriveEntry,
  shareId: string,
  onProgress?: RotationProgress,
): Promise<RotationStats> {
  await ctx.api.revokeShare(entry.id, shareId, true);
  return rotateTree(ctx, entry, onProgress);
}
