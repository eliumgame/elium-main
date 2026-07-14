import { describe, it, expect } from "vitest";
import { ruleMatches, colorScaleFill, describeRule, buildCondFormatter, toNum } from "../src/sheet/condformat";
import type { CondRule } from "../src/sheet/model";

const rule = (op: CondRule["op"], extra: Partial<CondRule> = {}): CondRule =>
  ({ id: "r", c0: 0, r0: 0, c1: 2, r1: 2, op, ...extra });

describe("conditional formatting — rule matching", () => {
  it("numeric comparisons", () => {
    expect(ruleMatches(rule("gt", { v1: "10" }), 12, "12")).toBe(true);
    expect(ruleMatches(rule("gt", { v1: "10" }), 8, "8")).toBe(false);
    expect(ruleMatches(rule("le", { v1: "5" }), 5, "5")).toBe(true);
    expect(ruleMatches(rule("between", { v1: "1", v2: "10" }), 7, "7")).toBe(true);
    expect(ruleMatches(rule("between", { v1: "1", v2: "10" }), 20, "20")).toBe(false);
  });

  it("equality works for numbers and text", () => {
    expect(ruleMatches(rule("eq", { v1: "3" }), 3, "3")).toBe(true);
    expect(ruleMatches(rule("eq", { v1: "oui" }), "oui", "oui")).toBe(true);
    expect(ruleMatches(rule("ne", { v1: "oui" }), "non", "non")).toBe(true);
  });

  it("text contains / empty / not empty", () => {
    expect(ruleMatches(rule("contains", { v1: "ell" }), "Hello", "Hello")).toBe(true);
    expect(ruleMatches(rule("contains", { v1: "xyz" }), "Hello", "Hello")).toBe(false);
    expect(ruleMatches(rule("empty"), "", "")).toBe(true);
    expect(ruleMatches(rule("notEmpty"), "x", "x")).toBe(true);
  });

  it("toNum coerces", () => {
    expect(toNum(42)).toBe(42);
    expect(toNum("3.5")).toBe(3.5);
    expect(toNum("abc")).toBeNull();
    expect(toNum({ error: "#DIV/0" })).toBeNull();
  });
});

describe("conditional formatting — colour scale", () => {
  it("interpolates a 2-stop scale and clamps", () => {
    const s = { min: "#000000", max: "#ffffff" };
    expect(colorScaleFill(s, 0, 0, 10)).toBe("#000000");
    expect(colorScaleFill(s, 10, 0, 10)).toBe("#ffffff");
    expect(colorScaleFill(s, 5, 0, 10)).toBe("#808080");
    expect(colorScaleFill(s, -5, 0, 10)).toBe("#000000"); // clamped
  });

  it("honours a mid stop", () => {
    const s = { min: "#000000", mid: "#ff0000", max: "#ffffff" };
    expect(colorScaleFill(s, 5, 0, 10)).toBe("#ff0000");
  });
});

describe("conditional formatting — formatter & describe", () => {
  it("applies a fill where the rule matches, leaves others untouched", () => {
    const rules: CondRule[] = [rule("gt", { v1: "5", fill: "#ffeeaa" })];
    const values: Record<string, number> = { "0,0": 9, "1,0": 2 };
    const fmt = buildCondFormatter(rules, (c, r) => values[`${c},${r}`] ?? "", (c, r) => String(values[`${c},${r}`] ?? ""));
    expect(fmt(0, 0).background).toBe("#ffeeaa");
    expect(fmt(1, 0).background).toBeUndefined();
    expect(fmt(5, 5)).toEqual({}); // outside range
  });

  it("colour scale paints across the range extremes", () => {
    const rules: CondRule[] = [rule("colorScale", { scale: { min: "#000000", max: "#ffffff" } })];
    const values: Record<string, number> = { "0,0": 0, "1,0": 100 };
    const fmt = buildCondFormatter(rules, (c, r) => values[`${c},${r}`] ?? "", () => "");
    expect(fmt(0, 0).background).toBe("#000000");
    expect(fmt(1, 0).background).toBe("#ffffff");
  });

  it("describeRule is human-readable", () => {
    expect(describeRule(rule("gt", { v1: "10" }))).toContain("Supérieur");
    expect(describeRule(rule("colorScale"))).toBe("Échelle de couleurs");
    expect(describeRule(rule("between", { v1: "1", v2: "9" }))).toContain("entre 1 et 9");
  });
});
