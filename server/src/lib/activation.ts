/**
 * Code d'activation à usage unique : protège l'AMORÇAGE d'un déploiement neuf.
 *
 * Tant qu'aucune organisation n'existe, n'importe qui joignant le site pourrait
 * s'inscrire et prendre le Drive. Au démarrage d'un déploiement sans organisation,
 * le serveur génère un code aléatoire fort (12 caractères, 60 bits), l'affiche dans
 * ses journaux (ou reprend `ACTIVATION_CODE`) et ne conserve que son EMPREINTE.
 * Le code est exigé pour créer le premier compte puis l'organisation, et consommé
 * à la création de l'organisation : il ne sert qu'une fois.
 *
 * Un nouveau code est généré à CHAQUE démarrage tant que le Drive n'est pas créé
 * (l'ancien est invalidé) : le code visible dans les journaux est donc toujours
 * le bon. Les essais sont limités (par adresse puis globalement) contre la force
 * brute ; ces compteurs vivent en mémoire du processus (déploiement mono-instance).
 */
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { query, queryOne } from "../db/pool.js";
import { forbidden, rateLimited } from "./errors.js";
import { getSiteState } from "./site-settings.js";

// Sans caractères ambigus (0/O, 1/I/L) : 32 symboles = 5 bits chacun.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 12;

export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function generateActivationCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8)}`;
}

function hashCode(code: string): Buffer {
  return createHash("sha256")
    .update(`${config.tokenSecret}|activation|${normalizeCode(code)}`)
    .digest();
}

/** Génère (ou reprend de l'environnement) le code et ne stocke que son empreinte. Renvoie le code à afficher, ou null si le Drive existe. */
export async function ensureActivationCode(): Promise<string | null> {
  if ((await getSiteState()).orgId) return null;
  const code = config.site.activationCode || generateActivationCode();
  await query(
    `INSERT INTO site_activation (id, code_hash, expires_at, consumed_at)
     VALUES (1, $1, now() + ($2::int * interval '1 hour'), NULL)
     ON CONFLICT (id) DO UPDATE
       SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, consumed_at = NULL`,
    [hashCode(code).toString("hex"), config.site.activationTtlHours],
  );
  return code;
}

/** Un code d'activation est-il exigé en ce moment ? (Drive pas encore créé et code provisionné.) */
export async function isActivationRequired(): Promise<boolean> {
  if ((await getSiteState()).orgId) return false;
  const row = await queryOne<{ consumed_at: string | null }>(`SELECT consumed_at FROM site_activation WHERE id = 1`);
  return !!row && !row.consumed_at;
}

// --- Anti force brute -------------------------------------------------------
const MAX_FAILS_PER_IP = 5;
const IP_LOCK_MS = 15 * 60_000;
// Plafond global (défense contre une force brute répartie sur beaucoup d'IP). Compromis connu :
// un tiers disposant de plusieurs adresses peut verrouiller l'activation 1 h (déni de service,
// sans accès : le code reste secret et le verrou expire). Le compteur PAR IP ci-dessus
// limite déjà chaque source à 5 essais / 15 min ; on conserve volontairement le global.
const MAX_FAILS_GLOBAL = 30;
const GLOBAL_WINDOW_MS = 60 * 60_000;
const perIp = new Map<string, { fails: number; lockedUntil: number }>();
let globalFails: number[] = [];

export function resetActivationLimits(): void {
  perIp.clear();
  globalFails = [];
}

function checkLimits(ip: string, now: number): void {
  globalFails = globalFails.filter((t) => now - t < GLOBAL_WINDOW_MS);
  if (globalFails.length >= MAX_FAILS_GLOBAL)
    throw rateLimited("Trop d'essais de code d'activation : réessayez plus tard.");
  const e = perIp.get(ip);
  if (e && e.lockedUntil > now)
    throw rateLimited("Trop d'essais de code d'activation : réessayez dans quelques minutes.");
}

function recordFailure(ip: string, now: number): void {
  globalFails.push(now);
  const e = perIp.get(ip) ?? { fails: 0, lockedUntil: 0 };
  e.fails += 1;
  if (e.fails >= MAX_FAILS_PER_IP) {
    e.fails = 0;
    e.lockedUntil = now + IP_LOCK_MS;
  }
  perIp.set(ip, e);
}

/** Vérifie le code (temps constant, essais limités). Ne le consomme pas. */
export async function verifyActivation(code: string | undefined, ip: string): Promise<void> {
  const now = Date.now();
  checkLimits(ip, now);
  const row = await queryOne<{ code_hash: string; expires_at: string; consumed_at: string | null }>(
    `SELECT code_hash, expires_at, consumed_at FROM site_activation WHERE id = 1`,
  );
  if (!row || row.consumed_at) throw forbidden("Code d'activation invalide.");
  if (new Date(row.expires_at).getTime() < now) {
    throw forbidden("Code d'activation expiré : redémarrez le serveur pour en générer un nouveau.");
  }
  const given = hashCode(code ?? "");
  const want = Buffer.from(row.code_hash, "hex");
  const good = want.length === given.length && timingSafeEqual(want, given);
  if (!code || !good) {
    recordFailure(ip, now);
    throw forbidden("Code d'activation invalide.");
  }
  perIp.delete(ip);
}

/** Consomme le code (à la création de l'organisation) : plus jamais valable. */
export async function consumeActivation(): Promise<void> {
  await query(`UPDATE site_activation SET consumed_at = now() WHERE id = 1 AND consumed_at IS NULL`);
}
