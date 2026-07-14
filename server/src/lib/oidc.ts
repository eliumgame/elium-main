/**
 * Minimal OIDC ID-token verification — dependency-free (Node crypto only).
 *
 * SSO in a ZERO-KNOWLEDGE product authenticates the user's IDENTITY only: the
 * IdP (Google/Okta/Azure AD/…) proves who they are. It does NOT and cannot
 * unlock the end-to-end keys — those stay derived from a client-side passphrase
 * the server never sees. So this module only validates the ID token; the client
 * still unlocks its key bundle after the session is issued.
 *
 * We verify the JWT signature (RS256 / ES256) against the org's configured JWKS
 * and check the standard claims (iss, aud, exp, nbf) plus a verified email.
 */
import { createPublicKey, createVerify, verify as edVerify, type JsonWebKey } from "node:crypto";

export interface OidcConfig {
  issuer: string;
  clientId: string;
  /** Static JWK set (array of JWKs). A production deploy may instead fetch a
   *  jwksUri, but static keys keep the server offline-friendly and testable. */
  jwks: JsonWebKey[];
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

/** Verify an OIDC ID token and return its (validated) claims, or throw. */
export function verifyIdToken(idToken: string, config: OidcConfig, atMs = Date.now()): OidcClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OidcError("Jeton d'identité malformé.");
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = b64urlJson(headerB64);
    payload = b64urlJson(payloadB64);
  } catch {
    throw new OidcError("Jeton d'identité illisible.");
  }

  const algInfo = ALG_TO_NODE[header.alg];
  if (!algInfo) throw new OidcError(`Algorithme de signature non supporté : ${header.alg}.`);

  // Pick the JWK by kid (or the sole key), build a public key, verify signature.
  const jwk = (config.jwks.length === 1 ? config.jwks[0] : config.jwks.find((k) => (k as { kid?: string }).kid === header.kid));
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
