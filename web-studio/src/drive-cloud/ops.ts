/**
 * High-level Drive operations: they combine the API with per-node cryptography
 * so the UI never touches keys directly. Names are decrypted for display;
 * content is encrypted before upload and decrypted after download; sharing
 * re-wraps the node key to a recipient's public key.
 */
import type { DriveApi } from "./api";
import type { AccountKeys } from "./account";
import type { NodeMeta, PublicUser, KeyShareInput, PrincipalType } from "./types";
import {
  generateNodeKey,
  wrapNodeKeyFor,
  unwrapNodeKey,
  encryptContent,
  decryptContent,
  encryptName,
  decryptName,
  type WrappedKey,
} from "./node-crypto";
import { generateRecipientKeypair } from "../crypto/recipients";
import { fromHex } from "../format/canonical";

export interface OpsCtx {
  api: DriveApi;
  keys: AccountKeys;
  userId: string;
  orgId: string;
  orgPublicHex: string;
  roleIdByKey: Record<string, string>;
}

/** A node with its name decrypted for display. */
export interface DriveEntry extends NodeMeta {
  name: string;
}

function pickRole(ctx: OpsCtx, ...keys: string[]): string {
  for (const k of keys) if (ctx.roleIdByKey[k]) return ctx.roleIdByKey[k]!;
  const any = Object.values(ctx.roleIdByKey)[0];
  if (!any) throw new Error("Aucun rôle disponible dans cette organisation.");
  return any;
}

/** Recover a node's CEK from the caller's wrapped-key share. */
export async function nodeKeyFrom(ctx: OpsCtx, wrapped: WrappedKey | null | undefined): Promise<Uint8Array | null> {
  if (!wrapped) return null;
  try {
    return await unwrapNodeKey(wrapped, ctx.keys.recipient);
  } catch {
    return null;
  }
}

/** The key shares to attach to a newly created node: the creator + org recovery. */
async function defaultShares(ctx: OpsCtx, nodeKey: Uint8Array): Promise<KeyShareInput[]> {
  const ownerRole = pickRole(ctx, "editor", "owner", "admin");
  const shares: KeyShareInput[] = [
    {
      principalType: "user",
      principalId: ctx.userId,
      roleId: ownerRole,
      wrappedKey: await wrapNodeKeyFor(nodeKey, ctx.keys.recipient.publicHex),
    },
  ];
  if (ctx.orgPublicHex) {
    shares.push({
      principalType: "org",
      principalId: ctx.orgId,
      roleId: pickRole(ctx, "admin", "owner", "editor"),
      wrappedKey: await wrapNodeKeyFor(nodeKey, ctx.orgPublicHex),
    });
  }
  return shares;
}

interface ParentShareRow {
  principalType: "user" | "group" | "org";
  principalId: string;
  roleId: string;
  inheritedFrom?: string | null;
}

/**
 * Key shares inherited from the parent folder's ACL: everyone who can decrypt
 * the parent gets the new node's key wrapped to their public key too (same
 * role). Without this, a file created inside a shared folder would be
 * authorized (ACL walks ancestors) but UNDECRYPTABLE by the other members.
 */
async function inheritedShares(ctx: OpsCtx, parentId: string, nodeKey: Uint8Array, already: Set<string>): Promise<KeyShareInput[]> {
  const out: KeyShareInput[] = [];
  let rows: ParentShareRow[] = [];
  try {
    const { shares } = await ctx.api.listShares(parentId);
    rows = shares as ParentShareRow[];
  } catch {
    return out; // no acl.view on the parent — keep the default shares only
  }
  let groups: { id: string; groupPublicHex: string }[] | null = null;
  for (const s of rows) {
    const key = `${s.principalType}:${s.principalId}`;
    if (already.has(key)) continue;
    try {
      let pub: string | null = null;
      if (s.principalType === "user") pub = (await ctx.api.getUser(s.principalId)).user.p256PublicHex;
      else if (s.principalType === "group") {
        groups ??= ((await ctx.api.listGroups(ctx.orgId)).groups as { id: string; groupPublicHex: string }[]) ?? [];
        pub = groups.find((g) => g.id === s.principalId)?.groupPublicHex ?? null;
      } else if (s.principalType === "org") pub = ctx.orgPublicHex || null;
      if (!pub) continue;
      already.add(key);
      // Track where the grant ultimately comes from: revoking that ancestor
      // share (deep) must clean this row up too.
      out.push({
        principalType: s.principalType,
        principalId: s.principalId,
        roleId: s.roleId,
        wrappedKey: await wrapNodeKeyFor(nodeKey, pub),
        inheritedFrom: s.inheritedFrom ?? parentId,
      });
    } catch {
      /* best effort per principal */
    }
  }
  return out;
}

/** All key shares for a new node: creator + org recovery + parent's principals. */
async function sharesForNewNode(ctx: OpsCtx, parentId: string | null, nodeKey: Uint8Array): Promise<KeyShareInput[]> {
  const shares = await defaultShares(ctx, nodeKey);
  if (parentId) {
    const already = new Set(shares.map((s) => `${s.principalType}:${s.principalId}`));
    shares.push(...(await inheritedShares(ctx, parentId, nodeKey, already)));
  }
  return shares;
}

/** Decrypt the names of a list of node metadata into displayable entries. */
export async function decryptEntries(ctx: OpsCtx, nodes: NodeMeta[]): Promise<DriveEntry[]> {
  const out: DriveEntry[] = [];
  for (const n of nodes) {
    let name = "(chiffré)";
    const key = await nodeKeyFrom(ctx, n.myWrappedKey);
    if (key) {
      try {
        name = await decryptName(key, n.nameEncrypted, n.nameNonce);
      } catch {
        /* keep placeholder */
      }
    }
    out.push({ ...n, name });
  }
  return out;
}

/** List and decrypt the children of a folder (or the org roots when null). */
export async function listFolder(ctx: OpsCtx, parentId: string | null, trashed = false): Promise<DriveEntry[]> {
  const { nodes } = await ctx.api.listChildren(ctx.orgId, parentId ?? undefined, trashed);
  return decryptEntries(ctx, nodes);
}

/** List and decrypt all trashed nodes of the org. */
export async function listTrash(ctx: OpsCtx): Promise<DriveEntry[]> {
  const { nodes } = await ctx.api.listTrash(ctx.orgId);
  return decryptEntries(ctx, nodes);
}

export async function createFolder(ctx: OpsCtx, parentId: string | null, name: string): Promise<NodeMeta> {
  const nodeKey = generateNodeKey();
  const encName = await encryptName(nodeKey, name);
  const shares = await sharesForNewNode(ctx, parentId, nodeKey);
  const { node } = await ctx.api.createNode({
    orgId: ctx.orgId,
    parentId,
    kind: "folder",
    nameEncrypted: encName.nameEncrypted,
    nameNonce: encName.nameNonce,
    keyShares: shares,
  });
  return node;
}

/** Create an empty collaborative node (content lives as encrypted Yjs updates). */
export async function createCollabNode(
  ctx: OpsCtx,
  parentId: string | null,
  name: string,
  appKind: "collab-doc" | "collab-sheet" | "collab-slides",
): Promise<NodeMeta> {
  const nodeKey = generateNodeKey();
  const encName = await encryptName(nodeKey, name);
  const shares = await sharesForNewNode(ctx, parentId, nodeKey);
  const { node } = await ctx.api.createNode({
    orgId: ctx.orgId,
    parentId,
    kind: "file",
    nameEncrypted: encName.nameEncrypted,
    nameNonce: encName.nameNonce,
    appKind,
    keyShares: shares,
  });
  return node;
}

export const createCollabDoc = (ctx: OpsCtx, parentId: string | null, name: string) => createCollabNode(ctx, parentId, name, "collab-doc");
export const createCollabSheet = (ctx: OpsCtx, parentId: string | null, name: string) => createCollabNode(ctx, parentId, name, "collab-sheet");
export const createCollabSlides = (ctx: OpsCtx, parentId: string | null, name: string) => createCollabNode(ctx, parentId, name, "collab-slides");

export async function uploadFile(ctx: OpsCtx, parentId: string | null, file: File): Promise<NodeMeta> {
  const nodeKey = generateNodeKey();
  const encName = await encryptName(nodeKey, file.name);
  const shares = await sharesForNewNode(ctx, parentId, nodeKey);
  const appKind = guessAppKind(file.name);
  const { node } = await ctx.api.createNode({
    orgId: ctx.orgId,
    parentId,
    kind: "file",
    nameEncrypted: encName.nameEncrypted,
    nameNonce: encName.nameNonce,
    ...(appKind ? { appKind } : {}),
    keyShares: shares,
  });
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const enc = await encryptContent(nodeKey, plaintext);
  const { node: updated } = await ctx.api.putContent(node.id, enc.ciphertext, enc.nonceHex);
  return updated;
}

export async function renameNode(ctx: OpsCtx, entry: DriveEntry, newName: string): Promise<void> {
  const key = await nodeKeyFrom(ctx, entry.myWrappedKey);
  if (!key) throw new Error("Clé du nœud indisponible.");
  const enc = await encryptName(key, newName);
  await ctx.api.patchNode(entry.id, { nameEncrypted: enc.nameEncrypted, nameNonce: enc.nameNonce });
}

export async function downloadFile(ctx: OpsCtx, entry: DriveEntry): Promise<{ bytes: Uint8Array; name: string }> {
  const key = await nodeKeyFrom(ctx, entry.myWrappedKey);
  if (!key) throw new Error("Clé du nœud indisponible.");
  const { bytes, nonceHex } = await ctx.api.getContent(entry.id);
  const plain = await decryptContent(key, nonceHex, bytes);
  return { bytes: plain, name: entry.name };
}

/**
 * Share a node with a principal: re-wrap its key + grant the role. For folders
 * this recurses over every decryptable descendant so the target can actually
 * OPEN the existing content (the ACL alone authorizes but cannot decrypt).
 */
async function shareNode(
  ctx: OpsCtx,
  entry: DriveEntry,
  principal: { type: PrincipalType; id: string; publicHex: string },
  roleId: string,
  inheritedFrom: string | null = null,
): Promise<void> {
  const key = await nodeKeyFrom(ctx, entry.myWrappedKey);
  if (!key) throw new Error("Impossible de partager : clé du nœud indisponible.");
  const wrappedKey = await wrapNodeKeyFor(key, principal.publicHex);
  await ctx.api.share(entry.id, { principalType: principal.type, principalId: principal.id, roleId, wrappedKey, inheritedFrom });
  if (entry.kind === "folder") {
    // Descendant rows are marked as fanned out from the ROOT of this share
    // operation, so revoking that share (deep) cleans the whole subtree up.
    const root = inheritedFrom ?? entry.id;
    const children = await listFolder(ctx, entry.id);
    for (const child of children) {
      if (!child.myWrappedKey) continue; // can't re-wrap what we can't decrypt
      try {
        await shareNode(ctx, child, principal, roleId, root);
      } catch {
        /* best effort per descendant */
      }
    }
  }
}

/** Re-wrap a node's key to a target user and grant them a role (deep for folders). */
export async function shareWithUser(
  ctx: OpsCtx,
  entry: DriveEntry,
  target: PublicUser,
  roleId: string,
): Promise<void> {
  await shareNode(ctx, entry, { type: "user", id: target.id, publicHex: target.p256PublicHex }, roleId);
}

/**
 * Create an external share link. The node key is wrapped to a fresh link
 * keypair; the link's PRIVATE key is the secret that lives in the URL fragment
 * (never sent to the server). Returns the lookup token + the secret to embed.
 */
export async function createShareLink(
  ctx: OpsCtx,
  entry: DriveEntry,
  roleId: string,
  opts: { expiresAt?: string; maxDownloads?: number } = {},
): Promise<{ token: string; secret: string; publicHex: string }> {
  const key = await nodeKeyFrom(ctx, entry.myWrappedKey);
  if (!key) throw new Error("Clé du nœud indisponible.");
  const linkKp = await generateRecipientKeypair();
  const wrappedKey = await wrapNodeKeyFor(key, linkKp.publicHex);
  const { token } = await ctx.api.createLink(entry.id, {
    roleId,
    wrappedKey,
    ...(opts.expiresAt ? { expiresAt: opts.expiresAt } : {}),
    ...(opts.maxDownloads ? { maxDownloads: opts.maxDownloads } : {}),
  });
  // Both the link private scalar and its public point travel in the URL
  // fragment (never sent to the server): the opener needs the pair to unwrap.
  return { token, secret: linkKp.privateHex, publicHex: linkKp.publicHex };
}

/** Download + decrypt a specific version's content of a node. */
export async function downloadVersion(
  ctx: OpsCtx,
  entry: DriveEntry,
  versionId: string,
): Promise<{ bytes: Uint8Array; name: string }> {
  const key = await nodeKeyFrom(ctx, entry.myWrappedKey);
  if (!key) throw new Error("Clé du nœud indisponible.");
  const { bytes, nonceHex } = await ctx.api.getVersionContent(entry.id, versionId);
  return { bytes: await decryptContent(key, nonceHex, bytes), name: entry.name };
}

/** Resolve a public share link and decrypt its name (+ content if a file). */
export async function openSharedLink(
  api: DriveApi,
  token: string,
  linkPrivateHex: string,
  linkPublicHex: string,
): Promise<{ name: string; kind: "folder" | "file"; hasContent: boolean; download: () => Promise<{ bytes: Uint8Array; name: string }> }> {
  const kp = { privateHex: linkPrivateHex, publicHex: linkPublicHex };
  const { node, wrappedKey } = await api.resolveLink(token);
  const nodeKey = await unwrapNodeKey(wrappedKey, kp);
  const name = await decryptName(nodeKey, node.nameEncrypted, node.nameNonce);
  return {
    name,
    kind: node.kind,
    hasContent: node.hasContent,
    download: async () => {
      const { bytes, nonceHex } = await api.getLinkContent(token);
      return { bytes: await decryptContent(nodeKey, nonceHex, bytes), name };
    },
  };
}

// --- Teams / groups (cryptographic principals) -----------------------------

/** Create a team: generate its keypair and wrap the private key to every member (incl. creator). */
export async function createTeam(
  ctx: OpsCtx,
  name: string,
  description: string,
  color: string,
  members: PublicUser[],
): Promise<void> {
  const kp = await generateRecipientKeypair();
  const priv = fromHex(kp.privateHex);
  const byId = new Map<string, string>(); // userId -> p256 public hex
  byId.set(ctx.userId, ctx.keys.recipient.publicHex);
  for (const m of members) byId.set(m.id, m.p256PublicHex);
  const memberInputs: { userId: string; wrappedGroupPrivate: WrappedKey; isManager?: boolean }[] = [];
  for (const [userId, pub] of byId) {
    memberInputs.push({ userId, wrappedGroupPrivate: await wrapNodeKeyFor(priv, pub), isManager: userId === ctx.userId });
  }
  await ctx.api.createGroup(ctx.orgId, { name, description, color, groupPublicHex: kp.publicHex, members: memberInputs });
}

/** Add a member to a team: unwrap the team key locally, re-wrap it to the new member. */
export async function addTeamMember(
  ctx: OpsCtx,
  groupId: string,
  myWrappedGroupPrivate: WrappedKey,
  target: PublicUser,
  isManager = false,
): Promise<void> {
  const priv = await unwrapNodeKey(myWrappedGroupPrivate, ctx.keys.recipient);
  const wrapped = await wrapNodeKeyFor(priv, target.p256PublicHex);
  await ctx.api.addGroupMember(ctx.orgId, groupId, { userId: target.id, wrappedGroupPrivate: wrapped, isManager });
}

/** Share a node with a whole team (deep for folders). */
export async function shareWithGroup(
  ctx: OpsCtx,
  entry: DriveEntry,
  groupId: string,
  groupPublicHex: string,
  roleId: string,
): Promise<void> {
  await shareNode(ctx, entry, { type: "group", id: groupId, publicHex: groupPublicHex }, roleId);
}

function guessAppKind(filename: string): string | undefined {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (["elium"].includes(ext)) return "elium";
  if (["doc", "docx", "odt", "txt", "md"].includes(ext)) return "doc";
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return "sheet";
  if (["ppt", "pptx", "odp"].includes(ext)) return "slides";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)) return "image";
  return undefined;
}

export function triggerDownload(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
