// @vitest-environment jsdom
// xlsx-import.ts uses the browser DOMParser (styles.xml, drawing/chart parts),
// unlike xlsx-export.ts's plain string building — hence the jsdom environment.
import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { workbookToXlsx } from "../src/sheet/xlsx-export";
import { importXlsx } from "../src/sheet/xlsx-import";
import {
  newYSheet,
  reconcileSheet,
  sheetSnapshot,
  type YSheet,
  type YSheets,
} from "../src/drive-cloud/collab-sheet-model";
import type { Workbook, SheetData, CondRule, DataValidation, ChartSpec } from "../src/sheet/model";

const strip = <T extends { id: string }>(x: T): Omit<T, "id"> => {
  const { id: _id, ...rest } = x;
  return rest;
};
const roundTrip = (wb: Workbook) => importXlsx(workbookToXlsx(wb));

describe("XLSX round trip — merges", () => {
  it("survives export → re-import", () => {
    const wb: Workbook = {
      active: 0,
      sheets: [
        {
          name: "Feuille",
          rows: 10,
          cols: 6,
          cells: { A1: "x" },
          merges: [
            { c0: 0, r0: 0, c1: 1, r1: 1 },
            { c0: 3, r0: 2, c1: 3, r1: 5 },
          ],
        },
      ],
    };
    const back = roundTrip(wb);
    expect(back.sheets[0]!.merges).toEqual(
      expect.arrayContaining([
        { c0: 0, r0: 0, c1: 1, r1: 1 },
        { c0: 3, r0: 2, c1: 3, r1: 5 },
      ]),
    );
    expect(back.sheets[0]!.merges).toHaveLength(2);
  });
});

describe("XLSX round trip — column widths & frozen panes", () => {
  it("colWidths survive (within the 7px/char rounding heuristic)", () => {
    const wb: Workbook = {
      active: 0,
      sheets: [{ name: "F", rows: 5, cols: 5, cells: {}, colWidths: { 0: 160, 2: 80 } }],
    };
    const back = roundTrip(wb).sheets[0]!;
    expect(back.colWidths?.[0]).toBeGreaterThanOrEqual(150);
    expect(back.colWidths?.[0]).toBeLessThanOrEqual(170);
    expect(back.colWidths?.[2]).toBeGreaterThanOrEqual(70);
    expect(back.colWidths?.[2]).toBeLessThanOrEqual(90);
  });

  it("rowHeights survive (within the 0.75pt/px rounding heuristic), incl. a row with no cells", () => {
    const wb: Workbook = {
      active: 0,
      sheets: [
        { name: "F", rows: 5, cols: 5, cells: { A1: "x", A4: "y" }, rowHeights: { 0: 50, 3: 20 } },
      ],
    };
    const back = roundTrip(wb).sheets[0]!;
    expect(back.rowHeights?.[0]).toBeGreaterThanOrEqual(45);
    expect(back.rowHeights?.[0]).toBeLessThanOrEqual(55);
    expect(back.rowHeights?.[3]).toBeGreaterThanOrEqual(15);
    expect(back.rowHeights?.[3]).toBeLessThanOrEqual(25);
  });

  it("a custom row height with NO cell content still survives (its own <row> element)", () => {
    const wb: Workbook = {
      active: 0,
      sheets: [{ name: "F", rows: 5, cols: 5, cells: {}, rowHeights: { 2: 40 } }],
    };
    const back = roundTrip(wb).sheets[0]!;
    expect(back.rowHeights?.[2]).toBeGreaterThanOrEqual(35);
    expect(back.rowHeights?.[2]).toBeLessThanOrEqual(45);
  });

  it("freeze (rows + cols) survives exactly", () => {
    const wb: Workbook = {
      active: 0,
      sheets: [{ name: "F", rows: 8, cols: 8, cells: {}, freeze: { rows: 2, cols: 1 } }],
    };
    expect(roundTrip(wb).sheets[0]!.freeze).toEqual({ rows: 2, cols: 1 });
  });

  it("row-only and column-only freeze survive", () => {
    const wbRows: Workbook = {
      active: 0,
      sheets: [{ name: "F", rows: 8, cols: 8, cells: {}, freeze: { rows: 3, cols: 0 } }],
    };
    const wbCols: Workbook = {
      active: 0,
      sheets: [{ name: "F", rows: 8, cols: 8, cells: {}, freeze: { rows: 0, cols: 2 } }],
    };
    expect(roundTrip(wbRows).sheets[0]!.freeze).toEqual({ rows: 3, cols: 0 });
    expect(roundTrip(wbCols).sheets[0]!.freeze).toEqual({ rows: 0, cols: 2 });
  });
});

describe("XLSX round trip — cell styles (incl. borders)", () => {
  it("bold/italic/align/colour/fill/font/size/format survive", () => {
    const wb: Workbook = {
      active: 0,
      sheets: [
        {
          name: "F",
          rows: 5,
          cols: 5,
          cells: { A1: "42" },
          styles: {
            A1: {
              bold: true,
              italic: true,
              align: "center",
              color: "#ab1234",
              fill: "#00ff88",
              fontFamily: "Georgia",
              fontSize: 20,
              fmt: "currency",
            },
          },
        },
      ],
    };
    const back = roundTrip(wb).sheets[0]!.styles?.A1;
    expect(back).toEqual({
      bold: true,
      italic: true,
      align: "center",
      color: "#ab1234",
      fill: "#00ff88",
      fontFamily: "Georgia",
      fontSize: 20,
      fmt: "currency",
    });
  });

  it("each NumFmt round-trips through the shared numFmt table", () => {
    const wb: Workbook = {
      active: 0,
      sheets: [
        {
          name: "F",
          rows: 2,
          cols: 6,
          cells: { A1: "1", B1: "2", C1: "3", D1: "4", E1: "5" },
          styles: {
            A1: { fmt: "number" },
            B1: { fmt: "int" },
            C1: { fmt: "percent" },
            D1: { fmt: "date" },
            E1: { fmt: "datetime" },
          },
        },
      ],
    };
    const back = roundTrip(wb).sheets[0]!.styles!;
    expect(back.A1?.fmt).toBe("number");
    expect(back.B1?.fmt).toBe("int");
    expect(back.C1?.fmt).toBe("percent");
    expect(back.D1?.fmt).toBe("date");
    expect(back.E1?.fmt).toBe("datetime");
  });

  it("a custom format (fmt+customFmt) round-trips its exact raw code", () => {
    const wb: Workbook = {
      active: 0,
      sheets: [
        {
          name: "F",
          rows: 2,
          cols: 2,
          cells: { A1: "90" },
          styles: { A1: { fmt: "custom", customFmt: "mm:ss" } },
        },
      ],
    };
    const back = roundTrip(wb).sheets[0]!.styles!.A1;
    expect(back?.fmt).toBe("custom");
    expect(back?.customFmt).toBe("mm:ss");
  });

  it("a cell with no style stays without a styles entry", () => {
    const wb: Workbook = { active: 0, sheets: [{ name: "F", rows: 3, cols: 3, cells: { A1: "plain" } }] };
    expect(roundTrip(wb).sheets[0]!.styles?.A1).toBeUndefined();
  });

  it("all four border sides (mixed styles/colours) survive", () => {
    const wb: Workbook = {
      active: 0,
      sheets: [
        {
          name: "F",
          rows: 3,
          cols: 3,
          cells: { B2: "x" },
          styles: {
            B2: {
              border: {
                top: { style: "thin", color: "#111111" },
                right: { style: "medium", color: "#222222" },
                bottom: { style: "dashed", color: "#333333" },
                left: { style: "double", color: "#444444" },
              },
            },
          },
        },
      ],
    };
    expect(roundTrip(wb).sheets[0]!.styles?.B2?.border).toEqual({
      top: { style: "thin", color: "#111111" },
      right: { style: "medium", color: "#222222" },
      bottom: { style: "dashed", color: "#333333" },
      left: { style: "double", color: "#444444" },
    });
  });
});

describe("XLSX round trip — conditional formatting", () => {
  const sheetWith = (rule: CondRule): Workbook => ({
    active: 0,
    sheets: [{ name: "F", rows: 5, cols: 5, cells: { A1: "5" }, condFormats: [rule] }],
  });

  it("cellIs operators (gt/lt/ge/le/eq/ne/between) survive with their dxf styling", () => {
    const ops: CondRule[] = [
      { id: "r1", c0: 0, r0: 0, c1: 0, r1: 4, op: "gt", v1: "10", fill: "#ffcccc", bold: true },
      { id: "r2", c0: 0, r0: 0, c1: 0, r1: 4, op: "lt", v1: "10", color: "#0000ff" },
      { id: "r3", c0: 0, r0: 0, c1: 0, r1: 4, op: "ge", v1: "10" },
      { id: "r4", c0: 0, r0: 0, c1: 0, r1: 4, op: "le", v1: "10" },
      { id: "r5", c0: 0, r0: 0, c1: 0, r1: 4, op: "eq", v1: "texte" },
      { id: "r6", c0: 0, r0: 0, c1: 0, r1: 4, op: "ne", v1: "texte" },
      { id: "r7", c0: 0, r0: 0, c1: 0, r1: 4, op: "between", v1: "1", v2: "10" },
    ];
    for (const rule of ops) {
      const back = roundTrip(sheetWith(rule)).sheets[0]!.condFormats!;
      expect(back).toHaveLength(1);
      expect(strip(back[0]!)).toEqual(strip(rule));
    }
  });

  it("contains / empty / notEmpty survive", () => {
    const rules: CondRule[] = [
      { id: "c1", c0: 0, r0: 0, c1: 0, r1: 4, op: "contains", v1: "abc", fill: "#eeeeee" },
      { id: "c2", c0: 0, r0: 0, c1: 0, r1: 4, op: "empty" },
      { id: "c3", c0: 0, r0: 0, c1: 0, r1: 4, op: "notEmpty" },
    ];
    for (const rule of rules) {
      const back = roundTrip(sheetWith(rule)).sheets[0]!.condFormats!;
      expect(strip(back[0]!)).toEqual(strip(rule));
    }
  });

  it("colorScale (2-stop and 3-stop) survives", () => {
    const two: CondRule = {
      id: "s1",
      c0: 0,
      r0: 0,
      c1: 0,
      r1: 4,
      op: "colorScale",
      scale: { min: "#ff0000", max: "#00ff00" },
    };
    const three: CondRule = {
      id: "s2",
      c0: 0,
      r0: 0,
      c1: 0,
      r1: 4,
      op: "colorScale",
      scale: { min: "#ff0000", mid: "#ffff00", max: "#00ff00" },
    };
    expect(strip(roundTrip(sheetWith(two)).sheets[0]!.condFormats![0]!)).toEqual(strip(two));
    expect(strip(roundTrip(sheetWith(three)).sheets[0]!.condFormats![0]!)).toEqual(strip(three));
  });

  it("top10 (incl. bottom/percent) and duplicateValues survive", () => {
    const rules: CondRule[] = [
      // rank is always round-tripped explicitly (export writes the Excel-required
      // rank="10" default when unset), so it's spelled out here too for the equality check.
      { id: "t1", c0: 0, r0: 0, c1: 0, r1: 4, op: "top10", rank: 10, fill: "#ffcccc" },
      { id: "t2", c0: 0, r0: 0, c1: 0, r1: 4, op: "top10", rank: 3, bottom: true, color: "#0000ff" },
      { id: "t3", c0: 0, r0: 0, c1: 0, r1: 4, op: "top10", rank: 25, percent: true, bold: true },
      { id: "d1", c0: 0, r0: 0, c1: 0, r1: 4, op: "duplicate", fill: "#eeeeee" },
    ];
    for (const rule of rules) {
      const back = roundTrip(sheetWith(rule)).sheets[0]!.condFormats!;
      expect(back).toHaveLength(1);
      expect(strip(back[0]!)).toEqual(strip(rule));
    }
  });
});

describe("XLSX round trip — data validation", () => {
  const sheetWith = (v: DataValidation): Workbook => ({
    active: 0,
    sheets: [{ name: "F", rows: 5, cols: 5, cells: {}, validations: [v] }],
  });

  it("list validation survives", () => {
    const v: DataValidation = {
      id: "v1",
      c0: 0,
      r0: 0,
      c1: 0,
      r1: 4,
      type: "list",
      list: ["Oui", "Non", "Peut-être"],
      allowBlank: true,
    };
    const back = roundTrip(sheetWith(v)).sheets[0]!.validations!;
    expect(strip(back[0]!)).toEqual(strip(v));
  });

  it("number / textLength validation (all operators) survive", () => {
    const rules: DataValidation[] = [
      { id: "n1", c0: 0, r0: 0, c1: 0, r1: 4, type: "number", op: "between", v1: "1", v2: "10", allowBlank: false },
      { id: "n2", c0: 0, r0: 0, c1: 0, r1: 4, type: "number", op: "gt", v1: "0", allowBlank: true },
      { id: "n3", c0: 0, r0: 0, c1: 0, r1: 4, type: "textLength", op: "le", v1: "20", allowBlank: true },
    ];
    for (const v of rules) expect(strip(roundTrip(sheetWith(v)).sheets[0]!.validations![0]!)).toEqual(strip(v));
  });

  it("date validation survives (ISO bounds preserved through the Excel serial epoch)", () => {
    const v: DataValidation = {
      id: "d1",
      c0: 0,
      r0: 0,
      c1: 0,
      r1: 4,
      type: "date",
      op: "between",
      v1: "2024-01-05",
      v2: "2024-12-25",
      allowBlank: true,
    };
    expect(strip(roundTrip(sheetWith(v)).sheets[0]!.validations![0]!)).toEqual(strip(v));
  });
});

describe("XLSX round trip — charts", () => {
  it("a two-column bar chart survives (source range + type + title)", () => {
    const chart: ChartSpec = { id: "ch1", type: "bar", c0: 0, r0: 1, c1: 1, r1: 4, title: "Ventes" };
    const wb: Workbook = {
      active: 0,
      sheets: [
        {
          name: "F",
          rows: 6,
          cols: 4,
          cells: { A1: "Produit", B1: "Prix", A2: "Café", B2: "3", A3: "Thé", B3: "2" },
          charts: [chart],
        },
      ],
    };
    const back = roundTrip(wb).sheets[0]!.charts!;
    expect(back).toHaveLength(1);
    expect(strip(back[0]!)).toEqual(strip(chart));
  });

  it("a single-column line chart (auto categories) survives", () => {
    const chart: ChartSpec = { id: "ch2", type: "line", c0: 2, r0: 0, c1: 2, r1: 9 };
    const wb: Workbook = { active: 0, sheets: [{ name: "F", rows: 12, cols: 4, cells: { C1: "1" }, charts: [chart] }] };
    const back = roundTrip(wb).sheets[0]!.charts!;
    expect(strip(back[0]!)).toEqual(strip(chart));
  });

  it("a pie chart survives, and multiple charts on one sheet don't collide", () => {
    const pie: ChartSpec = { id: "ch3", type: "pie", c0: 0, r0: 0, c1: 1, r1: 3 };
    const bar: ChartSpec = { id: "ch4", type: "bar", c0: 0, r0: 0, c1: 1, r1: 3, title: "Second graphique" };
    const wb: Workbook = { active: 0, sheets: [{ name: "F", rows: 6, cols: 4, cells: {}, charts: [pie, bar] }] };
    const back = roundTrip(wb).sheets[0]!.charts!;
    expect(back).toHaveLength(2);
    expect(back.map((c) => c.type).sort()).toEqual(["bar", "pie"]);
  });

  it("a multi-series bar chart (3+ columns) charts EVERY series, not just the first", () => {
    const chart: ChartSpec = { id: "multi", type: "bar", c0: 0, r0: 1, c1: 3, r1: 4 };
    const wb: Workbook = {
      active: 0,
      sheets: [
        {
          name: "F",
          rows: 6,
          cols: 4,
          cells: {
            A1: "Produit",
            B1: "T1",
            C1: "T2",
            D1: "T3",
            A2: "Café",
            B2: "3",
            C2: "4",
            D2: "5",
            A3: "Thé",
            B3: "2",
            C3: "3",
            D3: "1",
          },
          charts: [chart],
        },
      ],
    };
    const back = roundTrip(wb).sheets[0]!.charts!;
    expect(back).toHaveLength(1);
    // The bounding rectangle (all 3 series columns + the category column) is recovered.
    expect(strip(back[0]!)).toEqual(strip(chart));
  });

  it("a multi-series line chart survives the same way", () => {
    const chart: ChartSpec = { id: "multiline", type: "line", c0: 1, r0: 0, c1: 4, r1: 3, title: "Multi" };
    const wb: Workbook = {
      active: 0,
      sheets: [{ name: "F", rows: 6, cols: 6, cells: { B1: "x" }, charts: [chart] }],
    };
    const back = roundTrip(wb).sheets[0]!.charts!;
    expect(strip(back[0]!)).toEqual(strip(chart));
  });

  it("charts on different sheets don't collide (global chart-part numbering)", () => {
    const wb: Workbook = {
      active: 0,
      sheets: [
        { name: "S1", rows: 6, cols: 4, cells: {}, charts: [{ id: "a", type: "bar", c0: 0, r0: 0, c1: 1, r1: 3 }] },
        { name: "S2", rows: 6, cols: 4, cells: {}, charts: [{ id: "b", type: "pie", c0: 0, r0: 0, c1: 1, r1: 3 }] },
      ],
    };
    const back = roundTrip(wb);
    expect(back.sheets[0]!.charts).toHaveLength(1);
    expect(back.sheets[1]!.charts).toHaveLength(1);
    expect(back.sheets[0]!.charts![0]!.type).toBe("bar");
    expect(back.sheets[1]!.charts![0]!.type).toBe("pie");
  });
});

describe("XLSX round trip — everything together, multi-sheet", () => {
  it("a workbook combining all features survives a full export → re-import", () => {
    const sheet1: SheetData = {
      name: "Ventes",
      rows: 10,
      cols: 6,
      cells: { A1: "Produit", B1: "Prix", A2: "Café", B2: "3.5", A3: "Thé", B3: "2", B4: "=SUM(B2:B3)" },
      styles: { A1: { bold: true, fill: "#e2e8f0", border: { bottom: { style: "medium", color: "#000000" } } } },
      merges: [{ c0: 0, r0: 0, c1: 1, r1: 0 }],
      condFormats: [{ id: "cf1", c0: 1, r0: 1, c1: 1, r1: 3, op: "gt", v1: "2", fill: "#ffe4e6" }],
      validations: [{ id: "dv1", c0: 0, r0: 1, c1: 0, r1: 3, type: "list", list: ["Café", "Thé"], allowBlank: false }],
      charts: [{ id: "ch1", type: "bar", c0: 0, r0: 1, c1: 1, r1: 3, title: "Prix" }],
      colWidths: { 0: 140 },
      freeze: { rows: 1, cols: 0 },
    };
    const sheet2: SheetData = { name: "Notes", rows: 5, cols: 5, cells: { A1: "Libre" } };
    const wb: Workbook = { active: 0, sheets: [sheet1, sheet2] };

    const back = roundTrip(wb);
    expect(back.sheets.map((s) => s.name)).toEqual(["Ventes", "Notes"]);
    const s1 = back.sheets[0]!;
    expect(s1.cells.B4).toBe("=SUM(B2:B3)"); // formula preserved
    expect(s1.styles?.A1?.bold).toBe(true);
    expect(s1.styles?.A1?.border?.bottom).toEqual({ style: "medium", color: "#000000" });
    expect(s1.merges).toEqual([{ c0: 0, r0: 0, c1: 1, r1: 0 }]);
    expect(strip(s1.condFormats![0]!)).toEqual(strip(sheet1.condFormats![0]!));
    expect(strip(s1.validations![0]!)).toEqual(strip(sheet1.validations![0]!));
    expect(strip(s1.charts![0]!)).toEqual(strip(sheet1.charts![0]!));
    expect(s1.freeze).toEqual({ rows: 1, cols: 0 });
    expect(s1.colWidths?.[0]).toBeGreaterThanOrEqual(130);
    expect(s1.colWidths?.[0]).toBeLessThanOrEqual(150);
  });
});

describe("XLSX round trip — named ranges", () => {
  it("workbook-scoped defined names survive export → re-import", () => {
    const wb: Workbook = {
      active: 0,
      sheets: [{ name: "Ventes", rows: 10, cols: 6, cells: { B4: "42" } }],
      names: [
        { name: "TOTAL", ref: "Ventes!$B$4" },
        { name: "PLAGE", ref: "Ventes!$A$1:$B$3" },
      ],
    };
    const back = roundTrip(wb);
    expect(back.names).toEqual(
      expect.arrayContaining([
        { name: "TOTAL", ref: "Ventes!$B$4" },
        { name: "PLAGE", ref: "Ventes!$A$1:$B$3" },
      ]),
    );
    expect(back.names).toHaveLength(2);
  });

  it("a workbook with no names round-trips without a `names` key", () => {
    const wb: Workbook = { active: 0, sheets: [{ name: "F", rows: 5, cols: 5, cells: {} }] };
    expect(roundTrip(wb).names).toBeUndefined();
  });
});

describe("XLSX round trip — collaborative Tableur parity", () => {
  it("a SheetData round-tripped through the collab CRDT model still exports/imports identically", () => {
    // Dual-platform parity check: the same rich SheetData that survives XLSX
    // export/import (above) must ALSO survive a trip through the collaborative
    // model's reconcileSheet/sheetSnapshot (drive-cloud/collab-sheet-model.ts)
    // before hitting the exact same workbookToXlsx/importXlsx — proving the
    // fidelity work benefits the Drive editor for free, not just the local one.
    const sheet: SheetData = {
      name: "Collab",
      rows: 8,
      cols: 6,
      cells: { A1: "Ville", B1: "Population", A2: "Paris", B2: "2000000" },
      styles: { A1: { bold: true, border: { top: { style: "thin", color: "#000000" } } } },
      merges: [{ c0: 0, r0: 0, c1: 1, r1: 0 }],
      condFormats: [{ id: "cf", c0: 1, r0: 1, c1: 1, r1: 5, op: "gt", v1: "1000000", fill: "#fee2e2" }],
      validations: [{ id: "dv", c0: 0, r0: 1, c1: 0, r1: 5, type: "textLength", op: "le", v1: "30", allowBlank: true }],
      charts: [{ id: "ch", type: "pie", c0: 0, r0: 1, c1: 1, r1: 5 }],
      colWidths: { 1: 120 },
      freeze: { rows: 1, cols: 1 },
    };

    const ydoc = new Y.Doc();
    const ySheets = ydoc.getArray<YSheet>("sheets") as YSheets;
    ydoc.transact(() => ySheets.push([newYSheet(sheet.name)])); // must attach to the doc before writing sub-maps
    const ys = ySheets.get(0);
    reconcileSheet(ydoc, ys, sheet);
    const viaCollab = sheetSnapshot(ys);

    const wb: Workbook = { active: 0, sheets: [viaCollab] };
    const back = roundTrip(wb).sheets[0]!;
    expect(back.merges).toEqual(sheet.merges);
    expect(back.freeze).toEqual(sheet.freeze);
    expect(strip(back.condFormats![0]!)).toEqual(strip(sheet.condFormats![0]!));
    expect(strip(back.validations![0]!)).toEqual(strip(sheet.validations![0]!));
    expect(strip(back.charts![0]!)).toEqual(strip(sheet.charts![0]!));
    expect(back.styles?.A1?.border?.top).toEqual({ style: "thin", color: "#000000" });
  });
});
