/**
 * Minimal OIDC ID-token verification — dependency-free (Node crypto only).
 *
 * SSO in a ZERO-KNOWLEDGE product authenticates the user's IDENTITY only: the
 * IdP (Google/Okta/Azure AD/…) proves who they are. It does NOT and cannot
 * unlock the end-to-end keys — those stay derived from a client-side passphrase
 * the server never sees. So this module only validates the ID token; the client
 * still unlocks its key bundle after the session is issued.
 *
 * We verify the JWT signature (RS256 / ES256 / EdDSA) against the org's signing
 * keys and check the standard claims (iss, aud, exp, nbf) plus a verified email.
 * Keys may be configured STATICALLY (an inline `jwks` array) or fetched
 * DYNAMICALLY from the IdP's `jwksUri` (cached, honoring Cache-Control max-age,
 * with an automatic refetch when a token presents an unknown `kid` — i.e. the
 * IdP rotated its keys).
 */
import { createPublicKey, createVerify, verify as edVerify, type JsonWebKey } from "node:crypto";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  /** Static JWK set. Optional when `jwksUri` is set. */
  jwks?: JsonWebKey[];
  /** IdP JWKS endpoint. When set, signing keys are fetched + cached from here
   *  (and unioned with any static `jwks`). Must be https. */
  jwksUri?: string;
  /** Optional allow-list of email domains permitted to sign in via this IdP. */
  allowedDomains?: string[];
}

export interface OidcClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  iss: string;
  aud: string;
}

export class OidcError extends Error {}

function b64urlToBuf(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function b64urlJson<T>(s: string): T {
  return JSON.parse(b64urlToBuf(s).toString("utf8")) as T;
}

const ALG_TO_NODE: Record<string, { type: "rsa" | "ec" | "ed"; hash?: string }> = {
  RS256: { type: "rsa", hash: "sha256" },
  RS384: { type: "rsa", hash: "sha384" },
  RS512: { type: "rsa", hash: "sha512" },
  ES256: { type: "ec", hash: "sha256" },
  ES384: { type: "ec", hash: "sha384" },
  EdDSA: { type: "ed" },
};

function jwkKid(k: JsonWebKey): string | undefined {
  return (k as { kid?: string }).kid;
}

/** Choose the verification key for a token's `kid` (see call-site comment). */
function selectJwk(jwks: JsonWebKey[], kid: string | undefined): JsonWebKey | undefined {
  if (kid) {
    const exact = jwks.find((k) => jwkKid(k) === kid);
    if (exact) return exact;
    // Lenient only for a single keyless static key (manual configs).
    if (jwks.length === 1 && !jwkKid(jwks[0]!)) return jwks[0];
    return undefined;
  }
  if (jwks.length === 1) return jwks[0];
  return jwks.find((k) => !jwkKid(k));
}

interface ParsedToken {
  header: { alg: string; kid?: string };
  payload: Record<string, unknown>;
  headerB64: string;
  payloadB64: string;
  sigB64: string;
}

function parseToken(idToken: string): ParsedToken {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OidcError("Jeton d'identité malformé.");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];
  try {
    return {
      header: b64urlJson(headerB64),
      payload: b64urlJson(payloadB64),
      headerB64,
      payloadB64,
      sigB64,
    };
  } catch {
    throw new OidcError("Jeton d'identité illisible.");
  }
}

/**
 * Verify a token against an EXPLICIT set of JWKs (pure — no network). This is
 * the core; both the static and dynamic entrypoints funnel through it.
 */
export function verifyIdTokenWithKeys(
  idToken: string,
  config: OidcConfig,
  jwks: JsonWebKey[],
  atMs = Date.now(),
): OidcClaims {
  const { header, payload, headerB64, payloadB64, sigB64 } = parseToken(idToken);

  const algInfo = ALG_TO_NODE[header.alg];
  if (!algInfo) throw new OidcError(`Algorithme de signature non supporté : ${header.alg}.`);

  // Pick the JWK, build a public key, verify signature. When the token carries
  // a `kid` we require an exact match (a `kid` miss must surface so the dynamic
  // path refetches — IdP key rotation); a single *keyless* static key is the
  // only lenient fallback. Without a `kid`, use the sole/keyless key.
  const jwk = selectJwk(jwks, header.kid);
  if (!jwk) throw new OidcError("Aucune clé de vérification (JWKS) correspondante.");
  let key;
  try {
    key = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    throw new OidcError("Clé JWKS invalide.");
  }

  const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
  const signature = b64urlToBuf(sigB64);
  let valid = false;
  try {
    if (algInfo.type === "ed") {
      valid = edVerify(null, signingInput, key, signature);
    } else if (algInfo.type === "ec") {
      // JWT ES* signatures are raw R||S; Node expects DER unless we pass dsaEncoding.
      valid = createVerify(algInfo.hash!).update(signingInput).verify({ key, dsaEncoding: "ieee-p1363" }, signature);
    } else {
      valid = createVerify(algInfo.hash!).update(signingInput).verify(key, signature);
    }
  } catch {
    valid = false;
  }
  if (!valid) throw new OidcError("Signature du jeton d'identité invalide.");

  // Standard claim checks.
  const now = Math.floor(atMs / 1000);
  const skew = 60;
  if (payload.iss !== config.issuer) throw new OidcError("Émetteur (iss) inattendu.");
  const aud = payload.aud;
  const audOk = aud === config.clientId || (Array.isArray(aud) && aud.includes(config.clientId));
  if (!audOk) throw new OidcError("Audience (aud) inattendue.");
  if (typeof payload.exp === "number" && payload.exp + skew < now) throw new OidcError("Jeton d'identité expiré.");
  if (typeof payload.nbf === "number" && payload.nbf - skew > now) throw new OidcError("Jeton d'identité pas encore valide.");

  const email = typeof payload.email === "string" ? payload.email.toLowerCase() : "";
  if (!email) throw new OidcError("Le jeton d'identité ne contient pas d'e-mail.");
  const emailVerified = payload.email_verified === true || payload.email_verified === "true";
  if (config.allowedDomains?.length) {
    const domain = email.split("@")[1] ?? "";
    if (!config.allowedDomains.map((d) => d.toLowerCase()).includes(domain)) {
      throw new OidcError("Domaine e-mail non autorisé pour ce fournisseur SSO.");
    }
  }

  return {
    sub: String(payload.sub ?? ""),
    email,
    emailVerified,
    name: typeof payload.name === "string" ? payload.name : undefined,
    iss: config.issuer,
    aud: config.clientId,
  };
}

/**
 * Verify a token using the STATIC `config.jwks` only (synchronous, offline).
 * Kept for backward compatibility and pure unit testing.
 */
export function verifyIdToken(idToken: string, config: OidcConfig, atMs = Date.now()): OidcClaims {
  return verifyIdTokenWithKeys(idToken, config, config.jwks ?? [], atMs);
}

// --- Dynamic JWKS (jwks_uri) fetch + cache ---------------------------------

interface JwksCacheEntry {
  keys: JsonWebKey[];
  expiresAt: number; // epoch ms
}
const jwksCache = new Map<string, JwksCacheEntry>();

const MIN_TTL_SEC = 300; // 5 min — never hammer the IdP
const MAX_TTL_SEC = 86_400; // 24 h — never trust a stale set for too long
const DEFAULT_TTL_SEC = 3_600; // when the IdP gives no Cache-Control max-age

export interface VerifyOpts {
  atMs?: number;
  /** Clock for cache TTL bookkeeping (defaults Date.now). */
  now?: () => number;
  /** Injectable fetch (defaults global fetch) — lets tests avoid the network. */
  fetchImpl?: typeof fetch;
  /** Skip the cache and refetch. */
  forceRefresh?: boolean;
  timeoutMs?: number;
}

/** Test hook: clear the in-process JWKS cache. */
export function __clearJwksCache(): void {
  jwksCache.clear();
}

async function fetchJwksUri(
  uri: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ keys: JsonWebKey[]; maxAgeSec: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(uri, { signal: ctrl.signal, headers: { accept: "application/json" } });
  } catch {
    throw new OidcError("JWKS injoignable (réseau).");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new OidcError(`JWKS: réponse ${res.status}.`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new OidcError("JWKS: JSON illisible.");
  }
  const keys = (body as { keys?: unknown })?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new OidcError("JWKS: aucune clé.");
  const cc = res.headers.get("cache-control") ?? "";
  const m = /max-age=(\d+)/i.exec(cc);
  const maxAgeSec = m ? Number(m[1]) : DEFAULT_TTL_SEC;
  return { keys: keys as JsonWebKey[], maxAgeSec };
}

/** Resolve the signing keys: static jwks ∪ (cached-or-fetched jwksUri keys). */
async function resolveJwks(config: OidcConfig, opts: VerifyOpts): Promise<JsonWebKey[]> {
  const staticKeys = config.jwks ?? [];
  if (!config.jwksUri) {
    if (staticKeys.length === 0) throw new OidcError("Aucune clé de vérification (jwks/jwksUri) configurée.");
    return staticKeys;
  }
  const now = (opts.now ?? Date.now)();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const cached = jwksCache.get(config.jwksUri);
  if (!opts.forceRefresh && cached && cached.expiresAt > now) {
    return [...staticKeys, ...cached.keys];
  }
  try {
    const { keys, maxAgeSec } = await fetchJwksUri(config.jwksUri, fetchImpl, timeoutMs);
    const ttl = Math.min(Math.max(maxAgeSec, MIN_TTL_SEC), MAX_TTL_SEC);
    jwksCache.set(config.jwksUri, { keys, expiresAt: now + ttl * 1000 });
    return [...staticKeys, ...keys];
  } catch (e) {
    // Resilience: prefer slightly-stale cached keys over failing every login
    // during an IdP/network blip. A truly rotated key still fails signature
    // verification (and triggers a forced refetch — see verifyIdTokenAsync).
    if (cached) return [...staticKeys, ...cached.keys];
    throw e instanceof OidcError ? e : new OidcError("JWKS indisponible.");
  }
}

/**
 * Verify a token, resolving signing keys statically or from `jwksUri`
 * (cached). On an unknown-`kid` failure with a jwksUri configured, refetch the
 * JWKS once (IdP key rotation) and retry.
 */
export async function verifyIdTokenAsync(
  idToken: string,
  config: OidcConfig,
  opts: VerifyOpts = {},
): Promise<OidcClaims> {
  const atMs = opts.atMs ?? Date.now();
  const jwks = await resolveJwks(config, opts);
  try {
    return verifyIdTokenWithKeys(idToken, config, jwks, atMs);
  } catch (e) {
    const isKidMiss = e instanceof OidcError && /correspondante/.test(e.message);
    if (isKidMiss && config.jwksUri && !opts.forceRefresh) {
      const fresh = await resolveJwks(config, { ...opts, forceRefresh: true });
      return verifyIdTokenWithKeys(idToken, config, fresh, atMs);
    }
    throw e;
  }
}
