import { describe, it, expect } from "vitest";
import { createCalc } from "../src/sheet/formula";

const calc = (cells: Record<string, string>) => createCalc((ref) => cells[ref]);

describe("formula AST — precedence, parentheses, encapsulated errors", () => {
  it("keeps operator precedence and parentheses after the parse/eval split", () => {
    const c = calc({
      A1: "=1+2*3-4",        // 1 + 6 - 4 = 3
      A2: "=(1+2)*(3+4)",    // 21
      A3: "=2*-3+10",        // -6 + 10 = 4 (unary minus inside multiplication)
      A4: "=10/2/5",         // left-assoc: (10/2)/5 = 1
      A5: "=2>1",            // boolean comparison sits below arithmetic
    });
    expect(c.valueOf("A1")).toBe(3);
    expect(c.valueOf("A2")).toBe(21);
    expect(c.valueOf("A3")).toBe(4);
    expect(c.valueOf("A4")).toBe(1);
    expect(c.valueOf("A5")).toBe(true);
  });

  it("an error deep inside an expression still surfaces (no silent swallow)", () => {
    const c = calc({ A1: "=1+(2/0)", A2: "=SUM(1; 2/0)" });
    expect(c.valueOf("A1")).toEqual({ error: "#DIV/0" });
    expect(c.valueOf("A2")).toEqual({ error: "#DIV/0" });
  });

  it("rejects a malformed number instead of silently truncating it", () => {
    const c = calc({ A1: "=1.2.3", A2: "=.5+.5", A3: "=3.14*2" });
    expect(c.valueOf("A1")).toEqual({ error: "#NUM" }); // was silently 1.2 before
    expect(c.valueOf("A2")).toBe(1);
    expect(c.valueOf("A3")).toBeCloseTo(6.28, 10);
  });
});

describe("IFERROR", () => {
  it("replaces a thrown error with the fallback", () => {
    const c = calc({ A1: '=IFERROR(1/0;"-")' });
    expect(c.valueOf("A1")).toBe("-");
  });

  it("replaces an errored cell reference with the fallback", () => {
    const c = calc({ A1: "=1/0", B1: "=IFERROR(A1;0)" });
    expect(c.valueOf("B1")).toBe(0);
  });

  it("does NOT swallow a real value", () => {
    const c = calc({ A1: "42", B1: "=IFERROR(A1;0)", C1: '=IFERROR(2+3;"x")' });
    expect(c.valueOf("B1")).toBe(42);
    expect(c.valueOf("C1")).toBe(5);
  });

  it("catches errors raised inside a wrapped function call", () => {
    const c = calc({
      A1: "Pomme", B1: "3",
      C1: '=IFERROR(VLOOKUP("Inconnu";A1:B1;2;FALSE);"absent")',
    });
    expect(c.valueOf("C1")).toBe("absent");
  });

  it("nests and composes with eager functions", () => {
    const c = calc({ A1: "=SUM(IFERROR(1/0;10); 5)" });
    expect(c.valueOf("A1")).toBe(15);
  });
});

describe("IFNA", () => {
  it("catches only #N/A and returns the fallback", () => {
    const c = calc({
      A1: "Pomme", B1: "3",
      C1: '=IFNA(VLOOKUP("Inconnu";A1:B1;2;FALSE);"n/a")',
    });
    expect(c.valueOf("C1")).toBe("n/a");
  });

  it("propagates non-#N/A errors instead of swallowing them", () => {
    const c = calc({ A1: '=IFNA(1/0;"n/a")' });
    expect(c.valueOf("A1")).toEqual({ error: "#DIV/0" });
  });

  it("passes a non-error value through untouched", () => {
    const c = calc({ A1: '=IFNA(7;"n/a")' });
    expect(c.valueOf("A1")).toBe(7);
  });
});
