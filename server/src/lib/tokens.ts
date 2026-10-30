/**
 * Stateless access tokens (compact HMAC-SHA256-signed JSON, JWT-shaped) plus
 * opaque refresh tokens (stored hashed in `sessions`). No external JWT library:
 * a signed `base64url(header).base64url(payload).base64url(hmac)` triple.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { randomToken, sha256Hex } from "./crypto-server.js";

export interface AccessTokenClaims {
  sub: string; // user id
  fpr: string; // fingerprint (sanity)
  iat: number;
  exp: number;
}

function b64urlJson(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

function sign(data: string): string {
  return createHmac("sha256", config.tokenSecret).update(data).digest("base64url");
}

export function issueAccessToken(userId: string, fingerprint: string): { token: string; expiresAt: number } {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + config.accessTokenTtl;
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson({ sub: userId, fpr: fingerprint, iat: now, exp } satisfies AccessTokenClaims);
  const body = `${header}.${payload}`;
  return { token: `${body}.${sign(body)}`, expiresAt: exp };
}

export function verifyAccessToken(token: string): AccessTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, mac] = parts as [string, string, string];
  const expected = sign(`${header}.${payload}`);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessTokenClaims & {
      purpose?: unknown;
    };
    if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof claims.sub !== "string") return null;
    // Un jeton à usage limité (étape MFA de la connexion, challenges WebAuthn…) est signé avec la MÊME clé :
    // il ne doit JAMAIS être accepté comme jeton d'accès (sinon le mot de passe seul contournerait la 2FA).
    if (claims.purpose !== undefined) return null;
    if (typeof claims.fpr !== "string") return null;
    return claims;
  } catch {
    return null;
  }
}

// --- Purpose-scoped short-lived tokens (e.g. the MFA login step) -----------
interface ScopedClaims {
  sub: string;
  purpose: string;
  iat: number;
  exp: number;
  /** Optionnel : `sub` OIDC à lier à `users.sso_subject` une fois le 2e facteur réussi (étape MFA d'une connexion SSO). */
  sso?: string;
}

/** Contenu vérifié d'un jeton à usage limité. */
export interface VerifiedScopedToken {
  sub: string;
  iat: number;
  sso?: string;
}

/** A short-lived token bound to one `purpose` (default 5 min). `extra.sso` : sub OIDC à lier après le 2e facteur. */
export function issueScopedToken(sub: string, purpose: string, ttlSeconds = 300, extra?: { sso?: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const claims: ScopedClaims = { sub, purpose, iat: now, exp: now + ttlSeconds };
  if (extra?.sso) claims.sso = extra.sso;
  const payload = b64urlJson(claims);
  const body = `${header}.${payload}`;
  return `${body}.${sign(body)}`;
}

/** Verify a scoped token and return its subject, or null on any mismatch. */
export function verifyScopedToken(token: string, purpose: string): string | null {
  return verifyScopedTokenClaims(token, purpose)?.sub ?? null;
}

/** Comme `verifyScopedToken`, mais renvoie aussi `iat` (contrôle `token_epoch`) et le `sso` optionnel. */
export function verifyScopedTokenClaims(token: string, purpose: string): VerifiedScopedToken | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, payload, mac] = parts as [string, string, string];
  const expected = sign(`${header}.${payload}`);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ScopedClaims;
    if (claims.purpose !== purpose) return null;
    if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof claims.sub !== "string") return null;
    const out: VerifiedScopedToken = { sub: claims.sub, iat: typeof claims.iat === "number" ? claims.iat : 0 };
    if (typeof claims.sso === "string" && claims.sso) out.sso = claims.sso;
    return out;
  } catch {
    return null;
  }
}

/**
 * Vrai si un jeton émis à `iat` (secondes) est antérieur à l'époque `token_epoch` de l'utilisateur
 * (reset/changement de mot de passe, révocation globale) : il doit alors être refusé. Même règle
 * que `authenticate` (`<`, pas `<=`). Époque absente/illisible → pas de révocation.
 */
export function issuedBeforeEpoch(iat: number, tokenEpoch: unknown): boolean {
  if (tokenEpoch === null || tokenEpoch === undefined) return false;
  const t = new Date(tokenEpoch as string).getTime();
  if (!Number.isFinite(t)) return false;
  return iat < Math.floor(t / 1000);
}

/** A fresh refresh token: the raw value goes to the client, its hash to the DB. */
export function newRefreshToken(): { raw: string; hash: string; expiresAt: Date } {
  const raw = randomToken(48);
  return {
    raw,
    hash: sha256Hex(raw),
    expiresAt: new Date(Date.now() + config.refreshTokenTtl * 1000),
  };
}

export const hashToken = sha256Hex;
