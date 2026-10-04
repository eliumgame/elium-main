/**
 * Persistance locale des classeurs (IndexedDB, ce navigateur).
 *
 * Plusieurs classeurs par base, un par élément de l'espace de travail
 * (voir workspace/). La clé historique « current » (v1 : un seul classeur)
 * reste lisible ; `workspace/legacy-import.ts` la déplace en premier élément.
 * Quand le coffre local est actif, chaque classeur est chiffré au repos
 * (même schéma que les présentations et la bibliothèque).
 */
import type { Workbook } from "./model";
import { openMigrated } from "../format/idb-migrate";
import { SHEETS_SPEC } from "../format/db-specs";
import { idbKv } from "../workspace/kv";
import { createJsonStore, type JsonRecord } from "../workspace/record-store";
import type { VaultSecret } from "../crypto/local-vault";

const STORE = "workbooks";
export const LEGACY_WORKBOOK_ID = "current";

/** Ouvre la base des classeurs (conservé pour les appelants qui veulent migrer sans lire). */
export function openSheetsDb(): Promise<IDBDatabase> {
  return openMigrated(SHEETS_SPEC);
}

export const sheetStore = createJsonStore<Workbook>(idbKv<JsonRecord>(SHEETS_SPEC, STORE), {
  field: "wb",
  lockedMessage: "Ce classeur est chiffré — mot de passe du coffre requis.",
});

/** Charge un classeur (par défaut l'ancien classeur unique « current »). */
export async function loadWorkbook(id: string = LEGACY_WORKBOOK_ID, secret?: VaultSecret): Promise<Workbook | undefined> {
  return sheetStore.load(id, secret);
}

export async function saveWorkbook(wb: Workbook, id: string = LEGACY_WORKBOOK_ID, secret?: VaultSecret): Promise<void> {
  await sheetStore.save(id, wb, secret);
}
