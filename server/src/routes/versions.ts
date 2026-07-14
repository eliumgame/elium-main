/**
 * File version history. Every content upload records a `node_versions` snapshot
 * (see nodes.ts PUT /:id/content). This module lets an authorized caller list a
 * node's versions, download the ciphertext of a past version, and restore one as
 * the node's current content. Blob bytes stay opaque AES-256-GCM ciphertext; the
 * server only enforces authorization and moves references around.
 *
 * Mounted under the "/api" prefix (see app.ts), so routes resolve to
 * /api/nodes/:id/versions...
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { query, queryOne, withTx } from "../db/pool.js";
import { authenticate, requireUser, requireNodePerm } from "../middleware/auth.js";
import { notFound, badRequest, tooLarge } from "../lib/errors.js";
import { storage } from "../storage/adapter.js";
import { audit } from "../lib/audit.js";
import { config } from "../config.js";
import type { Readable } from "node:stream";

const idParams = z.object({ id: z.string().uuid() });
const versionParams = z.object({ id: z.string().uuid(), versionId: z.string().uuid() });

function versionDto(v: Record<string, unknown>) {
  return {
    id: v.id,
    versionNo: v.version_no,
    sizeBytes: v.size_bytes ?? 0,
    keyEpoch: v.key_epoch ?? 1,
    createdBy: v.created_by ?? null,
    createdByEmail: v.created_by_email ?? null,
    createdByName: v.created_by_name ?? null,
    createdAt: v.created_at,
  };
}

export default async function versionRoutes(app: FastifyInstance): Promise<void> {
  app.addHook("preHandler", authenticate);

  // --- List a node's versions (newest first) -------------------------------
  app.get("/nodes/:id/versions", async (req) => {
    const { id } = idParams.parse(req.params);
    await requireNodePerm(req, id, "node.version.view");

    const rows = await query(
      `SELECT v.id, v.version_no, v.size_bytes, v.key_epoch, v.created_by, v.created_at,
              u.email AS created_by_email, u.display_name AS created_by_name
         FROM node_versions v
         LEFT JOIN users u ON u.id = v.created_by
        WHERE v.node_id = $1
        ORDER BY v.version_no DESC`,
      [id],
    );
    return { versions: rows.map(versionDto) };
  });

  // --- Download the ciphertext of a specific version -----------------------
  // The 12-byte GCM nonce is returned in the `x-content-nonce` header (hex).
  app.get("/nodes/:id/versions/:versionId/content", async (req, reply) => {
    const { id, versionId } = versionParams.parse(req.params);
    await requireNodePerm(req, id, "node.version.view");

    const version = await queryOne<{ content_ref: string; content_nonce: Buffer }>(
      `SELECT content_ref, content_nonce FROM node_versions WHERE id = $1 AND node_id = $2`,
      [versionId, id],
    );
    if (!version) throw notFound();

    reply.header("content-type", "application/octet-stream");
    reply.header("x-content-nonce", Buffer.from(version.content_nonce).toString("hex"));
    return reply.send(await storage().getStream(version.content_ref));
  });

  // --- Re-encrypt a version's blob in place (key rotation only) ------------
  // After a CEK rotation, every historical blob is still ciphertext under the
  // OLD key. The rotating client downloads each version, re-encrypts it under
  // the new CEK and swaps the blob here — same version number, no new version
  // row. Gated on `node.acl.manage` (the rotation permission), and the version
  // row is stamped with the node's CURRENT key epoch.
  app.put("/nodes/:id/versions/:versionId/content", async (req, reply) => {
    const { id, versionId } = versionParams.parse(req.params);
    const access = await requireNodePerm(req, id, "node.acl.manage");
    const user = requireUser(req);

    const nonceHex = String(req.headers["x-content-nonce"] ?? "");
    if (!/^[0-9a-f]{24}$/.test(nonceHex)) throw badRequest("En-tête x-content-nonce invalide (nonce 12 octets hex).");
    const body = req.body as Readable | undefined;
    if (!body || typeof body.pipe !== "function") throw badRequest("Corps binaire attendu (application/octet-stream).");

    const store = storage();
    const newRef = store.newKey();
    try {
      await store.putStream(newRef, body, config.maxBlobBytes);
    } catch (err) {
      await store.delete(newRef).catch(() => {});
      if (err instanceof Error && err.message === "payload_too_large") throw tooLarge();
      throw err;
    }

    const oldRef = await withTx(async (c) => {
      const { rows: nrows } = await c.query(
        `SELECT key_epoch, current_version_id FROM nodes WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!nrows[0]) throw notFound();
      const { rows: old } = await c.query(
        `SELECT content_ref FROM node_versions WHERE id = $1 AND node_id = $2 FOR UPDATE`,
        [versionId, id],
      );
      if (!old[0]) throw notFound("Version introuvable.");
      await c.query(
        `UPDATE node_versions SET content_ref = $3, content_nonce = $4, key_epoch = $5
          WHERE id = $1 AND node_id = $2`,
        [versionId, id, newRef, Buffer.from(nonceHex, "hex"), nrows[0].key_epoch],
      );
      // Keep the node's current-content pointer coherent when this version IS
      // the current one.
      if (nrows[0].current_version_id === versionId) {
        await c.query(
          `UPDATE nodes SET content_ref = $2, content_nonce = $3, modified_at = now(), modified_by = $4 WHERE id = $1`,
          [id, newRef, Buffer.from(nonceHex, "hex"), user.id],
        );
      }
      return old[0].content_ref as string | null;
    }).catch(async (err) => {
      await store.delete(newRef).catch(() => {});
      throw err;
    });

    if (oldRef) await store.delete(oldRef).catch(() => {});
    await audit(access.orgId, user.id, "node.key.rotate.content", access.kind, id, { versionId }, req.ip);
    reply.header("x-content-nonce", nonceHex);
    return { ok: true };
  });

  // --- Restore a past version as the node's current content ----------------
  app.post("/nodes/:id/versions/:versionId/restore", async (req) => {
    const { id, versionId } = versionParams.parse(req.params);
    const access = await requireNodePerm(req, id, "node.version.restore");
    const user = requireUser(req);

    const version = await queryOne<{
      content_ref: string;
      content_nonce: Buffer;
      size_bytes: number;
    }>(`SELECT content_ref, content_nonce, size_bytes FROM node_versions WHERE id = $1 AND node_id = $2`, [
      versionId,
      id,
    ]);
    if (!version) throw notFound();

    const node = await withTx(async (c) => {
      const { rows } = await c.query(
        `UPDATE nodes
            SET content_ref = $2, content_nonce = $3, size_bytes = $4,
                current_version_id = $5, modified_at = now(), modified_by = $6
          WHERE id = $1
          RETURNING id, size_bytes, content_nonce, modified_at`,
        [id, version.content_ref, version.content_nonce, version.size_bytes, versionId, user.id],
      );
      return rows[0];
    });
    if (!node) throw notFound();

    await audit(access.orgId, user.id, "node.version.restore", access.kind, id, { versionId }, req.ip);

    return {
      node: {
        id: node.id,
        sizeBytes: node.size_bytes ?? 0,
        contentNonce: node.content_nonce ? Buffer.from(node.content_nonce as Buffer).toString("hex") : null,
        modifiedAt: node.modified_at,
      },
    };
  });
}
