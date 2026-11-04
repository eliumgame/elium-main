import { ApiError, badRequest, conflict } from "./errors.js";

/** The version/epoch must describe the bytes the writer actually opened. */
export function contentPreconditions(headers: Record<string, unknown>): { versionId: string | null; epoch: number } {
  const version = headers["x-base-version-id"];
  const epoch = headers["x-key-epoch"];
  if (version === undefined || epoch === undefined) {
    throw new ApiError(428, "precondition_required", "Rechargez le fichier : sa version et son époque de clé sont requises.");
  }
  if (typeof version !== "string" || (version !== "null" && !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(version))) {
    throw badRequest("En-tête x-base-version-id invalide.");
  }
  if (typeof epoch !== "string" || !/^[1-9][0-9]*$/.test(epoch) || !Number.isSafeInteger(Number(epoch))) {
    throw badRequest("En-tête x-key-epoch invalide.");
  }
  return { versionId: version === "null" ? null : version.toLowerCase(), epoch: Number(epoch) };
}

export function assertContentBase(base: { versionId: string | null; epoch: number }, current: { current_version_id?: string | null; key_epoch: number; key_rotation_required?: boolean }): void {
  if (current.key_rotation_required) {
    throw conflict("Une révocation impose de renouveler la clé de ce fichier avant toute nouvelle écriture.");
  }
  if (base.versionId !== (current.current_version_id ?? null) || base.epoch !== current.key_epoch) {
    throw conflict("Le contenu ou sa clé a changé : rechargez le fichier avant de renvoyer vos modifications.");
  }
}
