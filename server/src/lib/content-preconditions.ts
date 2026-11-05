import { config } from "../config.js";
import { ApiError, badRequest, conflict } from "./errors.js";

/** Code d'erreur stable : le client doit être rechargé / mis à jour. */
export const CLIENT_OUTDATED_CODE = "client_outdated";
export const CLIENT_OUTDATED_MESSAGE =
  "Cette version de l'application est trop ancienne : rechargez la page ou mettez l'application à jour.";
/** En-tête posé sur les réponses servies en mode de compatibilité (exposé en CORS, cf. app.ts). */
export const DEPRECATION_HEADER = "x-elium-deprecated";
export const DEPRECATION_VALUE = "client-outdated";

export const clientOutdated = (status = 428) => new ApiError(status, CLIENT_OUTDATED_CODE, CLIENT_OUTDATED_MESSAGE);

/**
 * Corps obligatoires des nouveaux clients (équipes, rotation d'organisation) : un
 * ancien client ne peut pas les produire et le serveur ne peut PAS les émuler
 * (il n'a jamais les clés). Refus net, avant toute écriture.
 */
export function requireNewClientBody(body: unknown, fields: string[]): void {
  const o = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!o || fields.some((f) => o[f] === undefined)) throw clientOutdated(400);
}

export type ContentBase = { versionId: string | null; epoch: number; legacy?: boolean };

/**
 * The version/epoch must describe the bytes the writer actually opened.
 *
 * Compatibilité transitoire (LEGACY_CLIENT_COMPAT) : si les DEUX en-têtes sont
 * absents (ancien client), la base est déduite de l'état courant sous verrou
 * (cf. assertContentBase). Compromis assumé : sans en-tête, on ne peut pas
 * garantir que le client a vu la dernière version ; l'écriture crée toutefois
 * TOUJOURS une nouvelle version, l'historique n'est jamais supprimé.
 */
export function contentPreconditions(
  headers: Record<string, unknown>,
  legacyCompat: boolean = config.legacyClientCompat,
): ContentBase {
  const version = headers["x-base-version-id"];
  const epoch = headers["x-key-epoch"];
  if (version === undefined && epoch === undefined) {
    if (legacyCompat) return { versionId: null, epoch: 0, legacy: true };
    throw clientOutdated(428);
  }
  if (version === undefined || epoch === undefined) {
    throw new ApiError(
      428,
      "precondition_required",
      "Rechargez le fichier : sa version et son époque de clé sont requises.",
    );
  }
  if (
    typeof version !== "string" ||
    (version !== "null" && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(version))
  ) {
    throw badRequest("En-tête x-base-version-id invalide.");
  }
  if (typeof epoch !== "string" || !/^[1-9][0-9]*$/.test(epoch) || !Number.isSafeInteger(Number(epoch))) {
    throw badRequest("En-tête x-key-epoch invalide.");
  }
  return { versionId: version === "null" ? null : version.toLowerCase(), epoch: Number(epoch) };
}

export function assertContentBase(
  base: ContentBase,
  current: { current_version_id?: string | null; key_epoch: number; key_rotation_required?: boolean },
): void {
  if (current.key_rotation_required) {
    throw conflict("Une révocation impose de renouveler la clé de ce fichier avant toute nouvelle écriture.");
  }
  // Mode compat : base = état courant (verrouillé par l'appelant), pas de comparaison.
  if (base.legacy) return;
  if (base.versionId !== (current.current_version_id ?? null) || base.epoch !== current.key_epoch) {
    throw conflict("Le contenu ou sa clé a changé : rechargez le fichier avant de renvoyer vos modifications.");
  }
}
