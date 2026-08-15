import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  cellText,
  cellsSnapshot,
  migrateCells,
  observeCells,
  setCellText,
  type YCells,
} from "../src/drive-cloud/collab-sheet-crdt";

/** Un document avec sa carte de cellules. */
function makeDoc() {
  const ydoc = new Y.Doc();
  const cells = ydoc.getMap("cells") as YCells;
  return { ydoc, cells };
}

/** Applique l'état de `a` dans `b` et réciproquement, comme le ferait le réseau. */
function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe("Tableur collaboratif — écriture et lecture", () => {
  it("écrit et relit une cellule", () => {
    const { ydoc, cells } = makeDoc();
    ydoc.transact(() => setCellText(cells, "A1", "=SOMME(B1:B9)"));
    expect(cellText(cells, "A1")).toBe("=SOMME(B1:B9)");
  });

  it("stocke un Y.Text, pas une chaîne", () => {
    const { ydoc, cells } = makeDoc();
    ydoc.transact(() => setCellText(cells, "A1", "x"));
    expect(cells.get("A1")).toBeInstanceOf(Y.Text);
  });

  it("supprime la clé quand la cellule est vidée", () => {
    const { ydoc, cells } = makeDoc();
    ydoc.transact(() => setCellText(cells, "A1", "x"));
    ydoc.transact(() => setCellText(cells, "A1", "   "));
    // Garder la clé ferait grossir le document au fil des effacements.
    expect(cells.has("A1")).toBe(false);
    expect(cellText(cells, "A1")).toBe("");
  });

  it("rend une chaîne vide pour une cellule absente", () => {
    const { cells } = makeDoc();
    expect(cellText(cells, "ZZ99")).toBe("");
    expect(cellText(null, "A1")).toBe("");
  });

  it("rend un instantané des cellules non vides", () => {
    const { ydoc, cells } = makeDoc();
    ydoc.transact(() => {
      setCellText(cells, "A1", "un");
      setCellText(cells, "B2", "deux");
    });
    expect(cellsSnapshot(cells)).toEqual({ A1: "un", B2: "deux" });
    expect(cellsSnapshot(null)).toEqual({});
  });
});

describe("Tableur collaboratif — compatibilité des documents existants", () => {
  it("lit une cellule héritée stockée en chaîne", () => {
    const { cells } = makeDoc();
    // Ce que contiennent les documents déjà partagés.
    (cells as Y.Map<unknown>).set("A1", "ancienne valeur");
    expect(cellText(cells, "A1")).toBe("ancienne valeur");
    expect(cellsSnapshot(cells)).toEqual({ A1: "ancienne valeur" });
  });

  it("convertit une cellule héritée à la première écriture", () => {
    const { ydoc, cells } = makeDoc();
    (cells as Y.Map<unknown>).set("A1", "ancien");
    ydoc.transact(() => setCellText(cells, "A1", "ancien!"));
    expect(cells.get("A1")).toBeInstanceOf(Y.Text);
    expect(cellText(cells, "A1")).toBe("ancien!");
  });

  it("convertit tout le document en une passe", () => {
    const { ydoc, cells } = makeDoc();
    (cells as Y.Map<unknown>).set("A1", "un");
    (cells as Y.Map<unknown>).set("B1", "deux");
    (cells as Y.Map<unknown>).set("C1", "   ");
    const n = migrateCells(ydoc, cells);
    expect(n).toBe(3);
    expect(cells.get("A1")).toBeInstanceOf(Y.Text);
    expect(cells.get("B1")).toBeInstanceOf(Y.Text);
    // Une cellule héritée vide est supprimée plutôt que convertie.
    expect(cells.has("C1")).toBe(false);
    expect(cellsSnapshot(cells)).toEqual({ A1: "un", B1: "deux" });
  });

  it("la conversion est idempotente", () => {
    const { ydoc, cells } = makeDoc();
    (cells as Y.Map<unknown>).set("A1", "un");
    expect(migrateCells(ydoc, cells)).toBe(1);
    expect(migrateCells(ydoc, cells)).toBe(0);
  });
});

describe("Tableur collaboratif — fusion dans une MÊME cellule", () => {
  it("deux frappes concurrentes dans la même cellule fusionnent", () => {
    const A = makeDoc();
    const B = makeDoc();
    A.ydoc.transact(() => setCellText(A.cells, "A1", "Bonjour monde"));
    sync(A.ydoc, B.ydoc);
    expect(cellText(B.cells, "A1")).toBe("Bonjour monde");

    // Hors ligne, chacun modifie une extrémité différente de la même cellule.
    A.ydoc.transact(() => setCellText(A.cells, "A1", "Bonjour beau monde"));
    B.ydoc.transact(() => setCellText(B.cells, "A1", "Bonjour monde !"));
    sync(A.ydoc, B.ydoc);

    const merged = cellText(A.cells, "A1");
    expect(cellText(B.cells, "A1")).toBe(merged);
    // C'est tout l'objet du changement : les DEUX modifications survivent, là où
    // un Y.Map de chaînes en aurait perdu une.
    expect(merged).toContain("beau");
    expect(merged).toContain("!");
  });

  it("les deux pairs convergent sur la même valeur", () => {
    const A = makeDoc();
    const B = makeDoc();
    A.ydoc.transact(() => setCellText(A.cells, "B2", "12"));
    sync(A.ydoc, B.ydoc);
    A.ydoc.transact(() => setCellText(A.cells, "B2", "125"));
    B.ydoc.transact(() => setCellText(B.cells, "B2", "312"));
    sync(A.ydoc, B.ydoc);
    expect(cellText(A.cells, "B2")).toBe(cellText(B.cells, "B2"));
  });

  it("des cellules différentes ne se marchent jamais dessus", () => {
    const A = makeDoc();
    const B = makeDoc();
    A.ydoc.transact(() => setCellText(A.cells, "A1", "gauche"));
    B.ydoc.transact(() => setCellText(B.cells, "B1", "droite"));
    sync(A.ydoc, B.ydoc);
    expect(cellsSnapshot(A.cells)).toEqual({ A1: "gauche", B1: "droite" });
    expect(cellsSnapshot(B.cells)).toEqual({ A1: "gauche", B1: "droite" });
  });

  it("une suppression concurrente d'une édition ne casse pas la convergence", () => {
    const A = makeDoc();
    const B = makeDoc();
    A.ydoc.transact(() => setCellText(A.cells, "A1", "valeur"));
    sync(A.ydoc, B.ydoc);
    A.ydoc.transact(() => setCellText(A.cells, "A1", ""));
    B.ydoc.transact(() => setCellText(B.cells, "A1", "valeur modifiée"));
    sync(A.ydoc, B.ydoc);
    expect(cellText(A.cells, "A1")).toBe(cellText(B.cells, "A1"));
  });
});

describe("Tableur collaboratif — observation", () => {
  it("signale la frappe DANS une cellule, pas seulement les clés", () => {
    const { ydoc, cells } = makeDoc();
    ydoc.transact(() => setCellText(cells, "A1", "abc"));
    let calls = 0;
    const stop = observeCells(cells, () => {
      calls += 1;
    });
    // `observe` (peu profond) ne verrait pas ceci : la clé ne change pas.
    ydoc.transact(() => setCellText(cells, "A1", "abcd"));
    expect(calls).toBeGreaterThan(0);
    const before = calls;
    stop();
    ydoc.transact(() => setCellText(cells, "A1", "abcde"));
    expect(calls).toBe(before);
  });

  it("signale aussi l'ajout et la suppression de cellules", () => {
    const { ydoc, cells } = makeDoc();
    let calls = 0;
    const stop = observeCells(cells, () => {
      calls += 1;
    });
    ydoc.transact(() => setCellText(cells, "A1", "x"));
    expect(calls).toBe(1);
    ydoc.transact(() => setCellText(cells, "A1", ""));
    expect(calls).toBe(2);
    stop();
  });
});
