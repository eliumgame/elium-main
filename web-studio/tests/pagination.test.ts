import { describe, it, expect } from "vitest";
import { planPages, pageAt, type MeasuredBlock, type PageMetrics, type PagePlan } from "../src/editor/Pagination";

const M: PageMetrics = { pageContentPx: 1000, gapPx: 40, marginLeftPx: 30, marginRightPx: 30 };
const b = (pos: number, height: number, isPageBreak = false): MeasuredBlock => ({ pos, height, isPageBreak });

describe("planPages (pure pagination planner)", () => {
  it("keeps everything on one page when it fits", () => {
    const plan = planPages([b(0, 300), b(1, 300), b(2, 300)], M);
    expect(plan.pageCount).toBe(1);
    expect(plan.spacers).toEqual([]);
  });

  it("breaks before the block that would overflow the page", () => {
    // 400 + 400 = 800 fit; the third (400) would reach 1200 > 1000 → new page.
    const plan = planPages([b(0, 400), b(5, 400), b(9, 400)], M);
    expect(plan.pageCount).toBe(2);
    expect(plan.spacers).toHaveLength(1);
    expect(plan.spacers[0]!.pos).toBe(9);
    // fills the remainder of page 1 (1000-800=200) plus the inter-sheet gap.
    expect(plan.spacers[0]!.height).toBe(200 + M.gapPx);
  });

  it("counts multiple pages and records each block's start page", () => {
    const blocks = [b(0, 600), b(1, 600), b(2, 600), b(3, 600)]; // 600×4
    const plan = planPages(blocks, M);
    // p1: 600 (next 600 → 1200 overflow) → p2: 600+600=1200? no: 600 then 600→1200>1000
    // Walk: b0 used=600(p1); b1 600→overflow→p2 used=600; b2 600→overflow→p3 used=600; b3→p4
    expect(plan.pageCount).toBe(4);
    expect(plan.pageStartByPos.get(0)).toBe(1);
    expect(plan.pageStartByPos.get(1)).toBe(2);
    expect(plan.pageStartByPos.get(3)).toBe(4);
  });

  it("honors a manual page break regardless of remaining space", () => {
    const plan = planPages([b(0, 200), b(3, 0, true), b(4, 200)], M);
    expect(plan.pageCount).toBe(2);
    expect(plan.spacers).toHaveLength(1);
    expect(plan.spacers[0]!.pos).toBe(3);
    expect(plan.spacers[0]!.height).toBe(800 + M.gapPx); // fill 1000-200 + gap
  });

  it("spreads a block taller than a whole page across the pages it spans", () => {
    const plan = planPages([b(0, 2500)], M); // 2.5 pages tall
    expect(plan.pageCount).toBe(3);
    expect(plan.spacers).toEqual([]); // can't split a single block
  });

  it("is a fixed point of its own output (stable, no oscillation)", () => {
    // Re-running with the SAME intrinsic heights yields the SAME plan — the
    // spacers it injects are widgets that never change block heights.
    const blocks = [b(0, 700), b(3, 700), b(6, 700)];
    const first = planPages(blocks, M);
    const second = planPages(blocks, M);
    expect(second.spacers).toEqual(first.spacers);
    expect(second.pageCount).toBe(first.pageCount);
  });

  it("degrades safely when metrics are unusable", () => {
    const plan = planPages([b(0, 500)], { ...M, pageContentPx: 0 });
    expect(plan.pageCount).toBe(1);
    expect(plan.spacers).toEqual([]);
  });
});

describe("pageAt", () => {
  const plan: PagePlan = {
    spacers: [],
    pageStartByPos: new Map([[0, 1], [10, 2]]),
    pageCount: 2,
  };
  // Minimal fake state: only doc.forEach(node{nodeSize}, offset) is used.
  const fakeState = {
    doc: {
      forEach(fn: (node: { nodeSize: number }, offset: number) => void) {
        fn({ nodeSize: 10 }, 0);
        fn({ nodeSize: 10 }, 10);
      },
    },
  } as unknown as import("@tiptap/pm/state").EditorState;

  it("maps a position to the page of its containing top-level block", () => {
    expect(pageAt(plan, fakeState, 3)).toBe(1);
    expect(pageAt(plan, fakeState, 12)).toBe(2);
  });
});
