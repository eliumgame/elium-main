/** A typed HTTP error surfaced cleanly to clients (never leaks internals). */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) => new ApiError(400, "bad_request", msg, details);
export const unauthorized = (msg = "Authentification requise.") => new ApiError(401, "unauthorized", msg);
export const forbidden = (msg = "Accès refusé.") => new ApiError(403, "forbidden", msg);
export const notFound = (msg = "Ressource introuvable.") => new ApiError(404, "not_found", msg);
export const conflict = (msg: string) => new ApiError(409, "conflict", msg);
export const tooLarge = (msg = "Contenu trop volumineux.") => new ApiError(413, "payload_too_large", msg);
export const rateLimited = (msg = "Trop de requêtes.") => new ApiError(429, "rate_limited", msg);
export const insufficientStorage = (msg = "Quota de stockage de l'organisation atteint.") =>
  new ApiError(507, "insufficient_storage", msg);
