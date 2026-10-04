/**
 * Petit magasin clé→enregistrement, abstrait pour pouvoir tester la logique de
 * l'espace de travail avec une implémentation mémoire (vitest tourne sans
 * IndexedDB) tout en s'appuyant sur IndexedDB (`idbKv`) en production.
 * Les enregistrements sont indexés par leur champ `id`.
 */
import { openMigrated, type DbSpec } from "../format/idb-migrate";

export interface KvStore<T extends { id: string }> {
  get(id: string): Promise<T | undefined>;
  getAll(): Promise<T[]>;
  keys(): Promise<string[]>;
  put(value: T): Promise<void>;
  /** Écrit tout le lot dans UNE transaction : tout ou rien. */
  putMany(values: T[]): Promise<void>;
  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<void>;
  clear(): Promise<void>;
}

/** Implémentation en mémoire (tests, repli quand IndexedDB est indisponible). */
export function memoryKv<T extends { id: string }>(initial: T[] = []): KvStore<T> & { snapshot(): T[] } {
  const map = new Map<string, T>(initial.map((v) => [v.id, structuredClone(v)]));
  return {
    async get(id) {
      const v = map.get(id);
      return v === undefined ? undefined : structuredClone(v);
    },
    async getAll() {
      return [...map.values()].map((v) => structuredClone(v));
    },
    async keys() {
      return [...map.keys()];
    },
    async put(v) {
      map.set(v.id, structuredClone(v));
    },
    async putMany(vs) {
      for (const v of vs) map.set(v.id, structuredClone(v));
    },
    async delete(id) {
      map.delete(id);
    },
    async deleteMany(ids) {
      for (const id of ids) map.delete(id);
    },
    async clear() {
      map.clear();
    },
    snapshot: () => [...map.values()].map((v) => structuredClone(v)),
  };
}

function reqP<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Magasin IndexedDB d'une table d'une base déclarée (ouverture via openMigrated à chaque opération, comme les autres magasins). */
export function idbKv<T extends { id: string }>(spec: DbSpec, store: string): KvStore<T> {
  async function tx<R>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<R> | R): Promise<R> {
    const db = await openMigrated(spec);
    try {
      const t = db.transaction(store, mode);
      const done = new Promise<void>((resolve, reject) => {
        t.oncomplete = () => resolve();
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error ?? new Error("Transaction annulée"));
      });
      const out = await fn(t.objectStore(store));
      await done;
      return out;
    } finally {
      db.close();
    }
  }
  return {
    get: (id) => tx("readonly", (s) => reqP(s.get(id) as IDBRequest<T | undefined>)),
    getAll: () => tx("readonly", (s) => reqP(s.getAll() as IDBRequest<T[]>)),
    keys: () => tx("readonly", async (s) => (await reqP(s.getAllKeys())).map(String)),
    put: (v) => tx("readwrite", (s) => void s.put(v)),
    putMany: (vs) =>
      tx("readwrite", (s) => {
        for (const v of vs) s.put(v);
      }),
    delete: (id) => tx("readwrite", (s) => void s.delete(id)),
    deleteMany: (ids) =>
      tx("readwrite", (s) => {
        for (const id of ids) s.delete(id);
      }),
    clear: () => tx("readwrite", (s) => void s.clear()),
  };
}
