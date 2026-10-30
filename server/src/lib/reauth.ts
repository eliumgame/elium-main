/**
 * Ré-authentification : preuve FRAÎCHE (mot de passe + second facteur) exigée avant
 * une opération sensible (ajout/retrait de passkey, configuration SSO/SCIM). Un
 * jeton d'accès volé ne suffit donc pas à s'ouvrir une porte dérobée durable.
 *
 * `POST /api/auth/reauth` émet un jeton à usage restreint (5 min, purpose « reauth »,
 * lié à l'utilisateur) ; les routes sensibles le lisent dans l'en-tête `x-reauth-token`.
 */
import type { FastifyRequest } from "fastify";
import { issueScopedToken, verifyScopedTokenClaims, issuedBeforeEpoch } from "./tokens.js";
import { queryOne } from "../db/pool.js";
import { ApiError } from "./errors.js";

export const REAUTH_PURPOSE = "reauth";
export const REAUTH_TTL_SECONDS = 300;

export function issueReauthToken(userId: string): string {
  return issueScopedToken(userId, REAUTH_PURPOSE, REAUTH_TTL_SECONDS);
}

/** Lève 403 `reauth_required` sans jeton de ré-authentification valide pour CET utilisateur. */
export async function requireReauth(req: FastifyRequest, userId: string): Promise<void> {
  const raw = req.headers["x-reauth-token"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  const claims = token ? verifyScopedTokenClaims(token, REAUTH_PURPOSE) : null;
  let ok = !!claims && claims.sub === userId;
  if (ok && claims) {
    // Audit SRV-09 : un jeton de ré-auth émis AVANT un reset/changement de mot de passe (token_epoch) est mort.
    const u = await queryOne<{ token_epoch: string }>(`SELECT token_epoch FROM users WHERE id = $1`, [userId]);
    if (!u || issuedBeforeEpoch(claims.iat, u.token_epoch)) ok = false;
  }
  if (!ok) {
    throw new ApiError(
      403,
      "reauth_required",
      "Confirmez votre identité (mot de passe et code de vérification) pour effectuer cette opération.",
    );
  }
}
