import { describe, it, expect } from "vitest";
import { Schema } from "@tiptap/pm/model";
import { findMatches, buildRegex, escapeRegex } from "../src/editor/Search";

// Minimal ProseMirror schema (doc/paragraph/text) — enough for the pure matcher.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*" },
    text: { group: "inline" },
  },
});
const docOf = (...paras: string[]) =>
  schema.node("doc", null, paras.map((p) => schema.node("paragraph", null, p ? [schema.text(p)] : [])));

describe("editor find/replace — findMatches", () => {
  it("finds case-insensitive literal matches with correct positions", () => {
    const m = findMatches(docOf("Hello hello HELLO"), "hello", { caseSensitive: false, useRegex: false });
    expect(m).toHaveLength(3);
    expect(m[0]).toEqual({ from: 1, to: 6 }); // paragraph content starts at pos 1
  });

  it("respects case sensitivity", () => {
    expect(findMatches(docOf("Hello hello HELLO"), "hello", { caseSensitive: true, useRegex: false })).toHaveLength(1);
  });

  it("supports regex mode", () => {
    expect(findMatches(docOf("a1 b2 c3"), "[a-c]\\d", { caseSensitive: false, useRegex: true })).toHaveLength(3);
  });

  it("treats an invalid regex as no matches", () => {
    expect(findMatches(docOf("text"), "(unclosed", { caseSensitive: false, useRegex: true })).toEqual([]);
  });

  it("escapes regex metacharacters in literal mode", () => {
    // literal "a.b" matches the two "a.b" but not "axb"
    expect(findMatches(docOf("a.b a.b axb"), "a.b", { caseSensitive: false, useRegex: false })).toHaveLength(2);
  });

  it("returns matches across paragraphs with increasing positions", () => {
    const m = findMatches(docOf("foo", "foo"), "foo", { caseSensitive: false, useRegex: false });
    expect(m).toHaveLength(2);
    expect(m[0].from).toBeLessThan(m[1].from);
  });

  it("does not loop forever on zero-width regex matches", () => {
    const m = findMatches(docOf("abc"), "a*", { caseSensitive: false, useRegex: true });
    expect(m).toHaveLength(1); // only the non-empty "a" survives the zero-width guard
    expect(m[0]).toEqual({ from: 1, to: 2 });
  });
});

describe("editor find/replace — buildRegex / escapeRegex", () => {
  it("escapes regex metacharacters", () => {
    expect(escapeRegex("a.b*c(")).toBe("a\\.b\\*c\\(");
  });

  it("returns null for an empty term or invalid regex", () => {
    expect(buildRegex("", { caseSensitive: false, useRegex: false })).toBeNull();
    expect(buildRegex("(", { caseSensitive: false, useRegex: true })).toBeNull();
  });

  it("applies the case-sensitivity flag", () => {
    expect(buildRegex("x", { caseSensitive: true, useRegex: false })!.flags).toBe("g");
    expect(buildRegex("x", { caseSensitive: false, useRegex: false })!.flags).toBe("gi");
  });
});
