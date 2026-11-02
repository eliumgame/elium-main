/**
 * Sauvegarde automatique du passeport dans un FICHIER choisi sur l'ordinateur
 * (application de bureau et navigateurs Chromium, via l'API File System
 * Access). Le fichier est réécrit après chaque modification ; sa poignée est
 * conservée entre les sessions, la permission étant redemandée au clic si le
 * navigateur l'a retirée. Avant la PREMIÈRE écriture d'une session, le fichier
 * est relu et comparé au passeport local : une version différente (modifiée
 * depuis un autre poste) n'est jamais écrasée sans confirmation.
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
import { backupJson, parseBackup } from "./exportPasseport";
import { normalizePassport } from "./model";
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

/** Résultat de la comparaison entre le fichier de sauvegarde et le passeport de ce poste. */
export type BackupComparison =
  | { kind: "empty" } // fichier neuf ou vide : rien à perdre
  | { kind: "same" } // même version (même date de modification ou même contenu)
  | { kind: "unreadable" } // fichier non vide qui n'est pas une sauvegarde de passeport lisible
  | { kind: "differs"; fileData: PassportData; newer: "file" | "local" | "unknown" };

/** Contenu comparable : sans date ni annexes (la sauvegarde JSON ne garde pas les annexes). */
const leanJson = (d: PassportData) =>
  JSON.stringify({ ...d, updatedAt: "", situations: d.situations.map((s) => ({ ...s, annexes: [] })) });

/**
 * Compare le contenu d'un fichier de sauvegarde au passeport local (pur). Sert avant la première écriture d'une
 * session (association, réouverture, réautorisation) : le fichier peut avoir été modifié depuis un autre poste
 * (dossier synchronisé, clé USB).
 */
export function compareBackupText(text: string, local: PassportData): BackupComparison {
  if (text.trim() === "") return { kind: "empty" };
  let fileData: PassportData | null;
  try {
    fileData = normalizePassport(parseBackup(text));
  } catch {
    return { kind: "unreadable" };
  }
  if (!fileData) return { kind: "unreadable" };
  if (fileData.updatedAt === local.updatedAt) return { kind: "same" };
  const lean = leanJson(fileData);
  if (lean === leanJson(local) || lean === leanJson(normalizePassport(local) ?? local)) return { kind: "same" };
  const f = Date.parse(fileData.updatedAt);
  const l = Date.parse(local.updatedAt);
  const newer = Number.isNaN(f) || Number.isNaN(l) || f === l ? "unknown" : f > l ? "file" : "local";
  return { kind: "differs", fileData, newer };
}

/** Lit le fichier associé et le compare au passeport local (voir `compareBackupText`). */
export async function inspectBackupFile(handle: FsFileHandle, local: PassportData): Promise<BackupComparison> {
  const file = await handle.getFile();
  return compareBackupText(await file.text(), local);
}
