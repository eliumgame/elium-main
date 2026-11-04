// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { emptyDeck, type Deck } from "../src/slides/model";

const loadDeck = vi.fn();
const saveDeck = vi.fn();
vi.mock("../src/slides/deck-store", () => ({
  loadDeck: (...a: unknown[]) => loadDeck(...a),
  saveDeck: (...a: unknown[]) => saveDeck(...a),
}));

import { shouldPersistDeck, useLocalDeckStore } from "../src/slides/useLocalDeckStore";

const base = { loaded: true, loadError: false, isNew: false, savedOnce: false, pristine: () => false };

describe("shouldPersistDeck (décision pure)", () => {
  it("n'écrit rien avant la fin du chargement", () => {
    expect(shouldPersistDeck({ ...base, loaded: false })).toBe(false);
  });
  it("n'écrit rien après une erreur de chargement", () => {
    expect(shouldPersistDeck({ ...base, loadError: true })).toBe(false);
  });
  it("n'enregistre pas un nouvel élément resté vierge, mais enregistre une fois modifié ou déjà enregistré", () => {
    expect(shouldPersistDeck({ ...base, isNew: true, pristine: () => true })).toBe(false);
    expect(shouldPersistDeck({ ...base, isNew: true, pristine: () => false })).toBe(true);
    expect(shouldPersistDeck({ ...base, isNew: true, savedOnce: true, pristine: () => true })).toBe(true);
  });
  it("enregistre un deck existant chargé", () => {
    expect(shouldPersistDeck(base)).toBe(true);
  });
});

describe("useLocalDeckStore : course de chargement", () => {
  beforeEach(() => {
    loadDeck.mockReset();
    saveDeck.mockReset();
    saveDeck.mockResolvedValue(10);
  });

  it("ne sauvegarde pas le deck vierge avant la fin du chargement, puis charge sans écraser", async () => {
    let resolveLoad!: (d: Deck) => void;
    loadDeck.mockReturnValue(new Promise<Deck>((r) => (resolveLoad = r)));
    const existing: Deck = { ...emptyDeck(), theme: "dark" };
    const { result, unmount } = renderHook(() => useLocalDeckStore(undefined, undefined, { id: "d1" }));

    let size: number | undefined;
    await act(async () => {
      size = await result.current.flush();
    });
    expect(size).toBeUndefined();
    expect(saveDeck).not.toHaveBeenCalled();

    await act(async () => {
      resolveLoad(existing);
    });
    expect(result.current.deck.theme).toBe("dark");
    // Une écriture ultérieure porte le deck existant, jamais le vierge.
    await act(async () => {
      await result.current.flush();
    });
    expect(saveDeck).toHaveBeenCalledTimes(1);
    expect((saveDeck.mock.calls[0]![0] as Deck).theme).toBe("dark");
    unmount();
  });

  it("ne sauvegarde rien au démontage tant que le chargement n'est pas terminé", () => {
    loadDeck.mockReturnValue(new Promise(() => {}));
    const { unmount } = renderHook(() => useLocalDeckStore(undefined, undefined, { id: "d2" }));
    unmount();
    expect(saveDeck).not.toHaveBeenCalled();
  });
});
