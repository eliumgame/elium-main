import { describe, it, expect } from "vitest";
import { A4_PX, DEFAULT_HANDOUT, expandTokens, notesLines, pageSize, perPageOf, planHandouts, slotsFor, type HandoutMode } from "../src/slides/handouts-layout";
import type { Slide } from "../src/slides/model";

const slides = (n: number, hidden: number[] = []): Slide[] =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, title: "", body: "", layout: "blank" as const, ...(hidden.includes(i) ? { hidden: true } : {}), notes: i === 0 ? "Un\n\n  Deux  " : "" }));

describe("mosaïques de documents", () => {
  const modes: HandoutMode[] = [1, 2, 3, 4, 6, 9, "notes"];
  it("le bon nombre d'emplacements, tous dans la page et sans chevauchement, au format 16:9", () => {
    for (const m of modes) {
      const s = slotsFor(m);
      expect(s).toHaveLength(perPageOf(m));
      for (const a of s) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.x + a.w).toBeLessThanOrEqual(A4_PX.w);
        expect(a.y + a.h).toBeLessThanOrEqual(A4_PX.h);
        expect(a.w / a.h).toBeCloseTo(16 / 9, 3);
      }
      for (let i = 0; i < s.length; i++)
        for (let j = i + 1; j < s.length; j++) {
          const a = s[i]!;
          const b = s[j]!;
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(overlap).toBe(false);
        }
    }
  });
  it("3 par page : lignes de notes à droite de chaque diapositive ; mode notes : zone dessous", () => {
    const s3 = slotsFor(3);
    expect(s3.every((s) => s.note && s.note.x >= s.x + s.w)).toBe(true);
    const n = slotsFor("notes")[0]!;
    expect(n.note!.y).toBeGreaterThan(n.y + n.h);
    expect(n.note!.h).toBeGreaterThan(300);
  });
  it("paysage pour les mosaïques seulement", () => {
    expect(pageSize({ mode: 4, orientation: "landscape" })).toEqual({ w: A4_PX.h, h: A4_PX.w });
    expect(pageSize({ mode: "notes", orientation: "landscape" })).toEqual(A4_PX);
    const s = slotsFor(6, pageSize({ mode: 6, orientation: "landscape" }));
    expect(s.every((x) => x.x + x.w <= A4_PX.h && x.y + x.h <= A4_PX.w)).toBe(true);
  });
});

describe("plan de pages", () => {
  it("masquées exclues par défaut, incluses sur demande ; dernière page partielle", () => {
    const p = planHandouts(slides(7, [2]), { ...DEFAULT_HANDOUT, mode: 4 });
    expect(p.keep).toEqual([0, 1, 3, 4, 5, 6]);
    expect(p.pages.map((x) => x.slideIndexes)).toEqual([[0, 1, 3, 4], [5, 6]]);
    expect(planHandouts(slides(7, [2]), { ...DEFAULT_HANDOUT, mode: 4, includeHidden: true }).keep).toHaveLength(7);
    expect(planHandouts(slides(3), { ...DEFAULT_HANDOUT, mode: "notes" }).pages).toHaveLength(3);
    expect(planHandouts([], DEFAULT_HANDOUT).pages).toEqual([]);
  });
  it("jetons d'en-tête/pied et lignes de notes", () => {
    expect(expandTokens("{titre} — {page}/{pages}", { title: "Bilan", page: 2, pages: 5 })).toBe("Bilan — 2/5");
    expect(expandTokens("{date}", { title: "", page: 1, pages: 1, date: new Date(2026, 2, 5) })).toBe("05/03/2026");
    expect(expandTokens(undefined, { title: "", page: 1, pages: 1 })).toBe("");
    expect(notesLines(slides(1)[0]!)).toEqual(["Un", "Deux"]);
  });
});
