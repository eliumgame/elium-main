import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readSheetHead } from "./xlsx-import";

describe("lecture partielle d'une feuille géante", () => {
  it("s'arrête au plafond et referme le XML après la dernière ligne complète", () => {
    const rows = Array.from(
      { length: 50_000 },
      (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`,
    ).join("");
    const xml = `<?xml version="1.0"?><worksheet><sheetData>${rows}</sheetData><mergeCells/></worksheet>`;
    const zip = zipSync({ "xl/worksheets/sheet1.xml": strToU8(xml) });
    const { xml: head, keptRows } = readSheetHead(zip, "xl/worksheets/sheet1.xml", 100_000);
    expect(keptRows).toBeGreaterThan(100);
    expect(keptRows).toBeLessThan(50_000);
    expect(head.endsWith("</row></sheetData></worksheet>")).toBe(true);
  });
});
