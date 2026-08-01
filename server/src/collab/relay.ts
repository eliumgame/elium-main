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
import { config } from "../config.js";

// Plafond de la longueur du ciphertext hex (2 caractères hex par octet).
const MAX_CIPHERTEXT_HEX = config.maxCollabMessageBytes * 2;
// Le champ awareness (présence) est ré-émis à tous les pairs : on le borne aussi
// pour éviter une amplification, avec une marge confortable pour un curseur/état.
const MAX_AWARENESS_CHARS = 64 * 1024;

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
  // Fenêtre glissante 1 s pour le plafond de débit par connexion (anti-flood).
  msgCount: number;
  windowStart: number;
}

// nodeId -> set of connected peers.
const rooms = new Map<string, Set<Peer>>();

// userId -> nombre de connexions WS collab simultanées. Un compte ne peut pas
// ouvrir un nombre illimité de sockets (épuisement mémoire/connexions DB) ; la
// borne est large pour un usage réel (onglets/appareils/documents multiples).
const connectionsByUser = new Map<string, number>();

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

    // Plafond de connexions simultanées par utilisateur (anti-épuisement).
    const open = connectionsByUser.get(claims.sub) ?? 0;
    if (open >= config.maxCollabConnectionsPerUser) {
      socket.close(1013, "too many connections");
      return;
    }
    connectionsByUser.set(claims.sub, open + 1);

    const peer: Peer = { socket, userId: claims.sub, canWrite: access.permissions.has("node.edit"), msgCount: 0, windowStart: Date.now() };
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
        // Plafond de débit par connexion (fenêtre glissante 1 s). Un pair qui
        // inonde le relais (et la base, via les inserts d'update) est fermé ; il
        // se reconnecte et re-synchronise via le backlog. Le seuil est très
        // au-dessus d'une frappe humaine, donc l'édition normale n'est jamais
        // affectée.
        const now = Date.now();
        if (now - peer.windowStart >= 1000) { peer.windowStart = now; peer.msgCount = 0; }
        if (++peer.msgCount > config.maxCollabMessagesPerSec) {
          try { socket.close(1013, "rate limited"); } catch { /* déjà fermé */ }
          return;
        }
        const text = String(raw);
        // Garde de taille défensive (le maxPayload du serveur WS borne déjà le
        // frame ; ceci reste une double sécurité côté application).
        if (text.length > MAX_CIPHERTEXT_HEX + 4096) return;
        let msg: { type?: string; ciphertext?: string; nonce?: string; payload?: unknown };
        try {
          msg = JSON.parse(text) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === "update") {
          if (!peer.canWrite) return;
          const ct = msg.ciphertext ?? "";
          const nonce = msg.nonce ?? "";
          // Rejeter un ciphertext hors-bornes (anti-DoS mémoire/base) ou mal formé.
          if (ct.length > MAX_CIPHERTEXT_HEX) return;
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
          // La présence est ré-émise à tous les pairs : borner pour éviter une
          // amplification (un pair envoie 1× une charge géante → N× sur le fil).
          const payload = msg.payload as { u?: unknown } | undefined;
          if (payload && typeof payload.u === "string" && payload.u.length > MAX_AWARENESS_CHARS) return;
          broadcast(nodeId, peer, { type: "awareness", from: peer.userId, payload: msg.payload });
        }
      })();
    });

    // `close` ET `error` peuvent tous deux se déclencher : le drapeau garantit un
    // seul décrément du compteur par utilisateur (sinon il dériverait vers le
    // négatif et le plafond ne tiendrait plus).
    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      const r = rooms.get(nodeId);
      if (r) { r.delete(peer); if (r.size === 0) rooms.delete(nodeId); }
      const n = (connectionsByUser.get(peer.userId) ?? 1) - 1;
      if (n <= 0) connectionsByUser.delete(peer.userId);
      else connectionsByUser.set(peer.userId, n);
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
