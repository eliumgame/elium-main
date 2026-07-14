/**
 * Nodes = the Drive tree (folders + files). All names/metadata are ciphertext;
 * content blobs live in object storage as ciphertext. Every read returns the
 * caller's own wrapped key so the client can decrypt locally. The server only
 * enforces authorization and stores opaque encrypted material.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { query, queryOne, withTx } from "../db/pool.js";
import { authenticate, requireUser, requireOrgPerm, requireNodePerm, requireMembership } from "../middleware/auth.js";
import { badRequest, notFound, tooLarge, conflict, insufficientStorage } from "../lib/errors.js";
import { storage } from "../storage/adapter.js";
import { audit } from "../lib/audit.js";
import { kickRoom } from "../collab/relay.js";
import { config } from "../config.js";
import type { Readable } from "node:stream";

const hexBytes = z.string().regex(/^[0-9a-f]*$/); // hex-encoded bytea
const envelope = z.record(z.unknown()); // recipients envelope (opaque)

const keyShareSchema = z.object({
  principalType: z.enum(["user", "group", "org"]),
  principalId: z.string().uuid(),
  roleId: z.string().uuid(),
  wrappedKey: envelope,
  inheritedFrom: z.string().uuid().nullable().optional(),
});

const createSchema = z.object({
  orgId: z.string().uuid(),
  parentId: z.string().uuid().nullable().default(null),
  kind: z.enum(["folder", "file"]),
  nameEncrypted: hexBytes,
  nameNonce: hexBytes,
  metaEncrypted: hexBytes.optional(),
  metaNonce: hexBytes.optional(),
  appKind: z.string().max(24).optional(),
  keyShares: z.array(keyShareSchema).min(1).max(256),
});

const hex = (v: string) => Buffer.from(v, "hex");

/** The wrapped node key for this caller (direct user share or via a group). */
async function myKeyShare(userId: string, orgId: string, nodeId: string) {
  const groups = await query<{ group_id: string }>(
    `SELECT gm.group_id FROM group_members gm JOIN groups g ON g.id = gm.group_id
      WHERE gm.user_id = $1 AND g.org_id = $2`,
    [userId, orgId],
  );
  const groupIds = groups.map((g) => g.group_id);
  const row = await queryOne<{ principal_type: string; principal_id: string; wrapped_key: unknown; role_id: string }>(
    `SELECT principal_type, principal_id, wrapped_key, role_id
       FROM node_keys
      WHERE node_id = $1
        AND ((principal_type = 'user' AND principal_id = $2)
             OR (principal_type = 'group' AND principal_id = ANY($3::uuid[])))
      ORDER BY (principal_type = 'user') DESC
      LIMIT 1`,
    [nodeId, userId, groupIds],
  );
  return row;
}

function nodeMetaDto(n: Record<string, unknown>) {
  return {
    id: n.id,
    orgId: n.org_id,
    parentId: n.parent_id,
    kind: n.kind,
    ownerUserId: n.owner_user_id,
    nameEncrypted: n.name_encrypted ? Buffer.from(n.name_encrypted as Buffer).toString("hex") : "",
    nameNonce: n.name_nonce ? Buffer.from(n.name_nonce as Buffer).toString("hex") : "",
    metaEncrypted: n.meta_encrypted ? Buffer.from(n.meta_encrypted as Buffer).toString("hex") : null,
    metaNonce: n.meta_nonce ? Buffer.from(n.meta_nonce as Buffer).toString("hex") : null,
    appKind: n.app_kind ?? null,
    sizeBytes: n.size_bytes ?? 0,
    hasContent: !!n.content_ref,
    contentNonce: n.content_nonce ? Buffer.from(n.content_nonce as Buffer).toString("hex") : null,
    trashedAt: n.trashed_at ?? null,
    keyEpoch: n.key_epoch ?? 1,
    prevKeyWrapped: n.prev_key_wrapped ? Buffer.from(n.prev_key_wrapped as Buffer).toString("hex") : null,
    prevKeyNonce: n.prev_key_nonce ? Buffer.from(n.prev_key_nonce as Buffer).toString("hex") : null,
    createdAt: n.created_at,
    modifiedAt: n.modified_at,
  };
}

async function validateRole(roleId: string, orgId: string): Promise<void> {
  const r = await queryOne(`SELECT id FROM roles WHERE id = $1 AND (org_id = $2 OR org_id IS NULL)`, [roleId, orgId]);
  if (!r) throw badRequest("Rôle invalide pour cette organisation.");
}

export default async function nodeRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // --- Create a folder or file (metadata + key shares) ---------------------
  app.post("/", async (req) => {
    const b = createSchema.parse(req.body);
    const user = requireUser(req);

    if (b.parentId) {
      const parent = await requireNodePerm(req, b.parentId, "node.create");
      if (parent.orgId !== b.orgId) throw badRequest("Organisation incohérente avec le parent.");
    } else {
      await requireOrgPerm(req, b.orgId, "space.create");
    }

    // The creator must retain access to their own node.
    if (!b.keyShares.some((s) => s.principalType === "user" && s.principalId === user.id)) {
      throw badRequest("Le créateur doit conserver une clé d'accès (part de clé manquante).");
    }
    for (const s of b.keyShares) await validateRole(s.roleId, b.orgId);

    const created = await withTx(async (c) => {
      const { rows } = await c.query(
        `INSERT INTO nodes (org_id, parent_id, kind, owner_user_id, name_encrypted, name_nonce,
                            meta_encrypted, meta_nonce, app_kind, modified_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$4)
         RETURNING *`,
        [
          b.orgId,
          b.parentId,
          b.kind,
          user.id,
          hex(b.nameEncrypted),
          hex(b.nameNonce),
          b.metaEncrypted ? hex(b.metaEncrypted) : null,
          b.metaNonce ? hex(b.metaNonce) : null,
          b.appKind ?? null,
        ],
      );
      const node = rows[0];
      for (const s of b.keyShares) {
        await c.query(
          `INSERT INTO node_keys (node_id, principal_type, principal_id, role_id, wrapped_key, granted_by, inherited_from)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [node.id, s.principalType, s.principalId, s.roleId, JSON.stringify(s.wrappedKey), user.id, s.inheritedFrom ?? null],
        );
      }
      return node;
    });

    await audit(b.orgId, user.id, "node.create", b.kind, created.id, { parentId: b.parentId }, req.ip);
    return { node: nodeMetaDto(created) };
  });

  // --- Get one node (metadata + my wrapped key) ----------------------------
  app.get("/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const access = await requireNodePerm(req, id, "node.view");
    const user = requireUser(req);
    const node = await queryOne(`SELECT * FROM nodes WHERE id = $1`, [id]);
    if (!node) throw notFound();
    const share = await myKeyShare(user.id, access.orgId, id);
    return {
      node: nodeMetaDto(node),
      myWrappedKey: share?.wrapped_key ?? null,
      permissions: [...access.permissions],
    };
  });

  // --- List children of a node (or org roots when parentId omitted) --------
  app.get("/", async (req) => {
    const q = z
      .object({
        orgId: z.string().uuid(),
        parentId: z.string().uuid().optional(),
        trashed: z.enum(["true", "false"]).default("false"),
      })
      .parse(req.query);
    const user = requireUser(req);
    const trashedFilter = q.trashed === "true" ? "IS NOT NULL" : "IS NULL";

    if (q.parentId) {
      await requireNodePerm(req, q.parentId, "node.view");
    } else {
      // Any active member may list root nodes; the LATERAL join below only ever
      // returns nodes the caller actually holds a key for. (member.view gates
      // the people directory, not file access.)
      await requireMembership(req, q.orgId);
    }

    // Children the caller can decrypt (has a node_keys row for user or group).
    const groups = await query<{ group_id: string }>(
      `SELECT gm.group_id FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE gm.user_id = $1 AND g.org_id = $2`,
      [user.id, q.orgId],
    );
    const groupIds = groups.map((g) => g.group_id);

    const rows = await query(
      `SELECT n.*, nk.wrapped_key AS my_wrapped_key
         FROM nodes n
         JOIN LATERAL (
            SELECT wrapped_key FROM node_keys k
             WHERE k.node_id = n.id
               AND ((k.principal_type = 'user' AND k.principal_id = $1)
                    OR (k.principal_type = 'group' AND k.principal_id = ANY($4::uuid[])))
             ORDER BY (k.principal_type = 'user') DESC LIMIT 1
         ) nk ON true
        WHERE n.org_id = $2
          AND n.parent_id IS NOT DISTINCT FROM $3
          AND n.trashed_at ${trashedFilter}
        ORDER BY n.kind DESC, n.created_at`,
      [user.id, q.orgId, q.parentId ?? null, groupIds],
    );

    return {
      nodes: rows.map((r) => ({ ...nodeMetaDto(r), myWrappedKey: r.my_wrapped_key ?? null })),
    };
  });

  // --- Rename / move / update meta -----------------------------------------
  const patchSchema = z.object({
    nameEncrypted: hexBytes.optional(),
    nameNonce: hexBytes.optional(),
    metaEncrypted: hexBytes.optional(),
    metaNonce: hexBytes.optional(),
    parentId: z.string().uuid().nullable().optional(),
  });
  app.patch("/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = patchSchema.parse(req.body);
    const user = requireUser(req);

    if (b.nameEncrypted !== undefined || b.metaEncrypted !== undefined) {
      await requireNodePerm(req, id, "node.rename");
    }
    const isMove = b.parentId !== undefined;
    if (isMove) {
      const access = await requireNodePerm(req, id, "node.move");
      if (b.parentId) {
        const target = await requireNodePerm(req, b.parentId, "node.create");
        if (target.orgId !== access.orgId) throw badRequest("Déplacement inter-organisation interdit.");
        if (b.parentId === id) throw badRequest("Un nœud ne peut pas être son propre parent.");
      }
    }

    const sets: string[] = ["modified_at = now()", "modified_by = $2"];
    const params: unknown[] = [id, user.id];
    let i = 3;
    if (b.nameEncrypted !== undefined) {
      sets.push(`name_encrypted = $${i++}`, `name_nonce = $${i++}`);
      params.push(hex(b.nameEncrypted), hex(b.nameNonce ?? ""));
    }
    if (b.metaEncrypted !== undefined) {
      sets.push(`meta_encrypted = $${i++}`, `meta_nonce = $${i++}`);
      params.push(hex(b.metaEncrypted), hex(b.metaNonce ?? ""));
    }
    if (b.parentId !== undefined) {
      sets.push(`parent_id = $${i++}`);
      params.push(b.parentId);
    }

    const node = await withTx(async (c) => {
      const { rows } = await c.query(`UPDATE nodes SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params);
      if (!rows[0]) throw notFound();
      if (isMove) {
        // A folder-inherited ACL grant is materialized (fanned out) onto every
        // descendant at share time (see the deep-share flow) — moving a node
        // out of that ancestor's subtree must not leave those rows behind, or
        // a principal who only had access via the OLD ancestor share keeps a
        // live node_keys row (and live decrypt capability via its wrapped
        // key) after the node moved somewhere they were never granted access
        // to. Direct grants made specifically on this subtree
        // (inherited_from IS NULL — including the owner's own key row) are
        // kept; re-sharing at the new location is a separate, explicit action.
        await c.query(
          `WITH RECURSIVE sub AS (
             SELECT id FROM nodes WHERE id = $1
             UNION ALL
             SELECT n.id FROM nodes n JOIN sub ON n.parent_id = sub.id
           )
           DELETE FROM node_keys WHERE node_id IN (SELECT id FROM sub) AND inherited_from IS NOT NULL`,
          [id],
        );
      }
      return rows[0];
    });
    await audit(node.org_id as string, user.id, "node.update", node.kind as string, id, {}, req.ip);
    return { node: nodeMetaDto(node) };
  });

  // --- Trash / restore -----------------------------------------------------
  app.delete("/:id", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const access = await requireNodePerm(req, id, "node.delete");
    const user = requireUser(req);
    await query(`UPDATE nodes SET trashed_at = now() WHERE id = $1 AND trashed_at IS NULL`, [id]);
    await audit(access.orgId, user.id, "node.trash", access.kind, id, {}, req.ip);
    return { ok: true };
  });

  app.post("/:id/restore", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const access = await requireNodePerm(req, id, "node.restore");
    const user = requireUser(req);
    await query(`UPDATE nodes SET trashed_at = NULL WHERE id = $1`, [id]);
    await audit(access.orgId, user.id, "node.restore", access.kind, id, {}, req.ip);
    return { ok: true };
  });

  // --- Trash: all trashed nodes in the org the caller can decrypt ----------
  app.get("/trash", async (req) => {
    const q = z.object({ orgId: z.string().uuid() }).parse(req.query);
    const user = requireUser(req);
    await requireMembership(req, q.orgId); // LATERAL join scopes to decryptable nodes
    const groups = await query<{ group_id: string }>(
      `SELECT gm.group_id FROM group_members gm JOIN groups g ON g.id = gm.group_id
        WHERE gm.user_id = $1 AND g.org_id = $2`,
      [user.id, q.orgId],
    );
    const groupIds = groups.map((g) => g.group_id);
    const rows = await query(
      `SELECT n.*, nk.wrapped_key AS my_wrapped_key
         FROM nodes n
         JOIN LATERAL (
            SELECT wrapped_key FROM node_keys k
             WHERE k.node_id = n.id
               AND ((k.principal_type = 'user' AND k.principal_id = $1)
                    OR (k.principal_type = 'group' AND k.principal_id = ANY($3::uuid[])))
             ORDER BY (k.principal_type = 'user') DESC LIMIT 1
         ) nk ON true
        WHERE n.org_id = $2 AND n.trashed_at IS NOT NULL
        ORDER BY n.trashed_at DESC`,
      [user.id, q.orgId, groupIds],
    );
    return { nodes: rows.map((r) => ({ ...nodeMetaDto(r), myWrappedKey: r.my_wrapped_key ?? null })) };
  });

  // --- Permanently delete a trashed node (empties the trash) ---------------
  app.delete("/:id/purge", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const access = await requireNodePerm(req, id, "node.restore");
    const user = requireUser(req);
    const node = await queryOne<{ trashed_at: string | null; content_ref: string | null }>(
      `SELECT trashed_at, content_ref FROM nodes WHERE id = $1`,
      [id],
    );
    if (!node) throw notFound();
    if (!node.trashed_at) throw badRequest("Le nœud doit d'abord être dans la corbeille.");
    // Best-effort blob cleanup (current + versions), then cascade-delete the row.
    const versions = await query<{ content_ref: string }>(`SELECT content_ref FROM node_versions WHERE node_id = $1`, [id]);
    const store = storage();
    for (const v of versions) await store.delete(v.content_ref).catch(() => {});
    if (node.content_ref) await store.delete(node.content_ref).catch(() => {});
    await query(`DELETE FROM nodes WHERE id = $1`, [id]);
    await audit(access.orgId, user.id, "node.purge", access.kind, id, {}, req.ip);
    return { ok: true };
  });

  // --- Key rotation (revocation hardening) ----------------------------------
  // Client-driven CEK rotation: the caller (who must hold the current CEK and
  // both ACL-management permissions) submits the name/meta re-encrypted under a
  // FRESH CEK plus the COMPLETE new crypto-ACL (the CEK wrapped to every
  // remaining principal). In one transaction the server replaces all key rows,
  // bumps `key_epoch`, and revokes active share links (their wrapped keys hold
  // the old CEK and cannot be re-wrapped: envelopes only carry fingerprints).
  // Content/version blobs are then re-encrypted via PUT /:id/versions/:vid/content,
  // and collab logs compacted via POST /api/collab/:id/compact.
  const rotateSchema = z.object({
    nameEncrypted: hexBytes.min(2),
    nameNonce: hexBytes.min(2),
    metaEncrypted: hexBytes.optional(),
    metaNonce: hexBytes.optional(),
    // Old CEK encrypted under the new CEK (crash-resilient rotation, see schema).
    prevKeyWrapped: hexBytes.optional(),
    prevKeyNonce: hexBytes.optional(),
    expectedEpoch: z.number().int().positive().optional(),
    keyShares: z.array(keyShareSchema).min(1).max(256),
  });
  app.post("/:id/rotate", async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = rotateSchema.parse(req.body);
    const user = requireUser(req);

    const access = await requireNodePerm(req, id, "node.acl.manage");
    await requireNodePerm(req, id, "node.share.manage");

    // The node owner must never be locked out by a rotation.
    if (!b.keyShares.some((s) => s.principalType === "user" && s.principalId === access.ownerUserId)) {
      throw badRequest("Le propriétaire du nœud doit conserver une part de clé.");
    }
    for (const s of b.keyShares) await validateRole(s.roleId, access.orgId);

    const { node, revokedLinks } = await withTx(async (c) => {
      const { rows: cur } = await c.query(`SELECT key_epoch FROM nodes WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur[0]) throw notFound();
      if (b.expectedEpoch !== undefined && cur[0].key_epoch !== b.expectedEpoch) {
        throw conflict("La clé du nœud a déjà tourné (époque obsolète) — rechargez puis réessayez.");
      }
      await c.query(`DELETE FROM node_keys WHERE node_id = $1`, [id]);
      for (const s of b.keyShares) {
        await c.query(
          `INSERT INTO node_keys (node_id, principal_type, principal_id, role_id, wrapped_key, granted_by, inherited_from)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [id, s.principalType, s.principalId, s.roleId, JSON.stringify(s.wrappedKey), user.id, s.inheritedFrom ?? null],
        );
      }
      const { rows: links } = await c.query(
        `UPDATE share_links SET revoked_at = now() WHERE node_id = $1 AND revoked_at IS NULL RETURNING id`,
        [id],
      );
      const { rows } = await c.query(
        `UPDATE nodes
            SET name_encrypted = $2, name_nonce = $3,
                meta_encrypted = $4, meta_nonce = $5,
                prev_key_wrapped = $6, prev_key_nonce = $7,
                key_epoch = key_epoch + 1, modified_at = now(), modified_by = $8
          WHERE id = $1 RETURNING *`,
        [
          id,
          hex(b.nameEncrypted),
          hex(b.nameNonce),
          b.metaEncrypted ? hex(b.metaEncrypted) : null,
          b.metaNonce ? hex(b.metaNonce) : null,
          b.prevKeyWrapped ? hex(b.prevKeyWrapped) : null,
          b.prevKeyNonce ? hex(b.prevKeyNonce) : null,
          user.id,
        ],
      );
      return { node: rows[0], revokedLinks: links.length };
    });

    // Every connected peer holds the OLD key: evict, they reconnect and re-fetch.
    kickRoom(id);

    await audit(access.orgId, user.id, "node.key.rotate", access.kind, id, { keyEpoch: node.key_epoch, revokedLinks }, req.ip);
    return { node: nodeMetaDto(node), revokedLinks };
  });

  // --- Content: upload (encrypted blob) ------------------------------------
  // Body is raw application/octet-stream ciphertext; the 12-byte GCM nonce is
  // sent in the `x-content-nonce` header (hex). A version snapshot is recorded.
  // Optional `x-key-epoch` header: rejected with 409 when it no longer matches
  // the node (the key rotated while this writer still held the old CEK).
  app.put("/:id/content", async (req: FastifyRequest) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const access = await requireNodePerm(req, id, "node.edit");
    const user = requireUser(req);
    if (access.kind !== "file") throw badRequest("Seuls les fichiers ont un contenu.");

    const nonceHex = String(req.headers["x-content-nonce"] ?? "");
    if (!/^[0-9a-f]{24}$/.test(nonceHex)) throw badRequest("En-tête x-content-nonce invalide (nonce 12 octets hex).");
    const body = req.body as Readable | undefined;
    if (!body || typeof body.pipe !== "function") throw badRequest("Corps binaire attendu (application/octet-stream).");

    // Stream straight to storage (no full buffering); size is enforced + tallied.
    const store = storage();
    const key = store.newKey();
    let size: number;
    try {
      size = await store.putStream(key, body, config.maxBlobBytes);
    } catch (err) {
      await store.delete(key).catch(() => {});
      if (err instanceof Error && err.message === "payload_too_large") throw tooLarge();
      throw err;
    }

    const epochHeader = String(req.headers["x-key-epoch"] ?? "");
    const updated = await withTx(async (c) => {
      const { rows: cur } = await c.query(`SELECT key_epoch FROM nodes WHERE id = $1 FOR UPDATE`, [id]);
      if (!cur[0]) throw notFound();
      if (epochHeader && Number(epochHeader) !== cur[0].key_epoch) {
        throw conflict("La clé du nœud a tourné — récupérez la nouvelle clé avant d'écrire.");
      }
      // Storage quota: a new version ADDS `size` bytes (prior versions are kept).
      // NULL quota = unlimited. Checked in-tx just before the version is recorded.
      // The lock above is per-NODE, not per-org, so two concurrent uploads to
      // TWO DIFFERENT nodes of the same org would otherwise both read `used`
      // before either commits and both pass the check, overrunning the quota.
      // An org-scoped advisory lock serializes the check+insert critical
      // section across nodes; it auto-releases at transaction end/rollback.
      await c.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [access.orgId]);
      const { rows: q } = await c.query(
        `SELECT o.storage_quota_bytes AS quota,
                COALESCE((SELECT SUM(v.size_bytes) FROM node_versions v
                           JOIN nodes n2 ON n2.id = v.node_id WHERE n2.org_id = o.id), 0) AS used
           FROM organizations o WHERE o.id = $1`,
        [access.orgId],
      );
      const quota = q[0]?.quota as number | null;
      const used = Number(q[0]?.used ?? 0);
      if (quota != null && used + size > Number(quota)) {
        throw insufficientStorage(
          `Quota atteint : ${used + size} octets requis pour ${Number(quota)} alloués.`,
        );
      }
      const { rows: vrows } = await c.query(
        `SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM node_versions WHERE node_id = $1`,
        [id],
      );
      const versionNo = vrows[0].next as number;
      const { rows: ver } = await c.query(
        `INSERT INTO node_versions (node_id, version_no, content_ref, content_nonce, size_bytes, created_by, key_epoch)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [id, versionNo, key, hex(nonceHex), size, user.id, cur[0].key_epoch],
      );
      const { rows } = await c.query(
        `UPDATE nodes SET content_ref = $2, content_nonce = $3, size_bytes = $4,
                          current_version_id = $5, modified_at = now(), modified_by = $6
          WHERE id = $1 RETURNING *`,
        [id, key, hex(nonceHex), size, ver[0].id, user.id],
      );
      return rows[0];
    }).catch(async (err) => {
      // The blob was already streamed to storage: clean it up on rejection.
      await store.delete(key).catch(() => {});
      throw err;
    });

    await audit(access.orgId, user.id, "node.content.update", "file", id, { size }, req.ip);
    return { node: nodeMetaDto(updated) };
  });

  // --- Content: download (encrypted blob) ----------------------------------
  app.get("/:id/content", async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await requireNodePerm(req, id, "node.download");
    const node = await queryOne<{ content_ref: string | null; content_nonce: Buffer | null }>(
      `SELECT content_ref, content_nonce FROM nodes WHERE id = $1`,
      [id],
    );
    if (!node?.content_ref) throw notFound("Aucun contenu.");
    reply.header("content-type", "application/octet-stream");
    if (node.content_nonce) reply.header("x-content-nonce", Buffer.from(node.content_nonce).toString("hex"));
    return reply.send(await storage().getStream(node.content_ref));
  });
}
