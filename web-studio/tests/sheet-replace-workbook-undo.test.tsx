// @vitest-environment jsdom
/**
 * useLocalSheetStore — replaceWorkbook() must not become undoable.
 *
 * Regression test for a real bug: importing a CSV/XLSX file (SheetEditor's
 * "Importer" action) calls store.replaceWorkbook(next), which used to go
 * through `set()` — the same reducer action as an ordinary cell edit. `set()`
 * pushes the PREVIOUS present state onto the undo stack before swapping in
 * the imported workbook. For a workbook that hadn't diverged from the initial
 * placeholder yet (a brand-new sheet, or one whose IndexedDB autosave hadn't
 * resolved), that previous state is the blank placeholder workbook.
 *
 * Consequence: right after importing a file into a just-created sheet,
 * `canUndo` was wrongly `true`, and a single Ctrl+Z discarded the entire
 * import, reverting to the blank placeholder — i.e. Ctrl+Z could empty a
 * sheet the user had just built.
 *
 * `replaceDeck` (the equivalent "swap the whole document" operation in
 * useLocalDeckStore.ts, used for PPTX import) already goes through `reset()`,
 * which replaces the value AND clears history — the correct behaviour for a
 * whole-document replacement. `replaceWorkbook` must follow the same
 * convention.
 *
 * loadWorkbook/saveWorkbook are mocked so this test needs no IndexedDB (jsdom
 * has none here) and passes an explicit `initial` to keep the autosave/reload
 * effects inert, isolating `replaceWorkbook` itself — same technique as
 * slides-vault-reload.test.tsx for the deck store.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";

const loadWorkbook = vi.fn();
const saveWorkbook = vi.fn();
vi.mock("../src/sheet/sheet-store", () => ({
  loadWorkbook: (...args: unknown[]) => loadWorkbook(...args),
  saveWorkbook: (...args: unknown[]) => saveWorkbook(...args),
}));

import { useLocalSheetStore } from "../src/sheet/useLocalSheetStore";
import { emptyWorkbook, type Workbook } from "../src/sheet/model";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useLocalSheetStore — replaceWorkbook (file import) and undo history", () => {
  it("clears undo history on import — Ctrl+Z must never wipe the just-imported sheet", () => {
    const placeholder = emptyWorkbook();
    const imported: Workbook = {
      sheets: [{ name: "Importé", rows: 20, cols: 3, cells: { A1: "42" } }],
      active: 0,
    };

    const { result } = renderHook(() => useLocalSheetStore(placeholder));

    // Brand-new sheet: nothing to undo yet.
    expect(result.current.canUndo).toBe(false);

    act(() => {
      result.current.replaceWorkbook(imported);
    });

    expect(result.current.wb).toEqual(imported);
    // The import is a whole-document replacement, not an editable step in the
    // sheet's own history — it must not be undoable back to the placeholder.
    expect(result.current.canUndo).toBe(false);

    act(() => {
      result.current.undo();
    });

    // Undo must be a no-op here: without the fix this reverted straight back
    // to the blank placeholder, discarding the imported data.
    expect(result.current.wb).toEqual(imported);
  });
});
