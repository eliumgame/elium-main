import { describe, it, expect } from "vitest";
import { computePivot, pivotToSheet, type PivotInput } from "../src/sheet/pivot";

const DATA: PivotInput = {
  headers: ["Région", "Produit", "Ventes"],
  rows: [
    ["Nord", "A", 10],
    ["Nord", "B", 20],
    ["Sud", "A", 5],
    ["Sud", "B", 15],
    ["Nord", "A", 30],
  ],
};

describe("pivot — computePivot", () => {
  it("sums a value field grouped by one row field", () => {
    const r = computePivot(DATA, { rowField: 0, colField: null, valueField: 2, agg: "sum" });
    expect(r.rowLabels).toEqual(["Nord", "Sud"]);
    expect(r.hasCols).toBe(false);
    expect(r.rowTotals).toEqual([60, 20]);
    expect(r.grandTotal).toBe(80);
    expect(r.corner).toBe("Somme de Ventes");
  });

  it("builds a 2-D matrix with row/col/grand totals", () => {
    const r = computePivot(DATA, { rowField: 0, colField: 1, valueField: 2, agg: "sum" });
    expect(r.colLabels).toEqual(["A", "B"]);
    expect(r.rowLabels).toEqual(["Nord", "Sud"]);
    // Nord: A=10+30=40, B=20 ; Sud: A=5, B=15
    expect(r.matrix).toEqual([[40, 20], [5, 15]]);
    expect(r.rowTotals).toEqual([60, 20]);
    expect(r.colTotals).toEqual([45, 35]);
    expect(r.grandTotal).toBe(80);
  });

  it("supports count / avg / min / max", () => {
    const count = computePivot(DATA, { rowField: 0, colField: null, valueField: 2, agg: "count" });
    expect(count.rowTotals).toEqual([3, 2]);
    expect(count.grandTotal).toBe(5);

    const avg = computePivot(DATA, { rowField: 0, colField: null, valueField: 2, agg: "avg" });
    expect(avg.rowTotals).toEqual([20, 10]); // 60/3, 20/2
    expect(avg.grandTotal).toBe(16); // 80/5

    const min = computePivot(DATA, { rowField: 0, colField: null, valueField: 2, agg: "min" });
    expect(min.rowTotals).toEqual([10, 5]);

    const max = computePivot(DATA, { rowField: 0, colField: null, valueField: 2, agg: "max" });
    expect(max.rowTotals).toEqual([30, 15]);
  });

  it("ignores non-numeric values for sum but counts non-empty entries", () => {
    const input: PivotInput = {
      headers: ["Cat", "Val"],
      rows: [["X", 5], ["X", "n/a"], ["X", null], ["Y", 2]],
    };
    const sum = computePivot(input, { rowField: 0, colField: null, valueField: 1, agg: "sum" });
    expect(sum.rowTotals).toEqual([5, 2]); // "n/a" and null skipped
    const count = computePivot(input, { rowField: 0, colField: null, valueField: 1, agg: "count" });
    expect(count.rowTotals).toEqual([2, 1]); // X: 5 and "n/a" are non-empty; null is empty
  });
});

describe("pivot — pivotToSheet", () => {
  it("renders labels, values and a Total row/column into a sheet", () => {
    const r = computePivot(DATA, { rowField: 0, colField: 1, valueField: 2, agg: "sum" });
    const sheet = pivotToSheet(r, "TCD");
    expect(sheet.name).toBe("TCD");
    expect(sheet.cells["A1"]).toBe("Somme de Ventes");
    expect(sheet.cells["B1"]).toBe("A");
    expect(sheet.cells["C1"]).toBe("B");
    expect(sheet.cells["D1"]).toBe("Total");
    expect(sheet.cells["A2"]).toBe("Nord");
    expect(sheet.cells["B2"]).toBe("40"); // Nord/A
    expect(sheet.cells["D2"]).toBe("60"); // Nord total
    expect(sheet.cells["A4"]).toBe("Total");
    expect(sheet.cells["D4"]).toBe("80"); // grand total
    // header + label column bolded
    expect(sheet.styles?.["A1"]?.bold).toBe(true);
    expect(sheet.styles?.["A2"]?.bold).toBe(true);
  });
});
