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
import { hasVaultSecret, type VaultSecret } from "../crypto/local-vault";
import type { Deck } from "./model";
import { openMigrated } from "../format/idb-migrate";
import { SLIDES_SPEC } from "../format/db-specs";
import { idbKv } from "../workspace/kv";
import { createJsonStore, type JsonRecord } from "../workspace/record-store";

const STORE = "decks";
export const LEGACY_DECK_ID = "current";

const LOCKED = "Cette présentation est chiffrée — mot de passe requis.";

/** Ouvre la base des présentations (migrations jouées à l'ouverture). */
export function openDecksDb(): Promise<IDBDatabase> {
  return openMigrated(SLIDES_SPEC);
}

/** Plusieurs présentations par base (un élément de l'espace de travail chacune). */
export const deckStore = createJsonStore<Deck>(idbKv<JsonRecord>(SLIDES_SPEC, STORE), {
  field: "deck",
  lockedMessage: LOCKED,
});

interface DeckRecord {
  id: string;
  vaultProtected: boolean;
  deck?: Deck; // plaintext — only when NOT vault-protected
  enc?: string; // encrypted deck — only when vault-protected
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
  if (!hasVaultSecret(secret)) throw new Error(LOCKED);
  return deckStore.resolve(rec as JsonRecord, secret);
}

/** Loads a deck (by default the legacy single "current" deck). Returns `undefined` when there is none.
 *  See {@link resolveDeckRecord} for the vault-protected case. */
export async function loadDeck(secret?: VaultSecret, id: string = LEGACY_DECK_ID): Promise<Deck | undefined> {
  return deckStore.load(id, secret);
}

export async function saveDeck(deck: Deck, secret?: VaultSecret, id: string = LEGACY_DECK_ID): Promise<void> {
  await deckStore.save(id, deck, secret);
}
