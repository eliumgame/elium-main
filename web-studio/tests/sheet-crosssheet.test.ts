import { describe, it, expect } from "vitest";
import { createCalc, rewriteRefs, renameSheetRefs, isError, type RefMap } from "../src/sheet/formula";

/** Build a calculator over several named sheets, `active` being the base sheet. */
function wbCalc(sheets: Record<string, Record<string, string>>, active: string) {
  return createCalc((ref) => sheets[active]?.[ref], {
    getSheetRaw: (name, ref) => sheets[name]?.[ref],
    hasSheet: (name) => name in sheets,
  });
}

describe("cross-sheet references (Feuille2!A1)", () => {
  it("resolves a qualified single ref", () => {
    const c = wbCalc({ "Feuille 1": { A1: "=Feuille2!A1+1" }, Feuille2: { A1: "10" } }, "Feuille 1");
    expect(c.valueOf("A1")).toBe(11);
  });

  it("resolves a qualified range in an aggregate", () => {
    const c = wbCalc(
      { Main: { A1: "=SUM(Data!A1:A3)" }, Data: { A1: "1", A2: "2", A3: "3" } },
      "Main",
    );
    expect(c.valueOf("A1")).toBe(6);
  });

  it("supports quoted sheet names with spaces", () => {
    const c = wbCalc({ Main: { A1: "='Mon onglet'!A1*2" }, "Mon onglet": { A1: "5" } }, "Main");
    expect(c.valueOf("A1")).toBe(10);
  });

  it("evaluates a referenced sheet's own formula in its own context", () => {
    const c = wbCalc({ Main: { A1: "=Feuille2!A1" }, Feuille2: { A1: "=B1", B1: "7" } }, "Main");
    expect(c.valueOf("A1")).toBe(7);
  });

  it("returns #REF for a missing sheet", () => {
    const c = wbCalc({ Main: { A1: "=Inconnue!A1" } }, "Main");
    expect(c.valueOf("A1")).toEqual({ error: "#REF" });
  });

  it("returns #REF for any qualified ref when the calc has no workbook", () => {
    const c = createCalc((ref) => ({ A1: "=Feuille2!A1" } as Record<string, string>)[ref]);
    expect(c.valueOf("A1")).toEqual({ error: "#REF" });
  });

  it("terminates on a cross-sheet cycle (no infinite loop)", () => {
    const c = wbCalc({ Main: { A1: "=Feuille2!A1" }, Feuille2: { A1: "=Main!A1" } }, "Main");
    expect(isError(c.valueOf("A1"))).toBe(true);
  });
});

describe("rewriteRefs — leaves cross-sheet refs intact under structural edits", () => {
  const insertRow = (at: number): RefMap => (col, row) => ({ col, row: row >= at ? row + 1 : row });
  const deleteRow = (at: number): RefMap => (col, row) => (row === at ? null : { col, row: row > at ? row - 1 : row });
  const offsetRow1: RefMap = (col, row) => ({ col, row: row + 1 });

  it("does not shift a cross-sheet address while shifting the local one", () => {
    expect(rewriteRefs("=Feuille2!A1+A1", insertRow(0))).toBe("=Feuille2!A1+A2");
  });

  it("does not turn a sheet name into a cell ref, and #REF!s only the local deletion", () => {
    expect(rewriteRefs("=Feuille2!A1+A1", deleteRow(0))).toBe("=Feuille2!A1+#REF!");
  });

  it("handles quoted cross-sheet names", () => {
    expect(rewriteRefs("='Mon onglet'!A1+A1", insertRow(0))).toBe("='Mon onglet'!A1+A2");
  });

  it("offsets the cross-sheet address on a copy/fill (respectAnchors)", () => {
    expect(rewriteRefs("=Feuille2!A1", offsetRow1, true)).toBe("=Feuille2!A2");
  });
});

describe("renameSheetRefs", () => {
  it("renames a bare qualifier", () => {
    expect(renameSheetRefs("=Feuille2!A1+1", "Feuille2", "Ventes")).toBe("=Ventes!A1+1");
  });

  it("quotes the new name when it contains a space", () => {
    expect(renameSheetRefs("=Feuille2!A1", "Feuille2", "Mon onglet")).toBe("='Mon onglet'!A1");
  });

  it("matches case-insensitively and leaves other sheets alone", () => {
    expect(renameSheetRefs("=feuille2!A1+Feuille3!B2", "Feuille2", "X")).toBe("=X!A1+Feuille3!B2");
  });

  it("renames a quoted qualifier", () => {
    expect(renameSheetRefs("='Old name'!A1", "Old name", "Neuf")).toBe("=Neuf!A1");
  });

  it("never touches a sheet name that only appears inside a string literal", () => {
    expect(renameSheetRefs('=IF(A1;"Feuille2";B1)', "Feuille2", "X")).toBe('=IF(A1;"Feuille2";B1)');
  });
});
