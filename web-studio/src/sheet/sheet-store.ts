/**
 * Local persistence for the spreadsheet workbook (IndexedDB, this browser).
 * v1 keeps a single current workbook. Saving spreadsheets into encrypted/signed
 * .elium containers (content/sheet.json) is a follow-up needing format support.
 */
import type { Workbook } from "./model";

const DB_NAME = "elium-sheets";
const STORE = "workbooks";
const DB_VERSION = 1;
const CURRENT = "current";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
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
