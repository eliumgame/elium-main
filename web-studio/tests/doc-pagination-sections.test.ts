import { describe, it, expect } from "vitest";
import { planPages, type MeasuredBlock, type SectionMetrics } from "../src/editor/Pagination";

const metrics = (content: number, total = content, restartAt: number | null = null): SectionMetrics => ({
  pageContentPx: content,
  pageTotalPx: total,
  gapPx: 40,
  marginLeftPx: 0,
  marginRightPx: 0,
  restartAt,
});

const block = (pos: number, height: number, sectionIndex = 0): MeasuredBlock => ({
  pos,
  height,
  isPageBreak: false,
  sectionIndex,
});

const sectionBreak = (pos: number, sectionIndex: number, breaksPage = true): MeasuredBlock => ({
  pos,
  height: 0,
  isPageBreak: false,
  isSectionBreak: true,
  breaksPage,
  sectionIndex,
});

describe("Pagination par section — géométrie propre à chaque section", () => {
  it("casse chaque section à SA hauteur de page", () => {
    // Section 0 : pages de 100px. Section 1 : pages de 50px.
    const plan = planPages(
      [block(0, 90, 0), sectionBreak(1, 1), block(2, 40, 1), block(3, 40, 1)],
      [metrics(100), metrics(50)],
    );
    // 90 tient dans la page 1 ; la section 1 ouvre la page 2 ; 40+40 = 80 > 50
    // donc une 3ᵉ page.
    expect(plan.pageCount).toBe(3);
    expect(plan.pages.map((p) => p.sectionIndex)).toEqual([0, 1, 1]);
  });

  it("dessine chaque feuille à la hauteur totale de sa section", () => {
    const plan = planPages(
      [block(0, 10, 0), sectionBreak(1, 1), block(2, 10, 1)],
      [metrics(100, 140), metrics(50, 80)],
    );
    expect(plan.pages.map((p) => p.height)).toEqual([140, 80]);
    // La 2ᵉ feuille commence après la 1ʳᵉ plus l'espace inter-feuilles.
    expect(plan.pages[0]!.top).toBe(0);
    expect(plan.pages[1]!.top).toBe(140 + 40);
  });

  it("ne change pas de page pour un saut de section continu", () => {
    const plan = planPages([block(0, 10, 0), sectionBreak(1, 1, false), block(2, 10, 1)], [metrics(100), metrics(100)]);
    expect(plan.pageCount).toBe(1);
    expect(plan.pages).toHaveLength(1);
  });

  it("recommence la numérotation quand la section le demande", () => {
    const plan = planPages(
      [
        block(0, 10, 0),
        sectionBreak(1, 1),
        block(2, 10, 1),
        { ...block(3, 10, 1), isPageBreak: true },
        block(4, 10, 1),
      ],
      [metrics(100), metrics(100, 100, 1)],
    );
    // Numéros AFFICHÉS : 1, puis la section 1 repart à 1, puis 2.
    expect(plan.pages.map((p) => p.number)).toEqual([1, 1, 2]);
    // Le compte réel de feuilles reste 3.
    expect(plan.pageCount).toBe(3);
  });

  it("applique la reprise de numérotation même sur un saut continu", () => {
    const plan = planPages(
      [block(0, 10, 0), sectionBreak(1, 1, false), block(2, 10, 1)],
      [metrics(100), metrics(100, 100, 7)],
    );
    expect(plan.pageStartByPos.get(2)).toBe(7);
  });

  it("associe chaque bloc au numéro de page affiché", () => {
    const plan = planPages(
      [block(0, 60, 0), block(1, 60, 0), sectionBreak(2, 1), block(3, 10, 1)],
      [metrics(100), metrics(100, 100, 1)],
    );
    expect(plan.pageStartByPos.get(0)).toBe(1);
    expect(plan.pageStartByPos.get(1)).toBe(2); // 60+60 > 100
    expect(plan.pageStartByPos.get(3)).toBe(1); // section 1 repart à 1
  });

  it("insère un espaceur qui remplit la page sortante au changement de section", () => {
    const plan = planPages([block(0, 30, 0), sectionBreak(1, 1), block(2, 10, 1)], [metrics(100), metrics(100)]);
    const spacer = plan.spacers.find((s) => s.pos === 1);
    expect(spacer).toBeDefined();
    expect(spacer!.height).toBe(100 - 30 + 40);
  });

  it("gère plusieurs sections d'affilée", () => {
    const plan = planPages(
      [block(0, 10, 0), sectionBreak(1, 1), sectionBreak(2, 2), block(3, 10, 2)],
      [metrics(100), metrics(100), metrics(100)],
    );
    expect(plan.pages.map((p) => p.sectionIndex)).toEqual([0, 1, 2]);
    expect(plan.pageCount).toBe(3);
  });
});

describe("Pagination par section — compatibilité", () => {
  it("accepte encore une géométrie unique (documents sans section)", () => {
    const plan = planPages([block(0, 60), block(1, 60), block(2, 60)], {
      pageContentPx: 100,
      gapPx: 40,
      marginLeftPx: 0,
      marginRightPx: 0,
    });
    expect(plan.pageCount).toBe(3);
    expect(plan.pages).toHaveLength(3);
  });

  it("retombe sur la première section pour un index inconnu", () => {
    const plan = planPages([block(0, 10, 9)], [metrics(100)]);
    expect(plan.pageCount).toBe(1);
  });

  it("reste neutre sur une géométrie nulle", () => {
    const plan = planPages([block(0, 10)], [metrics(0)]);
    expect(plan.pageCount).toBe(1);
    expect(plan.pages).toEqual([]);
  });

  it("répartit un bloc plus haut qu'une page sur les pages suivantes", () => {
    const plan = planPages([block(0, 250, 0)], [metrics(100)]);
    expect(plan.pageCount).toBe(3);
    expect(plan.pages.map((p) => p.number)).toEqual([1, 2, 3]);
  });
});
