import { describe, it, expect } from "vitest";
import { rowVisible, visibleRowsInRange } from "../src/sheet/filter";

// A tiny grid: column 0 holds fruit names on rows 0..4.
const grid: Record<string, string> = { 0: "Pomme", 1: "Poire", 2: "Banane", 3: "Ananas", 4: "" };
const displayOf = (_c: number, r: number) => grid[r] ?? "";

describe("sheet view filter (real AutoFilter)", () => {
  it("no filter → every row visible", () => {
    expect(rowVisible(undefined, displayOf, 2)).toBe(true);
    expect(visibleRowsInRange(undefined, displayOf, 0, 4)).toEqual([0, 1, 2, 3, 4]);
  });

  it("matches as a case-insensitive substring on the filter column", () => {
    const f = { col: 0, query: "an" };
    expect(rowVisible(f, displayOf, 0)).toBe(false); // Pomme
    expect(rowVisible(f, displayOf, 2)).toBe(true); // Banane
    expect(rowVisible(f, displayOf, 3)).toBe(true); // Ananas
  });

  it("visibleRowsInRange returns only the matching rows, in order", () => {
    expect(visibleRowsInRange({ col: 0, query: "po" }, displayOf, 0, 4)).toEqual([0, 1]); // Pomme, Poire
    expect(visibleRowsInRange({ col: 0, query: "z" }, displayOf, 0, 4)).toEqual([]); // none
  });

  it("an empty cell is hidden by any non-empty query (matches the on-screen view)", () => {
    expect(rowVisible({ col: 0, query: "a" }, displayOf, 4)).toBe(false);
  });
});
