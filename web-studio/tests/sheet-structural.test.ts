import { describe, it, expect } from "vitest";
import { insertRow, deleteRow, insertCol, deleteCol, sortRange, fillRange } from "../src/sheet/structural";
import type { SheetData } from "../src/sheet/model";

const base = (): SheetData => ({
  name: "F1",
  rows: 5,
  cols: 4,
  cells: { A1: "1", A2: "2", A3: "=SOMME(A1:A2)", B1: "10", C1: "20" },
  styles: { A1: { bold: true } },
  colWidths: { 1: 150 },
  rowHeights: { 1: 60 },
});

describe("Opérations structurelles pures (partagées local/collab)", () => {
  it("insère une ligne : les cellules descendent et les formules suivent", () => {
    const s = insertRow(base(), 1); // insère AU-DESSUS de la ligne d'index 1
    expect(s.rows).toBe(6);
    expect(s.cells.A1).toBe("1"); // avant le point d'insertion : inchangé
    expect(s.cells.A3).toBe("2"); // A2 a glissé en A3
    expect(s.cells.A4).toBe("=SOMME(A1:A3)"); // formule réécrite (A2→A3)
    expect(s.styles!.A1).toEqual({ bold: true });
    expect(s.rowHeights).toEqual({ 2: 60 }); // hauteur de la ligne 1 → 2 (a glissé avec elle)
  });

  it("supprime une ligne : décalage vers le haut + réécriture des formules", () => {
    const s = deleteRow(base(), 0); // supprime la ligne 1 (A1=1, B1, C1)
    expect(s.rows).toBe(4);
    expect(s.cells.A1).toBe("2"); // A2 remonte en A1
    // A3 remonte en A2 ; A1 (extrémité référencée) était sur la ligne supprimée
    // → #REF!, exactement comme le Tableur local (moteur de formules partagé).
    expect(s.cells.A2).toBe("=SOMME(#REF!:A1)");
    expect(s.cells.B1).toBeUndefined(); // B1 supprimé avec la ligne
    expect(s.rowHeights).toEqual({ 0: 60 }); // hauteur de la ligne 1 → 0 (a remonté)
  });

  it("supprime la ligne portant une hauteur personnalisée : elle disparaît", () => {
    const s = deleteRow(base(), 1);
    expect(s.rowHeights ?? {}).toEqual({});
  });

  it("insère une colonne : décalage à droite + largeurs suivies", () => {
    const s = insertCol(base(), 1); // insère À GAUCHE de la colonne d'index 1 (B)
    expect(s.cols).toBe(5);
    expect(s.cells.A1).toBe("1"); // colonne A inchangée
    expect(s.cells.C1).toBe("10"); // B1 poussé en C1
    expect(s.cells.D1).toBe("20"); // C1 poussé en D1
    expect(s.colWidths).toEqual({ 2: 150 }); // largeur de la colonne 1 → 2
  });

  it("supprime une colonne", () => {
    const s = deleteCol(base(), 1); // supprime la colonne B
    expect(s.cols).toBe(3);
    expect(s.cells.B1).toBe("20"); // C1 remonte en B1
    expect(s.colWidths).toEqual({}); // la largeur de B est retirée
  });
});

describe("Tri (pur, avec saut d'en-tête et filtre)", () => {
  const data = (): SheetData => ({
    name: "F1",
    rows: 5,
    cols: 2,
    cells: { A1: "Nom", B1: "Score", A2: "Zoé", B2: "3", A3: "Ana", B3: "9", A4: "Max", B4: "1" },
  });
  const noFilter = (c: number, r: number) => data().cells[`${String.fromCharCode(65 + c)}${r + 1}`] ?? "";

  it("tri croissant par colonne B, en sautant la ligne d'en-tête", () => {
    // Sélection A1:B4, clé = colonne B (index 1).
    const s = sortRange(data(), 1, { c0: 0, c1: 1, r0: 0, r1: 3 }, 1, noFilter);
    expect(s.cells.A1).toBe("Nom"); // en-tête préservé
    expect([s.cells.B2, s.cells.B3, s.cells.B4]).toEqual(["1", "3", "9"]); // trié asc
    expect([s.cells.A2, s.cells.A3, s.cells.A4]).toEqual(["Max", "Zoé", "Ana"]); // libellés suivent
  });

  it("tri décroissant", () => {
    const s = sortRange(data(), 1, { c0: 0, c1: 1, r0: 0, r1: 3 }, -1, noFilter);
    expect([s.cells.B2, s.cells.B3, s.cells.B4]).toEqual(["9", "3", "1"]);
  });
});

describe("Poignée de recopie (pure)", () => {
  it("extrapole une progression arithmétique verticale", () => {
    const sheet: SheetData = { name: "F1", rows: 6, cols: 2, cells: { A1: "1", A2: "2" } };
    const s = fillRange(sheet, { c0: 0, c1: 0, r0: 0, r1: 1 }, { c: 0, r: 4 });
    expect([s.cells.A3, s.cells.A4, s.cells.A5]).toEqual(["3", "4", "5"]);
  });

  it("recopie une formule en décalant ses références", () => {
    const sheet: SheetData = { name: "F1", rows: 5, cols: 3, cells: { A1: "10", B1: "20", C1: "=A1+B1" } };
    const s = fillRange(sheet, { c0: 2, c1: 2, r0: 0, r1: 0 }, { c: 2, r: 2 });
    expect(s.cells.C2).toBe("=A2+B2");
    expect(s.cells.C3).toBe("=A3+B3");
  });
});
