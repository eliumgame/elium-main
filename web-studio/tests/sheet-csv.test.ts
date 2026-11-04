import { describe, it, expect } from "vitest";
import { parseCsv, csvToWorkbook, csvImportCell, csvSafeCell } from "../src/sheet/csv";

describe("csv parser", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b,c")).toEqual([["a", "b", "c"]]);
    expect(parseCsv("a,b\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles quoted fields, commas and escaped quotes", () => {
    expect(parseCsv('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
    expect(parseCsv('"he said ""hi""",x')).toEqual([['he said "hi"', "x"]]);
    expect(parseCsv('"line\none",y')).toEqual([["line\none", "y"]]);
  });

  it("builds a workbook from CSV", () => {
    const wb = csvToWorkbook("x,y\n1,2");
    expect(wb.sheets[0].cells.A1).toBe("x");
    expect(wb.sheets[0].cells.B1).toBe("y");
    expect(wb.sheets[0].cells.B2).toBe("2");
  });
});

describe("import CSV : formules neutralisées, nombres conservés", () => {
  it("garde les nombres comme nombres (y compris format français)", () => {
    for (const v of ["12", "12,5", "1 234,5", "-3", "+5", "0.5"]) expect(csvImportCell(v)).toBe(v);
  });
  it("neutralise les débuts de formule qui ne sont pas des nombres", () => {
    expect(csvImportCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(csvImportCell("@cmd")).toBe("'@cmd");
    expect(csvImportCell("-cmd|' /C calc'!A0")).toBe("'-cmd|' /C calc'!A0");
    expect(csvImportCell("+SUM(1)")).toBe("'+SUM(1)");
    expect(csvImportCell("\tx")).toBe("'\tx");
  });
  it("laisse le texte ordinaire et les dates inchangés", () => {
    expect(csvImportCell("bonjour")).toBe("bonjour");
    expect(csvImportCell("2024-01-05")).toBe("2024-01-05");
  });
  it("applique la règle au classeur importé", () => {
    const wb = csvToWorkbook("=SUM(A1:A2);12,5;-3\n+5;-cmd|' /C calc'!A0;x");
    const c = wb.sheets[0].cells;
    expect(c.A1).toBe("'=SUM(A1:A2)");
    expect(c.B1).toBe("12,5");
    expect(c.C1).toBe("-3");
    expect(c.A2).toBe("+5");
    expect(c.B2).toBe("'-cmd|' /C calc'!A0");
  });
  it("conserve l'export neutralisé", () => {
    expect(csvSafeCell("=1+1")).toBe("'=1+1");
    expect(csvSafeCell("-3")).toBe("-3");
  });
});
