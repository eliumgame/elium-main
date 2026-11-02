/** A successful request is provisional until its transaction commits. */
export function committedRequest<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(store, mode);
    } catch (error) {
      db.close();
      reject(error);
      return;
    }
    let request: IDBRequest<T>;
    transaction.oncomplete = () => {
      db.close();
      resolve(request.result);
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error ?? new Error("L'enregistrement du passeport a été annulé."));
    };
    try {
      request = operation(transaction.objectStore(store));
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  });
}
