import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { newYSheet, reconcileSheet, sheetSnapshot, type YSheets } from "../src/drive-cloud/collab-sheet-model";
import { normalizePrint } from "../src/sheet/print";
import type { SheetData } from "../src/sheet/model";

function setup() {
  const ydoc = new Y.Doc();
  const sheets = ydoc.getArray("sheets") as unknown as YSheets;
  ydoc.transact(() => sheets.push([newYSheet("S")]));
  return { ydoc, ys: sheets.get(0) };
}

describe("parité collab — tableaux, impression, pivot", () => {
  it("tables, print et pivot survivent à reconcile → snapshot", () => {
    const { ydoc, ys } = setup();
    const target: SheetData = {
      ...sheetSnapshot(ys),
      cells: { A1: "Nom", A2: "x" },
      tables: [{ id: "t1", name: "Tab", c0: 0, r0: 0, c1: 0, r1: 1, banded: true }],
      print: normalizePrint({ orientation: "landscape", rowBreaks: [3], repeatRows: { r0: 0, r1: 0 } }),
      pivot: {
        id: "pv",
        source: { sheet: "S", c0: 0, r0: 0, c1: 1, r1: 5 },
        rowField: "Nom",
        colField: null,
        valueField: "V",
        agg: "sum",
        calcFields: [{ name: "M", formula: "[V]*2" }],
      },
    };
    reconcileSheet(ydoc, ys, target);
    const snap = sheetSnapshot(ys);
    expect(snap.tables).toEqual(target.tables);
    expect(snap.print).toEqual(target.print);
    expect(snap.pivot).toEqual(target.pivot);
  });
  it("suppression propagée ; deux auteurs fusionnent par objet", () => {
    const a = setup();
    reconcileSheet(a.ydoc, a.ys, {
      ...sheetSnapshot(a.ys),
      tables: [{ id: "t1", name: "A", c0: 0, r0: 0, c1: 1, r1: 3 }],
      print: normalizePrint({ scale: 80 }),
    });
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.ydoc));
    const bys = (b.getArray("sheets") as unknown as YSheets).get(0);
    // B ajoute un second tableau pendant que A supprime l'impression
    reconcileSheet(b, bys, {
      ...sheetSnapshot(bys),
      tables: [...(sheetSnapshot(bys).tables ?? []), { id: "t2", name: "B", c0: 3, r0: 0, c1: 4, r1: 3 }],
    });
    reconcileSheet(a.ydoc, a.ys, { ...sheetSnapshot(a.ys), print: undefined });
    Y.applyUpdate(a.ydoc, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a.ydoc));
    const sa = sheetSnapshot(a.ys);
    expect(sa.tables!.map((t) => t.id).sort()).toEqual(["t1", "t2"]);
    expect(sa.print).toBeUndefined();
    expect(sheetSnapshot(bys)).toEqual(sa);
  });
});
