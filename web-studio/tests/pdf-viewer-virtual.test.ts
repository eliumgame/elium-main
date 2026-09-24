import { describe, expect, it } from "vitest";
import { gridColumns, gridRowHeights, rowRange, scrollIntoRow, stackRows } from "../src/pdf/core/viewer/virtual";

describe("virtual lists — stacked rows", () => {
  it("stacks rows with a gap between them (none after the last)", () => {
    const s = stackRows([100, 50, 80], 10);
    expect([...s.tops]).toEqual([0, 110, 170]);
    expect(s.total).toBe(250);
    expect(stackRows([], 10).total).toBe(0);
  });

  it("finds the rows intersecting the scrolled band, in a 5 000-item list", () => {
    const heights = Array.from({ length: 5000 }, (_, i) => (i % 2 ? 200 : 150));
    const s = stackRows(heights, 10);
    // Row 1000 starts at 500 * (160 + 210) = 185 000.
    expect(s.tops[1000]).toBe(185_000);
    const r = rowRange(s, 185_000, 185_000 + 600);
    expect(r).toEqual({ first: 1000, last: 1003 });
    // Overscan widens the range on both sides.
    const o = rowRange(s, 185_000, 185_600, 400)!;
    expect(o.first).toBeLessThan(1000);
    expect(o.last).toBeGreaterThan(1003);
  });

  it("clamps a band before the start or past the end to real rows", () => {
    const s = stackRows([100, 100, 100], 0);
    expect(rowRange(s, -500, -100)).toEqual({ first: 0, last: 0 });
    expect(rowRange(s, 10_000, 11_000)).toEqual({ first: 2, last: 2 });
    expect(rowRange(stackRows([], 0), 0, 100)).toBeNull();
  });

  it("scrolls a row into view only when it is not already fully visible", () => {
    const s = stackRows([100, 100, 100, 100], 10);
    expect(scrollIntoRow(s, 1, 0, 400)).toBeNull();
    expect(scrollIntoRow(s, 3, 0, 200, 8)).toBe(330 + 100 - 200 + 8);
    expect(scrollIntoRow(s, 0, 150, 200, 8)).toBe(0);
    expect(scrollIntoRow(s, 9, 0, 200)).toBeNull();
  });
});

describe("virtual lists — grid (page organiser)", () => {
  it("counts the columns like CSS grid: n cells and n-1 gaps must fit", () => {
    expect(gridColumns(1000, 206, 18)).toBe(4); // 4*206 + 3*18 = 878 ≤ 1000
    expect(gridColumns(878, 206, 18)).toBe(4);
    expect(gridColumns(877, 206, 18)).toBe(3);
    expect(gridColumns(50, 206, 18)).toBe(1);
    expect(gridColumns(500, 0, 18)).toBe(1);
  });

  it("makes each row as tall as its tallest cell", () => {
    expect(gridRowHeights([100, 300, 120, 90, 90], 2)).toEqual([300, 120, 90]);
    expect(gridRowHeights([], 3)).toEqual([]);
  });
});
