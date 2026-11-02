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
 * finish the job (`repairInterruptedRotation`, run when the file is opened, and
 * at the start of the next rotation) — the revoked principal never obtains the
 * new CEK, so the slot discloses nothing to them. Readers also fall back on
 * the prev-key slot meanwhile (`decryptNodeContent`, collab channel).
 *
 * Safety rules (audit lot B):
 *   - every REMAINING principal must get the new CEK, or the rotation is
 *     refused before the ACL swap (the server replaces the whole crypto-ACL);
 *   - the collab log is compacted with every known key (new, current,
 *     previous) and only its fully-integrated prefix is ever deleted.
 */
import * as Y from "yjs";
import type { OpsCtx, DriveEntry } from "./ops";
import { listFolder, nodeKeyFrom } from "./ops";
import { readAllCollabUpdates } from "./collab";
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
import { makePrincipalResolver, type PrincipalKeyResolver } from "./principal-keys";
import { toHex, fromHex } from "../format/canonical";

export interface RotationStats {
  rotated: number;
  /** Nœuds que l'on ne peut pas déchiffrer : ils gardent leur clé (rien n'a été modifié). */
  skipped: number;
  revokedLinks: number;
  /**
   * Rotations refusées pour ne rien perdre (part d'un ayant droit non ré-emballable, versions en
   * retard, erreur réseau) ou COMMENCÉES mais pas terminées (ACL et époque déjà basculées, versions ou
   * journal collab pas encore ré-chiffrés). À relancer : `repairInterruptedRotation` (fait à
   * l'ouverture du fichier) ou une nouvelle révocation termine le travail.
   */
  incomplete: number;
}

export type RotationProgress = (label: string, stats: RotationStats) => void;

/**
 * Une part de clé RESTANTE (autre que celle du principal révoqué) n'a pas pu être ré-emballée : la
 * rotation est refusée AVANT toute bascule, sinon le serveur remplacerait l'ACL sans cette part et
 * l'ayant droit (souvent une équipe entière) perdrait son accès en silence.
 */
export class RotationIncomplete extends Error {
  constructor(readonly missing: string[]) {
    super(`Rotation refusée : impossible de ré-emballer la clé pour ${missing.join(", ")}.`);
    this.name = "RotationIncomplete";
  }
}

/** Ré-emballe la nouvelle CEK pour CHAQUE principal restant, ou lève `RotationIncomplete`. */
export async function wrapForRemainingPrincipals(
  shares: ShareInfo[],
  newKey: Uint8Array,
  resolver: PrincipalKeyResolver,
): Promise<KeyShareInput[]> {
  const keyShares: KeyShareInput[] = [];
  const missing: string[] = [];
  for (const s of shares) {
    let pub: string | null = null;
    try {
      pub = await resolver.resolve(s);
    } catch {
      pub = null;
    }
    if (!pub) {
      missing.push(`${s.principalType}:${s.principalId}`);
      continue;
    }
    keyShares.push({
      principalType: s.principalType,
      principalId: s.principalId,
      roleId: s.roleId,
      wrappedKey: await wrapNodeKeyFor(newKey, pub),
      inheritedFrom: s.inheritedFrom ?? null,
    });
  }
  if (missing.length) throw new RotationIncomplete(missing);
  return keyShares;
}

/** Déchiffre avec la première clé qui convient ; renvoie aussi l'indice de la clé utilisée. */
export async function decryptWithAny(
  keys: Uint8Array[],
  nonce: string,
  ct: Uint8Array,
): Promise<{ plain: Uint8Array; keyIndex: number } | null> {
  for (let i = 0; i < keys.length; i++) {
    try {
      return { plain: await decryptContent(keys[i]!, nonce, ct), keyIndex: i };
    } catch {
      /* clé suivante */
    }
  }
  return null;
}

/**
 * Compacte le journal collab en UN instantané chiffré sous `newKey`.
 *
 * - Chaque entrée est essayée avec TOUTES les clés connues (`keys`) : la nouvelle (un co-auteur
 *   reconnecté après l'éjection a déjà envoyé sous la nouvelle clé), la courante et la précédente
 *   (reliquat d'une compaction antérieure échouée). Rien de déchiffrable n'est donc perdu.
 * - Seul le PRÉFIXE du journal entièrement intégré est remplacé : la compaction s'arrête juste avant
 *   la première entrée illisible, qui est conservée (on n'efface jamais ce qu'on n'a pas intégré).
 * - Si toutes les entrées sont déjà sous `newKey`, rien n'est réécrit (`rewritten:false`).
 * - Relancée quelques fois sur échec transitoire ; l'échec final est renvoyé (`ok:false`).
 */
export async function compactCollabLog(
  api: Pick<OpsCtx["api"], "getCollabUpdates" | "compactCollab">,
  nodeId: string,
  keys: Uint8Array[],
  newKey: Uint8Array,
  opts: { attempts?: number; retryDelayMs?: number } = {},
): Promise<{ ok: boolean; integrated: number; kept: number; rewritten: boolean }> {
  const attempts = opts.attempts ?? 3;
  const { updates } = await readAllCollabUpdates(api, nodeId);
  if (!updates.length) return { ok: true, integrated: 0, kept: 0, rewritten: false };
  const doc = new Y.Doc();
  let integrated = 0;
  let upToSeq = 0;
  let blocked = false;
  let kept = 0;
  let needsRewrite = false;
  for (const u of [...updates].sort((a, b) => a.seq - b.seq)) {
    let hit: { plain: Uint8Array; keyIndex: number } | null = null;
    try {
      hit = await decryptWithAny(keys, u.nonce, fromHex(u.ciphertext));
    } catch {
      hit = null;
    }
    if (hit) {
      try {
        Y.applyUpdate(doc, hit.plain);
        integrated++;
        if (keys[hit.keyIndex] !== newKey) needsRewrite = true;
        if (!blocked) upToSeq = u.seq;
        continue;
      } catch {
        /* mise à jour Yjs invalide : traitée comme illisible, donc conservée */
      }
    }
    blocked = true;
    kept++;
  }
  if (!needsRewrite || upToSeq === 0) {
    doc.destroy();
    return { ok: kept === 0, integrated, kept, rewritten: false };
  }
  const snapshot = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  const encSnap = await encryptContent(newKey, snapshot);
  for (let i = 0; i < attempts; i++) {
    try {
      await api.compactCollab(nodeId, toHex(encSnap.ciphertext), encSnap.nonceHex, upToSeq);
      return { ok: kept === 0, integrated, kept, rewritten: true };
    } catch {
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 300) * (i + 1)));
    }
  }
  return { ok: false, integrated, kept, rewritten: false };
}

/** Clé précédente d'un nœud (fente `prevKeyWrapped`, chiffrée sous la clé courante), ou null. */
export async function previousNodeKey(
  entry: Pick<DriveEntry, "prevKeyWrapped" | "prevKeyNonce">,
  currentKey: Uint8Array,
): Promise<Uint8Array | null> {
  if (!entry.prevKeyWrapped || !entry.prevKeyNonce) return null;
  try {
    return await decryptContent(currentKey, entry.prevKeyNonce, fromHex(entry.prevKeyWrapped));
  } catch {
    return null;
  }
}

/** Outcome of a catch-up pass: how many versions got fixed vs. are still stale. */
export interface CatchUpResult {
  fixed: number;
  remaining: number;
}

/**
 * Finish a previously interrupted rotation: re-encrypt version blobs whose
 * epoch lags the node's, using the prev-key slot to read them. `remaining`
 * counts versions still stale afterwards (either genuinely more than one
 * epoch behind the prev-key slot — nothing more we can do from here — or a
 * transient failure); the caller MUST check it (see rotateNode) before
 * rotating again, since the prev-key slot is a single level and a further
 * rotation overwrites it.
 */
export async function catchUpStaleVersions(
  ctx: OpsCtx,
  entry: DriveEntry,
  currentKey: Uint8Array,
): Promise<CatchUpResult> {
  if (entry.kind !== "file" || !entry.prevKeyWrapped || !entry.prevKeyNonce) return { fixed: 0, remaining: 0 };
  const epoch = entry.keyEpoch ?? 1;
  const { versions } = (await ctx.api.listVersions(entry.id)) as unknown as { versions: VersionInfo[] };
  const stale = versions.filter((v) => v.keyEpoch < epoch);
  if (!stale.length) return { fixed: 0, remaining: 0 };
  const prevKey = await decryptContent(currentKey, entry.prevKeyNonce, fromHex(entry.prevKeyWrapped));
  let fixed = 0;
  let remaining = 0;
  for (const v of stale) {
    try {
      const { bytes, nonceHex } = await ctx.api.getVersionContent(entry.id, v.id);
      const plain = await decryptContent(prevKey, nonceHex, bytes);
      const enc = await encryptContent(currentKey, plain);
      await ctx.api.putVersionContent(entry.id, v.id, enc.ciphertext, enc.nonceHex);
      fixed++;
    } catch {
      /* a version we cannot read (older epoch than the prev slot), or a
         transient failure — either way it stays stale, so it must count
         toward `remaining` instead of being silently dropped. */
      remaining++;
    }
  }
  return { fixed, remaining };
}

/**
 * Termine une rotation interrompue sur un nœud (à l'ouverture d'un fichier, sans attendre la révocation
 * suivante) : versions restées sur l'ancienne époque, puis journal collab encore sous l'ancienne clé.
 * Au mieux : sans les droits nécessaires (lecture seule), rien n'est modifié et rien ne lève.
 */
export async function repairInterruptedRotation(
  ctx: OpsCtx,
  entry: DriveEntry,
): Promise<{ fixed: number; remaining: number; collabRewritten: boolean }> {
  const out = { fixed: 0, remaining: 0, collabRewritten: false };
  if (entry.kind !== "file" || !entry.prevKeyWrapped || !entry.prevKeyNonce) return out;
  const key = await nodeKeyFrom(ctx, entry.myWrappedKey);
  if (!key) return out;
  try {
    const r = await catchUpStaleVersions(ctx, entry, key);
    out.fixed = r.fixed;
    out.remaining = r.remaining;
  } catch {
    /* lecture seule / réseau : on réessaiera à la prochaine ouverture */
  }
  if (entry.appKind?.startsWith("collab-")) {
    const prev = await previousNodeKey(entry, key);
    if (prev) {
      try {
        const c = await compactCollabLog(ctx.api, entry.id, [key, prev], key, { attempts: 1 });
        out.collabRewritten = c.rewritten;
      } catch {
        /* pas le droit de compacter (node.acl.manage) : les lecteurs se replient sur la clé précédente */
      }
    }
  }
  return out;
}

/**
 * Rotate one node's CEK: new key, new crypto-ACL (current principals only —
 * call AFTER revoking), re-encrypted name/meta/content/versions/collab log.
 *
 * `ok:false` with `incomplete:true` means the ACL swap happened (or was
 * refused to avoid dropping a remaining principal) but some follow-up work
 * is pending — distinct from `ok:false` alone (node not decryptable by us).
 */
export async function rotateNode(
  ctx: OpsCtx,
  entry: DriveEntry,
  resolver: PrincipalKeyResolver = makePrincipalResolver(ctx),
): Promise<{
  ok: boolean;
  revokedLinks: number;
  blockedOnStaleVersions?: boolean;
  incomplete?: boolean;
  missingPrincipals?: string[];
}> {
  const oldKey = await nodeKeyFrom(ctx, entry.myWrappedKey);
  if (!oldKey) return { ok: false, revokedLinks: 0 }; // cannot rotate what we cannot decrypt
  const prevOfOld = await previousNodeKey(entry, oldKey);

  // Level any stragglers from an interrupted previous rotation first, so no
  // version ever ends up more than one epoch behind the prev-key slot. The
  // slot (`prevKeyWrapped`) is a SINGLE level, not a stack: rotating again
  // unconditionally would overwrite it, and any version this pass failed to
  // catch up (network hiccup, not just "genuinely too old") would become
  // PERMANENTLY unrecoverable. Refuse to proceed instead — the caller sees
  // this node reported as "incomplete" (rotateTree) and can retry.
  let caughtUp: CatchUpResult;
  try {
    caughtUp = await catchUpStaleVersions(ctx, entry, oldKey);
  } catch {
    return { ok: false, revokedLinks: 0, blockedOnStaleVersions: true, incomplete: true };
  }
  if (caughtUp.remaining > 0) {
    return { ok: false, revokedLinks: 0, blockedOnStaleVersions: true, incomplete: true };
  }

  const newKey = generateNodeKey();

  // 1. Wrap the fresh CEK to EVERY remaining principal of the node — or stop
  //    here, before anything changed server-side.
  const { shares } = (await ctx.api.listShares(entry.id)) as unknown as { shares: ShareInfo[] };
  let keyShares: KeyShareInput[];
  try {
    keyShares = await wrapForRemainingPrincipals(shares, newKey, resolver);
  } catch (e) {
    if (e instanceof RotationIncomplete)
      return { ok: false, revokedLinks: 0, incomplete: true, missingPrincipals: e.missing };
    throw e;
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

  let incomplete = false;
  if (entry.kind === "file") {
    // 4. Re-encrypt every version blob still on an older epoch (this includes
    //    the current content — it is just the version the node points at). A
    //    failure no longer aborts the whole node: the rest is still done and
    //    the node is reported "incomplete" (repairable via the prev-key slot).
    const newEpoch = node.keyEpoch ?? Number.MAX_SAFE_INTEGER;
    try {
      const { versions } = (await ctx.api.listVersions(entry.id)) as unknown as { versions: VersionInfo[] };
      for (const v of versions) {
        if (v.keyEpoch >= newEpoch) continue;
        try {
          const { bytes, nonceHex } = await ctx.api.getVersionContent(entry.id, v.id);
          const plain = await decryptContent(oldKey, nonceHex, bytes);
          const enc = await encryptContent(newKey, plain);
          await ctx.api.putVersionContent(entry.id, v.id, enc.ciphertext, enc.nonceHex);
        } catch {
          incomplete = true;
        }
      }
    } catch {
      incomplete = true;
    }

    // 5. Collab log → ONE snapshot under the new key, built from EVERY entry
    //    readable with the new, current or previous key (co-authors who
    //    reconnected after the eviction already write under the new key).
    if (entry.appKind?.startsWith("collab-")) {
      const keys = [newKey, oldKey, ...(prevOfOld ? [prevOfOld] : [])];
      try {
        const c = await compactCollabLog(ctx.api, entry.id, keys, newKey);
        if (!c.ok) incomplete = true;
      } catch {
        incomplete = true;
      }
    }
  }

  return incomplete ? { ok: false, revokedLinks, incomplete: true } : { ok: true, revokedLinks };
}

/**
 * Rotate a whole subtree (folder + every decryptable descendant, trash
 * included). Nodes the caller cannot decrypt keep their key (`skipped`);
 * nodes whose rotation was refused or left unfinished are `incomplete`.
 */
export async function rotateTree(
  ctx: OpsCtx,
  entry: DriveEntry,
  onProgress?: RotationProgress,
  resolver: PrincipalKeyResolver = makePrincipalResolver(ctx),
): Promise<RotationStats> {
  const stats: RotationStats = { rotated: 0, skipped: 0, revokedLinks: 0, incomplete: 0 };
  try {
    const res = await rotateNode(ctx, entry, resolver);
    stats.revokedLinks += res.revokedLinks;
    if (res.ok) stats.rotated++;
    else if (res.incomplete) stats.incomplete++;
    else stats.skipped++;
  } catch {
    stats.incomplete++;
  }
  onProgress?.(entry.name, stats);

  if (entry.kind === "folder") {
    const children = [
      ...(await listFolder(ctx, entry.id).catch(() => [] as DriveEntry[])),
      ...(await listFolder(ctx, entry.id, true).catch(() => [] as DriveEntry[])),
    ];
    for (const child of children) {
      const sub = await rotateTree(ctx, child, onProgress, resolver);
      stats.rotated += sub.rotated;
      stats.skipped += sub.skipped;
      stats.revokedLinks += sub.revokedLinks;
      stats.incomplete += sub.incomplete;
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

/** Message de bilan d'une révocation, distinguant « non déchiffrable » et « rotation à terminer ». */
export function rotationSummary(stats: RotationStats): string {
  const s = (n: number) => (n > 1 ? "s" : "");
  return (
    `Accès retiré. Clés régénérées sur ${stats.rotated} élément${s(stats.rotated)}` +
    (stats.revokedLinks ? ` — ${stats.revokedLinks} lien(s) externe(s) révoqué(s), à recréer si besoin.` : ".") +
    (stats.incomplete
      ? ` ⚠ ${stats.incomplete} élément${s(stats.incomplete)} : rotation inachevée (réseau, ayant droit dont la clé est introuvable ou versions en retard) — relancez la révocation ou rouvrez-le${stats.incomplete > 1 ? "s" : ""} pour terminer.`
      : "") +
    (stats.skipped ? ` ${stats.skipped} élément(s) non déchiffrable(s) par vous ont conservé leur clé.` : "")
  );
}
