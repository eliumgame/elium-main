import { describe, it, expect } from "vitest";
import {
  validateValue, validationAt, inValidation, buildValidator, describeValidation,
} from "../src/sheet/validation";
import type { DataValidation } from "../src/sheet/model";

const rule = (over: Partial<DataValidation>): DataValidation =>
  ({ id: "v", c0: 0, r0: 0, c1: 2, r1: 2, type: "number", ...over });

describe("data validation — validateValue", () => {
  it("list: only allowed values pass", () => {
    const v = rule({ type: "list", list: ["Oui", "Non"] });
    expect(validateValue(v, "Oui").valid).toBe(true);
    expect(validateValue(v, "Peut-être").valid).toBe(false);
  });

  it("number with bounds (between / gt)", () => {
    expect(validateValue(rule({ op: "between", v1: "1", v2: "10" }), "5").valid).toBe(true);
    expect(validateValue(rule({ op: "between", v1: "1", v2: "10" }), "50").valid).toBe(false);
    expect(validateValue(rule({ op: "gt", v1: "0" }), "-3").valid).toBe(false);
    expect(validateValue(rule({ op: "gt", v1: "0" }), "3").valid).toBe(true);
    expect(validateValue(rule({ op: "gt", v1: "0" }), "abc").valid).toBe(false); // not a number
  });

  it("textLength constrains length, not value", () => {
    const v = rule({ type: "textLength", op: "le", v1: "3" });
    expect(validateValue(v, "abc").valid).toBe(true);
    expect(validateValue(v, "abcd").valid).toBe(false);
  });

  it("date requires a parseable date within bounds", () => {
    const v = rule({ type: "date", op: "between", v1: "2026-01-01", v2: "2026-12-31" });
    expect(validateValue(v, "2026-07-19").valid).toBe(true);
    expect(validateValue(v, "2027-01-01").valid).toBe(false);
    expect(validateValue(v, "pas une date").valid).toBe(false);
  });

  it("blank passes by default but fails when allowBlank is false", () => {
    expect(validateValue(rule({ op: "gt", v1: "0" }), "").valid).toBe(true);
    expect(validateValue(rule({ op: "gt", v1: "0", allowBlank: false }), "  ").valid).toBe(false);
  });

  it("formulas are not flagged (evaluated elsewhere)", () => {
    expect(validateValue(rule({ type: "list", list: ["x"] }), "=SUM(A1:A2)").valid).toBe(true);
  });
});

describe("data validation — range helpers", () => {
  it("inValidation / validationAt (later rule overrides on overlap)", () => {
    const a = rule({ id: "a", type: "number", op: "gt", v1: "0" });
    const b = rule({ id: "b", c0: 1, r0: 1, c1: 1, r1: 1, type: "list", list: ["ok"] });
    expect(inValidation(a, 0, 0)).toBe(true);
    expect(inValidation(b, 0, 0)).toBe(false);
    expect(validationAt([a, b], 1, 1)?.id).toBe("b"); // b overrides a where they overlap
    expect(validationAt([a, b], 2, 2)?.id).toBe("a");
    expect(validationAt([a, b], 9, 9)).toBeNull();
  });

  it("buildValidator returns a reason only for invalid cells", () => {
    const raw: Record<string, string> = { "0,0": "5", "1,0": "50" };
    const v = buildValidator([rule({ op: "between", v1: "1", v2: "10" })], (c, r) => raw[`${c},${r}`] ?? "");
    expect(v(0, 0)).toBeNull();          // 5 in [1,10]
    expect(typeof v(1, 0)).toBe("string"); // 50 out of range → reason
    expect(v(5, 5)).toBeNull();          // no rule covers it
  });

  it("describeValidation is human-readable", () => {
    expect(describeValidation(rule({ type: "list", list: ["A", "B"] }))).toContain("Liste");
    expect(describeValidation(rule({ op: "between", v1: "1", v2: "9" }))).toContain("entre");
  });
});
