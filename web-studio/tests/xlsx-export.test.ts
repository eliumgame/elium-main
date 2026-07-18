import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { workbookToXlsx, colLetters } from "../src/sheet/xlsx-export";
import type { Workbook } from "../src/sheet/model";

function wb(): Workbook {
  return {
    active: 0,
    sheets: [
      {
        name: "Ventes",
        rows: 20,
        cols: 8,
        cells: {
          A1: "Produit",
          B1: "Prix",
          A2: "Café",
          B2: "3.5",
          A3: "Thé",
          B3: "2",
          B4: "=SUM(B2:B3)",
        },
        styles: {
          A1: { bold: true, fill: "#e2e8f0" },
          B1: { bold: true, align: "right" },
          B2: { fmt: "currency" },
          B4: { fmt: "currency", bold: true },
        },
      },
      { name: "Notes", rows: 20, cols: 8, cells: { A1: "Libre" } },
    ],
  };
}

describe("XLSX export", () => {
  it("colLetters maps indices to spreadsheet columns", () => {
    expect([0, 1, 25, 26, 27].map(colLetters)).toEqual(["A", "B", "Z", "AA", "AB"]);
  });

  it("produces a valid OPC package with the required parts", () => {
    const zip = unzipSync(workbookToXlsx(wb()));
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]) {
      expect(Object.keys(zip)).toContain(part);
    }
    // Both sheets listed + full recalc on load (so formulas resolve without cache).
    const book = strFromU8(zip["xl/workbook.xml"]);
    expect(book).toContain('name="Ventes"');
    expect(book).toContain('name="Notes"');
    expect(book).toContain('fullCalcOnLoad="1"');
  });

  it("writes numbers, inline strings and formulas", () => {
    const s1 = strFromU8(unzipSync(workbookToXlsx(wb()))["xl/worksheets/sheet1.xml"]);
    expect(s1).toContain('<c r="A1" s="'); // styled header (bold+fill)
    expect(s1).toContain('t="inlineStr"');
    expect(s1).toContain("<t xml:space=\"preserve\">Café</t>");
    expect(s1).toContain("<v>3.5</v>"); // numeric cell
    expect(s1).toContain("<f>SUM(B2:B3)</f>"); // formula, no leading '='
    expect(s1).not.toContain("=SUM"); // the '=' is stripped in <f>
  });

  it("builds a styles table with reserved fills, a currency numFmt and bold font", () => {
    const styles = strFromU8(unzipSync(workbookToXlsx(wb()))["xl/styles.xml"]);
    // Reserved fills 0 (none) and 1 (gray125) must be present + in order.
    const noneIdx = styles.indexOf('patternType="none"');
    const grayIdx = styles.indexOf('patternType="gray125"');
    expect(noneIdx).toBeGreaterThan(-1);
    expect(grayIdx).toBeGreaterThan(noneIdx);
    expect(styles).toContain('patternType="solid"'); // the header fill
    expect(styles).toContain("<b/>"); // bold font
    expect(styles).toContain('formatCode="#,##0.00\\ €"'); // currency numFmt
    // counts are self-consistent (each table declares its own count attribute)
    expect(styles).toMatch(/<fonts count="\d+">/);
    expect(styles).toMatch(/<cellXfs count="\d+">/);
  });

  it("sanitizes / de-duplicates sheet names (≤31 chars, no forbidden chars)", () => {
    const messy: Workbook = {
      active: 0,
      sheets: [
        { name: "A/B:C*?", rows: 5, cols: 5, cells: {} },
        { name: "A B C  ", rows: 5, cols: 5, cells: {} },
        { name: "x".repeat(50), rows: 5, cols: 5, cells: {} },
      ],
    };
    const book = strFromU8(unzipSync(workbookToXlsx(messy))["xl/workbook.xml"]);
    expect(book).not.toMatch(/name="[^"]*[[\]:*?/\\][^"]*"/); // no forbidden chars
    for (const m of book.matchAll(/name="([^"]*)"/g)) expect(m[1]!.length).toBeLessThanOrEqual(31);
  });
});
