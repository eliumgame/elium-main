/**
 * Local persistence for the presentation deck (IndexedDB, this browser).
 * v1 keeps a single current deck. Storing decks inside encrypted/signed .elium
 * containers (content/slides.json) is a follow-up needing format support.
 */
import type { Deck } from "./model";

const DB_NAME = "elium-slides";
const STORE = "decks";
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

export async function loadDeck(): Promise<Deck | undefined> {
  const rec = await run<{ id: string; deck: Deck } | undefined>("readonly", (s) => s.get(CURRENT));
  return rec?.deck;
}

export async function saveDeck(deck: Deck): Promise<void> {
  await run("readwrite", (s) => s.put({ id: CURRENT, deck }));
}
