import { describe, it, expect } from "vitest";
import { applyNamedRanges, createCalc, isError } from "../src/sheet/formula";

const NAMES: Record<string, string> = { TVA: "$B$1", SALAIRES: "$A$1:$A$3" };
const resolve = (n: string) => NAMES[n];

describe("named ranges — applyNamedRanges (pure substitution)", () => {
  it("substitutes a free name with its target", () => {
    expect(applyNamedRanges("TVA*100", resolve)).toBe("$B$1*100");
  });

  it("substitutes a range name inside a function call", () => {
    expect(applyNamedRanges("SUM(SALAIRES)", resolve)).toBe("SUM($A$1:$A$3)");
  });

  it("is case-insensitive on the name", () => {
    expect(applyNamedRanges("tva*2", resolve)).toBe("$B$1*2");
  });

  it("leaves function names, sheet qualifiers, addresses and string literals untouched", () => {
    expect(applyNamedRanges('SUM(A1:A2)&"TVA"', resolve)).toBe('SUM(A1:A2)&"TVA"'); // TVA inside a string
    expect(applyNamedRanges("Feuille1!A1", resolve)).toBe("Feuille1!A1");            // sheet-qualified
    expect(applyNamedRanges("$B$1+A1", resolve)).toBe("$B$1+A1");                    // bare addresses
    expect(applyNamedRanges("'Mon onglet'!A1", resolve)).toBe("'Mon onglet'!A1");    // quoted sheet
  });

  it("is identity for unknown names", () => {
    expect(applyNamedRanges("FOO+1", resolve)).toBe("FOO+1");
  });
});

describe("named ranges — createCalc integration", () => {
  it("resolves a named cell and a named range in formulas", () => {
    const cells: Record<string, string> = {
      B1: "20", A1: "100", A2: "200", A3: "300",
      C1: "=TVA/100*A1", C2: "=SUM(SALAIRES)",
    };
    const calc = createCalc((ref) => cells[ref], undefined, resolve);
    expect(calc.valueOf("C1")).toBe(20);  // 20/100*100
    expect(calc.valueOf("C2")).toBe(600); // 100+200+300
  });

  it("without a names resolver the engine is unchanged (an unknown name errors)", () => {
    const cells: Record<string, string> = { C1: "=TVA*2" };
    const calc = createCalc((ref) => cells[ref]);
    expect(isError(calc.valueOf("C1"))).toBe(true);
  });
});
