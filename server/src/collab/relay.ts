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
import { initBackplane, publishRelay, type RelayMsg } from "./backplane.js";

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
  kickRoomLocal(nodeId, reason);
  publishRelay({ k: "kick", nodeId, reason });
}

function kickRoomLocal(nodeId: string, reason: string): void {
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

// `from = null` → diffuse à TOUS les peers locaux (cas d'un message venu d'une
// AUTRE instance via le backplane : l'émetteur n'est pas local).
function broadcast(nodeId: string, from: Peer | null, message: unknown): void {
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

// --- Canal d'événements PAR ORGANISATION (notifications temps réel) ---------
//  Sert à rafraîchir INSTANTANÉMENT le navigateur de fichiers des membres quand
//  un nœud change (création/renommage/déplacement/corbeille/restauration), au
//  lieu d'un polling. Le message est VOLONTAIREMENT sans contenu (`nodes-changed`
//  seul) : aucune métadonnée (id/nom de dossier) ne fuit vers des membres qui
//  n'y ont pas accès ; le client se contente de re-lister son dossier courant,
//  re-filtré par RBAC côté serveur.
interface OrgPeer {
  socket: WsConn;
  userId: string;
}
const orgRooms = new Map<string, Set<OrgPeer>>();

/** Diffuse un ping « quelque chose a changé » à tous les membres connectés
 *  (local + autres instances via le backplane). */
export function notifyOrg(orgId: string): void {
  notifyOrgLocal(orgId);
  publishRelay({ k: "org", orgId });
}

function notifyOrgLocal(orgId: string): void {
  const room = orgRooms.get(orgId);
  if (!room) return;
  const data = JSON.stringify({ type: "nodes-changed" });
  for (const peer of room) {
    try {
      peer.socket.send(data);
    } catch {
      /* nettoyé à sa propre fermeture */
    }
  }
}

export async function registerCollab(app: FastifyInstance): Promise<void> {
  // Backplane multi-instance (no-op sans REDIS_URL). Les messages venus d'AUTRES
  // instances sont re-délivrés aux peers LOCAUX (from=null pour un broadcast).
  initBackplane((m: RelayMsg) => {
    if (m.k === "bcast") broadcast(m.nodeId, null, m.message);
    else if (m.k === "kick") kickRoomLocal(m.nodeId, m.reason);
    else if (m.k === "org") notifyOrgLocal(m.orgId);
  }, app.log);

  // --- WebSocket : canal d'événements de l'organisation --------------------
  const orgWsHandler = async (socket: WsConn, req: FastifyRequest) => {
    const orgId = (req.params as { orgId?: string }).orgId ?? "";
    const token = (req.query as { token?: string }).token ?? "";
    const claims = verifyAccessToken(token);
    if (!claims || !/^[0-9a-fA-F-]{36}$/.test(orgId)) {
      socket.close(1008, "unauthorized");
      return;
    }
    // Appartenance ACTIVE exigée (un membre suspendu/retiré ne reçoit rien).
    const member = await queryOne<{ ok: number }>(
      `SELECT 1 AS ok FROM memberships WHERE user_id = $1 AND org_id = $2 AND status = 'active'`,
      [claims.sub, orgId],
    ).catch(() => null);
    if (!member) {
      socket.close(1008, "forbidden");
      return;
    }
    const open = connectionsByUser.get(claims.sub) ?? 0;
    if (open >= config.maxCollabConnectionsPerUser) {
      socket.close(1013, "too many connections");
      return;
    }
    connectionsByUser.set(claims.sub, open + 1);

    const peer: OrgPeer = { socket, userId: claims.sub };
    let room = orgRooms.get(orgId);
    if (!room) {
      room = new Set<OrgPeer>();
      orgRooms.set(orgId, room);
    }
    room.add(peer);
    try {
      socket.send(JSON.stringify({ type: "ready" }));
    } catch {
      /* ignore */
    }

    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      const r = orgRooms.get(orgId);
      if (r) {
        r.delete(peer);
        if (r.size === 0) orgRooms.delete(orgId);
      }
      const n = (connectionsByUser.get(peer.userId) ?? 1) - 1;
      if (n <= 0) connectionsByUser.delete(peer.userId);
      else connectionsByUser.set(peer.userId, n);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    // Ce canal est purement descendant : on ignore tout message entrant.
  };
  app.get("/api/events/:orgId", { websocket: true } as never, orgWsHandler as never);

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

    const peer: Peer = {
      socket,
      userId: claims.sub,
      canWrite: access.permissions.has("node.edit"),
      msgCount: 0,
      windowStart: Date.now(),
    };
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
    // (awareness is opaque to the relay, so it can't replay it itself). Publié
    // aussi aux autres instances : un pair y re-émettra son awareness → le
    // nouveau venu (ici) la recevra via le backplane.
    {
      const joinMsg = { type: "peer-join", from: peer.userId };
      broadcast(nodeId, peer, joinMsg);
      publishRelay({ k: "bcast", nodeId, message: joinMsg });
    }

    socket.on("message", (raw: unknown) => {
      void (async () => {
        // Plafond de débit par connexion (fenêtre glissante 1 s). Un pair qui
        // inonde le relais (et la base, via les inserts d'update) est fermé ; il
        // se reconnecte et re-synchronise via le backlog. Le seuil est très
        // au-dessus d'une frappe humaine, donc l'édition normale n'est jamais
        // affectée.
        const now = Date.now();
        if (now - peer.windowStart >= 1000) {
          peer.windowStart = now;
          peer.msgCount = 0;
        }
        if (++peer.msgCount > config.maxCollabMessagesPerSec) {
          try {
            socket.close(1013, "rate limited");
          } catch {
            /* déjà fermé */
          }
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
            const upd = {
              type: "update",
              seq: inserted?.id ?? null,
              ciphertext: ct,
              nonce,
              author: peer.userId,
            };
            broadcast(nodeId, peer, upd);
            publishRelay({ k: "bcast", nodeId, message: upd });
          } catch {
            /* transient DB error — the client can re-sync via backlog */
          }
        } else if (msg.type === "awareness") {
          // La présence est ré-émise à tous les pairs : borner pour éviter une
          // amplification (un pair envoie 1× une charge géante → N× sur le fil).
          const payload = msg.payload as { u?: unknown } | undefined;
          if (payload && typeof payload.u === "string" && payload.u.length > MAX_AWARENESS_CHARS) return;
          const awMsg = { type: "awareness", from: peer.userId, payload: msg.payload };
          broadcast(nodeId, peer, awMsg);
          publishRelay({ k: "bcast", nodeId, message: awMsg });
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
      if (r) {
        r.delete(peer);
        if (r.size === 0) rooms.delete(nodeId);
      }
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
  app.post("/api/collab/:nodeId/compact", { preHandler: authenticate }, async (req: FastifyRequest) => {
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
  });

  // --- REST backlog (catch-up) --------------------------------------------
  app.get("/api/collab/:nodeId/updates", { preHandler: authenticate }, async (req: FastifyRequest) => {
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
  });
}
