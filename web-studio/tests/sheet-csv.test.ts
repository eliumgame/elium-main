import { describe, it, expect } from "vitest";
import { parseCsv, csvToWorkbook } from "../src/sheet/csv";

describe("csv parser", () => {
  it("parses simple rows", () => {
    expect(parseCsv("a,b,c")).toEqual([["a", "b", "c"]]);
    expect(parseCsv("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
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
