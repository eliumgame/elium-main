import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { collabSheetsToWorkbook, type CollabSheetSnap } from "../src/drive-cloud/collab-sheet-export";
import { workbookToXlsx } from "../src/sheet/xlsx-export";

function snaps(): CollabSheetSnap[] {
  return [
    {
      name: "Budget",
      rows: 20,
      cols: 8,
      cells: { A1: "Poste", B1: "Montant", A2: "Loyer", B2: "800", B3: "=SUM(B2:B2)" },
      styles: { A1: { bold: true }, B2: { fmt: "currency" } },
    },
    { name: "Notes", rows: 10, cols: 5, cells: { A1: "Libre" }, styles: {} },
  ];
}

describe("Collaborative sheet — XLSX export bridge", () => {
  it("rebuilds a Workbook from CRDT snapshots (clamping active)", () => {
    const wb = collabSheetsToWorkbook(snaps(), 5);
    expect(wb.sheets.map((s) => s.name)).toEqual(["Budget", "Notes"]);
    expect(wb.active).toBe(1); // clamped to last sheet
    expect(wb.sheets[0].cells.B3).toBe("=SUM(B2:B2)");
    expect(wb.sheets[0].styles?.A1).toEqual({ bold: true });
  });

  it("copies cells/styles (no aliasing of the live CRDT maps)", () => {
    const src = snaps();
    const wb = collabSheetsToWorkbook(src, 0);
    wb.sheets[0].cells.A1 = "MUTATED";
    expect(src[0].cells.A1).toBe("Poste"); // original snapshot untouched
  });

  it("defaults to an empty active index for no sheets", () => {
    expect(collabSheetsToWorkbook([], 3)).toEqual({ sheets: [], active: 0 });
  });

  it("produces a valid XLSX package carrying the collaborative data", () => {
    const bytes = workbookToXlsx(collabSheetsToWorkbook(snaps(), 0));
    const zip = unzipSync(bytes);
    expect(Object.keys(zip)).toContain("xl/worksheets/sheet1.xml");
    const s1 = strFromU8(zip["xl/worksheets/sheet1.xml"]);
    expect(s1).toContain("<f>SUM(B2:B2)</f>"); // formula preserved (no '=')
    expect(strFromU8(zip["xl/workbook.xml"])).toContain('name="Budget"');
  });
});
