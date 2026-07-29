import { describe, it, expect } from "vitest";
import {
  DEFAULT_GRID, MAX_EVERY, MAX_SPACING_MM, MIN_SPACING_MM, activeGrid, drawnStepX, drawnStepY,
  gridBackground, gridDraws, gridFromSettingsXml, gridSettingsXml, mmToTwips, normalizeGrid,
  setActiveGrid, snapDrag, snapMm, snapPoint,
} from "../src/editor/grid";
import { tableGridlinesCss } from "../src/editor/tableStyles";
import { strFromU8, unzipSync } from "fflate";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";

describe("Quadrillage — modèle", () => {
  it("retombe sur les valeurs par défaut", () => {
    expect(normalizeGrid(null)).toEqual(DEFAULT_GRID);
    expect(normalizeGrid("nope")).toEqual(DEFAULT_GRID);
    expect(normalizeGrid(undefined)).toEqual(DEFAULT_GRID);
  });

  it("borne le pas", () => {
    expect(normalizeGrid({ spacingXMm: 0.01 }).spacingXMm).toBe(MIN_SPACING_MM);
    expect(normalizeGrid({ spacingYMm: 9999 }).spacingYMm).toBe(MAX_SPACING_MM);
    // Quantifié au dixième : le pas fait l'aller-retour en twips sans dériver.
    expect(normalizeGrid({ spacingXMm: 2.34 }).spacingXMm).toBe(2.3);
  });

  it("borne « une ligne sur N » et accepte 0 (axe non tracé)", () => {
    expect(normalizeGrid({ everyX: 0 }).everyX) .toBe(0);
    expect(normalizeGrid({ everyX: -4 }).everyX).toBe(0);
    expect(normalizeGrid({ everyY: 999 }).everyY).toBe(MAX_EVERY);
  });

  it("refuse une couleur non hexadécimale", () => {
    expect(normalizeGrid({ color: "red" }).color).toBe(DEFAULT_GRID.color);
    expect(normalizeGrid({ color: "#ff0000" }).color).toBe("#ff0000");
  });

  it("distingue le pas d'alignement du pas tracé", () => {
    const g = normalizeGrid({ spacingXMm: 2.5, everyX: 2, spacingYMm: 5, everyY: 1 });
    expect(drawnStepX(g)).toBe(5);
    expect(drawnStepY(g)).toBe(5);
    // Aucune ligne sur un axe : rien n'y est tracé, l'alignement reste.
    expect(drawnStepX(normalizeGrid({ everyX: 0 }))).toBe(0);
  });

  it("ne dessine rien tant qu'il est masqué", () => {
    expect(gridDraws({ visible: false })).toBe(false);
    expect(gridDraws({ visible: true })).toBe(true);
    // Visible mais sans aucune ligne sur les deux axes : rien à dessiner.
    expect(gridDraws({ visible: true, everyX: 0, everyY: 0 })).toBe(false);
  });
});

describe("Quadrillage — fond CSS", () => {
  it("ne rend rien quand il n'y a rien à tracer", () => {
    expect(gridBackground({ visible: false })).toBeNull();
    expect(gridBackground({ visible: true, everyX: 0, everyY: 0 })).toBeNull();
  });

  it("trace deux dégradés répétés au pas tracé", () => {
    const bg = gridBackground({ visible: true, spacingXMm: 2.5, everyX: 2, spacingYMm: 2.5, everyY: 4 });
    expect(bg).not.toBeNull();
    expect(bg!.backgroundImage).toContain("repeating-linear-gradient(to right");
    expect(bg!.backgroundImage).toContain("transparent 5mm");
    expect(bg!.backgroundImage).toContain("repeating-linear-gradient(to bottom");
    expect(bg!.backgroundImage).toContain("transparent 10mm");
  });

  it("n'écrit qu'un seul axe quand l'autre n'est pas tracé", () => {
    const bg = gridBackground({ visible: true, everyY: 0 });
    expect(bg!.backgroundImage).toContain("to right");
    expect(bg!.backgroundImage).not.toContain("to bottom");
  });

  it("décale la grille à l'origine demandée", () => {
    const bg = gridBackground({ visible: true }, 20, 25);
    expect(bg!.backgroundPosition).toContain("20mm 0");
    expect(bg!.backgroundPosition).toContain("0 25mm");
  });
});

describe("Quadrillage — alignement", () => {
  it("ramène une valeur au pas le plus proche", () => {
    expect(snapMm(11.7, 5)).toBe(10);
    expect(snapMm(13, 5)).toBe(15);
    // Une origine décale la grille : aligner depuis la marge n'est pas aligner
    // depuis le bord de la feuille.
    expect(snapMm(13, 5, 2)).toBe(12);
  });

  it("laisse la valeur intacte pour un pas absurde", () => {
    expect(snapMm(13.37, 0)).toBe(13.37);
    expect(snapMm(13.37, Number.NaN)).toBe(13.37);
  });

  it("respecte l'alignement coupé", () => {
    expect(snapPoint(11.7, 13, { snap: true, spacingXMm: 5, spacingYMm: 5 })).toEqual({ x: 10, y: 15 });
    expect(snapPoint(11.7, 13, { snap: false })).toEqual({ x: 11.7, y: 13 });
  });

  it("publie la grille active pour les vues de nœud, Alt l'ignorant", () => {
    setActiveGrid(null);
    // Sans grille publiée, un glisser n'est pas aligné.
    expect(snapDrag(11.7, 13)).toEqual({ x: 11.7, y: 13 });
    setActiveGrid({ snap: true, spacingXMm: 5, spacingYMm: 5 });
    expect(activeGrid()?.spacingXMm).toBe(5);
    expect(snapDrag(11.7, 13)).toEqual({ x: 10, y: 15 });
    // Alt (bypass) pose l'objet librement, comme dans Word.
    expect(snapDrag(11.7, 13, true)).toEqual({ x: 11.7, y: 13 });
    setActiveGrid(null);
  });
});

describe("Quadrillage — OOXML", () => {
  it("convertit les millimètres en twips", () => {
    expect(mmToTwips(25.4)).toBe(1440);
    expect(mmToTwips(0)).toBe(0);
  });

  it("écrit le pas et les lignes affichées", () => {
    const xml = gridSettingsXml({ visible: true, spacingXMm: 2.5, spacingYMm: 5, everyX: 2, everyY: 3 });
    expect(xml).toContain(`<w:drawingGridHorizontalSpacing w:val="${mmToTwips(2.5)}"/>`);
    expect(xml).toContain(`<w:drawingGridVerticalSpacing w:val="${mmToTwips(5)}"/>`);
    expect(xml).toContain('<w:displayHorizontalDrawingGridEvery w:val="2"/>');
    expect(xml).toContain('<w:displayVerticalDrawingGridEvery w:val="3"/>');
  });

  it("exporte une grille masquée comme « aucune ligne », en gardant le pas", () => {
    // Word n'a pas de champ « grille visible » : zéro ligne affichée est la
    // traduction la plus proche de ce que l'auteur voit.
    const xml = gridSettingsXml({ visible: false, everyX: 4, everyY: 4, spacingXMm: 3 });
    expect(xml).toContain('<w:displayHorizontalDrawingGridEvery w:val="0"/>');
    expect(xml).toContain('<w:displayVerticalDrawingGridEvery w:val="0"/>');
    expect(xml).toContain(`<w:drawingGridHorizontalSpacing w:val="${mmToTwips(3)}"/>`);
  });

  it("n'écrit l'origine explicite qu'avec son drapeau", () => {
    expect(gridSettingsXml({ fromMargins: true })).not.toContain("doNotUseMargins");
    const xml = gridSettingsXml({ fromMargins: false, originXMm: 10, originYMm: 12 });
    expect(xml).toContain("<w:doNotUseMarginsForDrawingGridOrigin/>");
    expect(xml).toContain(`<w:drawingGridHorizontalOrigin w:val="${mmToTwips(10)}"/>`);
    expect(xml).toContain(`<w:drawingGridVerticalOrigin w:val="${mmToTwips(12)}"/>`);
  });

  it("relit une grille écrite par Word", () => {
    const src = gridSettingsXml({
      visible: true, spacingXMm: 3, spacingYMm: 4, everyX: 2, everyY: 5,
      fromMargins: false, originXMm: 8, originYMm: 9,
    });
    const back = gridFromSettingsXml(src);
    expect(back.spacingXMm).toBeCloseTo(3, 1);
    expect(back.spacingYMm).toBeCloseTo(4, 1);
    expect(back.everyX).toBe(2);
    expect(back.everyY).toBe(5);
    expect(back.visible).toBe(true);
    expect(back.fromMargins).toBe(false);
    expect(back.originXMm).toBeCloseTo(8, 1);
  });

  it("relit « aucune ligne » comme une grille masquée", () => {
    const back = gridFromSettingsXml(gridSettingsXml({ visible: false }));
    expect(back.visible).toBe(false);
  });

  it("ignore un settings.xml sans réglage de grille", () => {
    expect(gridFromSettingsXml("<w:settings/>")).toEqual({});
  });
});

describe("Quadrillage — paquet DOCX", () => {
  const doc = { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] };

  it("ajoute une vraie partie settings.xml, déclarée et reliée", async () => {
    const file = await createEliumFile({ title: "T", profile: "standard", doc: doc as never });
    file.document.page.grid = normalizeGrid({ visible: true, spacingXMm: 2.5, everyX: 2 });
    const zip = unzipSync(docToDocx(file));
    expect(zip["word/settings.xml"]).toBeTruthy();
    const settings = strFromU8(zip["word/settings.xml"]!);
    expect(settings).toContain("<w:settings");
    expect(settings).toContain("drawingGridHorizontalSpacing");
    // Sans la déclaration ET la relation, Word ignore purement la partie.
    expect(strFromU8(zip["[Content_Types].xml"]!)).toContain("/word/settings.xml");
    expect(strFromU8(zip["word/_rels/document.xml.rels"]!)).toContain("settings.xml");
  });

  it("respecte l'ordre du schéma dans settings.xml", () => {
    // `CT_Settings` est une séquence : un élément valide au mauvais endroit fait
    // rejeter toute la partie par Word.
    const xml = gridSettingsXml({ visible: true });
    const iH = xml.indexOf("drawingGridHorizontalSpacing");
    const iV = xml.indexOf("drawingGridVerticalSpacing");
    const iDH = xml.indexOf("displayHorizontalDrawingGridEvery");
    const iDV = xml.indexOf("displayVerticalDrawingGridEvery");
    expect(iH).toBeLessThan(iV);
    expect(iV).toBeLessThan(iDH);
    expect(iDH).toBeLessThan(iDV);
  });
});

describe("Quadrillage des tableaux", () => {
  it("ne cible que les styles sans filets", () => {
    const css = tableGridlinesCss();
    // « Grille » et « Simple » ont leurs propres filets : les pointiller les
    // doublerait.
    expect(css).not.toContain('data-table-style="grid"');
    expect(css).not.toContain('data-table-style="plain"');
    expect(css).toContain('data-table-style="minimal"');
    expect(css).toContain("tstyle-minimal");
    expect(css).toContain("outline:1px dashed");
  });

  it("ne s'imprime pas", () => {
    expect(tableGridlinesCss()).toContain("@media print");
  });
});
