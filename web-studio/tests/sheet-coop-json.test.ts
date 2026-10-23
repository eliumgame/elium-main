import { describe, expect, it } from "vitest";
import { stringifyWorkbookCooperative } from "../src/sheet/coop-json";
import type { Workbook } from "../src/sheet/model";

describe("sérialisation coopérative d'un classeur", () => {
  it("laisse les petits classeurs au chemin habituel", async () => {
    expect(
      await stringifyWorkbookCooperative({ sheets: [{ name: "A", rows: 20, cols: 8, cells: {} }], active: 0 }),
    ).toBeNull();
  });
  it("donne le même contenu que JSON.stringify", async () => {
    const cells: Record<string, string> = {};
    const styles: Record<string, { bold: boolean }> = {};
    for (let i = 1; i <= 5000; i++) {
      cells[`A${i}`] = `v"${i}\n`;
      if (i % 3 === 0) styles[`A${i}`] = { bold: true };
    }
    const wb: Workbook = {
      active: 1,
      names: [{ name: "N", ref: "A1" }],
      sheets: [
        { name: "Grande", rows: 5000, cols: 40, cells, styles, notes: { A1: "n" }, freeze: { rows: 1, cols: 0 } },
        { name: "Vide", rows: 3, cols: 3, cells: {} },
      ],
    };
    const blob = await stringifyWorkbookCooperative(wb);
    expect(blob).not.toBeNull();
    expect(JSON.parse(await blob!.text())).toEqual(JSON.parse(JSON.stringify(wb)));
  });
});

describe("enregistrement d'un gros classeur (Blob) puis relecture", () => {
  it("aller-retour par le magasin JSON", async () => {
    const { createJsonStore } = await import("../src/workspace/record-store");
    const { memoryKv } = await import("../src/workspace/kv");
    const store = createJsonStore<Workbook>(memoryKv(), {
      field: "wb",
      lockedMessage: "verrouillé",
      serialize: (wb) => stringifyWorkbookCooperative(wb as Workbook),
    });
    const cells: Record<string, string> = {};
    for (let i = 1; i <= 3000; i++) cells[`B${i}`] = String(i);
    const wb: Workbook = { active: 0, sheets: [{ name: "G", rows: 3000, cols: 60, cells }] };
    const size = await store.save("x", wb);
    expect(size).toBeGreaterThan(10_000);
    expect(await store.load("x")).toEqual(wb);
  });
});
