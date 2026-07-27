import { describe, it, expect } from "vitest";
import {
  DEFAULT_DROP_LINES, DEFAULT_WATERMARK, DROP_CAP_LABELS, SYMBOL_GROUPS, WATERMARK_PRESETS,
  clampDropLines, dropCapCss, dropCapXml, findSymbols, isInvisible, normalizeWatermark,
  symbolName, symbolsOf, watermarkCss, watermarkVml,
} from "../src/editor/ornaments";
import { strFromU8, unzipSync } from "fflate";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { buildStandaloneHtml, docToHtml } from "../src/export/exporters";
import type { ProseMirrorNode } from "../src/format/types";

describe("Symboles — catalogue", () => {
  it("expose des groupes non vides et sans doublon interne", () => {
    expect(SYMBOL_GROUPS.length).toBeGreaterThan(4);
    for (const g of SYMBOL_GROUPS) {
      expect(g.chars.length).toBeGreaterThan(0);
      expect(new Set(g.chars).size).toBe(g.chars.length);
    }
  });

  it("rend les symboles d'un groupe, ou tous", () => {
    expect(symbolsOf("greek")).toContain("λ");
    expect(symbolsOf("greek")).not.toContain("€");
    expect(symbolsOf(null).length).toBeGreaterThan(80);
    // Un groupe inconnu ne doit pas rendre une grille vide.
    expect(symbolsOf("inexistant")).toEqual([]);
  });

  it("nomme les caractères invisibles au lieu d'afficher du vide", () => {
    expect(symbolName(" ")).toBe("Espace insécable");
    expect(isInvisible(" ")).toBe(true);
    expect(isInvisible("€")).toBe(false);
  });

  it("nomme les autres par leur point de code", () => {
    expect(symbolName("€")).toBe("U+20AC");
    expect(symbolName("±")).toBe("U+00B1");
  });
});

describe("Symboles — recherche", () => {
  it("trouve par point de code, avec ou sans préfixe", () => {
    expect(findSymbols("U+20AC")).toEqual(["€"]);
    expect(findSymbols("20ac")).toEqual(["€"]);
  });

  it("trouve par fragment de nom", () => {
    expect(findSymbols("insécable")).toContain(" ");
  });

  it("rend tout pour une requête vide", () => {
    expect(findSymbols("   ").length).toBe(symbolsOf(null).length);
  });

  it("ne lève pas sur un point de code invalide", () => {
    expect(findSymbols("ffffff")).toEqual([]);
    expect(findSymbols("zzz")).toEqual([]);
  });
});

describe("Lettrine", () => {
  it("borne le nombre de lignes", () => {
    expect(clampDropLines(1)).toBe(2);
    expect(clampDropLines(9)).toBe(5);
    expect(clampDropLines(3)).toBe(3);
    expect(clampDropLines("bogus")).toBe(DEFAULT_DROP_LINES);
  });

  it("ne rend aucun CSS quand il n'y a pas de lettrine", () => {
    expect(dropCapCss("none", 3)).toBe("");
    expect(dropCapXml("none", 3)).toBe("");
  });

  it("cale la taille sur le nombre de lignes et l'interligne", () => {
    // 3 lignes à 1,5 d'interligne : la lettre doit couvrir 4,5 em.
    expect(dropCapCss("drop", 3, 1.5)).toContain("font-size:4.50em");
    expect(dropCapCss("drop", 2, 1.2)).toContain("font-size:2.40em");
    expect(dropCapCss("drop", 3)).toContain("float:left");
  });

  it("sort dans la marge pour le second type", () => {
    expect(dropCapCss("margin", 3)).toContain("margin-left:-.7em");
    expect(dropCapCss("drop", 3)).not.toContain("margin-left:-");
  });

  it("écrit un w:framePr que Word reconnaît", () => {
    const xml = dropCapXml("drop", 4);
    expect(xml).toContain('w:dropCap="drop"');
    expect(xml).toContain('w:lines="4"');
    // Sans `wrap="around"` le texte serait poussé sous la lettre au lieu de couler autour.
    expect(xml).toContain('w:wrap="around"');
  });

  it("borne aussi les lignes à l'export", () => {
    expect(dropCapXml("margin", 99)).toContain('w:lines="5"');
  });

  it("expose des libellés français", () => {
    expect(DROP_CAP_LABELS.margin).toBe("Dans la marge");
  });
});

describe("Filigrane — normalisation", () => {
  it("retombe sur les valeurs par défaut", () => {
    expect(normalizeWatermark(null)).toEqual(DEFAULT_WATERMARK);
    expect(normalizeWatermark("nope")).toEqual(DEFAULT_WATERMARK);
  });

  it("un texte vide vaut « aucun filigrane »", () => {
    // Rien à dessiner : le déclarer actif afficherait un fond invisible et
    // coûteux à chaque rendu.
    expect(normalizeWatermark({ kind: "text", text: "   " }).kind).toBe("none");
    expect(normalizeWatermark({ kind: "text", text: "OK" }).kind).toBe("text");
  });

  it("borne l'angle, l'opacité et la taille", () => {
    expect(normalizeWatermark({ kind: "text", text: "X", angle: 400 }).angle).toBe(90);
    expect(normalizeWatermark({ kind: "text", text: "X", angle: -400 }).angle).toBe(-90);
    expect(normalizeWatermark({ kind: "text", text: "X", opacity: 5 }).opacity).toBe(1);
    expect(normalizeWatermark({ kind: "text", text: "X", opacity: -1 }).opacity).toBe(0);
    expect(normalizeWatermark({ kind: "text", text: "X", sizePt: 9999 }).sizePt).toBe(400);
  });

  it("refuse une couleur qui n'est pas un hexadécimal à six chiffres", () => {
    expect(normalizeWatermark({ kind: "text", text: "X", color: "red" }).color).toBe(DEFAULT_WATERMARK.color);
    expect(normalizeWatermark({ kind: "text", text: "X", color: "#ff0000" }).color).toBe("#ff0000");
  });

  it("tronque un texte démesuré", () => {
    expect(normalizeWatermark({ kind: "text", text: "a".repeat(500) }).text).toHaveLength(120);
  });

  it("propose les textes usuels", () => {
    expect(WATERMARK_PRESETS).toContain("CONFIDENTIEL");
  });
});

describe("Filigrane — rendu", () => {
  const mark = { ...DEFAULT_WATERMARK, kind: "text" as const, text: "BROUILLON" };

  it("ne rend rien quand il est désactivé", () => {
    expect(watermarkCss(DEFAULT_WATERMARK, 210, 297)).toBe("");
    expect(watermarkVml(DEFAULT_WATERMARK)).toBe("");
  });

  it("rend un SVG encodé utilisable en background-image", () => {
    const css = watermarkCss(mark, 210, 297);
    expect(css.startsWith('url("data:image/svg+xml,')).toBe(true);
    const svg = decodeURIComponent(css.slice('url("data:image/svg+xml,'.length, -2));
    expect(svg).toContain("BROUILLON");
    expect(svg).toContain('width="210mm"');
    expect(svg).toContain("rotate(-45 105 148.5)");
  });

  it("échappe le texte du filigrane dans le SVG", () => {
    const css = watermarkCss({ ...mark, text: '<script>&"' }, 210, 297);
    const svg = decodeURIComponent(css.slice('url("data:image/svg+xml,'.length, -2));
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("survit à une page de taille absurde", () => {
    expect(watermarkCss(mark, 0, 0)).toContain("data:image/svg+xml");
    expect(watermarkCss(mark, -50, -50)).toContain("data:image/svg+xml");
  });

  it("écrit un filigrane VML, la seule forme que Word reconnaît", () => {
    const vml = watermarkVml(mark);
    // Word ignore un filigrane en SVG : il attend une forme VML dans l'en-tête.
    expect(vml).toContain("v:shapetype");
    expect(vml).toContain('string="BROUILLON"');
    expect(vml).toContain('w:pStyle w:val="Header"');
    expect(vml).toContain("rotation:-45");
  });

  it("échappe aussi le texte dans le VML", () => {
    expect(watermarkVml({ ...mark, text: 'a"b&c' })).toContain("a&quot;b&amp;c");
  });
});

describe("Ornements — export", () => {
  const model = (doc: ProseMirrorNode, watermark?: unknown) => ({
    schema: "elium-doc/1" as const,
    page: {
      format: "A4" as const, orientation: "portrait" as const,
      margins: { top: 25, right: 20, bottom: 25, left: 20 },
    },
    doc,
    ...(watermark ? { watermark } : {}),
  });
  const txt = (t: string): ProseMirrorNode => ({ type: "text", text: t });
  const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

  async function zipOf(node: ProseMirrorNode, watermark?: unknown) {
    const file = await createEliumFile({ title: "Doc ornements", profile: "standard", doc: node });
    if (watermark) (file.document as Record<string, unknown>).watermark = watermark;
    return unzipSync(docToDocx(file));
  }
  const part = (zip: Record<string, Uint8Array>, n: string) => (zip[n] ? strFromU8(zip[n]!) : null);

  it("rend la lettrine en HTML par attribut et variable CSS", () => {
    const html = docToHtml(model(doc({
      type: "paragraph", attrs: { dropCap: "drop", dropCapLines: 4 }, content: [txt("Alpha")],
    })));
    expect(html).toContain('data-drop-cap="drop"');
    expect(html).toContain("--elium-dropcap:6.00em");
  });

  it("n'ajoute rien sans lettrine", () => {
    const html = docToHtml(model(doc({ type: "paragraph", content: [txt("Alpha")] })));
    expect(html).not.toContain("data-drop-cap");
  });

  it("écrit un w:framePr en DOCX", async () => {
    const zip = await zipOf(doc({
      type: "paragraph", attrs: { dropCap: "margin", dropCapLines: 3 }, content: [txt("Alpha")],
    }));
    const body = part(zip, "word/document.xml")!;
    expect(body).toContain('w:dropCap="margin"');
    expect(body).toContain('w:lines="3"');
  });

  it("place w:framePr avant w:tabs, dans l'ordre du schéma", async () => {
    const zip = await zipOf(doc({
      type: "paragraph",
      attrs: { dropCap: "drop", dropCapLines: 2, tabStops: [{ pos: 40, align: "left", leader: "none" }] },
      content: [txt("Alpha")],
    }));
    const body = part(zip, "word/document.xml")!;
    expect(body.indexOf("<w:framePr")).toBeLessThan(body.indexOf("<w:tabs>"));
  });

  it("écrit le filigrane dans un en-tête VML, référencé par sectPr", async () => {
    const zip = await zipOf(doc({ type: "paragraph", content: [txt("a")] }), {
      kind: "text", text: "CONFIDENTIEL", angle: -45, opacity: 0.12, color: "#94a3b8", sizePt: 0,
    });
    const header = part(zip, "word/header1.xml");
    expect(header).toContain('string="CONFIDENTIEL"');
    expect(header).toContain("urn:schemas-microsoft-com:vml");
    // Sans w:headerReference la partie existe mais Word ne l'affiche jamais.
    expect(part(zip, "word/document.xml")).toContain("<w:headerReference");
    expect(part(zip, "[Content_Types].xml")).toContain("wordprocessingml.header+xml");
    expect(part(zip, "word/_rels/document.xml.rels")).toContain('Target="header1.xml"');
  });

  it("n'écrit aucun en-tête sans filigrane", async () => {
    const zip = await zipOf(doc({ type: "paragraph", content: [txt("a")] }));
    expect(part(zip, "word/header1.xml")).toBeNull();
    expect(part(zip, "word/document.xml")).not.toContain("<w:headerReference");
  });

  it("met le filigrane en fond dans l'export HTML autonome", async () => {
    const file = await createEliumFile({
      title: "T", profile: "standard", doc: doc({ type: "paragraph", content: [txt("a")] }),
    });
    (file.document as Record<string, unknown>).watermark = {
      kind: "text", text: "BROUILLON", angle: -45, opacity: 0.1, color: "#94a3b8", sizePt: 0,
    };
    const html = buildStandaloneHtml(file);
    expect(html).toContain("body{background-image:url(\"data:image/svg+xml,");
  });
});
