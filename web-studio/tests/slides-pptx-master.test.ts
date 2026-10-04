import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { deckToPptx } from "../src/slides/pptx";
import { importPptx } from "../src/slides/pptx-import";
import { applyLayout, defaultMaster, SLIDE_NUMBER_TOKEN } from "../src/slides/master";
import type { Deck, Slide } from "../src/slides/model";

const blank = (id: string, extra: Partial<Slide> = {}): Slide => ({ id, title: "", body: "", layout: "blank", elements: [], ...extra });

function deck(): Deck {
  const m = { ...defaultMaster(), name: "Charte Acme", fontHeading: "Georgia", fontBody: "Verdana", colorAccent: "#cc3300", footerText: "Acme — interne" };
  let s1 = applyLayout(blank("a"), m, "lay-titre");
  s1 = { ...s1, notes: "Penser à saluer.\nPuis présenter l'ordre du jour.", elements: s1.elements!.map((e) => (e.ph === "title" ? { ...e, html: "<p>Bilan</p>" } : e)) };
  let s2 = applyLayout(blank("b"), m, "lay-deux");
  s2 = { ...s2, hidden: true, elements: s2.elements!.map((e, i) => (e.ph === "body" ? { ...e, html: `<ul><li>Point ${i}<ul><li>Sous-point</li></ul></li></ul>` } : e)) };
  return { slides: [s1, s2, blank("c")], active: 0, master: m };
}

describe("PPTX — masque, dispositions, notes, diapositives masquées", () => {
  const bytes = deckToPptx(deck());
  const zip = unzipSync(bytes);
  const txt = (p: string) => strFromU8(zip[p]!);

  it("écrit un vrai masque avec une disposition par modèle et le thème (polices, accent)", () => {
    const layoutFiles = Object.keys(zip).filter((k) => /^ppt\/slideLayouts\/slideLayout\d+\.xml$/.test(k));
    expect(layoutFiles).toHaveLength(6);
    expect(txt("ppt/slideLayouts/slideLayout1.xml")).toContain('name="Diapositive de titre"');
    expect(txt("ppt/slideLayouts/slideLayout4.xml")).toContain('type="twoObj"');
    expect(txt("ppt/theme/theme1.xml")).toContain('<a:latin typeface="Georgia"/>');
    expect(txt("ppt/theme/theme1.xml")).toContain('<a:srgbClr val="CC3300"/>');
    expect(txt("ppt/slideMasters/slideMaster1.xml")).toContain("<p:titleStyle>");
    expect(txt("ppt/slideMasters/_rels/slideMaster1.xml.rels")).toContain("slideLayout6.xml");
  });
  it("les diapositives pointent vers leur disposition et portent de vrais espaces réservés", () => {
    expect(txt("ppt/slides/_rels/slide1.xml.rels")).toContain("slideLayout1.xml");
    expect(txt("ppt/slides/_rels/slide2.xml.rels")).toContain("slideLayout4.xml");
    expect(txt("ppt/slides/_rels/slide3.xml.rels")).toContain("slideLayout6.xml"); // sans disposition : vierge
    const s1 = txt("ppt/slides/slide1.xml");
    expect(s1).toContain('<p:ph type="title"/>');
    expect(s1).toContain('<p:ph type="ftr" sz="quarter" idx="11"/>');
    expect(s1).toContain('type="slidenum"');
    expect(txt("ppt/slides/slide2.xml")).toMatch(/<p:ph idx="1"\/>[\s\S]*<p:ph idx="2"\/>/);
  });
  it("notes (notesSlide + notesMaster) et attribut show=\"0\"", () => {
    expect(txt("ppt/notesSlides/notesSlide1.xml")).toContain("Penser à saluer.");
    expect(txt("ppt/slides/_rels/slide1.xml.rels")).toContain("notesSlide1.xml");
    expect(txt("[Content_Types].xml")).toContain("notesMaster1.xml");
    expect(txt("ppt/presentation.xml")).toContain("<p:notesMasterIdLst>");
    expect(txt("ppt/slides/slide2.xml")).toContain('show="0"');
    expect(txt("ppt/slides/slide1.xml")).not.toContain('show="0"');
  });
  it("niveaux de liste exportés (lvl) et police d'élément écrite", () => {
    const s2 = txt("ppt/slides/slide2.xml");
    expect(s2).toContain('lvl="1"');
    expect(s2).toContain('<a:latin typeface="Verdana"/>');
  });
  it("aller-retour : masque, dispositions, polices, couleurs, liens, notes, masquage, espaces réservés", () => {
    const back = importPptx(bytes);
    expect(back.master).toBeTruthy();
    expect(back.master!.layouts.map((l) => l.name)).toEqual(defaultMaster().layouts.map((l) => l.name));
    expect(back.master!.fontHeading).toBe("Georgia");
    expect(back.master!.fontBody).toBe("Verdana");
    expect(back.master!.colorAccent).toBe("#cc3300");
    const [s1, s2, s3] = back.slides;
    expect(s1!.layoutId).toBe(back.master!.layouts[0]!.id);
    expect(s2!.layoutId).toBe(back.master!.layouts[3]!.id);
    expect(s3!.layoutId).toBe(back.master!.layouts[5]!.id);
    expect(s1!.notes).toBe("Penser à saluer.\nPuis présenter l'ordre du jour.");
    expect(s2!.hidden).toBe(true);
    expect(s1!.hidden).toBeFalsy();
    expect(s1!.title).toBe("Bilan");
    const kinds = s1!.elements!.map((e) => e.ph).filter(Boolean);
    expect(kinds).toEqual(expect.arrayContaining(["title", "footer", "slideNumber"]));
    expect(s1!.elements!.find((e) => e.ph === "slideNumber")!.html).toContain(SLIDE_NUMBER_TOKEN);
    const title = s1!.elements!.find((e) => e.ph === "title")!;
    expect(title.align).toBe("center");
    // géométrie des espaces réservés de la disposition « deux contenus »
    const bodies = s2!.elements!.filter((e) => e.ph === "body");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.x).toBeGreaterThan(bodies[0]!.x + 30);
    // liste imbriquée relue
    expect(bodies[0]!.html).toContain("<ul>");
    expect(bodies[0]!.html).toMatch(/<ul>[\s\S]*<ul>/);
  });
  it("deck sans masque : export avec le masque par défaut, import → dispositions réelles", () => {
    const d: Deck = { slides: [blank("x", { elements: [{ id: "e", type: "text", x: 10, y: 10, w: 50, h: 10, html: "<p>Salut</p>" }] })], active: 0 };
    const back = importPptx(deckToPptx(d));
    expect(back.master!.layouts).toHaveLength(6);
    expect(back.slides[0]!.elements!.some((e) => (e.html ?? "").includes("Salut"))).toBe(true);
  });
});
