import { describe, it, expect } from "vitest";
import { hasSections, normalizeKind, sectionStartPages, splitSections, startsNewPage } from "../src/editor/sections";
import type { PageSettings, ProseMirrorNode } from "../src/format/types";

const PAGE: PageSettings = {
  format: "A4",
  orientation: "portrait",
  margins: { top: 25, right: 20, bottom: 25, left: 20 },
  header: "En-tête doc",
  footer: "Pied doc",
};

const p = (text: string): ProseMirrorNode => ({ type: "paragraph", content: [{ type: "text", text }] });
const brk = (attrs: Record<string, unknown>): ProseMirrorNode => ({ type: "sectionBreak", attrs });
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

describe("Sections — normalisation", () => {
  it("accepte les quatre types et retombe sur nextPage", () => {
    expect(normalizeKind("continuous")).toBe("continuous");
    expect(normalizeKind("evenPage")).toBe("evenPage");
    expect(normalizeKind("oddPage")).toBe("oddPage");
    expect(normalizeKind("n'importe quoi")).toBe("nextPage");
    expect(normalizeKind(undefined)).toBe("nextPage");
  });

  it("sait quel type ouvre une nouvelle page", () => {
    expect(startsNewPage("continuous")).toBe(false);
    expect(startsNewPage("nextPage")).toBe(true);
    expect(startsNewPage("evenPage")).toBe(true);
  });

  it("détecte la présence de sections", () => {
    expect(hasSections(doc(p("a")))).toBe(false);
    expect(hasSections(doc(p("a"), brk({ kind: "continuous" })))).toBe(true);
  });
});

describe("Sections — découpage", () => {
  it("rend une seule section héritant du document quand il n'y a aucun saut", () => {
    const sections = splitSections(doc(p("a"), p("b")), PAGE);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toMatchObject({ firstBlock: 0, endBlock: 2 });
    expect(sections[0]!.setup).toMatchObject({ orientation: "portrait", header: "En-tête doc", footer: "Pied doc" });
  });

  it("découpe à chaque saut, en excluant le marqueur des deux plages", () => {
    const sections = splitSections(doc(p("a"), brk({ kind: "nextPage" }), p("b"), brk({ kind: "continuous" }), p("c")), PAGE);
    expect(sections.map((s) => [s.firstBlock, s.endBlock])).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
    ]);
  });

  it("applique les surcharges du saut à la section qu'il ouvre", () => {
    const sections = splitSections(
      doc(p("a"), brk({ kind: "nextPage", orientation: "landscape", header: "Annexe", restartNumbering: true, startAt: 1 }), p("b")),
      PAGE,
    );
    expect(sections[0]!.setup.orientation).toBe("portrait");
    expect(sections[1]!.setup).toMatchObject({
      kind: "nextPage",
      orientation: "landscape",
      header: "Annexe",
      restartNumbering: true,
    });
  });

  it("hérite du document pour chaque champ laissé vide", () => {
    const sections = splitSections(doc(p("a"), brk({ kind: "continuous", orientation: "", header: "", footer: "" }), p("b")), PAGE);
    expect(sections[1]!.setup).toMatchObject({ orientation: "portrait", header: "En-tête doc", footer: "Pied doc" });
  });

  it("borne startAt à 1 minimum", () => {
    const sections = splitSections(doc(brk({ kind: "nextPage", startAt: -5 }), p("b")), PAGE);
    expect(sections[1]!.setup.startAt).toBe(1);
  });

  it("gère un saut en toute fin de document (dernière section vide)", () => {
    const sections = splitSections(doc(p("a"), brk({ kind: "nextPage" })), PAGE);
    expect(sections).toHaveLength(2);
    expect(sections[1]).toMatchObject({ firstBlock: 2, endBlock: 2 });
  });
});

describe("Sections — numéros de page de début", () => {
  it("enchaîne les sections sur la pagination continue", () => {
    const sections = splitSections(doc(p("a"), brk({ kind: "continuous" }), p("b"), brk({ kind: "nextPage" }), p("c")), PAGE);
    expect(sectionStartPages(sections, [3, 2, 4])).toEqual([1, 4, 6]);
  });

  it("repart au numéro demandé quand la section redémarre la numérotation", () => {
    const sections = splitSections(doc(p("a"), brk({ kind: "nextPage", restartNumbering: true, startAt: 1 }), p("b")), PAGE);
    expect(sectionStartPages(sections, [5, 3])).toEqual([1, 1]);
  });

  it("saute une page pour tomber sur une page paire", () => {
    const sections = splitSections(doc(p("a"), brk({ kind: "evenPage" }), p("b")), PAGE);
    // La première section occupe 2 pages → la suivante commencerait en 3 (impaire) → 4.
    expect(sectionStartPages(sections, [2, 1])).toEqual([1, 4]);
    // Si elle occupe 3 pages, la suivante commence en 4, déjà paire.
    expect(sectionStartPages(sections, [3, 1])).toEqual([1, 4]);
  });

  it("saute une page pour tomber sur une page impaire", () => {
    const sections = splitSections(doc(p("a"), brk({ kind: "oddPage" }), p("b")), PAGE);
    expect(sectionStartPages(sections, [3, 1])).toEqual([1, 5]);
    expect(sectionStartPages(sections, [2, 1])).toEqual([1, 3]);
  });

  it("laisse la parité de côté quand la numérotation redémarre", () => {
    const sections = splitSections(doc(p("a"), brk({ kind: "evenPage", restartNumbering: true, startAt: 7 }), p("b")), PAGE);
    expect(sectionStartPages(sections, [2, 1])).toEqual([1, 7]);
  });

  it("tolère un tableau de pages incomplet", () => {
    const sections = splitSections(doc(p("a"), brk({ kind: "continuous" }), p("b")), PAGE);
    expect(sectionStartPages(sections, [])).toEqual([1, 1]);
  });
});
