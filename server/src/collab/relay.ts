/**
 * End-to-end-encrypted collaboration relay. The server is an OPAQUE relay: it
 * never runs Yjs and never decrypts. It gates room access by RBAC, broadcasts
 * encrypted updates to peers, and appends them to `collab_updates` so late
 * joiners can catch up (fetched via the REST backlog route or streamed by the
 * client). Encryption/decryption of updates happens entirely on the clients,
 * under the node key.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { query, queryOne, withTx } from "../db/pool.js";
import { verifyAccessToken } from "../lib/tokens.js";
import { issueWsTicket, consumeWsTicket } from "../lib/ws-tickets.js";
import { authenticate, requireUser, requireNodePerm } from "../middleware/auth.js";
import { resolveNodeAccess } from "../rbac/engine.js";
import { badRequest } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { config } from "../config.js";
import { mfaEnrollmentRequired } from "../lib/site-settings.js";
import { assertDiskSpace } from "../lib/disk.js";

/** Revalidation à l'ouverture d'une WebSocket : compte actif, jeton non révoqué (token_epoch), 2FA imposée satisfaite. */
async function socketUserAllowed(claims: { sub: string; iat: number }): Promise<boolean> {
  try {
    const u = await queryOne<{ status: string; token_epoch: string }>(
      `SELECT status, token_epoch FROM users WHERE id = $1`,
      [claims.sub],
    );
    if (!u || u.status !== "active") return false;
    if (claims.iat < Math.floor(new Date(u.token_epoch).getTime() / 1000)) return false;
    return !(await mfaEnrollmentRequired(claims.sub));
  } catch {
    return false;
  }
}
import { initBackplane, publishRelay, type RelayMsg } from "./backplane.js";

// Plafond de la longueur du ciphertext hex (2 caractères hex par octet).
const MAX_CIPHERTEXT_HEX = config.maxCollabMessageBytes * 2;
// Le champ awareness (présence) est ré-émis à tous les pairs : on le borne aussi
// pour éviter une amplification, avec une marge confortable pour un curseur/état.
const MAX_AWARENESS_CHARS = 64 * 1024;
// Corps JSON de la compaction (rotation de clé) : l'instantané COMPLET du document, chiffré, en hex
// (×2). Le plafond JSON global (1 Mio par défaut) le limitait à ~512 Kio : une présentation avec
// images échouait en 413 APRÈS la bascule de clé. On autorise ici jusqu'à 64 Mio d'instantané.
const COMPACT_BODY_LIMIT = Math.max(config.maxJsonBytes, 2 * 64 * 1024 * 1024 + 64 * 1024);

/**
 * Ferme la socket exactement quand expire le jeton d'accès qui l'a admise,
 * plutôt que de la laisser vivre indéfiniment une fois ouverte. Sans ça,
 * révoquer un rôle ou une session protège les RECONNEXIONS mais pas une
 * socket déjà admise dont le jeton a depuis naturellement expiré — l'admission
 * initiale reste la SEULE vérification faite pendant toute la durée de vie du
 * canal. Code 4002 (distinct de 4001, la révocation explicite de kickRoom/
 * kickUser). Le timer est annulé par le cleanup normal (close/error).
 */
function scheduleTokenExpiry(socket: WsConn, expSec: number): ReturnType<typeof setTimeout> {
  const ms = Math.max(0, expSec * 1000 - Date.now());
  return setTimeout(() => {
    try {
      socket.close(4002, "token-expired");
    } catch {
      /* already gone */
    }
  }, ms);
}

/** Minimal structural type for the ws socket (avoids a hard dep on `ws` types). */
interface WsConn {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

/**
 * Suit la fermeture d'une socket DÈS l'entrée du gestionnaire (synchrone, avant
 * tout `await`). Les gestionnaires font plusieurs requêtes d'admission ; si le
 * client ferme pendant ce temps, l'événement `close` est déjà passé quand on
 * enregistrait le nettoyage ensuite : le compteur de connexions et la salle
 * fuyaient pour toujours (jusqu'à « too many connections » permanent).
 * `closed` dit si la socket est déjà partie ; `onGone` branche le nettoyage
 * (exécuté immédiatement si elle l'est déjà, une seule fois sinon).
 */
function trackSocketClose(socket: WsConn): { readonly closed: boolean; onGone(fn: () => void): void } {
  let closed = false;
  let cleanup: (() => void) | null = null;
  const gone = () => {
    if (closed) return;
    closed = true;
    const fn = cleanup;
    cleanup = null;
    fn?.();
  };
  socket.on("close", gone);
  socket.on("error", gone);
  return {
    get closed() {
      return closed;
    },
    onGone(fn: () => void) {
      if (closed) fn();
      else cleanup = fn;
    },
  };
}

interface Peer {
  socket: WsConn;
  userId: string;
  orgId: string;
  canWrite: boolean;
  keyEpoch: number;
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

// --- Garde-fous de STOCKAGE du journal collab (collab_updates) --------------
// Le journal grossit à chaque update persisté ; il échappait au quota
// d'organisation, au garde-fou disque et à tout plafond en octets. Trois
// contrôles, tous en mémoire ou mis en cache pour ne pas ajouter une requête
// lourde par message :
//  1. budget d'octets par utilisateur sur une fenêtre glissante d'une minute ;
//  2. espace disque (même marge que les blobs), re-mesuré au plus toutes les 5 s ;
//  3. quota de l'organisation : versions + journal collab, usage mis en cache 30 s
//     et incrémenté localement à chaque insertion.
const collabBytesByUser = new Map<string, { windowStart: number; bytes: number }>();

function consumeCollabBytes(userId: string, bytes: number, now = Date.now()): boolean {
  let w = collabBytesByUser.get(userId);
  if (!w || now - w.windowStart >= 60_000) {
    w = { windowStart: now, bytes: 0 };
    collabBytesByUser.set(userId, w);
  }
  if (w.bytes + bytes > config.maxCollabBytesPerUserPerMinute) return false;
  w.bytes += bytes;
  return true;
}

const DISK_RECHECK_MS = 5_000;
let collabDisk = { at: 0, ok: true };

async function collabDiskAllows(bytes: number): Promise<boolean> {
  const now = Date.now();
  if (now - collabDisk.at < DISK_RECHECK_MS) return collabDisk.ok;
  let ok = true;
  try {
    await assertDiskSpace(bytes);
  } catch {
    ok = false;
  }
  collabDisk = { at: now, ok };
  return ok;
}

const ORG_USAGE_TTL_MS = 30_000;
const orgUsageCache = new Map<string, { at: number; quota: number | null; used: number }>();

async function collabQuotaAllows(orgId: string, bytes: number): Promise<boolean> {
  const now = Date.now();
  let u = orgUsageCache.get(orgId);
  if (!u || now - u.at >= ORG_USAGE_TTL_MS) {
    const row = await queryOne<{ quota: string | number | null; used: string | number | null }>(
      `SELECT o.storage_quota_bytes AS quota,
              COALESCE((SELECT SUM(v.size_bytes) FROM node_versions v
                         JOIN nodes n ON n.id = v.node_id WHERE n.org_id = o.id), 0)
            + COALESCE((SELECT SUM(octet_length(cu.update_ciphertext)) FROM collab_updates cu
                         JOIN nodes n ON n.id = cu.node_id WHERE n.org_id = o.id), 0) AS used
         FROM organizations o WHERE o.id = $1`,
      [orgId],
    );
    u = { at: now, quota: row?.quota == null ? null : Number(row.quota), used: Number(row?.used ?? 0) };
    orgUsageCache.set(orgId, u);
  }
  return u.quota == null || u.used + bytes <= u.quota;
}

function recordCollabBytes(orgId: string, bytes: number): void {
  const u = orgUsageCache.get(orgId);
  if (u) u.used += bytes;
}

/** Réinitialise les compteurs en mémoire (tests). */
export function resetCollabStorageGuardsForTests(): void {
  collabBytesByUser.clear();
  orgUsageCache.clear();
  collabDisk = { at: 0, ok: true };
}

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

/**
 * Force un utilisateur hors de TOUTES ses connexions temps réel (salles de
 * collaboration + canal d'événements d'organisation), sur toutes les instances.
 * À appeler après tout retrait de droits qui doit couper l'accès immédiatement :
 * retrait d'une organisation, d'un groupe, déprovisionnement SCIM. Un pair
 * encore légitime ailleurs se contente de se reconnecter (ré-évalue son ACL à
 * la reconnexion) ; un pair réellement révoqué échoue la porte RBAC. Même code
 * de fermeture que `kickRoom` (4001 : ce n'est pas une coupure réseau).
 */
export function kickUser(userId: string, reason = "membership-revoked"): void {
  kickUserLocal(userId, reason);
  publishRelay({ k: "kickUser", userId, reason });
}

function kickUserLocal(userId: string, reason: string): void {
  for (const room of rooms.values()) {
    for (const peer of room) {
      if (peer.userId !== userId) continue;
      try {
        peer.socket.close(4001, reason);
      } catch {
        /* already gone */
      }
    }
  }
  for (const room of orgRooms.values()) {
    for (const peer of room) {
      if (peer.userId !== userId) continue;
      try {
        peer.socket.close(4001, reason);
      } catch {
        /* already gone */
      }
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

/** Taille d'une page de rattrapage (le client boucle tant que `hasMore`). */
export const COLLAB_PAGE_SIZE = 5000;

/**
 * Identité d'une socket à l'ouverture : ticket à usage unique `?ticket=` (préféré, CLIENT-10), sinon — pendant
 * la transition, sauf `WS_ALLOW_QUERY_TOKEN=false` — l'ancien JWT d'accès en `?token=`.
 */
async function socketClaims(
  req: FastifyRequest,
  target: string,
): Promise<{ sub: string; iat: number; exp: number } | null> {
  const q = req.query as { token?: string; ticket?: string };
  if (q.ticket) return consumeWsTicket(q.ticket, target);
  if (!config.wsAllowQueryToken) return null;
  return verifyAccessToken(q.token ?? "");
}

export async function registerCollab(app: FastifyInstance): Promise<void> {
  // Ticket WebSocket (usage unique, 30 s) : évite de mettre le JWT d'accès dans l'URL de la socket.
  app.post(
    "/api/ws-ticket",
    { preHandler: authenticate, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req) => {
      const user = requireUser(req);
      const raw = req.headers.authorization ?? "";
      const claims = verifyAccessToken(raw.slice("Bearer ".length).trim());
      if (!claims) throw badRequest("Jeton invalide.");
      const b = (req.body ?? {}) as { target?: unknown };
      const target =
        typeof b.target === "string" && /^(collab|events):[0-9a-fA-F-]{36}$/.test(b.target) ? b.target : undefined;
      const t = await issueWsTicket({
        sub: user.id,
        fpr: claims.fpr,
        iat: claims.iat,
        exp: claims.exp,
        ...(target ? { target } : {}),
      });
      return t;
    },
  );

  // Backplane multi-instance (no-op sans REDIS_URL). Les messages venus d'AUTRES
  // instances sont re-délivrés aux peers LOCAUX (from=null pour un broadcast).
  initBackplane((m: RelayMsg) => {
    if (m.k === "bcast") broadcast(m.nodeId, null, m.message);
    else if (m.k === "kick") kickRoomLocal(m.nodeId, m.reason);
    else if (m.k === "org") notifyOrgLocal(m.orgId);
    else if (m.k === "kickUser") kickUserLocal(m.userId, m.reason);
  }, app.log);

  // --- WebSocket : canal d'événements de l'organisation --------------------
  const orgWsHandler = async (socket: WsConn, req: FastifyRequest) => {
    const orgId = (req.params as { orgId?: string }).orgId ?? "";
    const life = trackSocketClose(socket); // AVANT tout await
    const claims = await socketClaims(req, `events:${orgId}`);
    if (!claims || !/^[0-9a-fA-F-]{36}$/.test(orgId) || !(await socketUserAllowed(claims))) {
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
    // Le client a pu partir pendant les requêtes d'admission : ne rien enregistrer.
    if (life.closed) return;
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
    const expiryTimer = scheduleTokenExpiry(socket, claims.exp);

    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(expiryTimer);
      const r = orgRooms.get(orgId);
      if (r) {
        r.delete(peer);
        if (r.size === 0) orgRooms.delete(orgId);
      }
      const n = (connectionsByUser.get(peer.userId) ?? 1) - 1;
      if (n <= 0) connectionsByUser.delete(peer.userId);
      else connectionsByUser.set(peer.userId, n);
    };
    life.onGone(cleanup);
    // Ce canal est purement descendant : on ignore tout message entrant.
  };
  app.get("/api/events/:orgId", { websocket: true } as never, orgWsHandler as never);

  // --- WebSocket room ------------------------------------------------------
  const wsHandler = async (socket: WsConn, req: FastifyRequest) => {
    const nodeId = (req.params as { nodeId?: string }).nodeId ?? "";
    const life = trackSocketClose(socket); // AVANT tout await
    const claims = await socketClaims(req, `collab:${nodeId}`);
    if (!claims || !/^[0-9a-fA-F-]{36}$/.test(nodeId) || !(await socketUserAllowed(claims))) {
      socket.close(1008, "unauthorized");
      return;
    }
    const access = await resolveNodeAccess(claims.sub, nodeId).catch(() => null);
    if (!access || !access.accessible || !access.permissions.has("node.view")) {
      socket.close(1008, "forbidden");
      return;
    }
    const keyState = await queryOne<{ key_epoch: number; key_rotation_required: boolean }>(
      `SELECT key_epoch, key_rotation_required FROM nodes WHERE id = $1`,
      [nodeId],
    );
    if (!keyState) {
      socket.close(1008, "forbidden");
      return;
    }
    // Le client a pu partir pendant les requêtes d'admission : ne rien enregistrer.
    if (life.closed) return;

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
      orgId: access.orgId,
      canWrite: access.permissions.has("node.edit") && !keyState.key_rotation_required,
      keyEpoch: keyState.key_epoch,
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
      socket.send(JSON.stringify({ type: "ready", canWrite: peer.canWrite, keyEpoch: peer.keyEpoch }));
    } catch {
      /* ignore */
    }
    const expiryTimer = scheduleTokenExpiry(socket, claims.exp);
    // Tell existing peers a newcomer joined so they re-broadcast their presence
    // (awareness is opaque to the relay, so it can't replay it itself). Publié
    // aussi aux autres instances : un pair y re-émettra son awareness → le
    // nouveau venu (ici) la recevra via le backplane.
    {
      const joinMsg = { type: "peer-join", from: peer.userId };
      broadcast(nodeId, peer, joinMsg);
      publishRelay({ k: "bcast", nodeId, message: joinMsg });
    }

    const peerId = randomUUID(); // relay-issued namespace; a payload cannot impersonate another socket
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
        // Une mise à jour refusée n'est JAMAIS abandonnée en silence : l'émetteur
        // reçoit une erreur explicite (avec le nonce de la mise à jour quand il
        // est connu) pour la découper, la refuser à l'utilisateur ou la renvoyer.
        // Sans ça, le contenu restait visible localement mais n'était ni persisté
        // ni reçu par les pairs, et disparaissait au rechargement.
        const reject = (code: string, nonce?: string) => {
          try {
            socket.send(
              JSON.stringify({
                type: "error",
                code,
                ...(nonce ? { nonce } : {}),
                ...(code === "update_too_large" ? { maxBytes: config.maxCollabMessageBytes } : {}),
              }),
            );
          } catch {
            /* déjà fermé */
          }
        };
        // Garde de taille défensive (le maxPayload du serveur WS borne déjà le
        // frame ; ceci reste une double sécurité côté application).
        if (text.length > MAX_CIPHERTEXT_HEX + 4096) {
          reject("update_too_large");
          return;
        }
        let msg: { type?: string; ciphertext?: string; nonce?: string; payload?: unknown };
        try {
          msg = JSON.parse(text) as typeof msg;
        } catch {
          return;
        }
        if (msg.type === "update") {
          const ct = typeof msg.ciphertext === "string" ? msg.ciphertext : "";
          const rawNonce = typeof msg.nonce === "string" ? msg.nonce : "";
          const nonce = /^[0-9a-f]{24}$/i.test(rawNonce) ? rawNonce : "";
          if (!peer.canWrite) {
            reject("read_only", nonce);
            return;
          }
          // Rejeter un ciphertext hors-bornes (anti-DoS mémoire/base) ou mal formé.
          if (ct.length > MAX_CIPHERTEXT_HEX) {
            reject("update_too_large", nonce);
            return;
          }
          if (!/^[0-9a-f]+$/i.test(ct) || !nonce) {
            reject("invalid_update", nonce);
            return;
          }
          // Garde-fous de stockage (voir plus haut) : refus EXPLICITE, jamais silencieux.
          const bytes = ct.length / 2;
          if (!consumeCollabBytes(peer.userId, bytes)) {
            reject("rate_limited_bytes", nonce);
            return;
          }
          try {
            if (!(await collabDiskAllows(bytes))) {
              reject("disk_full", nonce);
              return;
            }
            if (!(await collabQuotaAllows(peer.orgId, bytes))) {
              reject("quota_exceeded", nonce);
              return;
            }
          } catch {
            reject("persist_failed", nonce);
            return;
          }
          try {
            const inserted = await queryOne<{ id: number }>(
              `WITH current_node AS (
                 SELECT id FROM nodes WHERE id = $1 AND NOT key_rotation_required AND key_epoch = $5 FOR SHARE
               ) INSERT INTO collab_updates (node_id, update_ciphertext, update_nonce, author_user_id)
                 SELECT id, $2, $3, $4 FROM current_node RETURNING id`,
              [nodeId, Buffer.from(ct, "hex"), Buffer.from(nonce, "hex"), peer.userId, peer.keyEpoch],
            );
            if (!inserted) {
              reject("key_rotation_required", nonce);
              socket.close(4001, "key-rotation-required");
              return;
            }
            recordCollabBytes(peer.orgId, bytes);
            const upd = {
              type: "update",
              seq: inserted?.id ?? null,
              ciphertext: ct,
              nonce,
              author: peer.userId,
            };
            broadcast(nodeId, peer, upd);
            publishRelay({ k: "bcast", nodeId, message: upd });
            // Accusé de réception à l'émetteur : la mise à jour est durable
            // (persistée) — le client peut cesser de la garder pour renvoi.
            try {
              socket.send(JSON.stringify({ type: "ack", nonce, seq: upd.seq }));
            } catch {
              /* déjà fermé */
            }
          } catch {
            // Erreur base transitoire : l'émetteur DOIT le savoir pour renvoyer.
            reject("persist_failed", nonce);
          }
        } else if (msg.type === "awareness") {
          // La présence est ré-émise à tous les pairs : borner pour éviter une
          // amplification (un pair envoie 1× une charge géante → N× sur le fil).
          const payload = msg.payload as { u?: unknown } | undefined;
          if (payload && typeof payload.u === "string" && payload.u.length > MAX_AWARENESS_CHARS) return;
          // Le plafond doit couvrir TOUT le message, pas seulement `u` (autres champs = amplification).
          if (text.length > MAX_AWARENESS_CHARS + 1024) return;
          const awMsg = { type: "awareness", from: peer.userId, peerId, payload: msg.payload };
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
      clearTimeout(expiryTimer);
      const r = rooms.get(nodeId);
      if (r) {
        r.delete(peer);
        if (r.size === 0) rooms.delete(nodeId);
      }
      const n = (connectionsByUser.get(peer.userId) ?? 1) - 1;
      if (n <= 0) connectionsByUser.delete(peer.userId);
      else connectionsByUser.set(peer.userId, n);
    };
    life.onGone(cleanup);
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
    { preHandler: authenticate, bodyLimit: COMPACT_BODY_LIMIT },
    async (req: FastifyRequest) => {
      const nodeId = (req.params as { nodeId: string }).nodeId;
      const user = requireUser(req);
      const access = await requireNodePerm(req, nodeId, "node.acl.manage");
      const body = (req.body ?? {}) as { ciphertext?: unknown; nonce?: unknown; upToSeq?: unknown };
      const ct = typeof body.ciphertext === "string" ? body.ciphertext : "";
      const nonce = typeof body.nonce === "string" ? body.nonce : "";
      if (!/^[0-9a-f]+$/i.test(ct) || !/^[0-9a-f]{24}$/i.test(nonce)) {
        throw badRequest("Snapshot invalide (ciphertext/nonce hex attendus).");
      }
      // Le snapshot ne remplace QUE ce que le client a réellement lu et intégré : jusqu'à
      // `upToSeq` inclus. Une mise à jour arrivée entre-temps (id supérieur) est conservée.
      const upToSeq = body.upToSeq;
      if (typeof upToSeq !== "number" || !Number.isSafeInteger(upToSeq) || upToSeq < 0) {
        throw badRequest("upToSeq (dernier numéro de séquence intégré au snapshot) est requis.");
      }
      const seq = await withTx(async (c) => {
        await c.query(`DELETE FROM collab_updates WHERE node_id = $1 AND id <= $2`, [nodeId, upToSeq]);
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
          LIMIT ${COLLAB_PAGE_SIZE + 1}`,
      [nodeId, since],
    );
    // Une ligne de plus que la page : sait-on s'il en reste, sans second aller-retour.
    const hasMore = rows.length > COLLAB_PAGE_SIZE;
    if (hasMore) rows.length = COLLAB_PAGE_SIZE;
    return {
      hasMore,
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
