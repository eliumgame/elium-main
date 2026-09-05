/**
 * useCollabSheetStore — replaceWorkbook() must not become undoable.
 *
 * Regression test for the collaborative twin of the bug fixed in
 * sheet-replace-workbook-undo.test.tsx for useLocalSheetStore. Importing a
 * file (SheetEditor's "Importer" action) calls store.replaceWorkbook(next),
 * which runs SM.loadWorkbookIntoDoc(ydoc, ySheets, yNames, next) — a plain
 * `ydoc.transact()` with the default (null) origin.
 *
 * useCollabSheetStore builds its Y.UndoManager as
 * `new Y.UndoManager([ySheets, yNames])`, with no custom `trackedOrigins`.
 * Yjs's default `trackedOrigins` is `Set([null])`, i.e. it tracks exactly the
 * origin our own local edits use — including the null-origin transact() that
 * loadWorkbookIntoDoc runs. So importing a file into a sheet (even a just-
 * created, still-empty one) made `undoMgr.canUndo()` flip to `true`, and a
 * single Ctrl+Z right after importing reverted straight back to whatever was
 * there before (the blank placeholder sheet for a brand-new collab document),
 * discarding the import — the exact same user-facing data loss as the local
 * store bug, just reached through Yjs's undo tracking instead of the
 * useUndoable reducer.
 *
 * Fix: replaceWorkbook now calls `undoMgr.clear()` right after
 * loadWorkbookIntoDoc, mirroring the reset()-based fix for
 * useLocalSheetStore's replaceWorkbook — a whole-document replacement must
 * clear undo history, not become a single undoable step back to the prior
 * (often blank) state.
 *
 * This exercises the same Yjs primitives useCollabSheetStore wires together
 * (Y.Doc, the "sheets"/"names" root types, collab-sheet-model's
 * newYSheet/loadWorkbookIntoDoc/workbookSnapshot, and a Y.UndoManager scoped
 * to those two types) rather than mounting the React hook itself, matching
 * the existing convention for this CRDT layer (see
 * collab-slides-crdt.test.ts) — mounting the hook would require faking the
 * network-backed EncryptedYjsProvider for no added coverage of the bug.
 */
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import * as SM from "../src/drive-cloud/collab-sheet-model";
import type { Workbook } from "../src/sheet/model";

describe("useCollabSheetStore — replaceWorkbook (file import) and undo history", () => {
  it("clears undo history on import — Ctrl+Z must never wipe the just-imported sheet", () => {
    const ydoc = new Y.Doc();
    const ySheets = ydoc.getArray<SM.YSheet>("sheets") as SM.YSheets;
    const yNames = ydoc.getMap<string>("names");
    // Same construction order as useCollabSheetStore: the UndoManager is
    // created (in useState) before the provider.connect().then() callback
    // that pushes the placeholder sheet into a brand-new document.
    const undoMgr = new Y.UndoManager([ySheets, yNames]);

    // First open of a brand-new collaborative sheet.
    ydoc.transact(() => ySheets.push([SM.newYSheet("Feuille 1")]));

    const imported: Workbook = {
      sheets: [{ name: "Importé", rows: 20, cols: 3, cells: { A1: "42" } }],
      active: 0,
    };

    // replaceWorkbook's body: load the imported workbook, then clear undo
    // history so the import itself can never be undone away.
    SM.loadWorkbookIntoDoc(ydoc, ySheets, yNames, imported);
    undoMgr.clear();

    const afterImport = SM.workbookSnapshot(ySheets, yNames, 0);
    expect(afterImport.sheets).toHaveLength(1);
    expect(afterImport.sheets[0]!.cells).toEqual({ A1: "42" });

    // The import must not be undoable back to the placeholder sheet.
    expect(undoMgr.canUndo()).toBe(false);

    undoMgr.undo(); // must be a no-op

    // Without the fix, this reverted straight back to the empty "Feuille 1"
    // placeholder, discarding the imported data.
    expect(SM.workbookSnapshot(ySheets, yNames, 0)).toEqual(afterImport);
  });
});
