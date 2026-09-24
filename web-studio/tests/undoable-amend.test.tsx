// @vitest-environment jsdom
/**
 * useUndoable — `amend()` folds a late fact about the document into the WHOLE
 * history, without becoming an undo step.
 *
 * Used by the PDF module: the markup a file already carries (Acrobat
 * comments) is imported in the background AFTER the document is shown, while
 * the user may already have made edits. The import must survive Ctrl+Z (it is
 * part of the file, not an edit) and must not be lost by redo either.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useUndoable } from "../src/ui/useUndoable";

interface Doc {
  edits: string[];
  imported: string[];
}

afterEach(cleanup);

describe("useUndoable — amend", () => {
  it("applies to the present and to every past / future state, adding no history", () => {
    const { result } = renderHook(() => useUndoable<Doc>({ edits: [], imported: [] }));
    act(() => result.current.set((d) => ({ ...d, edits: [...d.edits, "e1"] })));
    act(() => result.current.set((d) => ({ ...d, edits: [...d.edits, "e2"] })));
    act(() => result.current.undo()); // one state in the future stack now
    act(() => result.current.amend((d) => (d.imported.length ? d : { ...d, imported: ["note"] })));

    expect(result.current.value).toEqual({ edits: ["e1"], imported: ["note"] });
    expect(result.current.canUndo).toBe(true);
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.undo());
    expect(result.current.value).toEqual({ edits: [], imported: ["note"] });
    expect(result.current.canUndo).toBe(false);

    act(() => result.current.redo());
    act(() => result.current.redo());
    expect(result.current.value).toEqual({ edits: ["e1", "e2"], imported: ["note"] });
  });

  it("is a no-op (same state object) when nothing changes", () => {
    const { result } = renderHook(() => useUndoable<Doc>({ edits: [], imported: ["x"] }));
    const before = result.current.value;
    act(() => result.current.amend((d) => d));
    expect(result.current.value).toBe(before);
  });
});
