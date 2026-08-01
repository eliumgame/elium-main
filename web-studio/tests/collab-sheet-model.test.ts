import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  newYSheet, ensureSheetStructures, sheetSnapshot, workbookSnapshot,
  setColWidth, setFreeze, setFilter, growSheet, toggleMergeY,
  setCondRule, removeCondRule, setValidation, setChart,
  setName, removeName, mergeKey, type YSheet, type YSheets,
} from "../src/drive-cloud/collab-sheet-model";
import { setCellText, type YCells } from "../src/drive-cloud/collab-sheet-crdt";
import type { CondRule, DataValidation, ChartSpec } from "../src/sheet/model";

/** Un pair : les mêmes types racine que le classeur collaboratif réel. */
function makePeer() {
  const ydoc = new Y.Doc();
  const sheets = ydoc.getArray<YSheet>("sheets") as YSheets;
  const names = ydoc.getMap<string>("names");
  return { ydoc, sheets, names };
}
/** Échange bidirectionnel d'état, comme le ferait le relais réseau. */
function sync(a: Y.Doc, b: Y.Doc) {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

const cf = (id: string, over: Partial<CondRule> = {}): CondRule => ({ id, c0: 0, r0: 0, c1: 0, r1: 0, op: "gt", v1: "10", fill: "#fee", ...over });
const dv = (id: string, over: Partial<DataValidation> = {}): DataValidation => ({ id, c0: 0, r0: 0, c1: 0, r1: 0, type: "number", op: "ge", v1: "0", ...over });
const chart = (id: string): ChartSpec => ({ id, type: "bar", c0: 0, r0: 0, c1: 1, r1: 3 });

describe("Tableur collaboratif — modèle plein (snapshot)", () => {
  it("rend une SheetData complète depuis une feuille CRDT neuve", () => {
    const { ydoc, sheets } = makePeer();
    ydoc.transact(() => sheets.push([newYSheet("Feuille 1")]));
    const ys = sheets.get(0);
    ydoc.transact(() => setCellText(ys.get("cells") as YCells, "A1", "42"));
    setColWidth(ydoc, ys, 2, 160);
    setFreeze(ydoc, ys, 1, 1);
    setCondRule(ydoc, ys, cf("cf1"));
    const snap = sheetSnapshot(ys);
    expect(snap.cells).toEqual({ A1: "42" });
    expect(snap.colWidths).toEqual({ 2: 160 });
    expect(snap.freeze).toEqual({ rows: 1, cols: 1 });
    expect(snap.condFormats).toHaveLength(1);
  });

  it("ouvre sans perte un document antérieur (cells/styles seuls)", () => {
    // Ce que contient un document créé AVANT le modèle plein.
    const { ydoc, sheets } = makePeer();
    ydoc.transact(() => {
      const ys = new Y.Map() as YSheet;
      ys.set("name", "Ancienne"); ys.set("rows", 20); ys.set("cols", 8);
      ys.set("cells", new Y.Map()); ys.set("styles", new Y.Map());
      sheets.push([ys]); // attacher au document AVANT d'écrire dans les sous-maps
    });
    const ys = sheets.get(0);
    ydoc.transact(() => (ys.get("cells") as Y.Map<unknown>).set("A1", "héritée")); // chaîne héritée
    // Le snapshot fonctionne sans les nouvelles sous-structures…
    expect(sheetSnapshot(ys).cells).toEqual({ A1: "héritée" });
    // …et le premier accès en écriture les crée à la volée, sans rien casser.
    ydoc.transact(() => ensureSheetStructures(ys));
    setColWidth(ydoc, ys, 0, 120);
    expect(sheetSnapshot(ys).cells).toEqual({ A1: "héritée" });
    expect(sheetSnapshot(ys).colWidths).toEqual({ 0: 120 });
  });
});

describe("Tableur collaboratif — convergence concurrente plein-modèle", () => {
  it("largeurs de colonnes différentes : les deux survivent", () => {
    const A = makePeer(); const B = makePeer();
    A.ydoc.transact(() => A.sheets.push([newYSheet("F1")]));
    sync(A.ydoc, B.ydoc);
    setColWidth(A.ydoc, A.sheets.get(0), 0, 200); // A élargit la colonne 0
    setColWidth(B.ydoc, B.sheets.get(0), 1, 90);  // B rétrécit la colonne 1
    sync(A.ydoc, B.ydoc);
    expect(sheetSnapshot(A.sheets.get(0)).colWidths).toEqual({ 0: 200, 1: 90 });
    expect(sheetSnapshot(B.sheets.get(0)).colWidths).toEqual({ 0: 200, 1: 90 });
  });

  it("fusions disjointes concurrentes : les deux survivent", () => {
    const A = makePeer(); const B = makePeer();
    A.ydoc.transact(() => A.sheets.push([newYSheet("F1")]));
    sync(A.ydoc, B.ydoc);
    toggleMergeY(A.ydoc, A.sheets.get(0), { c0: 0, r0: 0, c1: 1, r1: 1 });
    toggleMergeY(B.ydoc, B.sheets.get(0), { c0: 3, r0: 3, c1: 4, r1: 4 });
    sync(A.ydoc, B.ydoc);
    const keys = new Set(sheetSnapshot(A.sheets.get(0)).merges!.map(mergeKey));
    expect(keys).toEqual(new Set(["0:0:1:1", "3:3:4:4"]));
    expect(new Set(sheetSnapshot(B.sheets.get(0)).merges!.map(mergeKey))).toEqual(keys);
  });

  it("défusionner sur un pair se propage à l'autre", () => {
    const A = makePeer(); const B = makePeer();
    A.ydoc.transact(() => A.sheets.push([newYSheet("F1")]));
    toggleMergeY(A.ydoc, A.sheets.get(0), { c0: 0, r0: 0, c1: 2, r1: 0 });
    sync(A.ydoc, B.ydoc);
    expect(sheetSnapshot(B.sheets.get(0)).merges).toHaveLength(1);
    toggleMergeY(B.ydoc, B.sheets.get(0), { c0: 0, r0: 0, c1: 2, r1: 0 }); // même rect → défusion
    sync(A.ydoc, B.ydoc);
    expect(sheetSnapshot(A.sheets.get(0)).merges ?? []).toHaveLength(0);
  });

  it("règles condformat / validations / graphiques différentes fusionnent", () => {
    const A = makePeer(); const B = makePeer();
    A.ydoc.transact(() => A.sheets.push([newYSheet("F1")]));
    sync(A.ydoc, B.ydoc);
    setCondRule(A.ydoc, A.sheets.get(0), cf("cf-A"));
    setValidation(A.ydoc, A.sheets.get(0), dv("dv-A"));
    setChart(B.ydoc, B.sheets.get(0), chart("ch-B"));
    setCondRule(B.ydoc, B.sheets.get(0), cf("cf-B", { op: "lt", v1: "5" }));
    sync(A.ydoc, B.ydoc);
    const sa = sheetSnapshot(A.sheets.get(0));
    const sb = sheetSnapshot(B.sheets.get(0));
    expect(new Set(sa.condFormats!.map((r) => r.id))).toEqual(new Set(["cf-A", "cf-B"]));
    expect(sa.validations!.map((v) => v.id)).toEqual(["dv-A"]);
    expect(sa.charts!.map((c) => c.id)).toEqual(["ch-B"]);
    expect(sb.condFormats!.map((r) => r.id).sort()).toEqual(["cf-A", "cf-B"]);
  });

  it("supprimer une règle sur un pair la retire chez l'autre", () => {
    const A = makePeer(); const B = makePeer();
    A.ydoc.transact(() => A.sheets.push([newYSheet("F1")]));
    setCondRule(A.ydoc, A.sheets.get(0), cf("cf1"));
    sync(A.ydoc, B.ydoc);
    expect(sheetSnapshot(B.sheets.get(0)).condFormats).toHaveLength(1);
    removeCondRule(B.ydoc, B.sheets.get(0), "cf1");
    sync(A.ydoc, B.ydoc);
    expect(sheetSnapshot(A.sheets.get(0)).condFormats ?? []).toHaveLength(0);
  });

  it("plages nommées différentes fusionnent (portée classeur)", () => {
    const A = makePeer(); const B = makePeer();
    A.ydoc.transact(() => A.sheets.push([newYSheet("F1")]));
    sync(A.ydoc, B.ydoc);
    setName(A.ydoc, A.names, "TVA", "F1!$A$1");
    setName(B.ydoc, B.names, "TOTAL", "F1!$B$1");
    sync(A.ydoc, B.ydoc);
    const wa = workbookSnapshot(A.sheets, A.names, 0);
    expect(new Set(wa.names!.map((n) => n.name))).toEqual(new Set(["TVA", "TOTAL"]));
    removeName(B.ydoc, B.names, "TVA");
    sync(A.ydoc, B.ydoc);
    expect(workbookSnapshot(A.sheets, A.names, 0).names!.map((n) => n.name)).toEqual(["TOTAL"]);
  });

  it("grossir la feuille et poser un filtre/figeage se propagent", () => {
    const A = makePeer(); const B = makePeer();
    A.ydoc.transact(() => A.sheets.push([newYSheet("F1", 20, 8)]));
    sync(A.ydoc, B.ydoc);
    growSheet(A.ydoc, A.sheets.get(0), "rows", 30);
    setFilter(B.ydoc, B.sheets.get(0), 1, "Paris");
    setFreeze(A.ydoc, A.sheets.get(0), 2, 0);
    sync(A.ydoc, B.ydoc);
    const sb = sheetSnapshot(B.sheets.get(0));
    expect(sb.rows).toBe(50);
    expect(sb.filter).toEqual({ col: 1, query: "Paris" });
    expect(sb.freeze).toEqual({ rows: 2, cols: 0 });
  });

  it("après un tour complet, les deux classeurs sont identiques", () => {
    const A = makePeer(); const B = makePeer();
    A.ydoc.transact(() => A.sheets.push([newYSheet("F1")]));
    sync(A.ydoc, B.ydoc);
    // Édition croisée dense sur des structures variées.
    A.ydoc.transact(() => setCellText(A.sheets.get(0).get("cells") as YCells, "A1", "10"));
    B.ydoc.transact(() => setCellText(B.sheets.get(0).get("cells") as YCells, "B2", "20"));
    setColWidth(A.ydoc, A.sheets.get(0), 0, 140);
    setValidation(B.ydoc, B.sheets.get(0), dv("dv1", { type: "list", list: ["x", "y"] }));
    toggleMergeY(A.ydoc, A.sheets.get(0), { c0: 2, r0: 2, c1: 3, r1: 2 });
    setName(B.ydoc, B.names, "REF", "F1!$A$1");
    sync(A.ydoc, B.ydoc);
    expect(workbookSnapshot(A.sheets, A.names, 0)).toEqual(workbookSnapshot(B.sheets, B.names, 0));
  });
});
