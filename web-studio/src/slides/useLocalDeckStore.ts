/**
 * LocalDeckStore — the local-suite backend for the unified Présentations editor.
 * Backs the DeckStore contract with useUndoable (in-memory undo/redo) and the
 * IndexedDB deck-store (autosave/restore, encrypted at rest when the app vault
 * is active — see deck-store.ts). Single-user, so `active` lives in the deck
 * and there is no presence.
 */
import { useEffect, useRef, useState } from "react";
import { useUndoable } from "../ui/useUndoable";
import {
  emptyDeck,
  emptySlide,
  blankSlide,
  withElements,
  type Deck,
  type Slide,
  type SlideElement,
  type SlideMaster,
} from "./model";
import { loadDeck, saveDeck } from "./deck-store";
import { applyMasterToDeck } from "./master";
import {
  reorderSlide as reorderSlideList,
  removeSlideKeepingSections,
  cloneSlide,
  normalizeSections,
} from "./sections";
import type { VaultSecret } from "../crypto/local-vault";
import type { DeckStore } from "./store";
import { reportError } from "../ui/crash-log";
import { isDeckPristine } from "../workspace/pristine";

const migrate = (d: Deck): Deck => ({ ...d, slides: d.slides.map(withElements) });

export interface LocalDeckStore extends DeckStore {
  /** Live deck ref (for export handlers that must read the latest value). */
  deck: Deck;
  /** Set when the IndexedDB autosave couldn't be loaded — today only when it's
   *  vault-protected and `vaultSecret` is missing/wrong (see deck-store.ts:
   *  loadDeck). The editor falls back to a blank deck but MUST NOT autosave
   *  over the still-encrypted blob while this is set, or the real deck is lost
   *  for good the moment the debounced autosave fires. The host view should
   *  surface this to the user (see SlidesView.tsx) instead of failing silently. */
  loadError?: string;
}

/** Persistance d'une présentation de l'espace de travail (voir SheetPersist). Sans elle : la présentation historique « current ». */
export interface DeckPersist {
  id: string;
  /** Nouvel élément : une présentation restée vierge n'est pas enregistrée. */
  isNew?: boolean;
  onSaved?: (deck: Deck, size: number) => void;
}

export function useLocalDeckStore(initial?: Deck, vaultSecret?: VaultSecret, persist?: DeckPersist): LocalDeckStore {
  const persistRef = useRef(persist);
  persistRef.current = persist;
  const persistId = persist?.id;
  const savedOnce = useRef(false);
  const {
    value: deck,
    set,
    setQuiet,
    checkpoint,
    undo,
    redo,
    canUndo,
    canRedo,
    reset,
  } = useUndoable<Deck>(migrate(initial ?? emptyDeck()));

  // Load persisted deck on mount (only when not opening an explicit .elium deck).
  // loadDeck() throws (rather than resolving to `undefined`) when the autosave
  // is vault-protected and can't be decrypted with `vaultSecret` — e.g. the
  // app vault was disabled/reset, or unlocked with the wrong password, since
  // the deck was last saved. Surface that as `loadError` instead of silently
  // falling back to a blank deck: see the autosave effect below, which must
  // stay disabled while `loadError` is set so it never overwrites the still-
  // encrypted blob.
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (initial) return;
    loadDeck(vaultSecret, persistId)
      .then((d) => {
        if (d) reset(migrate(d));
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, [initial, persistId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced autosave + save on unmount — both skipped while `loadError` is
  // set (see above): the in-memory deck is a blank placeholder in that case,
  // not a real replacement for the undecryptable autosave.
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const secretRef = useRef(vaultSecret);
  secretRef.current = vaultSecret;
  // Read via a ref (not a `loadError` dependency) in the unmount-save effect
  // below: `loadError` starts as `undefined` and flips to a string shortly
  // after mount, once the load attempt settles. If that effect depended on
  // `loadError` directly, React would run its *cleanup* — the save-on-unmount
  // call — the moment the dependency changes, not just on a real unmount, and
  // that cleanup's closure would still see the OLD (pre-change) `loadError`
  // value, i.e. `undefined` — silently saving the blank placeholder deck right
  // as the real error was discovered. A ref always reads the current value.
  const loadErrorRef = useRef(loadError);
  loadErrorRef.current = loadError;
  useEffect(() => {
    if (initial || loadError) return;
    const t = setTimeout(() => void persistDeck(deck), 400);
    return () => clearTimeout(t);
  }, [deck, initial, loadError]);
  useEffect(
    () => () => {
      if (!initial && !loadErrorRef.current) void persistDeck(deckRef.current);
    },
    [initial],
  ); // eslint-disable-line react-hooks/exhaustive-deps

  /** Enregistre la présentation (sauf nouvel élément resté vierge) puis prévient l'espace de travail. */
  async function persistDeck(d: Deck): Promise<void> {
    const p = persistRef.current;
    if (p?.isNew && !savedOnce.current && isDeckPristine(d)) return;
    try {
      await saveDeck(d, secretRef.current, p?.id);
      savedOnce.current = true;
      p?.onSaved?.(d, JSON.stringify(d).length);
    } catch (err) {
      reportError("deck-autosave", err);
    }
  }

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
  const reorderEl = (id: string, dir: "front" | "back") =>
    setEls((els) => {
      const i = els.findIndex((e) => e.id === id);
      if (i < 0) return els;
      const cp = els.slice();
      const [it] = cp.splice(i, 1);
      if (dir === "front") cp.push(it!);
      else cp.unshift(it!);
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

  const addSlide = (blank = false) =>
    set((d) => {
      const slides = d.slides.slice();
      slides.splice(d.active + 1, 0, blank ? blankSlide() : withElements(emptySlide("title-content")));
      return { ...d, slides, active: d.active + 1 };
    });
  const insertSlide = (slide: Slide) =>
    set((d) => {
      const slides = d.slides.slice();
      slides.splice(d.active + 1, 0, withElements(slide));
      return { ...d, slides, active: d.active + 1 };
    });
  const removeSlide = (i: number) =>
    set((d) => {
      if (d.slides.length <= 1) return d;
      const r = removeSlideKeepingSections(d.slides, d.sections, i);
      return {
        ...d,
        slides: r.slides,
        ...(d.sections ? { sections: r.sections } : {}),
        active: Math.max(0, Math.min(d.active, r.slides.length - 1)),
      };
    });
  const moveSlide = (i: number, dir: -1 | 1) =>
    set((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.slides.length) return d;
      const r = reorderSlideList(d.slides, d.sections, i, j);
      return { ...d, slides: r.slides, ...(d.sections ? { sections: r.sections } : {}), active: j };
    });
  const duplicateSlide = (i: number) =>
    set((d) => {
      const slides = d.slides.slice();
      slides.splice(i + 1, 0, cloneSlide(slides[i]!));
      return { ...d, slides, active: i + 1 };
    });
  const patchSlideAt = (i: number, patch: Partial<Slide>) =>
    set((d) => {
      if (!d.slides[i]) return d;
      const slides = d.slides.slice();
      slides[i] = { ...slides[i]!, ...patch };
      return { ...d, slides };
    });
  const replaceSlideAt = (i: number, slide: Slide) =>
    set((d) => {
      if (!d.slides[i]) return d;
      const slides = d.slides.slice();
      slides[i] = withElements(slide);
      return { ...d, slides };
    });
  const applyMaster = (master: SlideMaster) => set((d) => applyMasterToDeck(d, master));
  const reorderSlide = (from: number, to: number) =>
    set((d) => {
      const activeId = d.slides[d.active]?.id;
      const r = reorderSlideList(d.slides, d.sections, from, to);
      if (r.slides === d.slides) return d;
      return {
        ...d,
        slides: r.slides,
        ...(d.sections ? { sections: r.sections } : {}),
        active: Math.max(
          0,
          r.slides.findIndex((s) => s.id === activeId),
        ),
      };
    });
  const setSlideOrder = (ids: string[]) =>
    set((d) => {
      const byId = new Map(d.slides.map((s) => [s.id, s]));
      const slides = ids.map((id) => byId.get(id)).filter((s): s is Slide => !!s);
      if (slides.length !== d.slides.length) return d;
      const activeId = d.slides[d.active]?.id;
      return {
        ...d,
        slides,
        ...(d.sections ? { sections: normalizeSections(slides, d.sections) } : {}),
        active: Math.max(
          0,
          slides.findIndex((s) => s.id === activeId),
        ),
      };
    });

  return {
    deck,
    active: deck.active,
    canWrite: true,
    collaborative: false,
    loadError,
    setActive,
    setDeckField,
    replaceDeck,
    addSlide,
    insertSlide,
    removeSlide,
    moveSlide,
    duplicateSlide,
    patchSlide,
    patchSlideAt,
    replaceSlideAt,
    applyMaster,
    reorderSlide,
    setSlideOrder,
    updateEl,
    addEl,
    removeEl,
    reorderEl,
    beginChange: checkpoint,
    undo,
    redo,
    canUndo,
    canRedo,
  };
}
