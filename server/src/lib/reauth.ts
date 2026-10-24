/**
 * Ré-authentification : preuve FRAÎCHE (mot de passe + second facteur) exigée avant
 * une opération sensible (ajout/retrait de passkey, configuration SSO/SCIM). Un
 * jeton d'accès volé ne suffit donc pas à s'ouvrir une porte dérobée durable.
 *
 * `POST /api/auth/reauth` émet un jeton à usage restreint (5 min, purpose « reauth »,
 * lié à l'utilisateur) ; les routes sensibles le lisent dans l'en-tête `x-reauth-token`.
 */
import type { FastifyRequest } from "fastify";
import { issueScopedToken, verifyScopedToken } from "./tokens.js";
import { ApiError } from "./errors.js";

export const REAUTH_PURPOSE = "reauth";
export const REAUTH_TTL_SECONDS = 300;

export function issueReauthToken(userId: string): string {
  return issueScopedToken(userId, REAUTH_PURPOSE, REAUTH_TTL_SECONDS);
}

/** Lève 403 `reauth_required` sans jeton de ré-authentification valide pour CET utilisateur. */
export function requireReauth(req: FastifyRequest, userId: string): void {
  const raw = req.headers["x-reauth-token"];
  const token = Array.isArray(raw) ? raw[0] : raw;
  if (!token || verifyScopedToken(token, REAUTH_PURPOSE) !== userId) {
    throw new ApiError(
      403,
      "reauth_required",
      "Confirmez votre identité (mot de passe et code de vérification) pour effectuer cette opération.",
    );
  }
}
