import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import {
  addSectionAt,
  cloneSlide,
  firstPlayableFrom,
  moveSection,
  nextPlayable,
  normalizeSections,
  playableIndices,
  removeSection,
  removeSlideKeepingSections,
  reorderSlide,
  sectionRanges,
} from "../src/slides/sections";
import { slideToY, yToSlide } from "../src/drive-cloud/collab-slides-crdt";
import type { Slide, SlideSection } from "../src/slides/model";

const mk = (id: string, extra: Partial<Slide> = {}): Slide => ({ id, title: id, body: "", layout: "blank", elements: [], ...extra });
const ids = (s: Slide[]) => s.map((x) => x.id).join(",");
const deck = () => ["a", "b", "c", "d", "e", "f"].map((i) => mk(i));
const secs = (): SlideSection[] => [
  { id: "s1", name: "Intro", startSlideId: "a" },
  { id: "s2", name: "Corps", startSlideId: "c" },
  { id: "s3", name: "Fin", startSlideId: "e" },
];

describe("sections", () => {
  it("découpe en plages, avec une zone sans section au début", () => {
    const r = sectionRanges(deck(), [{ id: "s2", name: "Corps", startSlideId: "c" }]);
    expect(r.map((x) => [x.section?.name ?? null, x.from, x.to])).toEqual([
      [null, 0, 1],
      ["Corps", 2, 5],
    ]);
    expect(sectionRanges(deck(), secs()).map((x) => [x.from, x.to])).toEqual([[0, 1], [2, 3], [4, 5]]);
  });
  it("ajoute, remplace et supprime une section", () => {
    let s = addSectionAt(deck(), [], 3, "  Annexes ");
    expect(s).toHaveLength(1);
    expect(s[0]!.startSlideId).toBe("d");
    expect(s[0]!.name).toBe("Annexes");
    s = addSectionAt(deck(), s, 3, "Autre nom");
    expect(s).toHaveLength(1);
    expect(s[0]!.name).toBe("Autre nom");
    expect(removeSection(s, s[0]!.id)).toEqual([]);
  });
  it("normalise : retire les ancres orphelines", () => {
    expect(normalizeSections(deck().slice(2), secs()).map((x) => x.id)).toEqual(["s2", "s3"]);
  });
});

describe("réordonnancement", () => {
  it("déplace une diapositive ordinaire", () => {
    const r = reorderSlide(deck(), secs(), 1, 4);
    expect(ids(r.slides)).toBe("a,c,d,e,b,f");
    expect(r.sections).toHaveLength(3);
  });
  it("une diapositive qui ouvre une section la quitte : l'ancre passe à la suivante", () => {
    const r = reorderSlide(deck(), secs(), 2, 5);
    expect(ids(r.slides)).toBe("a,b,d,e,f,c");
    expect(r.sections.find((x) => x.id === "s2")!.startSlideId).toBe("d");
  });
  it("une section réduite à une seule diapositive la suit", () => {
    const only: SlideSection[] = [{ id: "s", name: "Seule", startSlideId: "b" }, { id: "t", name: "Suite", startSlideId: "c" }];
    const r = reorderSlide(deck(), only, 1, 4);
    expect(r.sections.find((x) => x.id === "s")!.startSlideId).toBe("b");
    expect(ids(r.slides)).toBe("a,c,d,e,b,f");
  });
  it("déplacement hors limites : inchangé", () => {
    const d = deck();
    expect(reorderSlide(d, secs(), 1, 99).slides).toBe(d);
    expect(reorderSlide(d, secs(), 2, 2).slides).toBe(d);
  });
  it("déplace une section entière avant une autre / à la fin", () => {
    expect(ids(moveSection(deck(), secs(), "s3", "s1"))).toBe("e,f,a,b,c,d");
    expect(ids(moveSection(deck(), secs(), "s1", null))).toBe("c,d,e,f,a,b");
    expect(ids(moveSection(deck(), secs(), "s2", "s2"))).toBe("a,b,c,d,e,f");
  });
  it("suppression : l'ancre passe à la suivante, la dernière diapositive d'une section la supprime", () => {
    let r = removeSlideKeepingSections(deck(), secs(), 2);
    expect(r.sections.find((x) => x.id === "s2")!.startSlideId).toBe("d");
    r = removeSlideKeepingSections(deck(), [{ id: "x", name: "x", startSlideId: "f" }], 5);
    expect(r.sections).toEqual([]);
    expect(removeSlideKeepingSections([mk("z")], [], 0).slides).toHaveLength(1);
  });
});

describe("diapositives masquées et duplication", () => {
  const s = [mk("a"), mk("b", { hidden: true }), mk("c", { hidden: true }), mk("d")];
  it("ignore les masquées en diaporama", () => {
    expect(playableIndices(s)).toEqual([0, 3]);
    expect(nextPlayable(s, 0, 1)).toBe(3);
    expect(nextPlayable(s, 3, -1)).toBe(0);
    expect(nextPlayable(s, 3, 1)).toBeNull();
    expect(firstPlayableFrom(s, 1)).toBe(3);
    expect(firstPlayableFrom([mk("x", { hidden: true })], 0)).toBeNull();
  });
  it("duplique avec de nouveaux identifiants et conserve l'état masqué", () => {
    const c = cloneSlide(mk("a", { hidden: true, elements: [{ id: "e1", type: "text", x: 0, y: 0, w: 1, h: 1 }] }));
    expect(c.id).not.toBe("a");
    expect(c.hidden).toBe(true);
    expect(c.elements![0]!.id).not.toBe("e1");
    expect(c.elements![0]!.morphKey).toBe("e1");
  });
});

describe("CRDT : champs de la trieuse", () => {
  it("hidden, layoutId et espaces réservés survivent à l'aller-retour Yjs", () => {
    const slide = mk("a", {
      hidden: true,
      layoutId: "lay-1",
      elements: [
        { id: "e1", type: "text", x: 1, y: 2, w: 3, h: 4, ph: "title", html: "<p>T</p>" },
        {
          id: "e2",
          type: "media",
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          media: { kind: "video", src: "data:video/mp4;base64,AAAA", mime: "video/mp4", trimStart: 1.5, trimEnd: 9, autoplay: true },
        },
        { id: "e3", type: "diagram", x: 0, y: 0, w: 10, h: 10, diagram: { kind: "cycle", outline: "A\nB\nC" } },
        {
          id: "e4",
          type: "table",
          x: 0,
          y: 0,
          w: 10,
          h: 10,
          table: { rows: 2, cols: 2, cells: [["a", "b"], ["c", ""]], merges: [{ r: 0, c: 0, rs: 1, cs: 2 }], style: "grid", firstCol: true },
        },
      ],
    });
    const doc = new Y.Doc();
    const m = slideToY(slide);
    doc.getMap("deck").set("slide", m);
    const back = yToSlide(m);
    expect(back.hidden).toBe(true);
    expect(back.layoutId).toBe("lay-1");
    expect(back.elements).toEqual(slide.elements);
  });
  it("une diapositive non masquée n'écrit pas la clé", () => {
    expect(slideToY(mk("a")).has("hidden")).toBe(false);
  });
});
