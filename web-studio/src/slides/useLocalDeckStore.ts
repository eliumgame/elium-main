/**
 * LocalDeckStore — the local-suite backend for the unified Présentations editor.
 * Backs the DeckStore contract with useUndoable (in-memory undo/redo) and the
 * IndexedDB deck-store (autosave/restore). Single-user, so `active` lives in the
 * deck and there is no presence.
 */
import { useEffect, useRef } from "react";
import { useUndoable } from "../ui/useUndoable";
import {
  emptyDeck, emptySlide, blankSlide, newSlideId, newElementId, withElements,
  type Deck, type Slide, type SlideElement,
} from "./model";
import { loadDeck, saveDeck } from "./deck-store";
import type { DeckStore } from "./store";

const migrate = (d: Deck): Deck => ({ ...d, slides: d.slides.map(withElements) });

export interface LocalDeckStore extends DeckStore {
  /** Live deck ref (for export handlers that must read the latest value). */
  deck: Deck;
}

export function useLocalDeckStore(initial?: Deck): LocalDeckStore {
  const { value: deck, set, setQuiet, checkpoint, undo, redo, canUndo, canRedo, reset } =
    useUndoable<Deck>(migrate(initial ?? emptyDeck()));

  // Load persisted deck on mount (only when not opening an explicit .elium deck).
  useEffect(() => {
    if (initial) return;
    loadDeck().then((d) => d && reset(migrate(d))).catch(() => {});
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced autosave + save on unmount.
  const deckRef = useRef(deck); deckRef.current = deck;
  useEffect(() => { if (initial) return; const t = setTimeout(() => void saveDeck(deck), 400); return () => clearTimeout(t); }, [deck, initial]);
  useEffect(() => () => { if (!initial) void saveDeck(deckRef.current); }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- element mutations on the active slide ---
  const setEls = (mut: (els: SlideElement[]) => SlideElement[], commit: boolean) => {
    (commit ? set : setQuiet)((d) => {
      const slides = d.slides.slice();
      const s = withElements(slides[d.active]!);
      slides[d.active] = { ...s, elements: mut(s.elements!) };
      return { ...d, slides };
    });
  };
  const updateEl = (id: string, patch: Partial<SlideElement>, commit = true) =>
    setEls((els) => els.map((e) => (e.id === id ? { ...e, ...patch } : e)), commit);
  const addEl = (elm: SlideElement) => setEls((els) => [...els, elm], true);
  const removeEl = (id: string) => setEls((els) => els.filter((e) => e.id !== id), true);
  const reorderEl = (id: string, dir: "front" | "back") => setEls((els) => {
    const i = els.findIndex((e) => e.id === id); if (i < 0) return els;
    const cp = els.slice(); const [it] = cp.splice(i, 1);
    if (dir === "front") cp.push(it!); else cp.unshift(it!);
    return cp;
  }, true);

  // --- deck / slide operations ---
  const setActive = (i: number) => set((d) => ({ ...d, active: i }));
  const setDeckField = (patch: Partial<Deck>) => set((d) => ({ ...d, ...patch }));
  const replaceDeck = (d: Deck) => reset(migrate({ ...d, active: 0 }));
  const patchSlide = (patch: Partial<Slide>, commit = false) =>
    (commit ? set : setQuiet)((d) => {
      const slides = d.slides.slice();
      slides[d.active] = { ...slides[d.active]!, ...patch };
      return { ...d, slides };
    });

  const addSlide = (blank = false) => set((d) => {
    const slides = d.slides.slice();
    slides.splice(d.active + 1, 0, blank ? blankSlide() : withElements(emptySlide("title-content")));
    return { ...d, slides, active: d.active + 1 };
  });
  const insertSlide = (slide: Slide) => set((d) => {
    const slides = d.slides.slice();
    slides.splice(d.active + 1, 0, withElements(slide));
    return { ...d, slides, active: d.active + 1 };
  });
  const removeSlide = (i: number) => set((d) => {
    if (d.slides.length <= 1) return d;
    const slides = d.slides.filter((_, idx) => idx !== i);
    return { ...d, slides, active: Math.max(0, Math.min(d.active, slides.length - 1)) };
  });
  const moveSlide = (i: number, dir: -1 | 1) => set((d) => {
    const j = i + dir; if (j < 0 || j >= d.slides.length) return d;
    const slides = d.slides.slice(); [slides[i], slides[j]] = [slides[j]!, slides[i]!];
    return { ...d, slides, active: j };
  });
  const duplicateSlide = (i: number) => set((d) => {
    const slides = d.slides.slice(); const orig = withElements(slides[i]!);
    slides.splice(i + 1, 0, { ...orig, id: newSlideId(), elements: orig.elements!.map((e) => ({ ...e, id: newElementId(), morphKey: e.morphKey ?? e.id })) });
    return { ...d, slides, active: i + 1 };
  });

  return {
    deck, active: deck.active, canWrite: true, collaborative: false,
    setActive, setDeckField, replaceDeck,
    addSlide, insertSlide, removeSlide, moveSlide, duplicateSlide, patchSlide,
    updateEl, addEl, removeEl, reorderEl,
    beginChange: checkpoint, undo, redo, canUndo, canRedo,
  };
}
