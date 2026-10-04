import { describe, it, expect } from "vitest";
import {
  DEFAULT_PRINT,
  expandHeaderFooter,
  normalizePrint,
  paginate,
  toggleColBreak,
  toggleRowBreak,
  usedArea,
} from "../src/sheet/print";
import type { SheetData } from "../src/sheet/model";

const sheetOf = (rows: number, cols: number, extra: Partial<SheetData> = {}): SheetData => {
  const cells: Record<string, string> = {};
  for (let r = 1; r <= rows; r++) cells[`A${r}`] = String(r);
  cells[`${String.fromCharCode(64 + cols)}1`] = "fin";
  return { name: "F", rows, cols, cells, ...extra };
};

describe("normalisation", () => {
  it("valeurs par défaut et bornes", () => {
    const n = normalizePrint({
      paper: "Zzz" as never,
      scale: 9999,
      margins: { top: -4, right: 500, bottom: 1, left: 2 },
      rowBreaks: [5, 5, -1, 2.5, 1],
    });
    expect(n.paper).toBe("A4");
    expect(n.scale).toBe(400);
    expect(n.margins).toMatchObject({ top: 0, right: 60 });
    expect(n.rowBreaks).toEqual([1, 5]);
    expect(normalizePrint(undefined)).toEqual({ ...DEFAULT_PRINT });
  });
});

describe("pagination", () => {
  it("plage utilisée par défaut ; une page pour une petite feuille", () => {
    const s = sheetOf(10, 3);
    expect(usedArea(s)).toEqual({ c0: 0, r0: 0, c1: 2, r1: 9 });
    const p = paginate(s, undefined);
    expect(p.pages).toHaveLength(1);
    expect(p.pages[0]!.rows).toHaveLength(10);
  });
  it("découpe en hauteur selon la taille du papier et l'échelle", () => {
    const s = sheetOf(200, 2); // 200 × 28 px
    const a4 = paginate(s, undefined);
    expect(a4.pages.length).toBeGreaterThan(3);
    const total = a4.pages.reduce((n, pg) => n + pg.rows.length, 0);
    expect(total).toBe(200);
    const half = paginate(s, { scale: 50 });
    expect(half.pages.length).toBeLessThan(a4.pages.length);
    const land = paginate(s, { orientation: "landscape" });
    expect(land.pages.length).toBeGreaterThan(a4.pages.length);
  });
  it("ajuster à la largeur réduit sans jamais agrandir", () => {
    const wide = sheetOf(5, 26, { cols: 26 });
    const fit = paginate(wide, { fitWidth: true });
    expect(fit.scale).toBeLessThan(1);
    expect(fit.pages).toHaveLength(1);
    const small = paginate(sheetOf(5, 2), { fitWidth: true });
    expect(small.scale).toBe(1);
  });
  it("lignes répétées : en tête de chaque page suivante, sans doublon", () => {
    const s = sheetOf(120, 2);
    const p = paginate(s, { repeatRows: { r0: 0, r1: 1 } });
    expect(p.pages.length).toBeGreaterThan(1);
    expect(p.pages[0]!.rows.slice(0, 2)).toEqual([0, 1]);
    for (const pg of p.pages.slice(1)) expect(pg.rows.slice(0, 2)).toEqual([0, 1]);
    const all = p.pages.flatMap((pg) => pg.rows);
    expect(new Set(all).size).toBeLessThan(all.length); // les répétées apparaissent plusieurs fois
  });
  it("sauts manuels (lignes et colonnes) et ordre des pages", () => {
    const s = sheetOf(10, 4);
    const p = paginate(s, { rowBreaks: [3], colBreaks: [1] });
    expect(p.pages).toHaveLength(4);
    expect(p.rowBreakAfter.has(3)).toBe(true);
    expect(p.colBreakAfter.has(1)).toBe(true);
    // « down » : colonnes A-B (haut, bas) puis C-D
    expect(p.pages.map((pg) => [pg.cols[0], pg.rows[0]])).toEqual([
      [0, 0],
      [0, 4],
      [2, 0],
      [2, 4],
    ]);
    const over = paginate(s, { rowBreaks: [3], colBreaks: [1], order: "over" });
    expect(over.pages.map((pg) => [pg.cols[0], pg.rows[0]])).toEqual([
      [0, 0],
      [2, 0],
      [0, 4],
      [2, 4],
    ]);
  });
  it("zone d'impression et lignes masquées par un filtre", () => {
    const s = sheetOf(10, 4);
    const p = paginate(s, { area: { c0: 1, r0: 2, c1: 2, r1: 5 } }, { hidden: (r) => r === 3 });
    expect(p.pages[0]!.rows).toEqual([2, 4, 5]);
    expect(p.pages[0]!.cols).toEqual([1, 2]);
  });
  it("largeurs et hauteurs personnalisées comptent", () => {
    const s = sheetOf(4, 2, { rowHeights: { 0: 600, 1: 600 } });
    expect(paginate(s, undefined).pages.length).toBeGreaterThan(1);
  });
});

describe("outils", () => {
  it("bascule des sauts", () => {
    const a = toggleRowBreak(undefined, 7);
    expect(a.rowBreaks).toEqual([7]);
    expect(toggleRowBreak(a, 7).rowBreaks).toBeUndefined();
    expect(toggleColBreak(a, 2).colBreaks).toEqual([2]);
  });
  it("en-têtes et pieds de page", () => {
    expect(expandHeaderFooter("{feuille} — p. {page}/{pages}", { page: 2, pages: 5, sheet: "Ventes" })).toBe(
      "Ventes — p. 2/5",
    );
    expect(expandHeaderFooter(undefined, { page: 1, pages: 1, sheet: "x" })).toBe("");
    expect(expandHeaderFooter("{date}", { page: 1, pages: 1, sheet: "x", date: new Date(2026, 2, 5) })).toBe(
      "05/03/2026",
    );
  });
});
