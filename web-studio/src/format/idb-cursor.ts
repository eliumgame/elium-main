/**
 * Lecture d'un magasin IndexedDB par curseur AVEC projection : chaque enregistrement est réduit à ses
 * métadonnées dès qu'il arrive, puis libéré. Un `getAll()` ramène en mémoire, en un seul bloc, les
 * octets de tous les documents (centaines de Mo) pour n'en garder que le titre ; ici le pic de mémoire
 * reste celui d'UN enregistrement et le fil principal reprend la main entre deux.
 */
export async function readProjected<T, R>(
  openDb: () => Promise<IDBDatabase>,
  storeName: string,
  project: (value: T) => R,
): Promise<R[]> {
  const db = await openDb();
  try {
    return await new Promise<R[]>((resolve, reject) => {
      const out: R[] = [];
      const t = db.transaction(storeName, "readonly");
      const req = t.objectStore(storeName).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(out);
        out.push(project(cursor.value as T));
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
      t.onabort = () => reject(t.error ?? new Error("Lecture annulée"));
    });
  } finally {
    db.close();
  }
}
