import { describe, it, expect } from "vitest";
import {
  DEFAULT_GEOMETRY, DEFAULT_STYLE, MAX_MM, MIN_HEIGHT_MM, MIN_WIDTH_MM, WRAP_LABELS, WRAP_MODES,
  isFloating, mmToPt, normalizeGeometry, normalizeStyle, textBoxCss, textBoxShapeType, textBoxVml,
  wrapVml,
} from "../src/editor/textBox";
import { strFromU8, unzipSync } from "fflate";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { docToHtml } from "../src/export/exporters";
import type { ProseMirrorNode } from "../src/format/types";

describe("Zone de texte — géométrie", () => {
  it("retombe sur les valeurs par défaut", () => {
    expect(normalizeGeometry(null)).toEqual(DEFAULT_GEOMETRY);
    expect(normalizeGeometry("nope")).toEqual(DEFAULT_GEOMETRY);
  });

  it("borne la largeur et la position", () => {
    expect(normalizeGeometry({ widthMm: 2 }).widthMm).toBe(MIN_WIDTH_MM);
    expect(normalizeGeometry({ widthMm: 99999 }).widthMm).toBe(MAX_MM);
    // Un glisser parti hors de la feuille rendrait la zone inatteignable.
    expect(normalizeGeometry({ x: -50, y: -20 })).toMatchObject({ x: 0, y: 0 });
  });

  it("garde 0 comme hauteur automatique", () => {
    expect(normalizeGeometry({ heightMm: 0 }).heightMm).toBe(0);
    expect(normalizeGeometry({ heightMm: -5 }).heightMm).toBe(0);
    // Une hauteur explicite trop faible est remontée au minimum utile.
    expect(normalizeGeometry({ heightMm: 1 }).heightMm).toBe(MIN_HEIGHT_MM);
  });

  it("quantifie au dixième de millimètre", () => {
    expect(normalizeGeometry({ x: 10.16, widthMm: 60.14 })).toMatchObject({ x: 10.2, widthMm: 60.1 });
  });

  it("refuse un habillage inconnu", () => {
    expect(normalizeGeometry({ wrap: "bogus" }).wrap).toBe(DEFAULT_GEOMETRY.wrap);
    for (const w of WRAP_MODES) expect(normalizeGeometry({ wrap: w }).wrap).toBe(w);
  });

  it("distingue ce qui sort du flux", () => {
    // C'est ce qui décide si la pagination doit en tenir compte.
    expect(isFloating("front")).toBe(true);
    expect(isFloating("behind")).toBe(true);
    expect(isFloating("square")).toBe(false);
    expect(isFloating("inline")).toBe(false);
    expect(isFloating("bogus")).toBe(false);
  });

  it("expose des libellés français", () => {
    expect(WRAP_LABELS.behind).toBe("Derrière le texte");
  });
});

describe("Zone de texte — style", () => {
  it("retombe sur les valeurs par défaut", () => {
    expect(normalizeStyle(null)).toEqual(DEFAULT_STYLE);
  });

  it("distingue transparent et blanc", () => {
    // Une zone transparente laisse voir le filigrane et le texte derrière.
    expect(normalizeStyle({ fill: "" }).fill).toBe("");
    expect(normalizeStyle({ fill: "bogus" }).fill).toBe("");
    expect(normalizeStyle({ fill: "#ffffff" }).fill).toBe("#ffffff");
  });

  it("borne le filet, la marge et le rayon", () => {
    expect(normalizeStyle({ borderWidth: 99 }).borderWidth).toBe(12);
    expect(normalizeStyle({ borderWidth: -3 }).borderWidth).toBe(0);
    expect(normalizeStyle({ padMm: 999 }).padMm).toBe(40);
    expect(normalizeStyle({ radius: 999 }).radius).toBe(40);
  });

  it("refuse une couleur de filet non hexadécimale", () => {
    expect(normalizeStyle({ borderColor: "red" }).borderColor).toBe(DEFAULT_STYLE.borderColor);
  });
});

describe("Zone de texte — CSS", () => {
  it("impose la largeur et la marge intérieure", () => {
    const css = textBoxCss({ widthMm: 70, padMm: 0 }, { padMm: 5 });
    expect(css).toContain("width:70mm");
    expect(css).toContain("padding:5mm");
    expect(css).toContain("box-sizing:border-box");
  });

  it("laisse la hauteur libre quand elle vaut 0", () => {
    expect(textBoxCss({ heightMm: 0 }, {})).not.toContain("min-height");
    expect(textBoxCss({ heightMm: 40 }, {})).toContain("min-height:40mm");
  });

  it("fait flotter l'habillage carré du bon côté", () => {
    expect(textBoxCss({ wrap: "square", side: "right" }, {})).toContain("float:right");
    expect(textBoxCss({ wrap: "square", side: "left" }, {})).toContain("float:left");
  });

  it("sort du flux en position absolue", () => {
    const front = textBoxCss({ wrap: "front", x: 30, y: 50 }, {});
    expect(front).toContain("position:absolute");
    expect(front).toContain("left:30mm");
    expect(front).toContain("top:50mm");
    expect(front).toContain("z-index:3");
    // Derrière le texte : sous le contenu, mais toujours positionnée.
    expect(textBoxCss({ wrap: "behind" }, {})).toContain("z-index:0");
  });

  it("ne flotte pas en habillage « dans le texte »", () => {
    const css = textBoxCss({ wrap: "inline" }, {});
    expect(css).toContain("display:block");
    expect(css).not.toContain("float:");
    expect(css).not.toContain("position:absolute");
  });

  it("rend une bordure nulle explicitement", () => {
    expect(textBoxCss({}, { borderWidth: 0 })).toContain("border:0");
    expect(textBoxCss({}, { borderWidth: 2, borderColor: "#ff0000" })).toContain("border:2px solid #ff0000");
  });
});

describe("Zone de texte — OOXML", () => {
  it("convertit les millimètres en points", () => {
    expect(mmToPt(25.4)).toBe(72);
    expect(mmToPt(0)).toBe(0);
  });

  it("traduit chaque habillage", () => {
    expect(wrapVml("inline").wrapEl).toContain('type="inline"');
    expect(wrapVml("square").wrapEl).toContain('type="square"');
    expect(wrapVml("front").style).toContain("z-index:251658240");
    // Un z-index NÉGATIF est ce qui met la forme derrière le texte.
    expect(wrapVml("behind").style).toContain("z-index:-251658240");
    expect(wrapVml("bogus").wrapEl).toContain('type="square"');
  });

  it("écrit une forme VML avec son contenu", () => {
    const xml = textBoxVml({ widthMm: 50 }, {}, "<w:p><w:r><w:t>Encadré</w:t></w:r></w:p>", "tb1");
    expect(xml).toContain('type="#_x0000_t202"');
    expect(xml).toContain("<v:textbox");
    expect(xml).toContain("<w:txbxContent>");
    expect(xml).toContain("Encadré");
    expect(xml).toContain("width:141.73pt");
  });

  it("écrit un contenu vide valide plutôt que rien", () => {
    // Un `w:txbxContent` vide fait rejeter le fichier par Word.
    expect(textBoxVml({}, {}, "", "tb")).toContain("<w:txbxContent><w:p/></w:txbxContent>");
  });

  it("place une zone hors flux en absolu, relativement à la page", () => {
    const xml = textBoxVml({ wrap: "front", x: 30, y: 40 }, {}, "<w:p/>", "tb");
    expect(xml).toContain("margin-left:85.04pt");
    expect(xml).toContain("mso-position-horizontal-relative:page");
  });

  it("rend un filet et un remplissage absents explicitement", () => {
    const bare = textBoxVml({}, { borderWidth: 0, fill: "" }, "<w:p/>", "tb");
    expect(bare).toContain('stroked="f"');
    expect(bare).toContain('filled="f"');
    const dressed = textBoxVml({}, { borderWidth: 2, fill: "#eff6ff" }, "<w:p/>", "tb");
    expect(dressed).toContain('strokecolor="#cbd5e1"');
    expect(dressed).toContain('fillcolor="#eff6ff"');
    expect(dressed).toContain('strokeweight="1.50pt"');
  });

  it("échappe l'identifiant et les couleurs", () => {
    const xml = textBoxVml({}, {}, "<w:p/>", 'a"b<c');
    expect(xml).toContain("a&quot;b&lt;c");
    expect(xml).not.toContain('id="a"b');
  });

  it("déclare le type de forme canonique", () => {
    // Sans cette déclaration, Word ouvre le fichier mais dessine des formes vides.
    expect(textBoxShapeType()).toContain('id="_x0000_t202"');
    expect(textBoxShapeType()).toContain('o:spt="202"');
  });
});

describe("Zone de texte — export", () => {
  const p = (t: string): ProseMirrorNode => ({ type: "paragraph", content: [{ type: "text", text: t }] });
  const box = (attrs: Record<string, unknown>, ...kids: ProseMirrorNode[]): ProseMirrorNode =>
    ({ type: "textBox", attrs, content: kids });
  const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });
  const model = (d: ProseMirrorNode) => ({
    schema: "elium-doc/1" as const,
    page: {
      format: "A4" as const, orientation: "portrait" as const,
      margins: { top: 25, right: 20, bottom: 25, left: 20 },
    },
    doc: d,
  });

  it("rend la zone en HTML avec le même style que l'écran", () => {
    const html = docToHtml(model(doc(box({ wrap: "square", side: "right", widthMm: 70 }, p("Encadré")))));
    expect(html).toContain("elium-textbox--square");
    expect(html).toContain("float:right");
    expect(html).toContain("width:70mm");
    expect(html).toContain("Encadré");
  });

  it("conserve du contenu de bloc, pas du texte plat", () => {
    const html = docToHtml(model(doc(box({}, p("un"), { type: "bulletList", content: [
      { type: "listItem", content: [p("a")] },
    ] }))));
    expect(html).toContain("<ul");
    expect(html).toContain("<li");
  });

  it("écrit une forme VML en DOCX, avec son type déclaré une seule fois", async () => {
    const file = await createEliumFile({
      title: "T", profile: "standard",
      doc: doc(box({ wrap: "front", x: 20, y: 30 }, p("A")), box({ wrap: "square" }, p("B"))),
    });
    const xml = strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);
    // Le shapetype canonique, une fois : sans lui Word dessine des formes vides.
    expect(xml.match(/<v:shapetype/g)).toHaveLength(1);
    expect(xml).toContain('type="#_x0000_t202"');
    expect(xml.match(/<v:textbox/g)).toHaveLength(2);
    expect(xml).toContain("<w:txbxContent>");
    // Deux formes, deux identifiants distincts.
    expect(xml).toContain("EliumTextBox1");
    expect(xml).toContain("EliumTextBox2");
  });

  it("déclare les espaces de noms VML sur le document", async () => {
    const file = await createEliumFile({ title: "T", profile: "standard", doc: doc(box({}, p("A"))) });
    const xml = strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);
    // Sans ces déclarations, Word refuse la partie qui contient du VML.
    expect(xml).toContain('xmlns:v="urn:schemas-microsoft-com:vml"');
    expect(xml).toContain('xmlns:w10="urn:schemas-microsoft-com:office:word"');
  });

  it("ne déclare aucun shapetype sans zone de texte", async () => {
    const file = await createEliumFile({ title: "T", profile: "standard", doc: doc(p("rien")) });
    const xml = strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);
    expect(xml).not.toContain("v:shapetype");
  });

  it("porte l'habillage jusqu'à Word", async () => {
    const file = await createEliumFile({
      title: "T", profile: "standard", doc: doc(box({ wrap: "behind" }, p("A"))),
    });
    const xml = strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);
    expect(xml).toContain("z-index:-251658240");
    expect(xml).toContain('<w10:wrap type="none"/>');
  });
});
