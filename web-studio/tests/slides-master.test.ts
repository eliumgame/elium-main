import { describe, it, expect } from "vitest";
import {
  PLACEHOLDER_PROMPT,
  addLayout,
  addPlaceholder,
  applyLayout,
  applyMasterToDeck,
  defaultMaster,
  layoutIdForPptxType,
  removeLayout,
  removePlaceholder,
  renameLayout,
  resetSlide,
  updatePlaceholder,
  withSlideNumber,
} from "../src/slides/master";
import type { Deck, Slide } from "../src/slides/model";

const slide = (els: Slide["elements"] = []): Slide => ({
  id: "s",
  title: "",
  body: "",
  layout: "blank",
  elements: els,
});
const txt = (id: string, html: string, extra = {}) => ({
  id,
  type: "text" as const,
  x: 1,
  y: 1,
  w: 10,
  h: 10,
  html,
  ...extra,
});

describe("masque par défaut", () => {
  it("six dispositions avec pied de page et numéro", () => {
    const m = defaultMaster();
    expect(m.layouts.map((l) => l.name)).toEqual([
      "Diapositive de titre",
      "Titre et contenu",
      "En-tête de section",
      "Deux contenus",
      "Titre seul",
      "Vierge",
    ]);
    expect(m.layouts.every((l) => l.placeholders.some((p) => p.kind === "slideNumber"))).toBe(true);
  });
});

describe("appliquer une disposition", () => {
  const m = defaultMaster();
  it("crée les espaces réservés (titre, corps, numéro ; pied seulement si le masque en a un)", () => {
    const s = applyLayout(slide(), m, "lay-contenu");
    expect(s.layoutId).toBe("lay-contenu");
    expect(s.elements!.map((e) => e.ph)).toEqual(["title", "body", "slideNumber"]);
    const t = s.elements!.find((e) => e.ph === "title")!;
    expect(t.fontFamily).toBe("Calibri Light");
    expect(t.html).toContain(PLACEHOLDER_PROMPT.title);
    expect(
      applyLayout(slide(), { ...m, footerText: "Confidentiel" }, "lay-contenu").elements!.some(
        (e) => e.ph === "footer" && e.html!.includes("Confidentiel"),
      ),
    ).toBe(true);
  });
  it("conserve le contenu saisi en changeant de disposition, déplace/restyle l'espace réservé", () => {
    const a = applyLayout(slide(), m, "lay-contenu");
    const filled: Slide = {
      ...a,
      elements: a.elements!.map((e) => (e.ph === "title" ? { ...e, html: "<p>Mon titre</p>" } : e)),
    };
    const b = applyLayout(filled, m, "lay-titre");
    const t = b.elements!.find((e) => e.ph === "title")!;
    expect(t.html).toBe("<p>Mon titre</p>");
    expect(t.align).toBe("center");
    expect(t.fontSize).toBe(54);
    expect(t.y).toBe(30);
  });
  it("espaces réservés en trop : vides retirés, remplis conservés comme éléments ordinaires ; éléments libres intacts", () => {
    const a = applyLayout(slide([txt("free", "<p>libre</p>")]), m, "lay-deux");
    const withBody2 = {
      ...a,
      elements: a.elements!.map((e) => (e.ph === "body" ? { ...e, html: "<p>rempli</p>" } : e)),
    };
    const c = applyLayout(withBody2, m, "lay-vierge");
    expect(c.elements!.some((e) => e.ph === "body")).toBe(false);
    expect(c.elements!.some((e) => e.html === "<p>rempli</p>" && !e.ph)).toBe(true);
    expect(c.elements!.some((e) => e.id === "free")).toBe(true);
    expect(c.elements!.filter((e) => e.html?.includes(PLACEHOLDER_PROMPT.title))).toHaveLength(0);
  });
  it("disposition inconnue : diapositive inchangée", () => {
    const s = slide();
    expect(applyLayout(s, m, "nope")).toBe(s);
  });
});

describe("réinitialiser et propager", () => {
  const m = defaultMaster();
  it("« Réinitialiser » remet géométrie et style, garde le texte", () => {
    const a = applyLayout(slide(), m, "lay-contenu");
    const moved: Slide = {
      ...a,
      elements: a.elements!.map((e) => (e.ph === "title" ? { ...e, x: 50, y: 50, fontSize: 12, html: "<p>X</p>" } : e)),
    };
    const r = resetSlide(moved, m);
    const t = r.elements!.find((e) => e.ph === "title")!;
    expect([t.x, t.y, t.fontSize, t.html]).toEqual([7, 6, 40, "<p>X</p>"]);
    expect(resetSlide(slide(), m).elements).toEqual([]); // sans disposition : rien
  });
  it("modifier le masque se répercute sur les diapositives liées seulement", () => {
    const linked = applyLayout(slide(), m, "lay-contenu");
    const free = slide([txt("e", "<p>x</p>", { fontSize: 99 })]);
    const deck: Deck = { slides: [linked, free], active: 0 };
    let m2 = { ...m, fontHeading: "Georgia", footerText: "Pied" };
    m2 = updatePlaceholder(m2, "lay-contenu", "t", { fontSize: 50, x: 500 });
    const out = applyMasterToDeck(deck, m2);
    const t = out.slides[0]!.elements!.find((e) => e.ph === "title")!;
    expect([t.fontFamily, t.fontSize, t.x]).toEqual(["Georgia", 50, 100 - 86]); // x borné au cadre
    expect(out.slides[0]!.elements!.some((e) => e.ph === "footer")).toBe(true);
    expect(out.slides[1]).toBe(free);
    expect(out.master).toBe(m2);
  });
  it("numéro de diapositive désactivé : l'élément disparaît", () => {
    const a = applyLayout(slide(), m, "lay-vierge");
    expect(a.elements!.some((e) => e.ph === "slideNumber")).toBe(true);
    const off = resetSlide(a, { ...m, showSlideNumber: false });
    expect(off.elements!.some((e) => e.ph === "slideNumber")).toBe(false);
  });
});

describe("édition du masque", () => {
  it("ajout/retrait d'espaces réservés, de dispositions, renommage", () => {
    let m = defaultMaster();
    m = addPlaceholder(m, "lay-vierge", "body");
    expect(m.layouts.find((l) => l.id === "lay-vierge")!.placeholders.map((p) => p.id)).toContain("body1");
    m = removePlaceholder(m, "lay-vierge", "body1");
    expect(m.layouts.find((l) => l.id === "lay-vierge")!.placeholders.map((p) => p.id)).not.toContain("body1");
    m = addLayout(m, "  Mon modèle ");
    expect(m.layouts.at(-1)!.name).toBe("Mon modèle");
    m = renameLayout(m, m.layouts.at(-1)!.id, "Perso");
    expect(m.layouts.at(-1)!.name).toBe("Perso");
    expect(removeLayout(m, m.layouts.at(-1)!.id).layouts).toHaveLength(6);
    const single = { ...m, layouts: [m.layouts[0]!] };
    expect(removeLayout(single, single.layouts[0]!.id).layouts).toHaveLength(1);
  });
  it("correspondance avec les types PPTX et numéro de page", () => {
    const m = defaultMaster();
    expect(layoutIdForPptxType(m, "twoObj", "autre")).toBe("lay-deux");
    expect(layoutIdForPptxType(m, "x", "vierge")).toBe("lay-vierge");
    expect(layoutIdForPptxType(m, "inconnu", "?")).toBeUndefined();
    expect(withSlideNumber("<p>‹#›/12</p>", 3)).toBe("<p>3/12</p>");
    expect(withSlideNumber("<p>‹#›</p>", undefined)).toBe("<p>‹#›</p>");
  });
});
