import { describe, expect, it } from "vitest";
import { DEFAULT_SEARCH_OPTIONS } from "../core/search";
import { searchAsync } from "./search-client";

describe("searchAsync", () => {
  const pages = ["Facture 2024-001 du client", "Rien ici", "Avoir 2024-002"];
  it("recherche littérale identique à search()", async () => {
    const hits = await searchAsync(pages, "facture", DEFAULT_SEARCH_OPTIONS);
    expect(hits.map((h) => h.page)).toEqual([0]);
  });
  it("expression régulière (repli en ligne sous jsdom)", async () => {
    const hits = await searchAsync(pages, "\\d{4}-\\d{3}", { ...DEFAULT_SEARCH_OPTIONS, regex: true });
    expect(hits.map((h) => h.page)).toEqual([0, 2]);
  });
});
