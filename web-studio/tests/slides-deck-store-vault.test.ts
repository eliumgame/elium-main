/**
 * deck-store.ts — resolveDeckRecord (the pure resolution rule behind loadDeck).
 *
 * Regression coverage for a real bug: a vault-protected autosave that can't be
 * decrypted (vault disabled/reset, or unlocked with the wrong password since
 * the deck was last saved) used to resolve to `undefined`, indistinguishable
 * from "no autosave at all". The caller (useLocalDeckStore) then started the
 * editor on a blank deck and its debounced autosave silently overwrote the
 * still-encrypted blob with that blank deck — permanent, silent data loss.
 *
 * Fixed to follow the SAME convention as resolveDraft (format/drafts-store.ts)
 * and versionDoc (format/versions-store.ts): throw an explicit error instead.
 * Tested here the same way those two are tested (drafts-crypto.test.ts,
 * versions-crypto.test.ts) — against hand-built records, no IndexedDB needed.
 */
import { describe, it, expect } from "vitest";
import { resolveDeckRecord } from "../src/slides/deck-store";
import { encryptAtRest } from "../src/crypto/local-vault";
import { emptyDeck, type Deck } from "../src/slides/model";

const deck: Deck = emptyDeck();

describe("deck-store — resolveDeckRecord", () => {
  it("returns undefined when there is no record at all (nothing to restore)", async () => {
    await expect(resolveDeckRecord(undefined)).resolves.toBeUndefined();
  });

  it("returns the deck as-is for a legacy pre-vault record", async () => {
    const rec = { id: "current", deck };
    await expect(resolveDeckRecord(rec)).resolves.toEqual(deck);
  });

  it("returns the deck as-is for an unprotected record", async () => {
    const rec = { id: "current", vaultProtected: false, deck };
    await expect(resolveDeckRecord(rec)).resolves.toEqual(deck);
  });

  it("round-trips a vault-protected record with the right secret", async () => {
    const enc = await encryptAtRest(deck, { password: "coffre" });
    const rec = { id: "current", vaultProtected: true, enc };
    await expect(resolveDeckRecord(rec, { password: "coffre" })).resolves.toEqual(deck);
  });

  // --- the regression: saved with a secret, reloaded without one ---
  it("THROWS — never resolves to undefined — when a vault-protected record is reloaded with no secret", async () => {
    const enc = await encryptAtRest(deck, { password: "coffre" });
    const rec = { id: "current", vaultProtected: true, enc };

    // The old behaviour: `resolveDeckRecord` (then inlined in loadDeck) returned
    // `undefined` here, which a caller cannot distinguish from "no autosave
    // exists" — the exact condition that led to the blank deck silently
    // overwriting the encrypted autosave. It must now reject instead.
    await expect(resolveDeckRecord(rec, undefined)).rejects.toThrow(/chiffr/i);
  });

  it("THROWS on a vault-protected record decrypted with the wrong password", async () => {
    const enc = await encryptAtRest(deck, { password: "bon" });
    const rec = { id: "current", vaultProtected: true, enc };
    await expect(resolveDeckRecord(rec, { password: "mauvais" })).rejects.toBeTruthy();
  });

  it("honours a keyfile-only secret (empty password) instead of treating it as no secret", async () => {
    const keyfile = new TextEncoder().encode("cle-de-fichier");
    const enc = await encryptAtRest(deck, { password: "", keyfile });
    const rec = { id: "current", vaultProtected: true, enc };
    await expect(resolveDeckRecord(rec, { password: "", keyfile })).resolves.toEqual(deck);
    await expect(resolveDeckRecord(rec, undefined)).rejects.toBeTruthy();
  });
});
