/**
 * Digital IDs and trusted identities kept in this browser (Acrobat's
 * Préférences › Signatures › Identités et certificats approuvés).
 *
 *  - A self-signed ID holds its WebCrypto private key as a non-extractable
 *    CryptoKey (IndexedDB stores it as is: the key bytes cannot be read back).
 *  - A certificate file (.p12/.pfx) is remembered as the file itself, still
 *    protected by its password, asked at each signature.
 *  - Trusted identities are certificates (DER): a signature whose chain ends
 *    on one of them is shown as trusted. The user's own IDs are trusted.
 *  - Handwritten signatures and initials (pictures) for « Remplir et signer ».
 */

import type { SavedSignature } from "../ops/sign";

const DB_NAME = "elium-pdf-ids";
const STORE = "ids";
const TRUST = "trusted";
const MARKS = "marks";

export type DigitalId =
  | { id: string; kind: "self"; name: string; created: number; key: CryptoKey; cert: Uint8Array }
  | { id: string; kind: "p12"; name: string; created: number; fileName: string; p12: Uint8Array; cert: Uint8Array };

export interface TrustedIdentity {
  id: string;
  name: string;
  cert: Uint8Array;
  added: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(TRUST)) db.createObjectStore(TRUST, { keyPath: "id" });
      // v2: handwritten signatures and initials (Remplir et signer), kept between documents.
      if (!db.objectStoreNames.contains(MARKS)) db.createObjectStore(MARKS, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export async function listIds(): Promise<DigitalId[]> {
  try {
    const all = await run<DigitalId[]>(STORE, "readonly", (s) => s.getAll() as IDBRequest<DigitalId[]>);
    return all.sort((a, b) => a.created - b.created);
  } catch {
    return [];
  }
}

export async function addSelfId(name: string, key: CryptoKey, cert: Uint8Array): Promise<DigitalId> {
  const id: DigitalId = { id: newId(), kind: "self", name, created: Date.now(), key, cert };
  await run(STORE, "readwrite", (s) => s.put(id));
  return id;
}

export async function addP12Id(name: string, fileName: string, p12: Uint8Array, cert: Uint8Array): Promise<DigitalId> {
  const id: DigitalId = { id: newId(), kind: "p12", name, created: Date.now(), fileName, p12, cert };
  await run(STORE, "readwrite", (s) => s.put(id));
  return id;
}

export async function removeId(id: string): Promise<void> {
  await run(STORE, "readwrite", (s) => s.delete(id));
}

export async function listTrusted(): Promise<TrustedIdentity[]> {
  try {
    return await run<TrustedIdentity[]>(TRUST, "readonly", (s) => s.getAll() as IDBRequest<TrustedIdentity[]>);
  } catch {
    return [];
  }
}

export async function addTrusted(name: string, cert: Uint8Array): Promise<void> {
  const existing = await listTrusted();
  if (existing.some((t) => sameBytes(t.cert, cert))) return;
  await run(TRUST, "readwrite", (s) => s.put({ id: newId(), name, cert, added: Date.now() }));
}

export async function removeTrusted(id: string): Promise<void> {
  await run(TRUST, "readwrite", (s) => s.delete(id));
}

/** Certificates a verification trusts: the user's list and their own IDs. */
export async function trustAnchors(): Promise<Uint8Array[]> {
  const [trusted, ids] = await Promise.all([listTrusted(), listIds()]);
  return [...trusted.map((t) => t.cert), ...ids.map((i) => i.cert)];
}

/** Saved handwritten signatures and initials (pictures), oldest first. */
export async function listSavedMarks(): Promise<SavedSignature[]> {
  try {
    const all = await run<SavedSignature[]>(MARKS, "readonly", (s) => s.getAll() as IDBRequest<SavedSignature[]>);
    return all.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch {
    return [];
  }
}

export async function saveMark(mark: SavedSignature): Promise<void> {
  await run(MARKS, "readwrite", (s) => s.put(mark)).catch(() => {});
}

export async function removeMark(id: string): Promise<void> {
  await run(MARKS, "readwrite", (s) => s.delete(id)).catch(() => {});
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
