import { describe, it, expect } from "vitest";
import {
  DEFAULT_TAB_MM, MAX_TAB_STOPS, TAB_ALIGN_LABELS, addStop, barStops, mmToTwips, moveStop,
  nearestStop, nextStop, normalizeStop, normalizeStops, parseTabsXml, removeStopNear, rulerLabels,
  rulerTicks, tabsXml, twipsToMm, type TabStop,
} from "../src/editor/tabs";
import { strFromU8, unzipSync } from "fflate";
import { docToDocx, docxToDoc } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import type { ProseMirrorNode } from "../src/format/types";

const stop = (pos: number, align: TabStop["align"] = "left", leader: TabStop["leader"] = "none"): TabStop =>
  ({ pos, align, leader });

describe("Taquets — normalisation", () => {
  it("trie par position et dédoublonne", () => {
    const out = normalizeStops([stop(50), stop(10), stop(30), stop(10, "right")]);
    expect(out.map((s) => s.pos)).toEqual([10, 30, 50]);
    // Le dernier posé gagne, comme dans Word.
    expect(out[0]!.align).toBe("right");
  });

  it("écarte les positions absurdes", () => {
    expect(normalizeStop({ pos: -5 })).toBeNull();
    expect(normalizeStop({ pos: NaN })).toBeNull();
    expect(normalizeStop({ pos: Infinity })).toBeNull();
    expect(normalizeStop(null)).toBeNull();
    expect(normalizeStops([{ pos: -1 }, { pos: 10 }]).map((s) => s.pos)).toEqual([10]);
  });

  it("retombe sur des valeurs sûres", () => {
    const s = normalizeStop({ pos: 10, align: "bogus", leader: "bogus" })!;
    expect(s.align).toBe("left");
    expect(s.leader).toBe("none");
  });

  it("quantifie au dixième de millimètre, pour survivre à l'aller-retour twips", () => {
    expect(normalizeStop({ pos: 10.12345 })!.pos).toBe(10.1);
    expect(normalizeStop({ pos: 10.16 })!.pos).toBe(10.2);
  });

  it("borne le nombre de taquets", () => {
    const many = Array.from({ length: MAX_TAB_STOPS + 20 }, (_, i) => stop(i + 1));
    expect(normalizeStops(many)).toHaveLength(MAX_TAB_STOPS);
  });

  it("ignore une entrée qui n'est pas une liste", () => {
    expect(normalizeStops("nope")).toEqual([]);
    expect(normalizeStops(undefined)).toEqual([]);
  });
});

describe("Taquets — édition", () => {
  it("ajoute en gardant l'ordre", () => {
    expect(addStop([stop(30)], stop(10)).map((s) => s.pos)).toEqual([10, 30]);
  });

  it("retire le taquet le plus proche dans la tolérance", () => {
    const stops = [stop(10), stop(30)];
    expect(removeStopNear(stops, 10.5).map((s) => s.pos)).toEqual([30]);
    // Hors tolérance : rien ne bouge.
    expect(removeStopNear(stops, 20).map((s) => s.pos)).toEqual([10, 30]);
  });

  it("déplace un taquet en conservant son type", () => {
    const out = moveStop([stop(10, "decimal", "dot")], 10, 40);
    expect(out).toEqual([{ pos: 40, align: "decimal", leader: "dot" }]);
  });

  it("ne déplace rien si la position de départ n'existe pas", () => {
    const stops = [stop(10)];
    expect(moveStop(stops, 99, 40)).toBe(stops);
  });

  it("un déplacement négatif se clampe à zéro", () => {
    expect(moveStop([stop(10)], 10, -30)[0]!.pos).toBe(0);
  });

  it("trouve le taquet le plus proche", () => {
    expect(nearestStop([stop(10), stop(30)], 29.5)?.pos).toBe(30);
    expect(nearestStop([stop(10)], 50)).toBeNull();
  });
});

describe("Taquets — tabulation suivante", () => {
  it("privilégie un taquet explicite", () => {
    expect(nextStop(0, [stop(40)])!.pos).toBe(40);
    expect(nextStop(45, [stop(40), stop(80)])!.pos).toBe(80);
  });

  it("retombe sur la grille par défaut au-delà du dernier taquet", () => {
    const s = nextStop(45, [stop(40)])!;
    expect(s.pos).toBe(50); // 4 × 12,5
    expect(s.align).toBe("left");
  });

  it("utilise la grille par défaut sans aucun taquet", () => {
    expect(nextStop(0, [])!.pos).toBe(DEFAULT_TAB_MM);
    expect(nextStop(12.5, [])!.pos).toBe(25);
    expect(nextStop(13, [])!.pos).toBe(25);
  });

  it("ignore un taquet « barre » — c'est un filet, pas une destination", () => {
    // Sans cela une barre décorative avalerait la tabulation.
    expect(nextStop(0, [stop(20, "bar"), stop(40)])!.pos).toBe(40);
    expect(barStops([stop(20, "bar"), stop(40)]).map((s) => s.pos)).toEqual([20]);
  });

  it("ne dépasse pas la largeur utile", () => {
    expect(nextStop(160, [], DEFAULT_TAB_MM, 162)).toBeNull();
    expect(nextStop(100, [], DEFAULT_TAB_MM, 165)!.pos).toBe(112.5);
  });

  it("tolère un intervalle par défaut absurde", () => {
    expect(nextStop(0, [], 0)!.pos).toBe(DEFAULT_TAB_MM);
    expect(nextStop(0, [], -5)!.pos).toBe(DEFAULT_TAB_MM);
  });
});

describe("Règle — graduations", () => {
  it("place une graduation majeure par centimètre", () => {
    const ticks = rulerTicks(50);
    expect(ticks[0]).toEqual({ pos: 0, major: true });
    expect(ticks.filter((t) => t.major).map((t) => t.pos)).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it("ne perd pas de graduation majeure à cause du flottant", () => {
    // 30 % 10 en flottant peut valoir 9,999… : le modulo se fait en dixièmes.
    const majors = rulerTicks(100).filter((t) => t.major).map((t) => t.pos);
    expect(majors).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  });

  it("étiquette les centimètres, sans le zéro", () => {
    expect(rulerLabels(30)).toEqual([
      { pos: 10, label: "1" }, { pos: 20, label: "2" }, { pos: 30, label: "3" },
    ]);
  });

  it("rend une règle vide pour une largeur absurde", () => {
    expect(rulerTicks(0)).toEqual([]);
    expect(rulerTicks(-10)).toEqual([]);
    expect(rulerTicks(NaN)).toEqual([]);
  });

  it("expose les libellés d'alignement en français", () => {
    expect(TAB_ALIGN_LABELS.decimal).toBe("Décimal");
  });
});

describe("Taquets — OOXML", () => {
  it("convertit millimètres et twips dans les deux sens", () => {
    expect(mmToTwips(25.4)).toBe(1440);
    expect(twipsToMm(1440)).toBe(25.4);
    expect(twipsToMm(mmToTwips(12.5))).toBeCloseTo(12.5, 1);
  });

  it("écrit un w:tabs trié", () => {
    const xml = tabsXml([stop(40, "right", "dot"), stop(10)]);
    expect(xml).toBe(
      '<w:tabs><w:tab w:val="left" w:pos="567"/><w:tab w:val="right" w:pos="2268" w:leader="dot"/></w:tabs>',
    );
  });

  it("n'écrit rien sans taquet", () => {
    expect(tabsXml([])).toBe("");
  });

  it("relit un w:tabs", () => {
    const stops = parseTabsXml(
      '<w:tabs><w:tab w:val="center" w:pos="2268"/><w:tab w:val="decimal" w:pos="4536" w:leader="hyphen"/></w:tabs>',
    );
    expect(stops).toEqual([
      { pos: 40, align: "center", leader: "none" },
      { pos: 80, align: "decimal", leader: "hyphen" },
    ]);
  });

  it("ignore w:val=\"clear\", qui n'annule qu'un taquet hérité", () => {
    const stops = parseTabsXml('<w:tabs><w:tab w:val="clear" w:pos="567"/><w:tab w:val="left" w:pos="2268"/></w:tabs>');
    expect(stops.map((s) => s.pos)).toEqual([40]);
  });

  it("survit à un fragment vide ou malformé", () => {
    expect(parseTabsXml("")).toEqual([]);
    expect(parseTabsXml("<w:tabs></w:tabs>")).toEqual([]);
    expect(parseTabsXml("<w:tab w:val=\"left\"/>")).toEqual([]); // sans w:pos
  });

  it("fait l'aller-retour", () => {
    const stops = normalizeStops([stop(12.5), stop(40, "right", "dot"), stop(80, "bar")]);
    expect(parseTabsXml(tabsXml(stops))).toEqual(stops);
  });
});

describe("Taquets — aller-retour DOCX", () => {
  const para = (content: ProseMirrorNode[], stops?: TabStop[]): ProseMirrorNode => ({
    type: "paragraph",
    ...(stops ? { attrs: { tabStops: stops } } : {}),
    content,
  });
  const txt = (text: string): ProseMirrorNode => ({ type: "text", text });
  const tab = (): ProseMirrorNode => ({ type: "tab" });
  const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

  async function docxOf(node: ProseMirrorNode) {
    const file = await createEliumFile({ title: "Doc taquets", profile: "standard", doc: node });
    return docToDocx(file);
  }
  const bodyOf = (bytes: Uint8Array) => strFromU8(unzipSync(bytes)["word/document.xml"]!);

  it("écrit w:tabs dans les propriétés du paragraphe", async () => {
    const xml = bodyOf(await docxOf(doc(para([txt("a")], [stop(40, "right", "dot")]))));
    expect(xml).toContain('<w:tabs><w:tab w:val="right" w:pos="2268" w:leader="dot"/></w:tabs>');
  });

  it("écrit une vraie tabulation dans le run", async () => {
    const xml = bodyOf(await docxOf(doc(para([txt("a"), tab(), txt("b")]))));
    expect(xml).toContain("<w:r><w:tab/></w:r>");
  });

  it("place w:tabs avant w:pBdr, comme l'exige le schéma", async () => {
    const xml = bodyOf(await docxOf(doc(
      { type: "paragraph", attrs: { tabStops: [stop(40)], borders: { bottom: true } }, content: [txt("a")] },
    )));
    // Un ordre inversé fait signaler par Word un document à réparer.
    expect(xml.indexOf("<w:tabs>")).toBeLessThan(xml.indexOf("<w:pBdr>"));
    expect(xml.indexOf("<w:pBdr>")).toBeGreaterThan(0);
  });

  it("n'écrit pas w:tabs sans taquet", async () => {
    const xml = bodyOf(await docxOf(doc(para([txt("a")]))));
    expect(xml).not.toContain("<w:tabs>");
  });

  it("relit les taquets et les tabulations", async () => {
    const stops = [stop(12.5), stop(40, "center"), stop(80, "decimal", "hyphen")];
    const bytes = await docxOf(doc(para([txt("a"), tab(), txt("b")], stops)));
    const back = docxToDoc(bytes);
    const p = (back.doc.content ?? []).find((n) => n.type === "paragraph")!;
    expect(normalizeStops(p.attrs?.tabStops)).toEqual(stops);
    expect((p.content ?? []).map((c) => c.type)).toContain("tab");
  });

  it("l'aller-retour ne déplace pas les taquets", async () => {
    // La quantification au dixième de mm existe pour ça : sans elle, chaque
    // cycle ouverture/enregistrement décalerait les taquets.
    const stops = normalizeStops([stop(12.5), stop(40), stop(80), stop(165)]);
    let current = stops;
    for (let i = 0; i < 3; i++) {
      const bytes = await docxOf(doc(para([txt("a")], current)));
      const p = (docxToDoc(bytes).doc.content ?? []).find((n) => n.type === "paragraph")!;
      current = normalizeStops(p.attrs?.tabStops);
      expect(current).toEqual(stops);
    }
  });
});
