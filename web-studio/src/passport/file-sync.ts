/**
 * Sauvegarde automatique du passeport dans un FICHIER choisi sur l'ordinateur
 * (application de bureau et navigateurs Chromium, via l'API File System
 * Access). Le fichier est réécrit après chaque modification ; sa poignée est
 * conservée entre les sessions, la permission étant redemandée au clic si le
 * navigateur l'a retirée.
 */
import { strToU8 } from "fflate";
import {
  ensurePermission,
  forgetHandle,
  fsAccessSupported,
  permissionOf,
  recallHandle,
  rememberHandle,
  writeToHandle,
  type FsFileHandle,
} from "../workspace/fs-access";
import { backupJson } from "./exportPasseport";
import { safeStem } from "./print";
import type { PassportData } from "./types";

const HANDLE_KEY = "passport-autosave";
const JSON_TYPE = { description: "Sauvegarde du passeport", accept: { "application/json": [".json"] } };

export const fileSyncSupported = (): boolean => fsAccessSupported();

export const backupFileStem = (d: Pick<PassportData, "holder">): string =>
  `Passeport_GPME_${safeStem([d.holder.nom, d.holder.prenom].filter(Boolean).join("_") || "candidat")}`;

/** Fenêtre « Enregistrer sous… » ; null si annulée. Mémorise la poignée choisie. */
export async function chooseBackupFile(data: PassportData): Promise<FsFileHandle | null> {
  const w = window as unknown as {
    showSaveFilePicker?: (o: {
      suggestedName?: string;
      types?: (typeof JSON_TYPE)[];
      id?: string;
    }) => Promise<FsFileHandle>;
  };
  if (!w.showSaveFilePicker) return null;
  try {
    const handle = await w.showSaveFilePicker({
      suggestedName: `${backupFileStem(data)}.json`,
      types: [JSON_TYPE],
      id: "elium-passport-backup",
    });
    await rememberHandle(HANDLE_KEY, handle);
    return handle;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null;
    throw e;
  }
}

export const recallBackupFile = (): Promise<FsFileHandle | undefined> => recallHandle(HANDLE_KEY);
export const forgetBackupFile = (): Promise<void> => forgetHandle(HANDLE_KEY);

/** Vrai si l'écriture est déjà autorisée (sans geste de l'utilisateur). */
export async function canWriteSilently(handle: FsFileHandle): Promise<boolean> {
  return (await permissionOf(handle)) === "granted";
}

/** À appeler dans un clic : redemande la permission d'écriture. */
export const regrantBackupFile = (handle: FsFileHandle): Promise<boolean> => ensurePermission(handle);

export async function writeBackupFile(handle: FsFileHandle, data: PassportData): Promise<void> {
  await writeToHandle(handle, strToU8(backupJson(data)), "application/json");
}
