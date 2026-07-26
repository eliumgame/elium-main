import { describe, it, expect } from "vitest";
import {
  compileQuery, countByPage, DEFAULT_SEARCH_OPTIONS, escapeRegExp, firstHitFromPage, foldText,
  search, stepHit,
} from "../src/pdf/core/search";

const opts = (over: Partial<typeof DEFAULT_SEARCH_OPTIONS> = {}) => ({ ...DEFAULT_SEARCH_OPTIONS, ...over });

describe("PDF search — folding", () => {
  it("strips diacritics but keeps the map pointing at the original characters", () => {
    const { folded, map } = foldText("Créance échue", true);
    expect(folded).toBe("Creance echue");
    // Each folded character still points at the original it came from.
    expect(map[0]).toBe(0);
    expect(map[folded.indexOf("echue")]).toBe("Créance ".length);
  });

  it("expands ligatures so a search for the spelled-out form matches", () => {
    const { folded } = foldText("ﬁnal œuvre", true);
    expect(folded).toBe("final oeuvre");
  });

  it("normalises curly quotes and dashes", () => {
    const { folded } = foldText("l’état — vrai", true);
    expect(folded).toBe("l'etat - vrai");
  });

  it("preserves case — insensitivity is the regex flag's job", () => {
    expect(foldText("Écrit", true).folded).toBe("Ecrit");
    expect(foldText("Écrit", false).folded).toBe("Écrit");
  });
});

describe("PDF search — matching", () => {
  const pages = [
    "Le contrat de bail est signé.",
    "Bail commercial : le bailleur consent.",
    "",
    "Un bail, deux baux, trois BAIL.",
  ];

  it("finds every occurrence across pages, in reading order", () => {
    const hits = search(pages, "bail", opts());
    expect(hits.map((h) => h.page)).toEqual([0, 1, 1, 3, 3]);
  });

  it("respects case sensitivity", () => {
    const hits = search(pages, "BAIL", opts({ caseSensitive: true }));
    expect(hits).toHaveLength(1);
    expect(hits[0].page).toBe(3);
  });

  it("honours whole-word matching", () => {
    const loose = search(pages, "bail", opts());
    const strict = search(pages, "bail", opts({ wholeWord: true }));
    expect(strict.length).toBeLessThan(loose.length);
    // "bailleur" and "baux" must not count as the whole word "bail".
    for (const hit of strict) {
      const text = pages[hit.page].slice(hit.start, hit.end).toLowerCase();
      expect(text).toBe("bail");
    }
  });

  it("finds accented text from an unaccented query and vice versa", () => {
    expect(search(["signé"], "signe", opts())).toHaveLength(1);
    expect(search(["signe"], "signé", opts())).toHaveLength(1);
    expect(search(["signé"], "signe", opts({ ignoreDiacritics: false }))).toHaveLength(0);
  });

  it("lets a space in the query match a line break in the PDF", () => {
    expect(search(["contrat\nde bail"], "contrat de", opts())).toHaveLength(1);
  });

  it("supports regular expressions", () => {
    const hits = search(["ref A-1234 et ref B-9876"], "[A-Z]-\\d{4}", opts({ regex: true }));
    expect(hits).toHaveLength(2);
    expect(hits[0].start).toBe(4);
  });

  it("returns nothing for an empty query and never loops on an empty match", () => {
    expect(search(pages, "   ", opts())).toEqual([]);
    expect(search(pages, "x*", opts({ regex: true })).length).toBeLessThan(10_000);
  });

  it("falls back to a literal search when the regex is invalid", () => {
    const re = compileQuery("([", opts({ regex: true }));
    expect(re).not.toBeNull();
    expect(search(["a([b"], "([", opts({ regex: true }))).toHaveLength(1);
  });

  it("builds a readable context snippet around the match", () => {
    const [hit] = search(["Le contrat de bail est signé aujourd'hui même."], "bail", opts());
    expect(hit.context.slice(hit.ctxStart, hit.ctxEnd)).toBe("bail");
  });

  it("counts hits per page", () => {
    const { counts, total } = countByPage(search(pages, "bail", opts()), pages.length);
    expect(counts).toEqual([1, 2, 0, 2]);
    expect(total).toBe(5);
  });
});

describe("PDF search — navigation", () => {
  const hits = search(["a", "b a", "a a"], "a", DEFAULT_SEARCH_OPTIONS);

  it("jumps to the first hit at or after a page", () => {
    expect(firstHitFromPage(hits, 1)).toBe(1);
    expect(firstHitFromPage(hits, 99)).toBe(0); // wraps to the start
    expect(firstHitFromPage([], 0)).toBe(-1);
  });

  it("wraps around in both directions", () => {
    expect(stepHit(0, -1, 4)).toBe(3);
    expect(stepHit(3, 1, 4)).toBe(0);
    expect(stepHit(0, 1, 0)).toBe(-1);
  });
});

describe("PDF search — helpers", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
  });
});
