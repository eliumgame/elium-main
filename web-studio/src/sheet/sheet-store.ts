/**
 * Local persistence for the spreadsheet workbook (IndexedDB, this browser).
 * v1 keeps a single current workbook. Saving spreadsheets into encrypted/signed
 * .elium containers (content/sheet.json) is a follow-up needing format support.
 */
import type { Workbook } from "./model";

import { openMigrated } from "../format/idb-migrate";
import { SHEETS_SPEC } from "../format/db-specs";
const STORE = "workbooks";
const CURRENT = "current";

function openDb(): Promise<IDBDatabase> {
  return openMigrated(SHEETS_SPEC);
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );
}

export async function loadWorkbook(): Promise<Workbook | undefined> {
  const rec = await run<{ id: string; wb: Workbook } | undefined>("readonly", (s) => s.get(CURRENT));
  return rec?.wb;
}

export async function saveWorkbook(wb: Workbook): Promise<void> {
  await run("readwrite", (s) => s.put({ id: CURRENT, wb }));
}
