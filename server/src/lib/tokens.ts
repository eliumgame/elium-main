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
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as AccessTokenClaims;
    if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) return null;
    if (typeof claims.sub !== "string") return null;
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
}

/** A short-lived token bound to one `purpose` (default 5 min). */
export function issueScopedToken(sub: string, purpose: string, ttlSeconds = 300): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson({ sub, purpose, iat: now, exp: now + ttlSeconds } satisfies ScopedClaims);
  const body = `${header}.${payload}`;
  return `${body}.${sign(body)}`;
}

/** Verify a scoped token and return its subject, or null on any mismatch. */
export function verifyScopedToken(token: string, purpose: string): string | null {
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
    return claims.sub;
  } catch {
    return null;
  }
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
