// @vitest-environment jsdom
/**
 * Key toolbar actions for the shared SlidesEditor, mounted with the real
 * useLocalDeckStore. Passing an explicit `initial` deck keeps the IndexedDB
 * autosave effects inert (see useLocalDeckStore.ts: `if (initial) return;`),
 * so this needs no indexedDB polyfill — same trick the app itself uses when
 * opening an explicit .elium deck.
 */
import { useRef, type MutableRefObject } from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SlidesEditor from "../src/slides/SlidesEditor";
import { useLocalDeckStore, type LocalDeckStore } from "../src/slides/useLocalDeckStore";
import { DialogsProvider } from "../src/ui/dialogs";
import { emptyDeck } from "../src/slides/model";
import type { Deck } from "../src/slides/model";

afterEach(cleanup);

beforeEach(() => {
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function Harness({ initial, storeRef }: { initial: Deck; storeRef: MutableRefObject<LocalDeckStore | null> }) {
  const store = useLocalDeckStore(initial);
  storeRef.current = store;
  return (
    <DialogsProvider>
      <SlidesEditor store={store} chrome={{ title: "Test" }} />
    </DialogsProvider>
  );
}

function mount() {
  const storeRef = { current: null } as MutableRefObject<LocalDeckStore | null>;
  render(<Harness initial={emptyDeck()} storeRef={storeRef} />);
  return storeRef;
}

describe("SlidesEditor (component) — key toolbar actions", () => {
  it("starts from the given deck with undo/redo both disabled", () => {
    const store = mount();
    expect(store.current!.deck.slides.length).toBe(1);
    expect(screen.getByTitle("Annuler (Ctrl+Z)")).toHaveProperty("disabled", true);
    expect(screen.getByTitle("Rétablir (Ctrl+Y)")).toHaveProperty("disabled", true);
  });

  it("'Diapo' adds a slide, and Annuler/Rétablir (undo/redo) round-trip it", async () => {
    const store = mount();
    await userEvent.click(screen.getByText("Diapo"));
    expect(store.current!.deck.slides.length).toBe(2);

    const undoBtn = screen.getByTitle("Annuler (Ctrl+Z)");
    expect(undoBtn).toHaveProperty("disabled", false);
    await userEvent.click(undoBtn);
    expect(store.current!.deck.slides.length).toBe(1);

    const redoBtn = screen.getByTitle("Rétablir (Ctrl+Y)");
    expect(redoBtn).toHaveProperty("disabled", false);
    await userEvent.click(redoBtn);
    expect(store.current!.deck.slides.length).toBe(2);
  });

  it("'Texte' adds a text element to the active slide", async () => {
    const store = mount();
    const before = store.current!.deck.slides[0]!.elements!.length;
    await userEvent.click(screen.getByText("Texte"));
    expect(store.current!.deck.slides[0]!.elements!.length).toBe(before + 1);
    expect(store.current!.deck.slides[0]!.elements!.at(-1)!.type).toBe("text");
  });

  it("the Forme gallery opens as a real ARIA menu and adds the chosen shape", async () => {
    const store = mount();
    await userEvent.click(screen.getByText("Forme ▾"));
    const menu = screen.getByRole("menu", { name: "Formes" });
    await userEvent.click(within(menu).getByTitle("Ellipse"));
    const els = store.current!.deck.slides[0]!.elements!;
    expect(els.at(-1)!.type).toBe("shape");
    expect(els.at(-1)!.shape).toBe("ellipse");
    // the popover closes itself after picking an entry
    expect(screen.queryByRole("menu", { name: "Formes" })).toBeNull();
  });

  it("the Forme gallery closes on Échap without adding anything", async () => {
    const store = mount();
    const before = store.current!.deck.slides[0]!.elements!.length;
    await userEvent.click(screen.getByText("Forme ▾"));
    expect(screen.getByRole("menu", { name: "Formes" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu", { name: "Formes" })).toBeNull();
    expect(store.current!.deck.slides[0]!.elements!.length).toBe(before);
  });
});
