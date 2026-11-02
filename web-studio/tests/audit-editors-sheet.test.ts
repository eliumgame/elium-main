import { describe, it, expect, vi } from "vitest";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
import { createCalc } from "../src/sheet/formula";
import { formatValue } from "../src/sheet/format";
import { csvToWorkbook, csvToWorkbookAsync } from "../src/sheet/csv";
import { workbookToXlsx } from "../src/sheet/xlsx-export";
import { runStreamImport } from "../src/sheet/xlsx-stream";
const calc = (cells: Record<string, string>) => createCalc((ref) => cells[ref]);
describe("audit F tableur", () => {
  it.each([
    ["ROUND(1.005;2)", 1.01],
    ["ROUND(-2.5;0)", -3],
    ["ROUNDUP(0.07;2)", 0.07],
    ["ROUNDDOWN(0.29;2)", 0.29],
    ["ROUNDDOWN(-0.29;2)", -0.29],
    ["ROUND(125;-1)", 130],
    ["MOD(-1;3)", 2],
    ["MOD(5;-3)", -1],
  ])("%s", (f, n) => expect(calc({ A1: "=" + f }).valueOf("A1")).toBe(n));
  it("matches case, wildcards and escaped wildcards", () => {
    const c = calc({
      A1: "Paris",
      A2: "PARIS",
      A3: "paris",
      A4: "Fact*",
      B1: '=COUNTIF(A1:A4;"paris")',
      B2: '=COUNTIF(A1:A4;"p?r*")',
      B3: '=COUNTIF(A1:A4;"Fact~*")',
      B4: '=COUNTIF(A1:A4;"<>PARIS")',
    });
    expect([1, 2, 3, 4].map((i) => c.valueOf("B" + i))).toEqual([3, 3, 1, 1]);
  });
  it("keeps CSV text literal synchronously and asynchronously through XLSX export", async () => {
    for (const wb of [
      csvToWorkbook("00123,12345678901234567890,=1+1,123,0x1A,Infinity"),
      await csvToWorkbookAsync("00123,12345678901234567890,=1+1,123,0x1A,Infinity"),
    ]) {
      const c = calc(wb.sheets[0].cells);
      expect(["A1", "B1", "C1", "D1", "E1", "F1"].map((r) => c.valueOf(r))).toEqual([
        "00123",
        "12345678901234567890",
        "=1+1",
        "123",
        "0x1A",
        "Infinity",
      ]);
      const xml = strFromU8(unzipSync(workbookToXlsx(wb))["xl/worksheets/sheet1.xml"]);
      expect(xml).not.toContain("<f>");
      expect(xml.match(/t="inlineStr"/g)).toHaveLength(6);
    }
  });
  it("does not interpret hexadecimal, infinity or long identifiers", () => {
    expect(calc({ A1: "0x1A", A2: "Infinity", A3: "00123", A4: "12345678901234567890" }).display("A3")).toBe("00123");
  });
  it("renders serial dates in UTC, flooring fractional days", () => {
    const serial = (Date.UTC(2026, 10, 1) - Date.UTC(1899, 11, 30)) / 86400000;
    expect(formatValue(serial + 0.8, "date", "")).toBe("01/11/2026");
    expect(formatValue(serial, "datetime", "")).toContain("01/11/2026");
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 1, 0, 30));
    const c = calc({ A1: "=INT(NOW())", A2: "=TODAY()" });
    expect(c.valueOf("A1")).toBe(c.valueOf("A2"));
    vi.useRealTimers();
  });
  it("rejects a lying ZIP uncompressed size", () => {
    const zip = zipSync({ "xl/styles.xml": strToU8("x".repeat(200000)) });
    const dv = new DataView(zip.buffer);
    for (let i = 0; i < zip.length - 46; i++) if (dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, 1, true);
    expect(() => runStreamImport(zip, {}, () => {})).toThrow(/Taille décompressée/);
  });
  it("rejects excessive shared string counts", () => {
    const zip = zipSync({
      "xl/worksheets/sheet1.xml": strToU8("<worksheet><sheetData/></worksheet>"),
      "xl/sharedStrings.xml": strToU8("<sst>" + "<si/>".repeat(1000001) + "</sst>"),
    });
    expect(() => runStreamImport(zip, {}, () => {})).toThrow(/chaînes partagées/);
  });
});
