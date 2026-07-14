import { describe, it, expect } from "vitest";
import { createCalc, indexToCol, colToIndex, isError, rewriteRefs, type RefMap } from "../src/sheet/formula";

function calc(cells: Record<string, string>) {
  return createCalc((ref) => cells[ref]);
}

describe("formula engine", () => {
  it("evaluates literals", () => {
    const c = calc({ A1: "42", A2: "hello", A3: "3.5" });
    expect(c.valueOf("A1")).toBe(42);
    expect(c.valueOf("A2")).toBe("hello");
    expect(c.valueOf("A3")).toBe(3.5);
  });

  it("respects arithmetic precedence and unary minus", () => {
    const c = calc({ A1: "=1+2*3", A2: "=(1+2)*3", A3: "=-2+5" });
    expect(c.valueOf("A1")).toBe(7);
    expect(c.valueOf("A2")).toBe(9);
    expect(c.valueOf("A3")).toBe(3);
  });

  it("resolves cell references", () => {
    const c = calc({ A1: "10", B1: "20", C1: "=A1+B1" });
    expect(c.valueOf("C1")).toBe(30);
  });

  it("supports ranges and aggregate functions", () => {
    const c = calc({
      A1: "1", A2: "2", A3: "3",
      B1: "=SUM(A1:A3)", B2: "=AVERAGE(A1:A3)", B3: "=MAX(A1:A3)", B4: "=MIN(A1:A3)", B5: "=COUNT(A1:A3)",
    });
    expect(c.valueOf("B1")).toBe(6);
    expect(c.valueOf("B2")).toBe(2);
    expect(c.valueOf("B3")).toBe(3);
    expect(c.valueOf("B4")).toBe(1);
    expect(c.valueOf("B5")).toBe(3);
  });

  it("handles IF with comparisons", () => {
    const c = calc({ A1: "10", B1: '=IF(A1>5,"big","small")', B2: '=IF(A1<5,"big","small")' });
    expect(c.valueOf("B1")).toBe("big");
    expect(c.valueOf("B2")).toBe("small");
  });

  it("concatenates", () => {
    const c = calc({ A1: "foo", B1: '=CONCAT(A1,"-",2)' });
    expect(c.valueOf("B1")).toBe("foo-2");
  });

  it("reports division by zero", () => {
    const c = calc({ A1: "=1/0" });
    expect(c.valueOf("A1")).toEqual({ error: "#DIV/0" });
  });

  it("detects reference cycles", () => {
    const c = calc({ A1: "=B1", B1: "=A1" });
    expect(isError(c.valueOf("A1"))).toBe(true);
  });

  it("converts between column letters and indices", () => {
    expect(indexToCol(0)).toBe("A");
    expect(indexToCol(25)).toBe("Z");
    expect(indexToCol(26)).toBe("AA");
    expect(colToIndex("A")).toBe(0);
    expect(colToIndex("AA")).toBe(26);
  });
});

describe("formula engine — extended functions", () => {
  const calc = (cells: Record<string, string>) => createCalc((ref) => cells[ref]);

  it("math functions (incl. ; separator)", () => {
    const c = calc({ A1: "=SQRT(16)", A2: "=POWER(2;10)", A3: "=MOD(10;3)", A4: "=PRODUCT(2;3;4)", A5: "=ROUNDDOWN(2.78;1)" });
    expect(c.valueOf("A1")).toBe(4);
    expect(c.valueOf("A2")).toBe(1024);
    expect(c.valueOf("A3")).toBe(1);
    expect(c.valueOf("A4")).toBe(24);
    expect(c.valueOf("A5")).toBe(2.7);
  });

  it("COUNTIF / SUMIF over ranges", () => {
    const c = calc({
      A1: "10", A2: "5", A3: "20", A4: "5",
      B1: "=COUNTIF(A1:A4;5)", B2: '=COUNTIF(A1:A4;">=10")', B3: "=SUMIF(A1:A4;5)", B4: '=SUMIF(A1:A4;">5")',
    });
    expect(c.valueOf("B1")).toBe(2);
    expect(c.valueOf("B2")).toBe(2);
    expect(c.valueOf("B3")).toBe(10);
    expect(c.valueOf("B4")).toBe(30);
  });

  it("logic and text functions", () => {
    const c = calc({
      A1: "=AND(1;1;0)", A2: "=OR(0;0;1)", A3: "=NOT(0)",
      B1: '=UPPER("ab")', B2: '=LEFT("hello";2)', B3: '=MID("hello";2;3)', B4: '=LEN("abcd")',
    });
    expect(c.valueOf("A1")).toBe(false);
    expect(c.valueOf("A2")).toBe(true);
    expect(c.valueOf("A3")).toBe(true);
    expect(c.valueOf("B1")).toBe("AB");
    expect(c.valueOf("B2")).toBe("he");
    expect(c.valueOf("B3")).toBe("ell");
    expect(c.valueOf("B4")).toBe(4);
  });

  it("MEDIAN", () => {
    const c = calc({ A1: "1", A2: "3", A3: "2", A4: "10", B1: "=MEDIAN(A1:A4)" });
    expect(c.valueOf("B1")).toBe(2.5);
  });

  it("VLOOKUP — exact and approximate", () => {
    const c = calc({
      A1: "Pomme", B1: "3", A2: "Banane", B2: "5", A3: "Cerise", B3: "8",
      D1: '=VLOOKUP("Banane";A1:B3;2;FALSE)', // exact
      D2: '=VLOOKUP("Inconnu";A1:B3;2;FALSE)', // #N/A
      E1: "1", E2: "5", E3: "10", F1: "=VLOOKUP(7;E1:E3;1)", // approché → 5
    });
    expect(c.valueOf("D1")).toBe(5);
    expect(c.valueOf("D2")).toEqual({ error: "#N/A" });
    expect(c.valueOf("F1")).toBe(5);
  });

  it("HLOOKUP across the first row", () => {
    const c = calc({
      A1: "Q1", B1: "Q2", C1: "Q3",
      A2: "100", B2: "200", C2: "300",
      A4: '=HLOOKUP("Q2";A1:C2;2;FALSE)',
    });
    expect(c.valueOf("A4")).toBe(200);
  });

  it("SUMIFS / COUNTIFS / AVERAGEIF", () => {
    const c = calc({
      A1: "Nord", A2: "Sud", A3: "Nord", A4: "Sud",
      B1: "10", B2: "5", B3: "20", B4: "7",
      D1: '=SUMIFS(B1:B4;A1:A4;"Nord")', D2: '=COUNTIFS(A1:A4;"Sud")', D3: '=AVERAGEIF(A1:A4;"Nord";B1:B4)',
    });
    expect(c.valueOf("D1")).toBe(30);
    expect(c.valueOf("D2")).toBe(2);
    expect(c.valueOf("D3")).toBe(15);
  });

  it("IFS / SUBSTITUTE / FIND / SEARCH / REPLACE / DATE", () => {
    const c = calc({
      A1: "12", B1: '=IFS(A1>100;"grand";A1>5;"moyen";TRUE;"petit")',
      B2: '=SUBSTITUTE("a-b-c";"-";"+")', B3: '=FIND("b";"abc")', B4: '=SEARCH("B";"aBc")',
      B5: '=REPLACE("abcdef";2;3;"X")', B6: "=YEAR(DATE(2026;6;17))",
    });
    expect(c.valueOf("B1")).toBe("moyen");
    expect(c.valueOf("B2")).toBe("a+b+c");
    expect(c.valueOf("B3")).toBe(2);
    expect(c.valueOf("B4")).toBe(2);
    expect(c.valueOf("B5")).toBe("aXef");
    expect(c.valueOf("B6")).toBe(2026);
  });

  it("absolute references ($A$1) resolve and survive structural edits", () => {
    const c = calc({ A1: "7", B1: "=$A$1*2", C1: "=A$1+$A1" });
    expect(c.valueOf("B1")).toBe(14);
    expect(c.valueOf("C1")).toBe(14);
  });

  it("MATCH then INDEX", () => {
    const c = calc({
      A1: "rouge", A2: "vert", A3: "bleu",
      B1: "10", B2: "20", B3: "30",
      D1: '=MATCH("bleu";A1:A3;0)', // 3
      D2: "=INDEX(B1:B3;3)", // 30
      D3: '=INDEX(A1:B3;2;2)', // 20
    });
    expect(c.valueOf("D1")).toBe(3);
    expect(c.valueOf("D2")).toBe(30);
    expect(c.valueOf("D3")).toBe(20);
  });
});

describe("rewriteRefs — references track inserted/deleted rows·columns", () => {
  // Position maps mirror SheetView's insert/delete row·column logic.
  const insertRow = (at: number): RefMap => (col, row) => ({ col, row: row >= at ? row + 1 : row });
  const deleteRow = (at: number): RefMap => (col, row) => (row === at ? null : { col, row: row > at ? row - 1 : row });
  const insertCol = (at: number): RefMap => (col, row) => ({ col: col >= at ? col + 1 : col, row });
  const deleteCol = (at: number): RefMap => (col, row) => (col === at ? null : { col: col > at ? col - 1 : col, row });

  it("shifts refs down when a row is inserted above", () => {
    expect(rewriteRefs("=A1+B2", insertRow(0))).toBe("=A2+B3");
  });

  it("shifts refs up when a row is deleted above", () => {
    expect(rewriteRefs("=A2+B3", deleteRow(0))).toBe("=A1+B2");
  });

  it("expands a range when a row is inserted inside it", () => {
    expect(rewriteRefs("=SUM(A1:A5)", insertRow(2))).toBe("=SUM(A1:A6)");
  });

  it("shrinks a range when a row is deleted inside it", () => {
    expect(rewriteRefs("=SUM(A1:A5)", deleteRow(2))).toBe("=SUM(A1:A4)");
  });

  it("turns a deleted cell's ref into #REF! (and the cell errors)", () => {
    const rewritten = rewriteRefs("=A1*2", deleteRow(0));
    expect(rewritten).toBe("=#REF!*2");
    const c = createCalc((ref) => (ref === "Z9" ? rewritten : undefined));
    expect(c.valueOf("Z9")).toEqual({ error: "#REF" });
  });

  it("shifts column refs and the ; separator survives", () => {
    expect(rewriteRefs("=SUM(B1;C1)", insertCol(0))).toBe("=SUM(C1;D1)");
    expect(rewriteRefs("=A1+B1", deleteCol(0))).toBe("=#REF!+A1");
  });

  it("never rewrites function names or string literals", () => {
    expect(rewriteRefs('=IF(A1>5;"A1 is big";B2)', insertRow(0))).toBe('=IF(A2>5;"A1 is big";B3)');
    expect(rewriteRefs("=ROUND(A1;2)", insertRow(0))).toBe("=ROUND(A2;2)");
  });
});
