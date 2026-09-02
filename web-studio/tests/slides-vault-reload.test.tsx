// @vitest-environment jsdom
/**
 * useLocalDeckStore — no silent data loss on vault-protected reload.
 *
 * Regression test for the bug fixed in deck-store.ts / useLocalDeckStore.ts:
 * disabling/resetting the app-wide local vault (or reopening with a wrong
 * vault password) after a presentation had been autosaved while the vault was
 * active used to make loadDeck() resolve to `undefined` — indistinguishable
 * from "no autosave at all". `useLocalDeckStore` then started the editor on a
 * blank deck, and the 400ms debounced autosave silently overwrote the
 * still-encrypted IndexedDB blob with that blank deck: a permanent, silent
 * loss of the real presentation.
 *
 * deck-store.ts now throws instead (same convention as resolveDraft /
 * versionDoc — see slides-deck-store-vault.test.ts), and this test exercises
 * the consumer side: useLocalDeckStore must catch that error, expose it as
 * `loadError`, and — critically — never call saveDeck() while it's set.
 *
 * loadDeck/saveDeck are mocked directly rather than exercised through real
 * IndexedDB: this test environment has no IndexedDB implementation (jsdom
 * doesn't provide one here), which is also why every other test touching
 * useLocalDeckStore passes an explicit `initial` deck to keep the autosave
 * effects inert (see slides-editor.test.tsx).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, waitFor, cleanup } from "@testing-library/react";

const loadDeck = vi.fn();
const saveDeck = vi.fn();
vi.mock("../src/slides/deck-store", () => ({
  loadDeck: (...args: unknown[]) => loadDeck(...args),
  saveDeck: (...args: unknown[]) => saveDeck(...args),
}));

import { useLocalDeckStore } from "../src/slides/useLocalDeckStore";
import { emptyDeck, emptySlide } from "../src/slides/model";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useLocalDeckStore — vault-protected autosave that can't be decrypted", () => {
  it("surfaces loadError and never autosaves the blank placeholder over the encrypted deck", async () => {
    loadDeck.mockRejectedValue(new Error("Cette présentation est chiffrée — mot de passe requis."));
    saveDeck.mockResolvedValue(undefined);

    const { result, unmount } = renderHook(() => useLocalDeckStore());

    await waitFor(() => expect(result.current.loadError).toBeTruthy());
    expect(result.current.loadError).toMatch(/chiffr/i);
    // Falls back to a blank deck in memory...
    expect(result.current.deck.slides.length).toBe(1);

    // ...but must NOT persist it: give the debounced autosave (400ms) every
    // chance to fire before asserting it never did.
    await new Promise((r) => setTimeout(r, 700));
    expect(saveDeck).not.toHaveBeenCalled();

    // Closing the editor (unmount save) must not persist it either.
    unmount();
    await new Promise((r) => setTimeout(r, 50));
    expect(saveDeck).not.toHaveBeenCalled();
  });

  it("loads normally and autosaves as usual when there is no vault issue", async () => {
    const saved = { ...emptyDeck(), slides: [...emptyDeck().slides, emptySlide()] };
    loadDeck.mockResolvedValue(saved);
    saveDeck.mockResolvedValue(undefined);

    const { result } = renderHook(() => useLocalDeckStore());

    await waitFor(() => expect(result.current.deck.slides.length).toBe(2));
    expect(result.current.loadError).toBeUndefined();

    await new Promise((r) => setTimeout(r, 700));
    expect(saveDeck).toHaveBeenCalled();
  });
});
