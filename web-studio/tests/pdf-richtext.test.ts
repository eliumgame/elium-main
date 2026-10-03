import { describe, expect, it } from "vitest";
import {
  applyPatch,
  deleteRange,
  dominantStyle,
  insertAt,
  mergeSpans,
  sameSpans,
  spansText,
  styleAt,
  summarise,
} from "../src/pdf/ui/richtext";
import type { TextSpan, TextSpanStyle } from "../src/pdf/model/types";

/** The editor's model: a paragraph as styled spans. */

const base: TextSpanStyle = { fontResource: "F1", fontFamily: "Arial", fontSize: 11, color: "#000000" };
const bold: TextSpanStyle = { ...base, fontResource: "F2", bold: true };
const para = (): TextSpan[] => [
  { text: "Un mot ", style: base },
  { text: "gras", style: bold },
  { text: " et la suite.", style: base },
];

describe("styled paragraph", () => {
  it("merges neighbours of the same style and drops empty spans", () => {
    const merged = mergeSpans([
      { text: "a", style: base },
      { text: "", style: bold },
      { text: "b", style: { ...base } },
    ]);
    expect(merged).toEqual([{ text: "ab", style: base }]);
  });

  it("restyles a range without touching the rest, and drops the original font only for a face change", () => {
    const out = applyPatch(para(), 3, 5, { bold: true });
    expect(spansText(out)).toBe("Un mot gras et la suite.");
    const word = out.find((s) => s.text === "mo")!;
    expect(word.style.bold).toBe(true);
    expect(word.style.fontResource).toBeNull();
    // Size and colour keep the page's own font.
    const sized = applyPatch(para(), 0, 2, { fontSize: 14, color: "#ff0000" });
    expect(sized[0]!.text).toBe("Un");
    expect(sized[0]!.style.fontResource).toBe("F1");
    expect(sized[0]!.style.fontSize).toBe(14);
  });

  it("toggling back a whole bold word merges it into its neighbours when styles meet", () => {
    const out = applyPatch(para(), 7, 11, { bold: false, fontFamily: "Arial", fontSize: 11, color: "#000000" });
    // « gras » is regular again but now substituted, so it stays its own span.
    expect(out.map((s) => s.text).join("")).toBe(spansText(para()));
    expect(out.find((s) => s.text === "gras")!.style.bold).toBe(false);
  });

  it("inserts text with the given style at an offset, and deletes ranges", () => {
    const ins = insertAt(para(), 7, "très ", bold);
    expect(spansText(ins)).toBe("Un mot très gras et la suite.");
    expect(ins.find((s) => s.text.includes("très"))!.style.bold).toBe(true);
    const del = deleteRange(para(), 3, 11);
    expect(spansText(del)).toBe("Un  et la suite.");
    expect(deleteRange(para(), 0, 100)).toEqual([]);
  });

  it("finds the style at the caret (before it when between two spans)", () => {
    expect(styleAt(para(), 0, base).bold).toBeUndefined();
    expect(styleAt(para(), 7, base).bold).toBeUndefined(); // end of « Un mot »
    expect(styleAt(para(), 8, base).bold).toBe(true);
    expect(styleAt([], 0, bold)).toBe(bold);
  });

  it("summarises a selection for the format panel: same values shown, differing ones undefined", () => {
    const all = summarise(para(), 0, spansText(para()).length, base);
    expect(all.mixed).toBe(true);
    expect(all.bold).toBeUndefined();
    expect(all.fontSize).toBe(11);
    expect(all.color).toBe("#000000");
    const word = summarise(para(), 7, 11, base);
    expect(word.mixed).toBe(false);
    expect(word.bold).toBe(true);
    const caret = summarise(para(), 9, 9, base);
    expect(caret.bold).toBe(true);
  });

  it("compares paragraphs by text and style, and finds the dominant style", () => {
    expect(sameSpans(para(), mergeSpans(para()))).toBe(true);
    expect(sameSpans(para(), applyPatch(para(), 0, 2, { fontSize: 12 }))).toBe(false);
    expect(dominantStyle(para(), bold)).toBe(para()[2]!.style === base ? base : para()[0]!.style);
    expect(dominantStyle([], bold)).toBe(bold);
  });
});
