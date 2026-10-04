/**
 * Garde-fous de performance sur de gros documents. Seuils volontairement
 * généreux (CI lente, machine partagée) : ils attrapent une régression
 * d'ordre de grandeur (O(n²) glissé dans une boucle), pas un écart de 20 %.
 * Chaque test affiche sa mesure pour suivre la tendance.
 */
import { describe, it, expect } from "vitest";
import { planPages, type MeasuredBlock } from "../src/editor/Pagination";
import { createCalc } from "../src/sheet/formula";
import { insertRow, deleteRow } from "../src/sheet/structural";
import { emptySheet } from "../src/sheet/model";
import { rowRange, stackRows } from "../src/pdf/core/viewer/virtual";
import { deckToPptx } from "../src/slides/pptx";
import { emptyDeck, emptySlide, type Deck } from "../src/slides/model";

function timed<T>(label: string, fn: () => T): { ms: number; value: T } {
  const t0 = performance.now();
  const value = fn();
  const ms = performance.now() - t0;
  console.log(`[perf] ${label}: ${ms.toFixed(0)} ms`);
  return { ms, value };
}

describe("perf — Documents : pagination de 500 pages", () => {
  it("planPages sur ~25 000 blocs reste sous 2 s", () => {
    const blocks: MeasuredBlock[] = Array.from({ length: 25_000 }, (_, i) => ({
      pos: i * 10,
      height: 18 + (i % 5) * 4,
      isPageBreak: false,
    }));
    const { ms, value } = timed("planPages 25k blocs", () =>
      planPages(blocks, { pageContentPx: 900, gapPx: 24, marginLeftPx: 96, marginRightPx: 96 } as never),
    );
    expect(value.pageCount).toBeGreaterThan(400);
    expect(ms).toBeLessThan(2000);
  });
});

describe("perf — Tableur : 100 000 lignes", () => {
  const rows = 100_000;
  const cells: Record<string, string> = {};
  for (let r = 1; r <= rows; r++) {
    cells[`A${r}`] = String(r);
    cells[`B${r}`] = `=A${r}*2`;
  }
  cells["C1"] = `=SUM(B1:B${rows})`;

  it("recalcul complet des 100 000 formules + SUM global sous 8 s", () => {
    const { ms } = timed("calc 100k formules", () => {
      const calc = createCalc((ref) => cells[ref]);
      let last = 0;
      for (let r = 1; r <= rows; r++) last = Number(calc.display(`B${r}`));
      const sum = Number(calc.display("C1"));
      expect(last).toBe(rows * 2);
      expect(sum).toBe(rows * (rows + 1));
    });
    expect(ms).toBeLessThan(8000);
  });

  it("une chaîne de 3 000 dépendances ne fait pas déborder la pile", () => {
    const chain: Record<string, string> = { A1: "1" };
    for (let r = 2; r <= 3000; r++) chain[`A${r}`] = `=A${r - 1}+1`;
    const calc = createCalc((ref) => chain[ref]);
    expect(calc.display("A3000")).toBe("3000");
  });

  it("insertion/suppression de ligne sur 200 000 cellules sous 3 s", () => {
    const sheet = { ...emptySheet("Feuille1"), rows: rows + 10, cells: { ...cells } };
    const { ms } = timed("insertRow+deleteRow 200k cellules", () => deleteRow(insertRow(sheet, 5), 5));
    expect(ms).toBeLessThan(3000);
  });
});

describe("perf — Présentations : 300 diapositives", () => {
  it("export .pptx de 300 diapositives sous 15 s", () => {
    const deck: Deck = emptyDeck();
    deck.slides = Array.from({ length: 300 }, (_, i) => ({
      ...emptySlide("title-content"),
      id: `s${i}`,
      title: `Diapo ${i + 1}`,
      body: "Un\nDeux\nTrois",
    }));
    const { ms, value } = timed("deckToPptx 300", () => deckToPptx(deck));
    expect(value.length).toBeGreaterThan(1000);
    expect(ms).toBeLessThan(15000);
  });
});

describe("perf — PDF : virtualisation d'un document de 1 000 pages", () => {
  it("empilement + 10 000 recherches de bande restent instantanés", () => {
    const heights = Array.from({ length: 1000 }, (_, i) => 780 + (i % 7) * 12);
    const { ms } = timed("virtualisation 1000 pages", () => {
      const stack = stackRows(heights, 12);
      let mounted = 0;
      for (let i = 0; i < 10_000; i++) {
        const top = (i * 997) % Math.max(1, stack.total - 900);
        const range = rowRange(stack, top, top + 900, 600)!;
        mounted = Math.max(mounted, range.last - range.first + 1);
      }
      // Seules quelques pages sont montées à la fois, jamais les 1 000.
      expect(mounted).toBeLessThan(8);
    });
    expect(ms).toBeLessThan(500);
  });
});
