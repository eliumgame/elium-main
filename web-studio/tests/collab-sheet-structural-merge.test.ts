import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { newYSheet, insertRowY, sheetSnapshot, type YSheet } from "../src/drive-cloud/collab-sheet-model";
import { setCellText, type YCells } from "../src/drive-cloud/collab-sheet-crdt";

function pair() {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const sync = () => {
    for (let i = 0; i < 2; i++) {
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    }
  };
  a.transact(() => {
    const ys = newYSheet("S");
    a.getMap("root").set("sheet", ys);
    const cells = ys.get("cells") as YCells;
    setCellText(cells, "A1", "titre");
    setCellText(cells, "A2", "deux");
    setCellText(cells, "A4", "quatre");
  });
  sync();
  const sa = a.getMap("root").get("sheet") as YSheet;
  const sb = b.getMap("root").get("sheet") as YSheet;
  return { a, b, sa, sb, sync };
}

describe("fusion Tableur : opération structurelle vs frappe concurrente", () => {
  it("une cellule au-dessus du point d'insertion ne perd pas la frappe de l'autre pair", () => {
    const { a, b, sa, sb, sync } = pair();
    b.transact(() => setCellText(sb.get("cells") as YCells, "A1", "titre !"));
    insertRowY(a, sa, 3); // insère avant la ligne 4 : A1 et A2 ne bougent pas
    sync();
    const snapA = sheetSnapshot(sa);
    const snapB = sheetSnapshot(sb);
    expect(snapA.cells).toEqual(snapB.cells);
    expect(snapA.cells["A1"]).toBe("titre !");
    expect(snapA.cells["A5"]).toBe("quatre");
    expect(snapA.cells["A4"]).toBeUndefined();
  });

  it("la frappe d'un pair dans une cellule déplacée converge (sans garantie de conservation)", () => {
    const { a, b, sa, sb, sync } = pair();
    b.transact(() => setCellText(sb.get("cells") as YCells, "A4", "quatre!"));
    insertRowY(a, sa, 0);
    sync();
    expect(sheetSnapshot(sa).cells).toEqual(sheetSnapshot(sb).cells);
  });
});
