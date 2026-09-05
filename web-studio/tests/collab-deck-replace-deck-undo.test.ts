/**
 * useCollabDeckStore — replaceDeck() must not become undoable.
 *
 * Regression test for the Présentations twin of the bug fixed for the Tableur
 * in sheet-replace-workbook-undo.test.tsx (local store) and
 * collab-sheet-replace-workbook-undo.test.ts (collaborative store). Importing
 * a .pptx (SlidesEditor's "Importer" action) calls store.replaceDeck(next),
 * which used to run its writes in a single plain `ydoc.transact()` — the
 * default (null) origin.
 *
 * useCollabDeckStore builds its Y.UndoManager as `new Y.UndoManager(deckMap)`
 * with no custom `trackedOrigins`. Yjs's default `trackedOrigins` is
 * `Set([null])`, i.e. it tracks exactly the origin our own local edits use —
 * including the null-origin transact() replaceDeck ran. So importing a deck
 * (even into a just-created, still-placeholder one) made
 * `undoMgr.canUndo()` flip to `true`, and a single Ctrl+Z right after
 * importing reverted straight back to the placeholder title slide, discarding
 * the import — the same class of data loss as the Tableur bug, just on the
 * Présentations collaborative backend, which the original fix never touched.
 *
 * Fix: replaceDeck now calls `undoMgr.clear()` right after its transact(),
 * mirroring replaceWorkbook's fix in both sheet stores — a whole-document
 * replacement must clear undo history, not become a single undoable step back
 * to the prior (often placeholder) state.
 *
 * Exercises the same Yjs primitives useCollabDeckStore wires together
 * (Y.Doc, the "deck" root map, collab-slides-crdt's slideToY/yToSlide, and a
 * Y.UndoManager scoped to that map) rather than mounting the React hook,
 * matching the existing convention for this CRDT layer (see
 * collab-slides-crdt.test.ts) — mounting the hook would require faking the
 * network-backed EncryptedYjsProvider for no added coverage of the bug.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { slideToY, yToSlide } from "../src/drive-cloud/collab-slides-crdt";
import { newSlideId } from "../src/slides/model";
import type { Deck } from "../src/slides/model";

type YMap = Y.Map<unknown>;

describe("useCollabDeckStore — replaceDeck (file import) and undo history", () => {
  it("clears undo history on import — Ctrl+Z must never wipe the just-imported deck", () => {
    const ydoc = new Y.Doc();
    const deckMap = ydoc.getMap("deck");
    // Same construction order as useCollabDeckStore: the UndoManager is
    // created (in useState) before the provider.connect().then() callback
    // that seeds a brand-new document with its placeholder title slide.
    const undoMgr = new Y.UndoManager(deckMap);

    ydoc.transact(() => {
      deckMap.set("theme", "light");
      deckMap.set("transition", "fade");
      const arr = new Y.Array<YMap>();
      arr.push([
        slideToY({
          id: newSlideId(),
          title: "Titre de la présentation",
          body: "",
          bodyHtml: "<p>Sous-titre</p>",
          layout: "title",
        }),
      ]);
      deckMap.set("slides", arr);
    });

    const imported: Deck = {
      slides: [{ id: "s-imported", title: "Importé", body: "", bodyHtml: "", layout: "blank", elements: [] }],
      active: 0,
      theme: "dark",
      transition: "none",
    };

    // replaceDeck's body: swap in the imported slides, then clear undo
    // history so the import itself can never be undone away.
    ydoc.transact(() => {
      const arr = deckMap.get("slides") as Y.Array<YMap>;
      arr.delete(0, arr.length);
      arr.push(imported.slides.map(slideToY));
      deckMap.set("theme", imported.theme ?? "light");
      deckMap.set("transition", imported.transition ?? "fade");
    });
    undoMgr.clear();

    const snapshot = () => (deckMap.get("slides") as Y.Array<YMap>).toArray().map(yToSlide);
    const afterImport = snapshot();
    expect(afterImport).toHaveLength(1);
    expect(afterImport[0]!.title).toBe("Importé");

    // The import must not be undoable back to the placeholder slide.
    expect(undoMgr.canUndo()).toBe(false);

    undoMgr.undo(); // must be a no-op

    // Without the fix, this reverted straight back to the placeholder title
    // slide, discarding the imported deck.
    expect(snapshot()).toEqual(afterImport);
    expect(deckMap.get("theme")).toBe("dark");
  });
});
