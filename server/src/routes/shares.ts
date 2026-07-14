/**
 * Sharing = the two ways a node's key (CEK) is handed to others in the
 * zero-knowledge model:
 *   - Internal ACL shares (`node_keys`): the CEK is wrapped to a member/group/org
 *     public key, paired with a role that fixes the authorization grant.
 *   - External share links (`share_links`): the CEK is wrapped to a key derived
 *     from a URL-fragment secret that never reaches the server; we store only the
 *     sha256 of the lookup token so anonymous visitors can resolve the node.
 *
 * The server only moves opaque wrapped keys and ciphertext around and enforces
 * authorization — it never sees a plaintext key or file name. This module has
 * BOTH authenticated routes (managing shares/links) and PUBLIC routes (resolving
 * a link), so it does NOT install a global `authenticate` hook; instead the
 * authenticated routes carry `{ preHandler: authenticate }` individually.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, queryOne, withTx } from "../db/pool.js";
import { authenticate, requireUser, requireNodePerm } from "../middleware/auth.js";
import { badRequest, notFound, conflict } from "../lib/errors.js";
import { sha256Hex, randomToken } from "../lib/crypto-server.js";
import { storage } from "../storage/adapter.js";
import { audit } from "../lib/audit.js";
import { kickRoom } from "../collab/relay.js";

const envelope = z.record(z.unknown()); // recipients envelope (opaque)

/** bytea Buffer -> hex string for JSON, or "" / null when absent. */
function toHex(v: unknown): string {
  return v ? Buffer.from(v as Buffer).toString("hex") : "";
}

/** Public metadata DTO for a link-resolved node (mirrors nodes.ts nodeMetaDto). */
function linkNodeMetaDto(n: Record<string, unknown>) {
  return {
    id: n.id,
    kind: n.kind,
    nameEncrypted: toHex(n.name_encrypted),
    nameNonce: toHex(n.name_nonce),
    metaEncrypted: n.meta_encrypted ? Buffer.from(n.meta_encrypted as Buffer).toString("hex") : null,
    metaNonce: n.meta_nonce ? Buffer.from(n.meta_nonce as Buffer).toString("hex") : null,
    appKind: n.app_kind ?? null,
    sizeBytes: n.size_bytes ?? 0,
    hasContent: !!n.content_ref,
    contentNonce: n.content_nonce ? Buffer.from(n.content_nonce as Buffer).toString("hex") : null,
    createdAt: n.created_at,
    modifiedAt: n.modified_at,
  };
}

/** Assert `roleId` is a role usable in `orgId` (org-scoped or a global template). */
async function validateRole(roleId: string, orgId: string): Promise<void> {
  const r = await queryOne(`SELECT id FROM roles WHERE id = $1 AND (org_id = $2 OR org_id IS NULL)`, [roleId, orgId]);
  if (!r) throw badRequest("Rôle invalide pour cette organisation.");
}

/**
 * Resolve a raw link token to a live `share_links` row joined to its node and
 * role. Returns null when the token is unknown, revoked, expired, or has hit its
 * download cap — callers turn null into a generic 404 (never leak which).
 */
async function resolveLink(token: string) {
  const tokenHash = sha256Hex(token);
  const row = await queryOne<{
    id: string;
    node_id: string;
    wrapped_key: unknown;
    has_password: boolean;
    role_key: string;
    expires_at: string | null;
    max_downloads: number | null;
    download_count: number;
    revoked_at: string | null;
    n_id: string;
    n_kind: string;
    n_name_encrypted: Buffer;
    n_name_nonce: Buffer;
    n_meta_encrypted: Buffer | null;
    n_meta_nonce: Buffer | null;
    n_app_kind: string | null;
    n_size_bytes: number;
    n_content_ref: string | null;
    n_content_nonce: Buffer | null;
    n_created_at: string;
    n_modified_at: string;
  }>(
    `SELECT sl.id, sl.node_id, sl.wrapped_key, sl.has_password, sl.expires_at,
            sl.max_downloads, sl.download_count, sl.revoked_at,
            r.key AS role_key,
            n.id AS n_id, n.kind AS n_kind,
            n.name_encrypted AS n_name_encrypted, n.name_nonce AS n_name_nonce,
            n.meta_encrypted AS n_meta_encrypted, n.meta_nonce AS n_meta_nonce,
            n.app_kind AS n_app_kind, n.size_bytes AS n_size_bytes,
            n.content_ref AS n_content_ref, n.content_nonce AS n_content_nonce,
            n.created_at AS n_created_at, n.modified_at AS n_modified_at
       FROM share_links sl
       JOIN roles r ON r.id = sl.role_id
       JOIN nodes n ON n.id = sl.node_id
      WHERE sl.token_hash = $1`,
    [tokenHash],
  );
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;
  if (row.max_downloads != null && row.download_count >= row.max_downloads) return null;
  return row;
}

export default async function shareRoutes(app: FastifyInstance): Promise<void> {
  // =====================================================================
  //  Authenticated routes — internal ACL shares
  // =====================================================================

  // --- List the ACL of a node ----------------------------------------------
  app.get("/nodes/:id/shares", { preHandler: authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await requireNodePerm(req, id, "node.acl.view");

    const rows = await query<{
      id: string;
      principal_type: string;
      principal_id: string;
      role_id: string;
      role_key: string;
      role_name: string;
      inherited_from: string | null;
      user_email: string | null;
      user_display_name: string | null;
      group_name: string | null;
    }>(
      `SELECT nk.id, nk.principal_type, nk.principal_id, nk.role_id, nk.inherited_from,
              r.key AS role_key, r.name AS role_name,
              u.email AS user_email, u.display_name AS user_display_name,
              g.name AS group_name
         FROM node_keys nk
         JOIN roles r ON r.id = nk.role_id
         LEFT JOIN users u ON nk.principal_type = 'user' AND u.id = nk.principal_id
         LEFT JOIN groups g ON nk.principal_type = 'group' AND g.id = nk.principal_id
        WHERE nk.node_id = $1
        ORDER BY nk.created_at`,
      [id],
    );

    const shares = rows.map((row) => {
      let name: string;
      if (row.principal_type === "user") {
        name = row.user_display_name || row.user_email || "Utilisateur";
      } else if (row.principal_type === "group") {
        name = row.group_name || "Groupe";
      } else {
        name = "Organisation";
      }
      return {
        id: row.id,
        principalType: row.principal_type,
        principalId: row.principal_id,
        roleId: row.role_id,
        roleKey: row.role_key,
        roleName: row.role_name,
        name,
        inheritedFrom: row.inherited_from ?? null,
      };
    });

    return { shares };
  });

  // --- Grant / update an internal share ------------------------------------
  // `inheritedFrom` marks a share that was fanned out from an ancestor folder
  // (deep share): revoking the ancestor share then cleans these rows up too.
  const createShareSchema = z.object({
    principalType: z.enum(["user", "group", "org"]),
    principalId: z.string().uuid(),
    roleId: z.string().uuid(),
    wrappedKey: envelope,
    inheritedFrom: z.string().uuid().nullable().optional(),
  });
  app.post("/nodes/:id/shares", { preHandler: authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = createShareSchema.parse(req.body);
    const user = requireUser(req);

    // Both crypto-grant (share.internal) and authorization (acl.manage) needed.
    const access = await requireNodePerm(req, id, "node.share.internal");
    await requireNodePerm(req, id, "node.acl.manage");

    await validateRole(b.roleId, access.orgId);

    const row = await queryOne<{ id: string }>(
      `INSERT INTO node_keys (node_id, principal_type, principal_id, role_id, wrapped_key, granted_by, inherited_from)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (node_id, principal_type, principal_id)
       DO UPDATE SET role_id = EXCLUDED.role_id,
                     wrapped_key = EXCLUDED.wrapped_key,
                     granted_by = EXCLUDED.granted_by,
                     inherited_from = EXCLUDED.inherited_from
       RETURNING id`,
      [id, b.principalType, b.principalId, b.roleId, JSON.stringify(b.wrappedKey), user.id, b.inheritedFrom ?? null],
    );
    if (!row) throw badRequest("Partage impossible.");

    await audit(
      access.orgId,
      user.id,
      "node.share",
      access.kind,
      id,
      { principalType: b.principalType, principalId: b.principalId, roleId: b.roleId },
      req.ip,
    );
    return { shareId: row.id };
  });

  // --- Change the role of an existing share ---------------------------------
  const patchShareSchema = z.object({ roleId: z.string().uuid() });
  app.patch("/nodes/:id/shares/:shareId", { preHandler: authenticate }, async (req) => {
    const { id, shareId } = z
      .object({ id: z.string().uuid(), shareId: z.string().uuid() })
      .parse(req.params);
    const b = patchShareSchema.parse(req.body);
    const user = requireUser(req);

    const access = await requireNodePerm(req, id, "node.acl.manage");
    await validateRole(b.roleId, access.orgId);

    const row = await queryOne<{ id: string }>(
      `UPDATE node_keys SET role_id = $3 WHERE id = $2 AND node_id = $1 RETURNING id`,
      [id, shareId, b.roleId],
    );
    if (!row) throw notFound("Partage introuvable.");

    await audit(access.orgId, user.id, "node.share.update", access.kind, id, { shareId, roleId: b.roleId }, req.ip);
    return { ok: true };
  });

  // --- Revoke an internal share --------------------------------------------
  // `?deep=true` (folders): also removes the principal's key rows on every
  // descendant — a deep share fanned explicit rows down the subtree, and
  // without this cleanup the principal keeps AUTHORIZED direct-ID access to
  // children after the parent share is gone. Rows where the principal is the
  // descendant node's own owner are preserved (never orphan an owner).
  // Revoking authorization does NOT invalidate an already-unwrapped CEK: the
  // caller is expected to follow up with key rotation (POST /nodes/:id/rotate).
  app.delete("/nodes/:id/shares/:shareId", { preHandler: authenticate }, async (req) => {
    const { id, shareId } = z
      .object({ id: z.string().uuid(), shareId: z.string().uuid() })
      .parse(req.params);
    const { deep } = z.object({ deep: z.enum(["true", "false"]).default("false") }).parse(req.query);
    const user = requireUser(req);

    const access = await requireNodePerm(req, id, "node.share.manage");

    const share = await queryOne<{ principal_type: string; principal_id: string }>(
      `SELECT principal_type, principal_id FROM node_keys WHERE id = $1 AND node_id = $2`,
      [shareId, id],
    );
    if (!share) throw notFound("Partage introuvable.");

    // Never orphan the node owner from their own node.
    if (share.principal_type === "user" && share.principal_id === access.ownerUserId) {
      throw conflict("Impossible de retirer l'accès du propriétaire du nœud.");
    }

    const touched = await withTx(async (c) => {
      await c.query(`DELETE FROM node_keys WHERE id = $1 AND node_id = $2`, [shareId, id]);
      if (deep !== "true" || access.kind !== "folder") return [id];
      const { rows } = await c.query(
        `WITH RECURSIVE sub AS (
            SELECT id FROM nodes WHERE parent_id = $1
            UNION ALL
            SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
         )
         DELETE FROM node_keys nk
          WHERE nk.node_id IN (SELECT id FROM sub)
            AND nk.principal_type = $2 AND nk.principal_id = $3
            AND NOT (nk.principal_type = 'user'
                     AND nk.principal_id = (SELECT owner_user_id FROM nodes WHERE id = nk.node_id))
          RETURNING nk.node_id`,
        [id, share.principal_type, share.principal_id],
      );
      return [id, ...rows.map((r) => r.node_id as string)];
    });

    // Evict live collab peers on every touched node: a revoked-but-connected
    // socket must not keep receiving updates. Survivors reconnect through RBAC.
    for (const nodeId of new Set(touched)) kickRoom(nodeId, "acl-changed");

    await audit(
      access.orgId,
      user.id,
      "node.unshare",
      access.kind,
      id,
      { shareId, principalType: share.principal_type, principalId: share.principal_id, deep: deep === "true" },
      req.ip,
    );
    return { ok: true };
  });

  // =====================================================================
  //  Authenticated routes — external share links
  // =====================================================================

  // --- Create a share link --------------------------------------------------
  const createLinkSchema = z.object({
    roleId: z.string().uuid(),
    wrappedKey: envelope,
    hasPassword: z.boolean().default(false),
    expiresAt: z.string().datetime().optional(),
    maxDownloads: z.number().int().positive().optional(),
  });
  app.post("/nodes/:id/links", { preHandler: authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = createLinkSchema.parse(req.body);
    const user = requireUser(req);

    const access = await requireNodePerm(req, id, "node.share.link");
    await validateRole(b.roleId, access.orgId);

    const token = randomToken(32);
    const tokenHash = sha256Hex(token);

    const row = await queryOne<{ id: string }>(
      `INSERT INTO share_links (node_id, token_hash, role_id, wrapped_key, has_password,
                                expires_at, max_downloads, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [
        id,
        tokenHash,
        b.roleId,
        JSON.stringify(b.wrappedKey),
        b.hasPassword,
        b.expiresAt ?? null,
        b.maxDownloads ?? null,
        user.id,
      ],
    );
    if (!row) throw badRequest("Création du lien impossible.");

    await audit(access.orgId, user.id, "node.link.create", access.kind, id, { linkId: row.id }, req.ip);
    return { token, linkId: row.id };
  });

  // --- List a node's active links ------------------------------------------
  app.get("/nodes/:id/links", { preHandler: authenticate }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await requireNodePerm(req, id, "node.acl.view");

    const rows = await query<{
      id: string;
      has_password: boolean;
      expires_at: string | null;
      max_downloads: number | null;
      download_count: number;
      created_at: string;
    }>(
      `SELECT id, has_password, expires_at, max_downloads, download_count, created_at
         FROM share_links
        WHERE node_id = $1 AND revoked_at IS NULL
        ORDER BY created_at DESC`,
      [id],
    );

    return {
      links: rows.map((r) => ({
        id: r.id,
        hasPassword: r.has_password,
        expiresAt: r.expires_at ?? null,
        maxDownloads: r.max_downloads ?? null,
        downloadCount: r.download_count,
        createdAt: r.created_at,
      })),
    };
  });

  // --- Revoke a share link --------------------------------------------------
  app.delete("/nodes/:id/links/:linkId", { preHandler: authenticate }, async (req) => {
    const { id, linkId } = z
      .object({ id: z.string().uuid(), linkId: z.string().uuid() })
      .parse(req.params);
    const user = requireUser(req);

    const access = await requireNodePerm(req, id, "node.share.manage");

    const row = await queryOne<{ id: string }>(
      `UPDATE share_links SET revoked_at = now()
        WHERE id = $1 AND node_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [linkId, id],
    );
    if (!row) throw notFound("Lien introuvable.");

    await audit(access.orgId, user.id, "node.link.revoke", access.kind, id, { linkId }, req.ip);
    return { ok: true };
  });

  // =====================================================================
  //  PUBLIC routes — anonymous link resolution (no authenticate hook)
  // =====================================================================

  // --- Resolve a link: encrypted metadata + wrapped key --------------------
  app.get("/links/:token", async (req) => {
    const { token } = z.object({ token: z.string().min(1).max(512) }).parse(req.params);
    const link = await resolveLink(token);
    if (!link) throw notFound("Lien introuvable, révoqué ou expiré.");

    const node = {
      id: link.n_id,
      kind: link.n_kind,
      name_encrypted: link.n_name_encrypted,
      name_nonce: link.n_name_nonce,
      meta_encrypted: link.n_meta_encrypted,
      meta_nonce: link.n_meta_nonce,
      app_kind: link.n_app_kind,
      size_bytes: link.n_size_bytes,
      content_ref: link.n_content_ref,
      content_nonce: link.n_content_nonce,
      created_at: link.n_created_at,
      modified_at: link.n_modified_at,
    };

    return {
      node: linkNodeMetaDto(node),
      wrappedKey: link.wrapped_key,
      hasPassword: link.has_password,
      roleKey: link.role_key,
    };
  });

  // --- Resolve a link and stream the node's encrypted blob -----------------
  app.get("/links/:token/content", async (req, reply) => {
    const { token } = z.object({ token: z.string().min(1).max(512) }).parse(req.params);
    const link = await resolveLink(token);
    if (!link) throw notFound("Lien introuvable, révoqué ou expiré.");
    if (!link.n_content_ref) throw notFound("Aucun contenu.");

    // Count the download atomically (re-checking the cap to avoid overshoot).
    await query(
      `UPDATE share_links SET download_count = download_count + 1
        WHERE id = $1 AND revoked_at IS NULL
          AND (max_downloads IS NULL OR download_count < max_downloads)`,
      [link.id],
    );

    reply.header("content-type", "application/octet-stream");
    if (link.n_content_nonce) {
      reply.header("x-content-nonce", Buffer.from(link.n_content_nonce).toString("hex"));
    }
    return reply.send(await storage().getStream(link.n_content_ref));
  });
}
