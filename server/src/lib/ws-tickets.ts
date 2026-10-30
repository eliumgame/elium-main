/**
 * Tickets WebSocket à usage unique (audit CLIENT-10).
 *
 * L'API WebSocket du navigateur n'accepte pas d'en-tête Authorization : le JWT d'accès finissait donc en
 * query string (`?token=`), donc potentiellement dans les journaux d'un proxy. À la place, le client appelle
 * `POST /api/ws-ticket` (authentifié, jeton en en-tête) et reçoit un ticket OPAQUE, valable 30 s et consommé
 * à la première utilisation : `?ticket=…`. Une fois consommé ou expiré, il ne vaut plus rien dans un journal.
 *
 * Stockage : mémoire de processus (mono-instance) ; avec `REDIS_URL`, Redis (SET EX + GETDEL atomique), pour
 * qu'un ticket émis par une instance soit consommable sur une autre. Si Redis est en panne, repli mémoire
 * (best-effort, comme le backplane).
 */
import { randomBytes } from "node:crypto";
import type Redis from "ioredis";
import { createRateLimitRedis } from "../collab/backplane.js";
import { sha256Hex } from "./crypto-server.js";

export const WS_TICKET_TTL_SECONDS = 30;
const MAX_MEMORY_TICKETS = 20000;

/** Ce que le ticket « rejoue » : les claims du jeton d'accès qui l'a obtenu (sub/iat/exp/fpr) + une cible optionnelle. */
export interface WsTicketPayload {
  sub: string;
  fpr: string;
  iat: number;
  exp: number;
  /** ex. `collab:<nodeId>` ou `events:<orgId>` ; absent = utilisable partout. */
  target?: string;
}

const mem = new Map<string, { payload: WsTicketPayload; expiresAt: number }>();
let redis: Redis | null | undefined;

function client(): Redis | null {
  if (redis === undefined) redis = createRateLimitRedis();
  return redis;
}

function sweep(now: number): void {
  for (const [k, v] of mem) if (v.expiresAt <= now) mem.delete(k);
}

// On ne stocke que le HASH du ticket : un dump mémoire/Redis ne donne pas de ticket rejouable.
const keyOf = (ticket: string) => `elium:wst:${sha256Hex(ticket)}`;

export async function issueWsTicket(payload: WsTicketPayload): Promise<{ ticket: string; expiresIn: number }> {
  const ticket = randomBytes(32).toString("base64url");
  const key = keyOf(ticket);
  const r = client();
  if (r) {
    try {
      await r.set(key, JSON.stringify(payload), "EX", WS_TICKET_TTL_SECONDS);
      return { ticket, expiresIn: WS_TICKET_TTL_SECONDS };
    } catch {
      /* repli mémoire */
    }
  }
  const now = Date.now();
  if (mem.size >= MAX_MEMORY_TICKETS) sweep(now);
  if (mem.size >= MAX_MEMORY_TICKETS) throw new Error("ws ticket store full");
  mem.set(key, { payload, expiresAt: now + WS_TICKET_TTL_SECONDS * 1000 });
  return { ticket, expiresIn: WS_TICKET_TTL_SECONDS };
}

/** Consomme (usage unique) un ticket ; null s'il est inconnu, expiré, déjà utilisé ou lié à une autre cible. */
export async function consumeWsTicket(ticket: string, target: string): Promise<WsTicketPayload | null> {
  if (!ticket || ticket.length > 128) return null;
  const key = keyOf(ticket);
  let payload: WsTicketPayload | null = null;
  const r = client();
  if (r) {
    try {
      const raw = await (r as Redis & { getdel(k: string): Promise<string | null> }).getdel(key);
      if (raw) payload = JSON.parse(raw) as WsTicketPayload;
    } catch {
      /* repli mémoire ci-dessous */
    }
  }
  if (!payload) {
    const e = mem.get(key);
    if (e) {
      mem.delete(key); // usage unique, même si la cible ne correspond pas
      if (e.expiresAt > Date.now()) payload = e.payload;
    }
  }
  if (!payload) return null;
  if (payload.target && payload.target !== target) return null;
  return payload;
}

/** Tests : vide le stockage mémoire. */
export function _resetWsTicketsForTests(): void {
  mem.clear();
}
