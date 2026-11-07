/**
 * Clés d'API des clients (un client = un projet : Elium, un autre site, un script…).
 *
 * Format : `eai_` + 32 octets aléatoires en base64url. Seule l'empreinte SHA-256 est configurée ;
 * la recherche se fait PAR empreinte (pas de comparaison caractère par caractère d'un secret,
 * donc rien à fuir par chronométrage).
 */
import { createHash, randomBytes } from "node:crypto";
import type { Client, GatewayConfig } from "./config.js";

export const KEY_PREFIX = "eai_";

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function generateKey(): { key: string; keySha256: string } {
  const key = KEY_PREFIX + randomBytes(32).toString("base64url");
  return { key, keySha256: sha256Hex(key) };
}

export interface AuthedClient {
  id: string;
  client: Client;
}

export function buildKeyIndex(cfg: GatewayConfig): Map<string, AuthedClient> {
  const index = new Map<string, AuthedClient>();
  for (const [id, client] of Object.entries(cfg.clients)) index.set(client.keySha256, { id, client });
  return index;
}

/** Extrait la clé d'un en-tête `Authorization: Bearer …` (ou `x-api-key`). */
export function extractKey(headers: Record<string, string | string[] | undefined>): string | null {
  const auth = headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
    if (m?.[1]) return m[1];
  }
  const x = headers["x-api-key"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return null;
}

export function authenticate(index: Map<string, AuthedClient>, key: string | null): AuthedClient | null {
  if (!key || !key.startsWith(KEY_PREFIX) || key.length > 200) return null;
  const hit = index.get(sha256Hex(key));
  if (!hit || hit.client.disabled) return null;
  return hit;
}

export function canUseAssistant(client: Client, assistantId: string): boolean {
  return client.assistants.includes("*") || client.assistants.includes(assistantId);
}
