// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { handoutsHtml } from "../src/slides/handouts";
import { DEFAULT_HANDOUT } from "../src/slides/handouts-layout";
import type { Deck, Slide } from "../src/slides/model";

const slide = (i: number, extra: Partial<Slide> = {}): Slide => ({
  id: `s${i}`,
  title: "",
  body: "",
  layout: "blank",
  elements: [{ id: `e${i}`, type: "text", x: 10, y: 10, w: 60, h: 20, html: `<p>Titre ${i}</p>` }],
  ...extra,
});
const deck = (): Deck => ({ active: 0, slides: [slide(1, { notes: "Dire bonjour" }), slide(2, { hidden: true }), slide(3), slide(4), slide(5)] });

describe("documents et pages de notes — HTML des pages", () => {
  it("4 par page : diapositives masquées exclues, miniatures mises à l'échelle, numéros, pied de page développé", async () => {
    const r = await handoutsHtml(deck(), "Bilan", { ...DEFAULT_HANDOUT, mode: 4, footer: "{titre} — {page}/{pages}" });
    expect(r.pages).toHaveLength(1);
    expect(r.pages[0]).toContain("Titre 1");
    expect(r.pages[0]).not.toContain("Titre 2");
    expect(r.pages[0]).toContain("Titre 5");
    expect(r.pages[0]).toContain("transform:scale(");
    expect(r.pages[0]).toContain("Bilan — 1/1");
    expect(r.pages[0]).toContain('class="ho-num"');
    expect(r.width).toBe(794);
  });
  it("incluant les masquées : 2 pages ; paysage", async () => {
    const r = await handoutsHtml(deck(), "B", { ...DEFAULT_HANDOUT, mode: 4, includeHidden: true });
    expect(r.pages).toHaveLength(2);
    const ls = await handoutsHtml(deck(), "B", { ...DEFAULT_HANDOUT, mode: 6, orientation: "landscape" });
    expect([ls.width, ls.height]).toEqual([1123, 794]);
  });
  it("pages de notes : texte des notes dessous ; sans notes : mention", async () => {
    const r = await handoutsHtml(deck(), "B", { ...DEFAULT_HANDOUT, mode: "notes" });
    expect(r.pages).toHaveLength(4);
    expect(r.pages[0]).toContain("Dire bonjour");
    expect(r.pages[1]).toContain("Aucune note.");
  });
  it("3 par page : lignes à remplir à droite", async () => {
    const r = await handoutsHtml(deck(), "B", { ...DEFAULT_HANDOUT, mode: 3 });
    expect(r.pages[0]!.match(/border-bottom:1px solid #94a3b8/g)!.length).toBe(15);
  });
  it("aucune diapositive retenue : zéro page", async () => {
    const d: Deck = { active: 0, slides: [slide(1, { hidden: true })] };
    expect((await handoutsHtml(d, "B", DEFAULT_HANDOUT)).pages).toEqual([]);
  });
});
