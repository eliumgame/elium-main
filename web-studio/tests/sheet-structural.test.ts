import { describe, it, expect } from "vitest";
import { insertRow, deleteRow, insertCol, deleteCol } from "../src/sheet/structural";
import type { SheetData } from "../src/sheet/model";

const base = (): SheetData => ({
  name: "F1", rows: 5, cols: 4,
  cells: { A1: "1", A2: "2", A3: "=SOMME(A1:A2)", B1: "10", C1: "20" },
  styles: { A1: { bold: true } },
  colWidths: { 1: 150 },
});

describe("Opérations structurelles pures (partagées local/collab)", () => {
  it("insère une ligne : les cellules descendent et les formules suivent", () => {
    const s = insertRow(base(), 1); // insère AU-DESSUS de la ligne d'index 1
    expect(s.rows).toBe(6);
    expect(s.cells.A1).toBe("1");      // avant le point d'insertion : inchangé
    expect(s.cells.A3).toBe("2");      // A2 a glissé en A3
    expect(s.cells.A4).toBe("=SOMME(A1:A3)"); // formule réécrite (A2→A3)
    expect(s.styles!.A1).toEqual({ bold: true });
  });

  it("supprime une ligne : décalage vers le haut + réécriture des formules", () => {
    const s = deleteRow(base(), 0); // supprime la ligne 1 (A1=1, B1, C1)
    expect(s.rows).toBe(4);
    expect(s.cells.A1).toBe("2");        // A2 remonte en A1
    // A3 remonte en A2 ; A1 (extrémité référencée) était sur la ligne supprimée
    // → #REF!, exactement comme le Tableur local (moteur de formules partagé).
    expect(s.cells.A2).toBe("=SOMME(#REF!:A1)");
    expect(s.cells.B1).toBeUndefined();  // B1 supprimé avec la ligne
  });

  it("insère une colonne : décalage à droite + largeurs suivies", () => {
    const s = insertCol(base(), 1); // insère À GAUCHE de la colonne d'index 1 (B)
    expect(s.cols).toBe(5);
    expect(s.cells.A1).toBe("1");   // colonne A inchangée
    expect(s.cells.C1).toBe("10");  // B1 poussé en C1
    expect(s.cells.D1).toBe("20");  // C1 poussé en D1
    expect(s.colWidths).toEqual({ 2: 150 }); // largeur de la colonne 1 → 2
  });

  it("supprime une colonne", () => {
    const s = deleteCol(base(), 1); // supprime la colonne B
    expect(s.cols).toBe(3);
    expect(s.cells.B1).toBe("20");  // C1 remonte en B1
    expect(s.colWidths).toEqual({}); // la largeur de B est retirée
  });
});
