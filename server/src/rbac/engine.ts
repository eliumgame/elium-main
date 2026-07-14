/**
 * RBAC resolution. Turns (user, org) and (user, node) into a concrete set of
 * effective permission keys, by unioning:
 *   - the user's org-level role (membership),
 *   - the roles granted to their groups,
 *   - ACL entries (node_keys) on the node AND all its ancestors (folder shares
 *     cascade to descendants),
 * plus intrinsic grants (a node's owner has all node permissions).
 *
 * Authorization (can this request proceed) is distinct from cryptographic
 * capability (can the client decrypt) — this module answers only the former.
 */
import { query, queryOne } from "../db/pool.js";

export interface OrgContext {
  orgId: string;
  membershipId: string;
  roleId: string;
  roleKey: string;
  permissions: Set<string>;
  isOwner: boolean; // org owner
}

export interface NodeAccess {
  nodeId: string;
  orgId: string;
  ownerUserId: string;
  kind: "folder" | "file";
  trashed: boolean;
  isOwner: boolean; // node owner
  permissions: Set<string>; // effective node-scoped permissions
  accessible: boolean; // has any ACL grant or is owner
}

/** Org-level context for the user, or null if they are not an active member. */
export async function loadOrgContext(userId: string, orgId: string): Promise<OrgContext | null> {
  const row = await queryOne<{
    membership_id: string;
    role_id: string;
    role_key: string;
    permissions: string[];
    org_owner: string;
  }>(
    `SELECT m.id AS membership_id, m.role_id, r.key AS role_key, r.permissions,
            o.owner_user_id AS org_owner
       FROM memberships m
       JOIN roles r ON r.id = m.role_id
       JOIN organizations o ON o.id = m.org_id
      WHERE m.user_id = $1 AND m.org_id = $2 AND m.status = 'active'`,
    [userId, orgId],
  );
  if (!row) return null;

  const isOwner = row.org_owner === userId;
  const permissions = new Set(row.permissions ?? []);
  // Group roles do not carry org-level permissions in v1; org perms come from
  // the membership role only. (Group roles apply at the node ACL level.)
  return {
    orgId,
    membershipId: row.membership_id,
    roleId: row.role_id,
    roleKey: row.role_key,
    permissions,
    isOwner,
  };
}

export function orgHasPermission(ctx: OrgContext | null, perm: string): boolean {
  if (!ctx) return false;
  if (ctx.isOwner) return true;
  return ctx.permissions.has(perm);
}

/** Ids of the groups the user belongs to within an org. */
async function userGroupIds(userId: string, orgId: string): Promise<string[]> {
  const rows = await query<{ group_id: string }>(
    `SELECT gm.group_id
       FROM group_members gm
       JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = $1 AND g.org_id = $2`,
    [userId, orgId],
  );
  return rows.map((r) => r.group_id);
}

/**
 * Effective node access for a user. Considers the target node plus every
 * ancestor (so sharing a folder cascades), the user directly and via groups,
 * and the org membership/owner.
 */
export async function resolveNodeAccess(userId: string, nodeId: string): Promise<NodeAccess | null> {
  const node = await queryOne<{
    id: string;
    org_id: string;
    owner_user_id: string;
    kind: "folder" | "file";
    trashed_at: string | null;
  }>(`SELECT id, org_id, owner_user_id, kind, trashed_at FROM nodes WHERE id = $1`, [nodeId]);
  if (!node) return null;

  const orgCtx = await loadOrgContext(userId, node.org_id);
  const groupIds = await userGroupIds(userId, node.org_id);

  // ACL rows on the node and its ancestors, matching the user or their groups.
  const aclRows = await query<{ permissions: string[] }>(
    `WITH RECURSIVE anc AS (
        SELECT id, parent_id FROM nodes WHERE id = $1
        UNION ALL
        SELECT n.id, n.parent_id FROM nodes n JOIN anc ON n.id = anc.parent_id
     )
     SELECT r.permissions
       FROM node_keys nk
       JOIN roles r ON r.id = nk.role_id
      WHERE nk.node_id IN (SELECT id FROM anc)
        AND (
          (nk.principal_type = 'user' AND nk.principal_id = $2)
          OR (nk.principal_type = 'group' AND nk.principal_id = ANY($3::uuid[]))
        )`,
    [nodeId, userId, groupIds],
  );

  const permissions = new Set<string>();
  for (const row of aclRows) for (const perm of row.permissions ?? []) permissions.add(perm);

  const isOwner = node.owner_user_id === userId;
  // The node owner AND the org owner implicitly get all node permissions: the
  // org owner already holds the recovery key (can decrypt any org node), so
  // withholding authorization would be pure friction — and it is what lets them
  // drive an org-wide revocation + key rotation across nodes they do not
  // personally own.
  if (isOwner || orgCtx?.isOwner) {
    for (const perm of OWNER_NODE_PERMS) permissions.add(perm);
  }

  const accessible = isOwner || aclRows.length > 0 || (orgCtx?.isOwner ?? false);

  return {
    nodeId: node.id,
    orgId: node.org_id,
    ownerUserId: node.owner_user_id,
    kind: node.kind,
    trashed: node.trashed_at != null,
    isOwner,
    permissions,
    accessible,
  };
}

export function nodeHasPermission(access: NodeAccess | null, perm: string): boolean {
  if (!access) return false;
  return access.permissions.has(perm);
}

const OWNER_NODE_PERMS: readonly string[] = [
  "node.view",
  "node.download",
  "node.export",
  "node.print",
  "node.create",
  "node.edit",
  "node.rename",
  "node.move",
  "node.copy",
  "node.delete",
  "node.restore",
  "node.comment",
  "node.version.view",
  "node.version.restore",
  "node.share.internal",
  "node.share.link",
  "node.share.manage",
  "node.acl.view",
  "node.acl.manage",
];
