import { describe, it, expect } from "vitest";
import { cellClass, deleteCol, deleteRow, insertCol, insertRow, isCovered, mergeAt, mergeCells, mergeContaining, tableFromTsv, unmergeAt, validMerges } from "../src/slides/table";
import type { TableData } from "../src/slides/model";

const t3 = (): TableData => ({
  rows: 3,
  cols: 3,
  cells: [
    ["A", "B", "C"],
    ["D", "E", "F"],
    ["G", "H", "I"],
  ],
});

describe("fusion de cellules", () => {
  it("fusionne un rectangle : textes regroupés dans l'ancre, cellules couvertes", () => {
    const m = mergeCells(t3(), { r: 0, c: 0 }, { r: 1, c: 1 });
    expect(m.merges).toEqual([{ r: 0, c: 0, rs: 2, cs: 2 }]);
    expect(m.cells[0]![0]).toBe("A B D E");
    expect(m.cells[1]![1]).toBe("");
    expect(isCovered(m, 1, 1)).toBe(true);
    expect(isCovered(m, 0, 0)).toBe(false);
    expect(isCovered(m, 2, 2)).toBe(false);
    expect(mergeAt(m, 0, 0)).toBeTruthy();
    expect(mergeContaining(m, 1, 0)).toBeTruthy();
    expect(validMerges(m)).toBe(true);
  });
  it("ignore une sélection d'une cellule ou hors du tableau", () => {
    const t = t3();
    expect(mergeCells(t, { r: 1, c: 1 }, { r: 1, c: 1 })).toBe(t);
    expect(mergeCells(t, { r: 0, c: 0 }, { r: 5, c: 5 })).toBe(t);
  });
  it("chevauchement : le rectangle absorbe les fusions touchées", () => {
    const a = mergeCells(t3(), { r: 0, c: 0 }, { r: 0, c: 1 });
    const b = mergeCells(a, { r: 0, c: 1 }, { r: 1, c: 2 });
    expect(b.merges).toEqual([{ r: 0, c: 0, rs: 2, cs: 3 }]);
    expect(validMerges(b)).toBe(true);
  });
  it("sépare", () => {
    const m = mergeCells(t3(), { r: 0, c: 0 }, { r: 0, c: 2 });
    expect(unmergeAt(m, 0, 1).merges).toBeUndefined();
    expect(unmergeAt(t3(), 0, 0)).toEqual(t3());
  });
});

describe("lignes et colonnes avec fusions", () => {
  const m = mergeCells(t3(), { r: 0, c: 0 }, { r: 1, c: 1 });
  it("insérer au milieu d'une fusion l'agrandit, avant elle la décale", () => {
    expect(insertRow(m, 1).merges).toEqual([{ r: 0, c: 0, rs: 3, cs: 2 }]);
    expect(insertRow(m, 0).merges).toEqual([{ r: 1, c: 0, rs: 2, cs: 2 }]);
    expect(insertCol(m, 1).merges).toEqual([{ r: 0, c: 0, rs: 2, cs: 3 }]);
    expect(insertCol(m, 3).merges).toEqual(m.merges);
    expect(insertRow(m, 1).cells).toHaveLength(4);
  });
  it("supprimer rétrécit ou supprime la fusion ; jamais le dernier ligne/colonne", () => {
    expect(deleteRow(m, 1).merges).toEqual([{ r: 0, c: 0, rs: 1, cs: 2 }]);
    expect(deleteRow(m, 2).merges).toEqual(m.merges);
    expect(deleteCol(m, 0).merges).toEqual([{ r: 0, c: 0, rs: 2, cs: 1 }]);
    expect(deleteRow(mergeCells(t3(), { r: 0, c: 0 }, { r: 1, c: 0 }), 0).merges).toBeUndefined(); // 2×1 → 1×1 : plus une fusion
    const one: TableData = { rows: 1, cols: 1, cells: [["x"]] };
    expect(deleteRow(one, 0)).toBe(one);
    expect(deleteCol(one, 0)).toBe(one);
    const d = deleteRow(mergeCells(t3(), { r: 1, c: 0 }, { r: 2, c: 0 }), 0);
    expect(d.merges).toEqual([{ r: 0, c: 0, rs: 2, cs: 1 }]);
    expect(validMerges(d)).toBe(true);
  });
});

describe("import depuis le Tableur et styles", () => {
  it("TSV → tableau complété à la largeur maximale", () => {
    const t = tableFromTsv("Nom\tVille\nAna\tParis\tFR\n")!;
    expect([t.rows, t.cols]).toEqual([2, 3]);
    expect(t.cells[0]).toEqual(["Nom", "Ville", ""]);
    expect(t.style).toBe("banded");
    expect(tableFromTsv("")).toBeNull();
    expect(tableFromTsv("\n\n")).toBeNull();
    expect(tableFromTsv('"a ""b"""\tx')!.cells[0]![0]).toBe('a "b"');
  });
  it("classes de cellule selon le style", () => {
    const t = { ...t3(), style: "banded" as const, firstCol: true };
    expect(cellClass(t, 0, 0)).toBe("ce-td--head");
    expect(cellClass(t, 1, 0)).toBe("ce-td--firstcol");
    expect(cellClass(t, 2, 1)).toBe("ce-td--band");
    expect(cellClass(t, 1, 1)).toBe("");
    expect(cellClass({ ...t, style: "grid" }, 1, 1)).toBe("ce-td--grid");
    expect(cellClass({ ...t, headerRow: false, style: "plain" }, 0, 1)).toBe("");
  });
});
