import { describe, it, expect } from "vitest";
import { findMatches, matchCountsByPage, spanMatches } from "../src/pdf/search";

const pages = [
  "Le rapport annuel Elium présente les résultats.",
  "Elium chiffre les documents. elium reste local.",
  "Aucune correspondance ici.",
];

describe("findMatches", () => {
  it("finds every occurrence across pages, case-insensitively, in order", () => {
    const m = findMatches(pages, "elium");
    expect(m.map((x) => x.page)).toEqual([0, 1, 1]); // 1 on p0, 2 on p1 (Elium + elium)
    expect(m[0]!.index).toBeGreaterThanOrEqual(0);
  });
  it("returns nothing for an empty or absent query", () => {
    expect(findMatches(pages, "   ")).toEqual([]);
    expect(findMatches(pages, "introuvable")).toEqual([]);
  });
  it("handles overlapping-free repeated matches", () => {
    expect(findMatches(["aaaa"], "aa").length).toBe(2); // non-overlapping: [0,2]
  });
});

describe("matchCountsByPage", () => {
  it("counts per page and totals", () => {
    const { counts, total } = matchCountsByPage(pages, "elium");
    expect(counts).toEqual([1, 2, 0]);
    expect(total).toBe(3);
  });
});

describe("spanMatches", () => {
  it("is a case-insensitive substring test guarded on empty query", () => {
    expect(spanMatches("Elium", "eli")).toBe(true);
    expect(spanMatches("Elium", "xyz")).toBe(false);
    expect(spanMatches("Elium", "  ")).toBe(false);
  });
});
