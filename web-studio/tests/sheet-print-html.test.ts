// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { printPagesHtml } from "../src/sheet/print-pdf";
import type { Workbook } from "../src/sheet/model";

const wb = (): Workbook => {
  const cells: Record<string, string> = { A1: "Nom", B1: "Montant" };
  for (let r = 2; r <= 120; r++) {
    cells[`A${r}`] = `Ligne ${r}`;
    cells[`B${r}`] = String(r * 10);
  }
  return { active: 0, sheets: [{ name: "Compta", rows: 120, cols: 3, cells }] };
};

describe("impression — pages HTML", () => {
  it("une page par bloc, titres répétés, en-tête/pied développés, quadrillage et numéros", async () => {
    const r = (await printPagesHtml(wb(), 0, {
      repeatRows: { r0: 0, r1: 0 },
      header: "{feuille}",
      footer: "Page {page}/{pages}",
      gridlines: true,
      headings: true,
    }))!;
    expect(r.count).toBeGreaterThan(2);
    expect(r.pages).toHaveLength(r.count);
    expect(r.pages[1]).toContain("Montant"); // ligne de titres répétée sur la 2e page
    expect(r.pages[1]).toContain("Compta");
    expect(r.pages[1]).toContain(`Page 2/${r.count}`);
    expect(r.pages[0]).toContain("xs-grid");
    expect(r.pages[0]).toContain('class="xs-head"');
    expect(r.pages[1]).not.toContain("Ligne 2<"); // la 2e page ne recommence pas au début
  });
  it("zone d'impression et saut manuel", async () => {
    const r = (await printPagesHtml(wb(), 0, { area: { c0: 0, r0: 0, c1: 1, r1: 9 }, rowBreaks: [4] }))!;
    expect(r.count).toBe(2);
    expect(r.pages[0]).toContain("Ligne 5");
    expect(r.pages[0]).not.toContain("Ligne 6");
    expect(r.pages[1]).toContain("Ligne 6");
    expect(r.pages[1]).not.toContain("Ligne 11");
  });
  it("feuille inexistante : null", async () => {
    expect(await printPagesHtml(wb(), 5)).toBeNull();
  });
});
