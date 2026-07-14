/**
 * DeckStore — the persistence-agnostic contract behind the unified Présentations
 * editor. The shared <SlidesEditor> renders every toolbar, panel, canvas gesture
 * and the presenter purely against this interface, so a feature written once
 * lights up on BOTH surfaces:
 *   - local suite  → LocalDeckStore  (useUndoable + IndexedDB deck-store)
 *   - Drive cloud  → CollabDeckStore (encrypted Y.Doc, live presence)
 *
 * Deck data + mutations live in the store; per-user UI state (selection, the
 * presenter, open menus) stays in <SlidesEditor>. `active` is intentionally part
 * of the store because it lives in different places per backend (persisted in the
 * local deck vs. per-user local state in collab).
 */
import type { Deck, Slide, SlideElement } from "./model";

export type DeckStatus = "connecting" | "open" | "closed" | "revoked";

/** A collaborator's live presence (collab backend only). */
export interface DeckPeer {
  color: string;
  name: string;
  slide: number;
}

export interface DeckPresence {
  me: { color: string; name: string };
  peers: DeckPeer[];
}

export interface DeckStore {
  /** Current deck snapshot (plain objects; a fresh reference on every change). */
  deck: Deck;
  /** Index of the slide the local user is viewing/editing. */
  active: number;
  /** Whether the current user may mutate the deck (collab read-only viewers = false). */
  canWrite: boolean;
  /** True for the Drive collaborative backend (enables presence chrome, etc.). */
  collaborative: boolean;

  setActive(i: number): void;
  /** Deck-level fields: theme, default transition. */
  setDeckField(patch: Partial<Deck>): void;
  /** Replace the whole deck (e.g. after a PPTX/.elium import). Optional: a
   *  read-only collaborator can't, and some backends may not support it. */
  replaceDeck?(deck: Deck): void;

  // --- slide operations ---
  addSlide(blank?: boolean): void;
  /** Insert a fully-built slide (e.g. from a template) after the active one. */
  insertSlide(slide: Slide): void;
  removeSlide(i: number): void;
  moveSlide(i: number, dir: -1 | 1): void;
  duplicateSlide(i: number): void;
  /** Patch the active slide (notes, background, layout…). `commit` gates undo history. */
  patchSlide(patch: Partial<Slide>, commit?: boolean): void;

  // --- element operations (act on the active slide) ---
  updateEl(id: string, patch: Partial<SlideElement>, commit?: boolean): void;
  addEl(el: SlideElement): void;
  removeEl(id: string): void;
  reorderEl(id: string, dir: "front" | "back"): void;

  // --- undo (optional: local has real history; collab omits it) ---
  beginChange(): void; // checkpoint before a drag gesture
  undo?: () => void;
  redo?: () => void;
  canUndo?: boolean;
  canRedo?: boolean;

  // --- collab-only ---
  presence?: DeckPresence;
  status?: DeckStatus;
}
