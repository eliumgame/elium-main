/**
 * Local persistence for the presentation deck (IndexedDB, this browser).
 * v1 keeps a single current deck. Storing decks inside encrypted/signed .elium
 * containers (content/slides.json) is a follow-up needing format support.
 *
 * When the app-wide local vault (crypto/local-vault.ts, see format/vault-store.ts)
 * is configured and unlocked, the deck is encrypted at rest — same pattern as
 * format/drive-store.ts and format/parapheur-store.ts. Decks have no password of
 * their own (unlike Documents' EliumProfile), so the vault is the only secret
 * available; without it, behaviour is unchanged and the deck is stored verbatim.
 * This is an autosave/recovery cache, not the document of record (that's the
 * exported .elium file), so a vault password change or reset simply starts the
 * next session from a blank deck instead of the stale autosave — the same
 * "best-effort" contract every other autosave cache here already has.
 */
import { encryptAtRest, decryptAtRest, hasVaultSecret, type VaultSecret } from "../crypto/local-vault";
import type { Deck } from "./model";

const DB_NAME = "elium-slides";
const STORE = "decks";
const DB_VERSION = 1;
const CURRENT = "current";

interface DeckRecord {
  id: string;
  vaultProtected: boolean;
  deck?: Deck; // plaintext — only when NOT vault-protected
  enc?: string; // encrypted deck — only when vault-protected
}

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

/** Loads the autosaved deck. Returns `undefined` when there is none, when a
 *  vault-protected record can't be decrypted with `secret` (wrong/missing
 *  vault password) — best-effort, never throws — or on a legacy pre-vault
 *  record (kept plaintext rather than discarded, still readable as-is). */
export async function loadDeck(secret?: VaultSecret): Promise<Deck | undefined> {
  const rec = await run<DeckRecord | { id: string; deck: Deck } | undefined>("readonly", (s) => s.get(CURRENT));
  if (!rec) return undefined;
  if (!("vaultProtected" in rec)) return rec.deck; // legacy record, predates the vault
  if (!rec.vaultProtected) return rec.deck;
  if (!hasVaultSecret(secret)) return undefined;
  try {
    return await decryptAtRest<Deck>(rec.enc!, secret!);
  } catch {
    return undefined; // wrong/missing vault password — never crash the editor
  }
}

export async function saveDeck(deck: Deck, secret?: VaultSecret): Promise<void> {
  const record: DeckRecord = hasVaultSecret(secret)
    ? { id: CURRENT, vaultProtected: true, enc: await encryptAtRest(deck, secret!) }
    : { id: CURRENT, vaultProtected: false, deck };
  await run("readwrite", (s) => s.put(record));
}
