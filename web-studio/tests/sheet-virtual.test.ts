import { describe, it, expect } from "vitest";
import {
  expandForMerges,
  pageJump,
  rowAt,
  rowOffsets,
  scrollTopToReveal,
  spacers,
  windowFor,
} from "../src/sheet/virtual";

const uniform = (rows: number, h = 28) => rowOffsets(rows, () => h);

describe("virtualisation des lignes", () => {
  it("décalages cumulés, lignes masquées sans hauteur, hauteurs variables", () => {
    const o = rowOffsets(
      5,
      (r) => (r === 2 ? 50 : 28),
      (r) => r === 1,
    );
    expect(Array.from(o)).toEqual([0, 28, 28, 78, 106, 134]);
    expect(rowAt(o, 0)).toBe(0);
    expect(rowAt(o, 28)).toBe(2); // la ligne 1 est masquée
    expect(rowAt(o, 77)).toBe(2);
    expect(rowAt(o, 78)).toBe(3);
  });
  it("100 000 lignes : la fenêtre reste petite et rapide", () => {
    const o = uniform(100_000);
    const t0 = performance.now();
    const w = windowFor(o, 28 * 50_000, 600);
    expect(performance.now() - t0).toBeLessThan(50);
    expect(w.start).toBeGreaterThan(49_900);
    expect(w.end - w.start).toBeLessThan(80);
    const sp = spacers(o, w, 0);
    expect(sp.top + (w.end - w.start) * 28 + sp.bottom).toBe(100_000 * 28);
  });
  it("début et fin de feuille", () => {
    const o = uniform(1000);
    expect(windowFor(o, 0, 500).start).toBe(0);
    const w = windowFor(o, 28 * 1000, 500);
    expect(w.end).toBe(1000);
    expect(
      windowFor(
        rowOffsets(0, () => 28),
        0,
        500,
      ),
    ).toEqual({ start: 0, end: 0 });
  });
  it("lignes figées : l'espacement du haut ne les compte pas", () => {
    const o = uniform(1000);
    const w = windowFor(o, 28 * 500, 400);
    const sp = spacers(o, w, 2);
    expect(sp.top + 2 * 28 + (w.end - w.start) * 28 + sp.bottom).toBe(1000 * 28);
  });
  it("une fusion verticale à cheval sur la fenêtre est incluse en entier", () => {
    const w = expandForMerges({ start: 10, end: 20 }, [
      { c0: 0, r0: 5, c1: 1, r1: 12 },
      { c0: 0, r0: 18, c1: 0, r1: 25 },
    ]);
    expect(w).toEqual({ start: 5, end: 26 });
    expect(expandForMerges({ start: 10, end: 20 }, undefined)).toEqual({ start: 10, end: 20 });
  });
  it("révéler une ligne : défilement minimal", () => {
    const o = uniform(1000);
    expect(scrollTopToReveal(o, 5, 0, 500, 28)).toBeNull();
    expect(scrollTopToReveal(o, 100, 0, 500, 28)).toBe(28 * 101 - 500);
    expect(scrollTopToReveal(o, 2, 28 * 50, 500, 28)).toBe(28 * 2 - 28);
    expect(scrollTopToReveal(o, 5000, 0, 500, 28)).toBeNull();
  });
  it("saut de page", () => {
    const o = uniform(1000);
    expect(pageJump(o, 10, 560, 1)).toBe(10 + 18);
    expect(pageJump(o, 5, 560, -1)).toBe(0);
    expect(pageJump(o, 995, 560, 1)).toBe(999);
  });
});
