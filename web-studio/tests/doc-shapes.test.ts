import { describe, it, expect } from "vitest";
import {
  DASH_LABELS,
  DEFAULT_KIND,
  DEFAULT_SHAPE_STYLE,
  SHAPES,
  SHAPE_GROUPS,
  arcCubics,
  clampAdj,
  dashFromOoxml,
  defaultAdj,
  emuToMm,
  isShapeKind,
  kindFromPrst,
  mmToEmu,
  normalizeShapeStyle,
  pxToMm,
  shapeContainerCss,
  shapeDef,
  shapeDml,
  shapeHeads,
  shapePath,
  shapeSvg,
  shapeVml,
  shapeXml,
  usesEvenOdd,
  vAlignCss,
  vmlPath,
} from "../src/editor/shapes";
import { normalizeGeometry, DEFAULT_GEOMETRY } from "../src/editor/textBox";
import { strFromU8, unzipSync } from "fflate";
import { docToDocx, docxToDoc } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { docToHtml } from "../src/export/exporters";
import type { ProseMirrorNode } from "../src/format/types";

describe("Formes — catalogue", () => {
  it("expose des formes uniques, groupées, avec une géométrie préréglée", () => {
    const kinds = new Set(SHAPES.map((s) => s.kind));
    expect(kinds.size).toBe(SHAPES.length);
    const groups = new Set(SHAPE_GROUPS.map((g) => g.id));
    for (const s of SHAPES) {
      expect(groups.has(s.group)).toBe(true);
      // `prst` est ce qui fait arriver une VRAIE forme dans Word.
      expect(s.prst).toMatch(/^[A-Za-z0-9]+$/);
      expect(s.label.length).toBeGreaterThan(2);
    }
  });

  it("couvre les sept familles de la galerie", () => {
    for (const g of SHAPE_GROUPS) {
      expect(SHAPES.filter((s) => s.group === g.id).length).toBeGreaterThan(0);
    }
    expect(SHAPES.length).toBeGreaterThanOrEqual(45);
  });

  it("retombe sur le rectangle pour une forme inconnue", () => {
    expect(shapeDef("bogus").kind).toBe(DEFAULT_KIND);
    expect(isShapeKind("star5")).toBe(true);
    expect(isShapeKind("bogus")).toBe(false);
  });

  it("borne l'ajustement aux valeurs de la forme", () => {
    expect(defaultAdj("roundRect")).toBe(16);
    expect(defaultAdj("rect")).toBe(0);
    expect(clampAdj("roundRect", 999)).toBe(50);
    expect(clampAdj("roundRect", -5)).toBe(0);
    expect(clampAdj("roundRect", "nope")).toBe(16);
    // Une forme sans poignée d'ajustement n'en accepte aucun.
    expect(clampAdj("rect", 30)).toBe(0);
  });

  it("retrouve la forme depuis sa géométrie préréglée", () => {
    expect(kindFromPrst("star5")).toBe("star5");
    expect(kindFromPrst("wedgeEllipseCallout")).toBe("calloutEllipse");
    expect(kindFromPrst("inconnu")).toBeNull();
  });
});

describe("Formes — tracés", () => {
  /** Toutes les formes, à plusieurs proportions, y compris dégénérées. */
  const sizes: [number, number][] = [
    [40, 25],
    [10, 60],
    [100, 4],
    [1, 1],
    [0, 0],
  ];

  it("n'émet que M, L, C et Z — la contrainte qui rend le VML mécanique", () => {
    for (const s of SHAPES) {
      for (const [w, h] of sizes) {
        const d = shapePath(s.kind, w, h);
        expect(d.length).toBeGreaterThan(4);
        // L'arc `A` de SVG n'existe pas en VML : il est interdit ici.
        expect(d).not.toMatch(/[AaQqSsTtHhVv]/);
        expect(d).toMatch(/^M/);
      }
    }
  });

  it("ne produit jamais de coordonnée invalide", () => {
    for (const s of SHAPES) {
      for (const [w, h] of sizes) {
        const d = shapePath(s.kind, w, h, 999);
        // Un NaN dans un chemin fait disparaître la forme SANS erreur : c'est
        // exactement le genre de panne qu'on ne diagnostique jamais.
        expect(d).not.toContain("NaN");
        expect(d).not.toContain("Infinity");
        expect(d).not.toContain("undefined");
      }
    }
  });

  it("dessine un rectangle sur les quatre coins de sa boîte", () => {
    expect(shapePath("rect", 40, 20)).toBe("M0,0L40,0L40,20L0,20Z");
  });

  it("arrondit les coins et borne le rayon à la moitié du petit côté", () => {
    expect(shapePath("roundRect", 40, 20, 0)).toBe(shapePath("rect", 40, 20));
    // 50 % du plus petit côté : le rayon ne peut pas dépasser 10 sur h = 20.
    const max = shapePath("roundRect", 40, 20, 50);
    expect(max).toContain("C");
    expect(max).not.toContain("NaN");
  });

  it("ferme les formes pleines et laisse les lignes ouvertes", () => {
    expect(shapePath("ellipse", 30, 30)).toMatch(/Z$/);
    expect(shapePath("line", 30, 30)).not.toContain("Z");
    expect(shapePath("elbow", 30, 30)).not.toContain("Z");
  });

  it("compte deux sommets par branche d'étoile", () => {
    // Une étoile à 5 branches, c'est 10 sommets : 5 pointes, 5 creux.
    expect((shapePath("star5", 40, 40).match(/L/g) ?? []).length).toBe(9);
    expect((shapePath("star12", 40, 40).match(/L/g) ?? []).length).toBe(23);
  });

  it("creuse l'anneau et le cadre en deux contours", () => {
    expect(usesEvenOdd("donut")).toBe(true);
    expect(usesEvenOdd("frame")).toBe(true);
    expect(usesEvenOdd("rect")).toBe(false);
    // Deux sous-tracés : le remplissage `evenodd` fait le trou.
    expect((shapePath("donut", 40, 40).match(/M/g) ?? []).length).toBe(2);
    expect((shapePath("frame", 40, 40).match(/M/g) ?? []).length).toBe(2);
  });

  it("approxime un arc par des Béziers d'au plus un quart de tour", () => {
    const quarter = arcCubics(0, 0, 10, 10, 0, Math.PI / 2);
    expect((quarter.match(/C/g) ?? []).length).toBe(1);
    const full = arcCubics(0, 0, 10, 10, 0, Math.PI * 2);
    expect((full.match(/C/g) ?? []).length).toBe(4);
    // Le point de départ est bien sur l'ellipse.
    expect(quarter.startsWith("M10,0")).toBe(true);
  });

  it("pointe les flèches au bout de la ligne, et aux deux bouts si demandé", () => {
    expect(shapeHeads("line", 40, 20)).toBe("");
    expect((shapeHeads("arrow", 40, 20).match(/M/g) ?? []).length).toBe(1);
    expect((shapeHeads("doubleArrow", 40, 20).match(/M/g) ?? []).length).toBe(2);
  });
});

describe("Formes — style", () => {
  it("retombe sur les valeurs par défaut", () => {
    expect(normalizeShapeStyle(null)).toEqual(DEFAULT_SHAPE_STYLE);
  });

  it("distingue « sans remplissage » et blanc", () => {
    expect(normalizeShapeStyle({ fill: "" }).fill).toBe("");
    expect(normalizeShapeStyle({ fill: "bogus" }).fill).toBe(DEFAULT_SHAPE_STYLE.fill);
    expect(normalizeShapeStyle({ fill: "#ffffff" }).fill).toBe("#ffffff");
  });

  it("borne l'épaisseur, l'opacité, l'angle et la marge", () => {
    expect(normalizeShapeStyle({ strokeWidth: 99 }).strokeWidth).toBe(12);
    expect(normalizeShapeStyle({ strokeWidth: -1 }).strokeWidth).toBe(0);
    expect(normalizeShapeStyle({ fillOpacity: 5 }).fillOpacity).toBe(1);
    expect(normalizeShapeStyle({ gradientAngle: 400 }).gradientAngle).toBe(40);
    expect(normalizeShapeStyle({ gradientAngle: -90 }).gradientAngle).toBe(270);
    expect(normalizeShapeStyle({ padMm: 999 }).padMm).toBe(40);
  });

  it("refuse un motif de trait inconnu", () => {
    expect(normalizeShapeStyle({ dash: "zigzag" }).dash).toBe("solid");
    for (const d of Object.keys(DASH_LABELS)) {
      expect(normalizeShapeStyle({ dash: d }).dash).toBe(d);
    }
  });

  it("traduit l'alignement vertical en flex", () => {
    expect(vAlignCss("top")).toBe("flex-start");
    expect(vAlignCss("bottom")).toBe("flex-end");
    expect(vAlignCss("middle")).toBe("center");
  });
});

describe("Formes — SVG", () => {
  it("dimensionne le viewBox en millimètres et remplit son conteneur", () => {
    const svg = shapeSvg("rect", 40, 25, {});
    expect(svg).toContain('viewBox="0 0 40 25"');
    expect(svg).toContain('width="100%"');
    expect(svg).toContain('preserveAspectRatio="none"');
  });

  it("convertit l'épaisseur en px vers l'unité du tracé", () => {
    // 1 px CSS = 25,4/96 mm ; le viewBox est en mm, donc le trait doit l'être aussi.
    expect(pxToMm(96)).toBe(25.4);
    // 12 px est le maximum accepté par le modèle : 12 × 25,4/96 = 3,17 mm.
    expect(shapeSvg("rect", 40, 25, { strokeWidth: 12 })).toContain('stroke-width="3.17"');
  });

  it("ne remplit jamais une ligne", () => {
    const svg = shapeSvg("line", 40, 25, { fill: "#ff0000" });
    expect(svg).toContain('fill="none"');
  });

  it("écrit un dégradé avec un identifiant propre à la forme", () => {
    const a = shapeSvg("rect", 40, 25, { fill: "#ff0000", gradient: "linear" }, undefined, "a");
    const b = shapeSvg("rect", 40, 25, { fill: "#ff0000", gradient: "linear" }, undefined, "b");
    expect(a).toContain('id="elium-grad-a"');
    expect(a).toContain("url(#elium-grad-a)");
    // Deux formes de la même page ne doivent pas partager la définition.
    expect(b).toContain('id="elium-grad-b"');
    expect(a).toContain("<linearGradient");
    expect(shapeSvg("rect", 40, 25, { fill: "#ff0000", gradient: "radial" })).toContain("<radialGradient");
  });

  it("porte le motif de tirets et le remplissage evenodd", () => {
    expect(shapeSvg("rect", 40, 25, { dash: "dash", strokeWidth: 2 })).toContain("stroke-dasharray=");
    expect(shapeSvg("donut", 40, 25, {})).toContain('fill-rule="evenodd"');
    expect(shapeSvg("rect", 40, 25, {})).not.toContain("fill-rule");
  });

  it("échappe les couleurs invalides plutôt que d'écrire du balisage", () => {
    const svg = shapeSvg("rect", 40, 25, { fill: '"><script>' });
    expect(svg).not.toContain("<script");
  });

  it("place et tourne la forme avec le même générateur que les encadrés", () => {
    const css = shapeContainerCss({ wrap: "front", x: 10, y: 20, widthMm: 40, rotation: 30 }, {}, 25);
    expect(css).toContain("width:40mm");
    expect(css).toContain("height:25mm");
    expect(css).toContain("position:absolute");
    expect(css).toContain("left:10mm");
    expect(css).toContain("transform:rotate(30deg)");
  });
});

describe("Formes — VML", () => {
  it("convertit le chemin en commandes VML entières", () => {
    const path = vmlPath("M0,0L40,0L40,20L0,20Z", 40, 20);
    // Une commande VML par segment, en unités de la boîte de 21 600, fermée par
    // « x » (fermer le contour) puis « e » (fin du tracé).
    expect(path).toBe("m0,0l21600,0l21600,21600l0,21600xe");
  });

  it("traduit les Béziers et termine par « e »", () => {
    const path = vmlPath(shapePath("ellipse", 40, 20), 40, 20);
    expect(path).toContain("c");
    expect(path.endsWith("e")).toBe(true);
    expect(path).not.toMatch(/\d\.\d/); // VML n'accepte que des entiers
  });
});

describe("Formes — DrawingML", () => {
  it("écrit la géométrie préréglée et sa poignée d'ajustement", () => {
    const xml = shapeDml("roundRect", { widthMm: 40, heightMm: 25 }, {}, "", 7, 20);
    expect(xml).toContain('<a:prstGeom prst="roundRect">');
    expect(xml).toContain('<a:gd name="adj" fmla="val 20000"/>');
    expect(xml).toContain(`cx="${mmToEmu(40)}"`);
    expect(xml).toContain(`cy="${mmToEmu(25)}"`);
  });

  it("ancre hors du flux et passe derrière le texte", () => {
    const front = shapeDml("rect", { wrap: "front", x: 20, y: 30 }, {}, "", 1);
    expect(front).toContain("<wp:anchor");
    expect(front).toContain('behindDoc="0"');
    expect(front).toContain(`<wp:posOffset>${mmToEmu(20)}</wp:posOffset>`);
    const behind = shapeDml("rect", { wrap: "behind" }, {}, "", 1);
    expect(behind).toContain('behindDoc="1"');
    expect(behind).toContain("<wp:wrapNone/>");
    expect(shapeDml("rect", { wrap: "square" }, {}, "", 1)).toContain("<wp:wrapSquare");
    // Dans le flux : `wp:inline`, pas d'ancre.
    const inline = shapeDml("rect", { wrap: "inline" }, {}, "", 1);
    expect(inline).toContain("<wp:inline");
    expect(inline).not.toContain("<wp:anchor");
  });

  it("porte la rotation en soixantièmes de degré", () => {
    expect(shapeDml("rect", { rotation: 30 }, {}, "", 1)).toContain('<a:xfrm rot="1800000">');
    // Sans rotation, aucun attribut sur le `a:xfrm` (celui du corps de texte,
    // `wps:bodyPr rot="0"`, est un réglage distinct).
    expect(shapeDml("rect", { rotation: 0 }, {}, "", 1)).toContain("<a:xfrm><a:off");
  });

  it("écrit le remplissage, le dégradé, le contour et l'ombre", () => {
    expect(shapeDml("rect", {}, { fill: "" }, "", 1)).toContain("<a:noFill/>");
    expect(shapeDml("rect", {}, { fill: "#ff0000" }, "", 1)).toContain('<a:srgbClr val="FF0000"/>');
    const grad = shapeDml("rect", {}, { fill: "#ff0000", fill2: "#00ff00", gradient: "linear" }, "", 1);
    expect(grad).toContain("<a:gradFill");
    expect(grad).toContain('val="00FF00"');
    expect(shapeDml("rect", {}, { fill: "#ff0000", gradient: "radial" }, "", 1)).toContain('path="circle"');
    expect(shapeDml("rect", {}, { strokeWidth: 0 }, "", 1)).toContain("<a:ln><a:noFill/></a:ln>");
    expect(shapeDml("rect", {}, { dash: "dot" }, "", 1)).toContain('<a:prstDash val="sysDot"/>');
    expect(shapeDml("rect", {}, { shadow: true }, "", 1)).toContain("<a:outerShdw");
  });

  it("met une pointe de flèche sur les lignes fléchées, et rien sur une droite", () => {
    expect(shapeDml("arrow", {}, {}, "", 1)).toContain("<a:tailEnd");
    expect(shapeDml("doubleArrow", {}, {}, "", 1)).toContain("<a:headEnd");
    expect(shapeDml("line", {}, {}, "", 1)).not.toContain("tailEnd");
  });

  it("n'écrit pas de zone de texte dans une ligne", () => {
    const inner = "<w:p><w:r><w:t>Bonjour</w:t></w:r></w:p>";
    expect(shapeDml("rect", {}, {}, inner, 1)).toContain("<w:txbxContent>");
    expect(shapeDml("line", {}, {}, inner, 1)).not.toContain("txbxContent");
    // Pas de `txBox="1"` : ce drapeau désigne une VRAIE zone de texte de Word, et
    // le poser ferait revenir toutes nos formes en encadrés à la relecture.
    expect(shapeDml("rect", {}, {}, inner, 1)).not.toContain('txBox="1"');
  });

  it("aligne le texte verticalement comme à l'écran", () => {
    expect(shapeDml("rect", {}, { vAlign: "top" }, "<w:p/>", 1)).toContain('anchor="t"');
    expect(shapeDml("rect", {}, { vAlign: "bottom" }, "<w:p/>", 1)).toContain('anchor="b"');
    expect(shapeDml("rect", {}, { vAlign: "middle" }, "<w:p/>", 1)).toContain('anchor="ctr"');
  });

  it("écrit les deux branches d'un AlternateContent", () => {
    const xml = shapeXml("star5", { widthMm: 30, heightMm: 30 }, {}, "<w:p/>", 3);
    expect(xml).toContain("<mc:AlternateContent>");
    expect(xml).toContain('<mc:Choice Requires="wps">');
    expect(xml).toContain('prst="star5"');
    expect(xml).toContain("<mc:Fallback>");
    expect(xml).toContain("<v:shape");
    expect(xml).toContain("EliumShape3");
  });

  it("écrit un repli VML au même tracé, avec l'habillage", () => {
    const vml = shapeVml("star5", { wrap: "behind", widthMm: 30, heightMm: 30 }, {}, "", "s1");
    expect(vml).toContain('coordsize="21600,21600"');
    expect(vml).toContain("z-index:-251658240");
    expect(vml).toContain('<w10:wrap type="none"/>');
    expect(vml).toContain('path="m');
  });

  it("convertit les EMU dans les deux sens", () => {
    expect(mmToEmu(25.4)).toBe(914400);
    expect(emuToMm(914400)).toBe(25.4);
  });

  it("reconnaît les motifs de trait de Word", () => {
    expect(dashFromOoxml("sysDot")).toBe("dot");
    expect(dashFromOoxml("lgDash")).toBe("longDash");
    // Les variantes de Word retombent sur le motif le plus proche, du plus
    // spécifique au plus général.
    expect(dashFromOoxml("dashDotDot")).toBe("dashDot");
    expect(dashFromOoxml("sysDash")).toBe("dash");
    expect(dashFromOoxml("solid")).toBe("solid");
    expect(dashFromOoxml(undefined)).toBe("solid");
  });
});

describe("Formes — export et relecture", () => {
  const p = (t: string): ProseMirrorNode => ({ type: "paragraph", content: [{ type: "text", text: t }] });
  const shape = (attrs: Record<string, unknown>, ...kids: ProseMirrorNode[]): ProseMirrorNode => ({
    type: "shape",
    attrs,
    content: kids,
  });
  const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });
  const model = (d: ProseMirrorNode) => ({
    schema: "elium-doc/1" as const,
    page: {
      format: "A4" as const,
      orientation: "portrait" as const,
      margins: { top: 25, right: 20, bottom: 25, left: 20 },
    },
    doc: d,
  });

  it("rend le même SVG en HTML qu'à l'écran", () => {
    const html = docToHtml(model(doc(shape({ kind: "star5", widthMm: 40, heightMm: 40 }, p("Étoile")))));
    expect(html).toContain("elium-shape");
    expect(html).toContain("<svg");
    expect(html).toContain("Étoile");
    expect(html).toContain("width:40mm");
  });

  it("n'écrit pas de zone de texte HTML pour une ligne", () => {
    const html = docToHtml(model(doc(shape({ kind: "line" }))));
    expect(html).toContain("elium-shape__art");
    expect(html).not.toContain("elium-shape__content");
  });

  it("écrit chaque forme du DOCX avec un identifiant unique", async () => {
    const file = await createEliumFile({
      title: "T",
      profile: "standard",
      doc: doc(shape({ kind: "star5" }, p("A")), shape({ kind: "diamond" }, p("B"))),
    });
    const xml = strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);
    expect(xml.match(/<mc:AlternateContent>/g)).toHaveLength(2);
    expect(xml).toContain('prst="star5"');
    expect(xml).toContain('prst="diamond"');
    // `wp:docPr/@id` doit être unique dans tout le document.
    expect(xml).toContain('<wp:docPr id="1"');
    expect(xml).toContain('<wp:docPr id="2"');
  });

  it("déclare les espaces de noms exigés par DrawingML", async () => {
    const file = await createEliumFile({ title: "T", profile: "standard", doc: doc(shape({ kind: "rect" }, p("A"))) });
    const xml = strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);
    // Sans `mc` et `wps`, Word rejette la partie entière.
    expect(xml).toContain('xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"');
    expect(xml).toContain("wordprocessingShape");
    expect(xml).toContain('mc:Ignorable="wp14"');
  });

  it("retrouve la forme, sa taille et son texte après un aller-retour DOCX", async () => {
    const file = await createEliumFile({
      title: "T",
      profile: "standard",
      doc: doc(
        shape({ kind: "star5", widthMm: 50, heightMm: 30, wrap: "front", x: 20, y: 40, fill: "#ff0000" }, p("Ici")),
      ),
    });
    const back = docxToDoc(docToDocx(file));
    const found = (back.doc.content ?? []).find((n) => n.type === "shape");
    expect(found).toBeTruthy();
    // La géométrie préréglée est ce qui permet de retrouver LA forme, pas
    // seulement sa boîte.
    expect(found!.attrs?.kind).toBe("star5");
    expect(found!.attrs?.widthMm).toBeCloseTo(50, 0);
    expect(found!.attrs?.heightMm).toBeCloseTo(30, 0);
    expect(found!.attrs?.wrap).toBe("front");
    expect(String(found!.attrs?.fill).toLowerCase()).toBe("#ff0000");
    expect(JSON.stringify(found!.content)).toContain("Ici");
  });

  it("relit une zone de texte comme une zone de texte, pas comme une forme", async () => {
    const file = await createEliumFile({
      title: "T",
      profile: "standard",
      doc: doc({ type: "textBox", attrs: { wrap: "square", widthMm: 60 }, content: [p("Encadré")] }),
    });
    const back = docxToDoc(docToDocx(file));
    const found = (back.doc.content ?? []).find((n) => n.type === "textBox" || n.type === "shape");
    expect(found?.type).toBe("textBox");
    expect(JSON.stringify(found?.content)).toContain("Encadré");
  });

  it("conserve la rotation d'un encadré jusqu'à Word et au retour", async () => {
    const file = await createEliumFile({
      title: "T",
      profile: "standard",
      doc: doc({ type: "textBox", attrs: { wrap: "front", rotation: 15 }, content: [p("Tourné")] }),
    });
    const xml = strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);
    expect(xml).toContain("rotation:15");
    const back = docxToDoc(docToDocx(file));
    const found = (back.doc.content ?? []).find((n) => n.type === "textBox");
    expect(found?.attrs?.rotation).toBe(15);
  });

  it("ajoute la rotation à la géométrie commune sans casser les défauts", () => {
    expect(DEFAULT_GEOMETRY.rotation).toBe(0);
    expect(normalizeGeometry({ rotation: 375 }).rotation).toBe(15);
    expect(normalizeGeometry({ rotation: -30 }).rotation).toBe(330);
    // Un tour complet vaut zéro : deux valeurs pour le même angle feraient croire
    // à un changement d'attribut.
    expect(normalizeGeometry({ rotation: 360 }).rotation).toBe(0);
  });
});
