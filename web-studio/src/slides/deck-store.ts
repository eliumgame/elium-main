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
 * exported .elium file) — but unlike format/drafts-store.ts and
 * format/versions-store.ts (which throw when a protected snapshot can't be
 * decrypted), an earlier version of this file returned `undefined` in that
 * case, indistinguishable from "no autosave at all". The caller then treated
 * that as license to start from a blank deck, and the 400ms debounced
 * autosave silently overwrote the still-encrypted blob with that blank deck —
 * a permanent, silent data loss the moment the app vault is disabled/reset or
 * unlocked with the wrong password. Fixed to follow the SAME convention as
 * those two files: throw an explicit error instead (see resolveDeckRecord).
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

/**
 * Resolve a stored deck record to its content, decrypting when vault-protected.
 * Pure (no IndexedDB access), so the resolution rule is unit-testable on its
 * own — same split as resolveDraft (format/drafts-store.ts) and versionDoc
 * (format/versions-store.ts).
 *
 * Throws when the record is vault-protected and can't be decrypted with
 * `secret` (missing or wrong vault password) — same convention as those two
 * files: a disabled/reset/wrong vault must surface as an explicit error, never
 * as a silent "no deck" a caller could mistake for "nothing to restore" and
 * overwrite the encrypted autosave with a blank one.
 */
export async function resolveDeckRecord(
  rec: DeckRecord | { id: string; deck: Deck } | undefined,
  secret?: VaultSecret,
): Promise<Deck | undefined> {
  if (!rec) return undefined;
  if (!("vaultProtected" in rec)) return rec.deck; // legacy record, predates the vault
  if (!rec.vaultProtected) return rec.deck;
  if (!hasVaultSecret(secret)) throw new Error("Cette présentation est chiffrée — mot de passe requis.");
  return decryptAtRest<Deck>(rec.enc!, secret!);
}

/** Loads the autosaved deck. Returns `undefined` when there is none, or on a
 *  legacy pre-vault record (kept plaintext rather than discarded, still
 *  readable as-is). See {@link resolveDeckRecord} for the vault-protected case. */
export async function loadDeck(secret?: VaultSecret): Promise<Deck | undefined> {
  const rec = await run<DeckRecord | { id: string; deck: Deck } | undefined>("readonly", (s) => s.get(CURRENT));
  return resolveDeckRecord(rec, secret);
}

export async function saveDeck(deck: Deck, secret?: VaultSecret): Promise<void> {
  const record: DeckRecord = hasVaultSecret(secret)
    ? { id: CURRENT, vaultProtected: true, enc: await encryptAtRest(deck, secret!) }
    : { id: CURRENT, vaultProtected: false, deck };
  await run("readwrite", (s) => s.put(record));
}
