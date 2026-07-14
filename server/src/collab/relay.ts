/**
 * End-to-end-encrypted collaboration relay. The server is an OPAQUE relay: it
 * never runs Yjs and never decrypts. It gates room access by RBAC, broadcasts
 * encrypted updates to peers, and appends them to `collab_updates` so late
 * joiners can catch up (fetched via the REST backlog route or streamed by the
 * client). Encryption/decryption of updates happens entirely on the clients,
 * under the node key.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { query, queryOne, withTx } from "../db/pool.js";
import { verifyAccessToken } from "../lib/tokens.js";
import { authenticate, requireUser, requireNodePerm } from "../middleware/auth.js";
import { resolveNodeAccess } from "../rbac/engine.js";
import { badRequest } from "../lib/errors.js";
import { audit } from "../lib/audit.js";

/** Minimal structural type for the ws socket (avoids a hard dep on `ws` types). */
interface WsConn {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

interface Peer {
  socket: WsConn;
  userId: string;
  canWrite: boolean;
}

// nodeId -> set of connected peers.
const rooms = new Map<string, Set<Peer>>();

/**
 * Force every peer out of a room (key rotation / revocation). Survivors
 * reconnect, re-resolve their ACL and re-fetch their wrapped key; a revoked
 * peer fails the RBAC gate on reconnection. Close code 4001 tells the client
 * this is a rekey, not a network failure.
 */
export function kickRoom(nodeId: string, reason = "rekeyed"): void {
  const room = rooms.get(nodeId);
  if (!room) return;
  for (const peer of room) {
    try {
      peer.socket.close(4001, reason);
    } catch {
      /* already gone */
    }
  }
  rooms.delete(nodeId);
}

function broadcast(nodeId: string, from: Peer, message: unknown): void {
  const room = rooms.get(nodeId);
  if (!room) return;
  const data = JSON.stringify(message);
  for (const peer of room) {
    if (peer === from) continue;
    try {
      peer.socket.send(data);
    } catch {
      /* peer will be cleaned up on its own close */
    }
  }
}

export async function registerCollab(app: FastifyInstance): Promise<void> {
  // --- WebSocket room ------------------------------------------------------
  const wsHandler = async (socket: WsConn, req: FastifyRequest) => {
    const nodeId = (req.params as { nodeId?: string }).nodeId ?? "";
    const token = (req.query as { token?: string }).token ?? "";

    const claims = verifyAccessToken(token);
    if (!claims || !/^[0-9a-fA-F-]{36}$/.test(nodeId)) {
      socket.close(1008, "unauthorized");
      return;
    }
    const access = await resolveNodeAccess(claims.sub, nodeId).catch(() => null);
    if (!access || !access.accessible || !access.permissions.has("node.view")) {
      socket.close(1008, "forbidden");
      return;
    }

    const peer: Peer = { socket, userId: claims.sub, canWrite: access.permissions.has("node.edit") };
    let room = rooms.get(nodeId);
    if (!room) {
      room = new Set<Peer>();
      rooms.set(nodeId, room);
    }
    room.add(peer);
    try {
      socket.send(JSON.stringify({ type: "ready", canWrite: peer.canWrite }));
    } catch {
      /* ignore */
    }
    // Tell existing peers a newcomer joined so they re-broadcast their presence
    // (awareness is opaque to the relay, so it can't replay it itself).
    broadcast(nodeId, peer, { type: "peer-join", from: peer.userId });

    socket.on("message", (raw: unknown) => {
      void (async () => {
        let msg: { type?: string; ciphertext?: string; nonce?: string; payload?: unknown };
        try {
          msg = JSON.parse(String(raw)) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === "update") {
          if (!peer.canWrite) return;
          const ct = msg.ciphertext ?? "";
          const nonce = msg.nonce ?? "";
          if (!/^[0-9a-f]+$/i.test(ct) || !/^[0-9a-f]{24}$/i.test(nonce)) return;
          try {
            const inserted = await queryOne<{ id: number }>(
              `INSERT INTO collab_updates (node_id, update_ciphertext, update_nonce, author_user_id)
               VALUES ($1, $2, $3, $4) RETURNING id`,
              [nodeId, Buffer.from(ct, "hex"), Buffer.from(nonce, "hex"), peer.userId],
            );
            broadcast(nodeId, peer, {
              type: "update",
              seq: inserted?.id ?? null,
              ciphertext: ct,
              nonce,
              author: peer.userId,
            });
          } catch {
            /* transient DB error — the client can re-sync via backlog */
          }
        } else if (msg.type === "awareness") {
          broadcast(nodeId, peer, { type: "awareness", from: peer.userId, payload: msg.payload });
        }
      })();
    });

    const cleanup = () => {
      const r = rooms.get(nodeId);
      if (!r) return;
      r.delete(peer);
      if (r.size === 0) rooms.delete(nodeId);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  };

  // Options/handler cast: @fastify/websocket handler typing varies across
  // versions; the runtime contract (socket, request) is stable.
  app.get("/api/collab/:nodeId", { websocket: true } as never, wsHandler as never);

  // --- Compaction (key rotation) --------------------------------------------
  // Replaces the whole update log with ONE snapshot encrypted under the NEW
  // node key, then kicks the room so every peer reconnects and re-fetches its
  // wrapped key. The snapshot is opaque ciphertext like any other update.
  app.post(
    "/api/collab/:nodeId/compact",
    { preHandler: authenticate },
    async (req: FastifyRequest) => {
      const nodeId = (req.params as { nodeId: string }).nodeId;
      const user = requireUser(req);
      const access = await requireNodePerm(req, nodeId, "node.acl.manage");
      const body = (req.body ?? {}) as { ciphertext?: unknown; nonce?: unknown };
      const ct = typeof body.ciphertext === "string" ? body.ciphertext : "";
      const nonce = typeof body.nonce === "string" ? body.nonce : "";
      if (!/^[0-9a-f]+$/i.test(ct) || !/^[0-9a-f]{24}$/i.test(nonce)) {
        throw badRequest("Snapshot invalide (ciphertext/nonce hex attendus).");
      }
      const seq = await withTx(async (c) => {
        await c.query(`DELETE FROM collab_updates WHERE node_id = $1`, [nodeId]);
        const { rows } = await c.query(
          `INSERT INTO collab_updates (node_id, update_ciphertext, update_nonce, author_user_id)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [nodeId, Buffer.from(ct, "hex"), Buffer.from(nonce, "hex"), user.id],
        );
        return rows[0]?.id as number;
      });
      kickRoom(nodeId);
      await audit(access.orgId, user.id, "collab.compact", access.kind, nodeId, { seq }, req.ip);
      return { seq };
    },
  );

  // --- REST backlog (catch-up) --------------------------------------------
  app.get(
    "/api/collab/:nodeId/updates",
    { preHandler: authenticate },
    async (req: FastifyRequest) => {
      const nodeId = (req.params as { nodeId: string }).nodeId;
      await requireNodePerm(req, nodeId, "node.view");
      const since = Number((req.query as { since?: string }).since ?? 0) || 0;
      const rows = await query<{
        id: number;
        update_ciphertext: Buffer;
        update_nonce: Buffer;
        author_user_id: string | null;
        created_at: string;
      }>(
        `SELECT id, update_ciphertext, update_nonce, author_user_id, created_at
           FROM collab_updates
          WHERE node_id = $1 AND id > $2
          ORDER BY id ASC
          LIMIT 5000`,
        [nodeId, since],
      );
      return {
        updates: rows.map((r) => ({
          seq: r.id,
          ciphertext: Buffer.from(r.update_ciphertext).toString("hex"),
          nonce: Buffer.from(r.update_nonce).toString("hex"),
          author: r.author_user_id,
          createdAt: r.created_at,
        })),
      };
    },
  );
}
