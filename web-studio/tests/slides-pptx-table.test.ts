import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { deckToPptx } from "../src/slides/pptx";
import { importPptx } from "../src/slides/pptx-import";
import { mergeCells } from "../src/slides/table";
import type { Deck, TableData } from "../src/slides/model";

const base: TableData = {
  rows: 4,
  cols: 3,
  cells: [
    ["Titre", "", ""],
    ["a", "b", "c"],
    ["d", "e", "f"],
    ["g", "h", "i"],
  ],
  style: "banded",
  headerRow: true,
  firstCol: true,
};
const deckOf = (t: TableData): Deck => ({
  active: 0,
  slides: [
    {
      id: "s",
      title: "",
      body: "",
      layout: "blank",
      elements: [{ id: "t", type: "table", x: 5, y: 5, w: 80, h: 50, table: t, fontSize: 18 }],
    },
  ],
});

describe("PPTX — tableaux fusionnés et stylés", () => {
  const merged = mergeCells(mergeCells(base, { r: 0, c: 0 }, { r: 0, c: 2 }), { r: 2, c: 0 }, { r: 3, c: 0 });
  const bytes = deckToPptx(deckOf(merged));
  const xml = strFromU8(unzipSync(bytes)["ppt/slides/slide1.xml"]!);
  it("gridSpan/rowSpan sur l'ancre, hMerge/vMerge sur les cellules couvertes", () => {
    expect(xml).toContain('gridSpan="3"');
    expect(xml).toContain('rowSpan="2"');
    expect((xml.match(/hMerge="1"/g) ?? []).length).toBe(2);
    expect((xml.match(/vMerge="1"/g) ?? []).length).toBe(1);
  });
  it("indicateurs de style et remplissages explicites (en-tête, lignes alternées)", () => {
    expect(xml).toContain('<a:tblPr firstRow="1" bandRow="1" firstCol="1"/>');
    expect(xml).toContain('<a:srgbClr val="E2E8F0"/>');
    expect(xml).toContain('<a:srgbClr val="F1F5F9"/>');
  });
  it("aller-retour : fusions, texte regroupé, style", () => {
    const t = importPptx(bytes).slides[0]!.elements!.find((e) => e.type === "table")!.table!;
    expect(t.merges).toEqual([
      { r: 0, c: 0, rs: 1, cs: 3 },
      { r: 2, c: 0, rs: 2, cs: 1 },
    ]);
    expect(t.cells[0]![0]).toBe("Titre");
    expect(t.cells[2]![0]).toBe("d g");
    expect(t.style).toBe("banded");
    expect(t.headerRow).toBe(true);
    expect(t.firstCol).toBe(true);
  });
  it("styles quadrillage / accent / sans style", () => {
    const grid = strFromU8(unzipSync(deckToPptx(deckOf({ ...base, style: "grid" })))["ppt/slides/slide1.xml"]!);
    expect(grid).toContain("<a:lnL ");
    expect(grid).not.toContain("bandRow");
    const accent = strFromU8(unzipSync(deckToPptx(deckOf({ ...base, style: "accent" })))["ppt/slides/slide1.xml"]!);
    expect(accent).toContain('<a:srgbClr val="2563EB"/>');
    const plain = importPptx(deckToPptx(deckOf({ ...base, style: "plain", headerRow: false }))).slides[0]!.elements![0]!
      .table!;
    expect(plain.style).toBe("plain");
    expect(plain.headerRow).toBe(false);
  });
});
