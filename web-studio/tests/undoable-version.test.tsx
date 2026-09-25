// @vitest-environment jsdom
/**
 * useUndoable — `version` identifies the present state for a modified/saved
 * flag: a recorded change gives a new stamp, `amend` (a late fact about the
 * document, e.g. imported markup) keeps it, and undoing back to the saved
 * state brings the saved stamp back.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useUndoable } from "../src/ui/useUndoable";

afterEach(cleanup);

describe("useUndoable — version", () => {
  it("tracks edits, ignores amend, and returns to the saved stamp on undo", () => {
    const { result } = renderHook(() => useUndoable<{ n: number; imported: boolean }>({ n: 0, imported: false }));
    const saved = result.current.version;

    act(() => result.current.amend((d) => ({ ...d, imported: true })));
    expect(result.current.version).toBe(saved); // not a user edit

    act(() => result.current.set((d) => ({ ...d, n: 1 })));
    const afterEdit = result.current.version;
    expect(afterEdit).not.toBe(saved);

    act(() => result.current.checkpoint());
    act(() => result.current.setQuiet((d) => ({ ...d, n: 2 })));
    expect(result.current.version).not.toBe(afterEdit);

    act(() => result.current.undo());
    expect(result.current.version).toBe(afterEdit);
    act(() => result.current.undo());
    expect(result.current.version).toBe(saved);
    act(() => result.current.redo());
    expect(result.current.version).toBe(afterEdit);

    act(() => result.current.reset({ n: 9, imported: false }));
    expect(result.current.version).not.toBe(saved);
    expect(result.current.version).not.toBe(afterEdit);
  });
});
