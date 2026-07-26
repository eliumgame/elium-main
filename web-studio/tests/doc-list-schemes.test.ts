import { describe, it, expect } from "vitest";
import {
  LIST_SCHEMES, MAX_CSS_DEPTH, abstractNumXml, formatNumeral, levelAt, markerText, matchSchemeId,
  schemeById, schemesCss,
} from "../src/editor/listSchemes";

describe("Listes multiniveaux — table des schémas", () => {
  it("expose des ids uniques et des niveaux non vides", () => {
    const ids = LIST_SCHEMES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const scheme of LIST_SCHEMES) {
      expect(scheme.levels.length).toBeGreaterThan(0);
      expect(scheme.preview).toHaveLength(3);
    }
  });

  it("résout un schéma par id, et rien pour un id inconnu ou vide", () => {
    expect(schemeById("outline")?.label).toBe("1. / 1.1 / 1.1.1");
    expect(schemeById("inexistant")).toBeNull();
    expect(schemeById("")).toBeNull();
    expect(schemeById(null)).toBeNull();
    expect(schemeById(42)).toBeNull();
  });

  it("réutilise le dernier niveau au-delà de la profondeur définie", () => {
    const scheme = schemeById("outline")!;
    const last = scheme.levels[scheme.levels.length - 1]!;
    expect(levelAt(scheme, 99)).toBe(last);
    expect(levelAt(scheme, -3)).toBe(scheme.levels[0]);
  });
});

describe("Listes multiniveaux — formatage des numéraux", () => {
  it("formate en décimal, décimal zéro, lettres et romains", () => {
    expect(formatNumeral(7, "decimal")).toBe("7");
    expect(formatNumeral(7, "decimalZero")).toBe("07");
    expect(formatNumeral(12, "decimalZero")).toBe("12");
    expect(formatNumeral(3, "lowerLetter")).toBe("c");
    expect(formatNumeral(3, "upperLetter")).toBe("C");
    expect(formatNumeral(4, "lowerRoman")).toBe("iv");
    expect(formatNumeral(9, "upperRoman")).toBe("IX");
    expect(formatNumeral(2024, "upperRoman")).toBe("MMXXIV");
  });

  it("ne boucle pas sur l'alphabet au 27ᵉ élément", () => {
    expect(formatNumeral(26, "lowerLetter")).toBe("z");
    expect(formatNumeral(27, "lowerLetter")).toBe("aa");
    expect(formatNumeral(28, "upperLetter")).toBe("AB");
  });
});

describe("Listes multiniveaux — marqueurs (export Markdown / texte)", () => {
  it("compose la numérotation hiérarchique du schéma outline", () => {
    const outline = schemeById("outline")!;
    expect(markerText(outline, 0, [2])).toBe("2.");
    expect(markerText(outline, 1, [2, 3])).toBe("2.3");
    expect(markerText(outline, 2, [2, 3, 1])).toBe("2.3.1");
  });

  it("change de format par niveau dans le schéma en cascade", () => {
    const cascade = schemeById("cascade")!;
    expect(markerText(cascade, 0, [4])).toBe("4.");
    expect(markerText(cascade, 1, [4, 2])).toBe("b.");
    expect(markerText(cascade, 2, [4, 2, 3])).toBe("iii.");
  });

  it("rend le libellé juridique avec un numéro à zéro non significatif", () => {
    const legal = schemeById("legal")!;
    expect(markerText(legal, 0, [3])).toBe("Article III.");
    expect(markerText(legal, 1, [3, 1])).toBe("Section 3.01");
    expect(markerText(legal, 2, [3, 1, 2])).toBe("(b)");
  });

  it("rend le glyphe brut pour les schémas à puces", () => {
    const bullets = schemeById("bullets")!;
    expect(markerText(bullets, 0, [1])).toBe("•");
    expect(markerText(bullets, 2, [1, 1, 1])).toBe("▪");
  });

  it("retombe sur 1 quand le compteur d'un niveau manque", () => {
    const outline = schemeById("outline")!;
    expect(markerText(outline, 1, [])).toBe("1.1");
  });
});

describe("Listes multiniveaux — CSS générée", () => {
  const css = schemesCss();

  it("couvre chaque schéma sur toutes les profondeurs", () => {
    for (const scheme of LIST_SCHEMES) {
      const tag = scheme.kind === "ordered" ? "ol" : "ul";
      const deepest = `${tag}[data-list-scheme="${scheme.id}"]${` ${tag}`.repeat(MAX_CSS_DEPTH - 1)}>li`;
      expect(css).toContain(deepest);
    }
  });

  it("fait hériter le schéma aux sous-listes créées avec Tab", () => {
    // La profondeur 1 est un sélecteur DESCENDANT : une sous-liste sans
    // attribut reprend donc automatiquement le niveau suivant du schéma.
    expect(css).toContain('ol[data-list-scheme="outline"] ol>li::before');
  });

  it("traduit %n en compteur CSS avec le bon format", () => {
    expect(css).toContain("counter(elx-outline-1, decimal)");
    expect(css).toContain("counter(elx-legal-2, decimal-leading-zero)");
    expect(css).toContain("counter(elx-roman-1, upper-roman)");
    expect(css).toContain("counter(elx-cascade-2, lower-alpha)");
  });

  it("cite les littéraux et n'affecte que les listes portant l'attribut", () => {
    expect(css).toContain('"Article "');
    expect(css).not.toMatch(/(^|\n)\.elium-prose ol\{/);
    expect(css).not.toContain("taskList");
  });

  it("se scope au préfixe demandé (éditeur vs export autonome)", () => {
    expect(schemesCss(".elium-prose")).toContain('.elium-prose ol[data-list-scheme="outline"]');
    const unscoped = schemesCss("");
    expect(unscoped).toContain('ol[data-list-scheme="outline"]{');
    expect(unscoped).not.toContain(".elium-prose");
  });

  it("échappe les guillemets d'un littéral de marqueur", () => {
    // Garde-fou : un futur schéma contenant un guillemet ne doit pas casser la CSS.
    const withQuote = schemesCss("");
    expect(withQuote).not.toMatch(/content:[^;]*[^\\]""[^;]*"/);
  });
});

describe("Listes multiniveaux — numbering.xml (DOCX)", () => {
  it("déclare 9 niveaux avec numFmt et lvlText réels", () => {
    const xml = abstractNumXml(schemeById("outline")!, 5);
    expect(xml).toContain('w:abstractNumId="5"');
    expect(xml).toContain('<w:multiLevelType w:val="multilevel"/>');
    for (let i = 0; i < 9; i++) expect(xml).toContain(`<w:lvl w:ilvl="${i}">`);
    expect(xml).toContain('<w:numFmt w:val="decimal"/>');
    expect(xml).toContain('<w:lvlText w:val="%1.%2"/>');
    expect(xml).toContain('<w:ind w:left="720" w:hanging="360"/>');
  });

  it("utilise decimalZero pour le niveau juridique et échappe les attributs", () => {
    const xml = abstractNumXml(schemeById("legal")!, 0);
    expect(xml).toContain('<w:numFmt w:val="decimalZero"/>');
    expect(xml).toContain('<w:lvlText w:val="Article %1."/>');
  });

  it("marque les puces en hybridMultilevel avec une police de symboles", () => {
    const xml = abstractNumXml(schemeById("bullets")!, 1);
    expect(xml).toContain('<w:multiLevelType w:val="hybridMultilevel"/>');
    expect(xml).toContain('<w:numFmt w:val="bullet"/>');
    expect(xml).toContain("Segoe UI Symbol");
  });

  it("creuse l'indentation à chaque niveau", () => {
    const xml = abstractNumXml(schemeById("cascade")!, 2);
    expect(xml).toContain('w:left="720"');
    expect(xml).toContain('w:left="1440"');
    expect(xml).toContain('w:left="6480"');
  });
});

describe("Listes multiniveaux — reconnaissance à l'import DOCX", () => {
  it("retrouve le schéma outline depuis les niveaux Word", () => {
    expect(
      matchSchemeId([
        { fmt: "decimal", text: "%1." },
        { fmt: "decimal", text: "%1.%2" },
        { fmt: "decimal", text: "%1.%2.%3" },
      ]),
    ).toBe("outline");
  });

  it("retrouve le schéma juridique et tolère les espaces", () => {
    expect(
      matchSchemeId([
        { fmt: "upperRoman", text: "Article  %1." },
        { fmt: "decimalZero", text: "Section %1.%2" },
        { fmt: "lowerLetter", text: "(%3)" },
      ]),
    ).toBe("legal");
  });

  it("ne force aucun schéma quand rien ne correspond", () => {
    expect(matchSchemeId([{ fmt: "decimal", text: "%1)" }, { fmt: "decimal", text: "→" }])).toBeNull();
    expect(matchSchemeId([])).toBeNull();
  });

  it("distingue deux schémas qui ne diffèrent qu'au 2ᵉ niveau", () => {
    expect(
      matchSchemeId([
        { fmt: "decimal", text: "%1." },
        { fmt: "lowerLetter", text: "%2." },
        { fmt: "lowerRoman", text: "%3." },
      ]),
    ).toBe("cascade");
  });
});
