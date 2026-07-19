import { describe, it, expect } from "vitest";
import { mergeAt, isMergeOrigin, isCovered, spanAt, toggleMerge } from "../src/sheet/merges";
import type { MergeRect } from "../src/sheet/model";

const M: MergeRect = { c0: 1, r0: 1, c1: 3, r1: 2 }; // B2:D3

describe("merges — geometry", () => {
  it("mergeAt finds the covering merge", () => {
    expect(mergeAt([M], 2, 1)).toBe(M);
    expect(mergeAt([M], 0, 0)).toBeNull();
    expect(mergeAt(undefined, 1, 1)).toBeNull();
  });

  it("origin / covered classification", () => {
    expect(isMergeOrigin(M, 1, 1)).toBe(true);
    expect(isMergeOrigin(M, 2, 1)).toBe(false);
    expect(isCovered([M], 1, 1)).toBe(false); // origin is not "covered"
    expect(isCovered([M], 2, 1)).toBe(true);
    expect(isCovered([M], 3, 2)).toBe(true);
    expect(isCovered([M], 5, 5)).toBe(false);
  });

  it("spanAt returns colSpan/rowSpan only at the origin", () => {
    expect(spanAt([M], 1, 1)).toEqual({ colSpan: 3, rowSpan: 2 });
    expect(spanAt([M], 2, 1)).toBeNull(); // covered, not origin
    expect(spanAt([M], 9, 9)).toBeNull();
  });
});

describe("merges — toggleMerge", () => {
  it("merges a multi-cell rectangle (normalised)", () => {
    const out = toggleMerge([], { c0: 3, r0: 2, c1: 1, r1: 1 }); // reversed
    expect(out).toEqual([{ c0: 1, r0: 1, c1: 3, r1: 2 }]);
  });

  it("is a no-op for a single cell", () => {
    expect(toggleMerge([], { c0: 0, r0: 0, c1: 0, r1: 0 })).toEqual([]);
  });

  it("unmerges any merge intersecting the selection", () => {
    const out = toggleMerge([M], { c0: 2, r0: 1, c1: 2, r1: 1 }); // a cell inside B2:D3
    expect(out).toEqual([]);
  });

  it("keeps non-intersecting merges when merging elsewhere", () => {
    const out = toggleMerge([M], { c0: 5, r0: 5, c1: 6, r1: 6 });
    expect(out).toHaveLength(2);
    expect(out).toContainEqual(M);
    expect(out).toContainEqual({ c0: 5, r0: 5, c1: 6, r1: 6 });
  });
});
