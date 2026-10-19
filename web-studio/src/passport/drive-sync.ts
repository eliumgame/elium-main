/**
 * Sauvegarde du passeport dans le Drive entreprise (serveur) : un fichier JSON chiffré de bout en
 * bout, versionné par le serveur. Sert à retrouver son passeport depuis un autre appareil ou
 * navigateur, et à le garder quand les données locales sont effacées.
 */
import { strFromU8, strToU8 } from "fflate";
import {
  isConflict,
  pullNamedFile,
  pushNamedFile,
  readAuto as readAutoFlag,
  readLink as readLinkOf,
  writeAuto as writeAutoFlag,
  writeLink,
  type DriveLink,
} from "../drive-cloud/named-file";
import type { OpsCtx } from "../drive-cloud/ops";
import { backupJson, parseBackup } from "./exportPasseport";
import { normalizePassport } from "./model";
import type { PassportData } from "./types";

export const DRIVE_FILE_NAME = "Passeport-BTS-GPME.json";
const SLOT = "passport";
type Who = Pick<OpsCtx, "userId" | "orgId">;

export type { DriveLink };
export { isConflict };
export const readLink = (w: Who): DriveLink | null => readLinkOf(SLOT, w);
export const readAuto = (w: Who): boolean => readAutoFlag(SLOT, w);
export const writeAuto = (w: Who, on: boolean): void => writeAutoFlag(SLOT, w, on);
export const forgetLink = (w: Who): void => writeLink(SLOT, w, null);

/** Écrit le passeport dans le Drive ; `DriveConflict` si modifié ailleurs (sauf `force`). */
export function pushPassport(ctx: OpsCtx, data: PassportData, opts: { force?: boolean } = {}): Promise<DriveLink> {
  return pushNamedFile(ctx, SLOT, DRIVE_FILE_NAME, strToU8(backupJson(data)), { ...opts, mime: "application/json" });
}

/** Lit le passeport du Drive. `null` si aucun fichier n'existe. */
export async function pullPassport(ctx: OpsCtx): Promise<{ data: PassportData; link: DriveLink } | null> {
  const got = await pullNamedFile(ctx, SLOT, DRIVE_FILE_NAME);
  if (!got) return null;
  const data = normalizePassport(parseBackup(strFromU8(got.bytes)));
  if (!data) throw new Error("Le fichier du Drive n'est pas un passeport Elium valide.");
  return { data, link: got.link };
}
