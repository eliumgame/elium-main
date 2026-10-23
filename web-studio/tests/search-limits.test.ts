import { describe, expect, it } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { MAX_SEARCH_MATCHES, buildRegex, findMatches, isRiskyRegex } from "../src/editor/Search";

const schema = new Schema({
  nodes: {
    doc: { content: "paragraph+" },
    paragraph: { content: "text*", toDOM: () => ["p", 0] },
    text: {},
  },
});
const opts = { caseSensitive: false, useRegex: false };
const docOf = (n: number, text: string) =>
  schema.node(
    "doc",
    null,
    Array.from({ length: n }, () => schema.node("paragraph", null, [schema.text(text)])),
  );

describe("recherche — plafonds et regex dangereuses", () => {
  it("s'arrête à la limite demandée", () => {
    const doc = docOf(500, "e e e e e e e e e e");
    expect(findMatches(doc, "e", opts)).toHaveLength(5000);
    expect(findMatches(doc, "e", opts, MAX_SEARCH_MATCHES + 1)).toHaveLength(MAX_SEARCH_MATCHES + 1);
  });

  it("refuse les quantificateurs imbriqués, accepte les expressions ordinaires", () => {
    for (const bad of ["(a+)+$", "(.*)*x", "([a-z]+)*", "(a*){2,}"]) expect(isRiskyRegex(bad), bad).toBe(true);
    for (const ok of ["(ab)+", "a+b*", String.raw`\d{3}-\d+`, "(foo|bar)", "[(+*]+"]) expect(isRiskyRegex(ok), ok).toBe(false);
    expect(buildRegex("(a+)+$", { ...opts, useRegex: true })).toBeNull();
    expect(buildRegex("a+", { ...opts, useRegex: true })).not.toBeNull();
  });

  it("une regex dangereuse ne fige pas : aucun résultat, immédiat", () => {
    const doc = docOf(1, "a".repeat(40) + "!");
    const t0 = performance.now();
    expect(findMatches(doc, "(a+)+$", { ...opts, useRegex: true })).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(100);
  });
});
