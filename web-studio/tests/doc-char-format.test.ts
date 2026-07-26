import { describe, it, expect } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import {
  CASE_LABELS, DEFAULT_FONT_SIZE_PX, UNDERLINE_LABELS, parsePx, stepFontSize, transformCase, underlineCss,
} from "../src/editor/charFormat";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { docToHtml } from "../src/export/exporters";
import type { EliumFile, ProseMirrorNode } from "../src/format/types";

const run = (text: string, marks: { type: string; attrs?: Record<string, unknown> }[]): ProseMirrorNode => ({
  type: "text", text, marks,
});
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });
const para = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "paragraph", content });

async function fileWith(node: ProseMirrorNode): Promise<EliumFile> {
  return createEliumFile({ title: "Doc caractères", profile: "standard", doc: node });
}
const documentXml = (file: EliumFile) => strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);

describe("Casse — transformations", () => {
  it("met en majuscules et en minuscules, accents compris", () => {
    expect(transformCase("élan Noël", "upper")).toBe("ÉLAN NOËL");
    expect(transformCase("ÉLAN Noël", "lower")).toBe("élan noël");
  });

  it("met une majuscule en début de phrase", () => {
    expect(transformCase("bonjour. ça va ? oui !", "sentence")).toBe("Bonjour. Ça va ? Oui !");
  });

  it("met une majuscule à chaque mot", () => {
    expect(transformCase("le petit chat", "title")).toBe("Le Petit Chat");
    expect(transformCase("porte-parole d'état", "title")).toBe("Porte-Parole D'État");
  });

  it("inverse la casse", () => {
    expect(transformCase("Bonjour MONDE", "toggle")).toBe("bONJOUR monde");
  });

  it("laisse le texte intact pour un mode inconnu", () => {
    expect(transformCase("abc", "inconnu" as never)).toBe("abc");
  });

  it("gère une chaîne vide et la ponctuation seule", () => {
    expect(transformCase("", "upper")).toBe("");
    expect(transformCase("...", "sentence")).toBe("...");
  });

  it("expose un libellé pour chaque mode", () => {
    for (const mode of ["upper", "lower", "sentence", "title", "toggle"] as const) {
      expect(CASE_LABELS[mode]).toBeTruthy();
    }
  });
});

describe("Taille de police — pas à pas", () => {
  it("monte et descend par paliers du sélecteur", () => {
    expect(stepFontSize(16, 1)).toBe(18);
    expect(stepFontSize(16, -1)).toBe(14);
  });

  it("part de la taille par défaut quand rien n'est défini", () => {
    expect(stepFontSize(null, 1)).toBeGreaterThan(DEFAULT_FONT_SIZE_PX);
    expect(stepFontSize(null, -1)).toBeLessThan(DEFAULT_FONT_SIZE_PX);
  });

  it("continue proportionnellement au-delà des paliers", () => {
    expect(stepFontSize(64, 1)).toBe(74);
    expect(stepFontSize(8, -1)).toBe(7);
  });

  it("reste dans des bornes raisonnables", () => {
    expect(stepFontSize(400, 1)).toBeLessThanOrEqual(400);
    expect(stepFontSize(4, -1)).toBeGreaterThanOrEqual(4);
  });

  it("lit une longueur CSS", () => {
    expect(parsePx("14px")).toBe(14);
    expect(parsePx("")).toBeNull();
    expect(parsePx(undefined)).toBeNull();
  });
});

describe("Soulignement — styles", () => {
  it("produit la CSS du style demandé", () => {
    expect(underlineCss("double")).toContain("text-decoration-style:double");
    expect(underlineCss("wavy")).toContain("text-decoration-style:wavy");
    expect(underlineCss("single")).toContain("text-decoration-style:solid");
    expect(underlineCss("none")).toBe("");
  });

  it("expose un libellé pour chaque style", () => {
    for (const s of ["none", "single", "double", "dotted", "dashed", "wavy"] as const) {
      expect(UNDERLINE_LABELS[s]).toBeTruthy();
    }
  });
});

describe("Mise en forme des caractères — export HTML", () => {
  it("écrit exposant et indice en <sup>/<sub>", () => {
    const html = docToHtml({
      schema: "elium-doc/1",
      page: { format: "A4", orientation: "portrait", margins: { top: 25, right: 20, bottom: 25, left: 20 } },
      doc: doc(para(run("2", [{ type: "superscript" }]), run("3", [{ type: "subscript" }]))),
    });
    expect(html).toContain("<sup>2</sup>");
    expect(html).toContain("<sub>3</sub>");
  });

  it("écrit petites majuscules, majuscules, espacement et position", () => {
    const html = docToHtml({
      schema: "elium-doc/1",
      page: { format: "A4", orientation: "portrait", margins: { top: 25, right: 20, bottom: 25, left: 20 } },
      doc: doc(
        para(
          run("a", [{ type: "textStyle", attrs: { smallCaps: true } }]),
          run("b", [{ type: "textStyle", attrs: { allCaps: true } }]),
          run("c", [{ type: "textStyle", attrs: { letterSpacing: "2px" } }]),
          run("d", [{ type: "textStyle", attrs: { textPosition: "3px" } }]),
        ),
      ),
    });
    expect(html).toContain("font-variant-caps:small-caps");
    expect(html).toContain("text-transform:uppercase");
    expect(html).toContain("letter-spacing:2px");
    expect(html).toContain("vertical-align:3px");
  });

  it("combine les décorations en une seule déclaration", () => {
    const html = docToHtml({
      schema: "elium-doc/1",
      page: { format: "A4", orientation: "portrait", margins: { top: 25, right: 20, bottom: 25, left: 20 } },
      doc: doc(para(run("x", [{ type: "textStyle", attrs: { underlineStyle: "wavy", doubleStrike: true } }]))),
    });
    // Une seule text-decoration-line, listant les deux lignes.
    expect(html.match(/text-decoration-line:/g) ?? []).toHaveLength(1);
    expect(html).toContain("text-decoration-line:underline line-through");
  });
});

describe("Mise en forme des caractères — export DOCX", () => {
  it("écrit vertAlign pour exposant et indice", async () => {
    const xml = documentXml(await fileWith(doc(para(run("2", [{ type: "superscript" }]), run("3", [{ type: "subscript" }])))));
    expect(xml).toContain('<w:vertAlign w:val="superscript"/>');
    expect(xml).toContain('<w:vertAlign w:val="subscript"/>');
  });

  it("écrit smallCaps, caps et dstrike", async () => {
    const xml = documentXml(
      await fileWith(
        doc(
          para(
            run("a", [{ type: "textStyle", attrs: { smallCaps: true } }]),
            run("b", [{ type: "textStyle", attrs: { allCaps: true } }]),
            run("c", [{ type: "textStyle", attrs: { doubleStrike: true } }]),
          ),
        ),
      ),
    );
    expect(xml).toContain("<w:smallCaps/>");
    expect(xml).toContain("<w:caps/>");
    expect(xml).toContain("<w:dstrike/>");
  });

  it("convertit l'espacement en vingtièmes de point et la position en demi-points", async () => {
    const xml = documentXml(
      await fileWith(
        doc(
          para(
            run("a", [{ type: "textStyle", attrs: { letterSpacing: "2px" } }]),
            run("b", [{ type: "textStyle", attrs: { textPosition: "4px" } }]),
          ),
        ),
      ),
    );
    // 2px → 1.5pt → 30 vingtièmes ; 4px → 3pt → 6 demi-points.
    expect(xml).toContain('<w:spacing w:val="30"/>');
    expect(xml).toContain('<w:position w:val="6"/>');
  });

  it("écrit le style de soulignement demandé", async () => {
    const xml = documentXml(
      await fileWith(
        doc(para(run("x", [{ type: "underline" }, { type: "textStyle", attrs: { underlineStyle: "wavy" } }]))),
      ),
    );
    expect(xml).toContain('<w:u w:val="wave"/>');
  });

  it("garde le soulignement simple par défaut", async () => {
    const xml = documentXml(await fileWith(doc(para(run("x", [{ type: "underline" }])))));
    expect(xml).toContain('<w:u w:val="single"/>');
  });
});
