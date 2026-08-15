import { describe, it, expect } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import {
  BUILTIN_STYLES,
  findStyle,
  mergeStyles,
  newStyleId,
  resolveStyle,
  styleAttrs,
  styleCss,
  styleMarks,
  styleTextStyleAttrs,
  styleToDocxXml,
  stylesXml,
  type DocStyle,
} from "../src/editor/styles";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import type { EliumFile, ProseMirrorNode } from "../src/format/types";

const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

async function fileWith(node: ProseMirrorNode, styles?: DocStyle[]): Promise<EliumFile> {
  const file = await createEliumFile({ title: "Doc styles", profile: "standard", doc: node });
  if (styles) file.document.styles = styles as never;
  return file;
}
const part = (file: EliumFile, name: string) => strFromU8(unzipSync(docToDocx(file))[name]!);

describe("Styles — jeu intégré", () => {
  it("expose des ids uniques et un nom pour chacun", () => {
    const ids = BUILTIN_STYLES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of BUILTIN_STYLES) expect(s.name).toBeTruthy();
  });

  it("contient Normal, les quatre titres et des styles de caractère", () => {
    expect(findStyle(BUILTIN_STYLES, "Normal")).toBeTruthy();
    for (const l of [1, 2, 3, 4]) {
      const s = findStyle(BUILTIN_STYLES, `Titre${l}`);
      expect(s?.block).toEqual({ type: "heading", level: l });
    }
    expect(BUILTIN_STYLES.filter((s) => s.kind === "character").length).toBeGreaterThan(2);
  });

  it("marque les intégrés comme non supprimables", () => {
    for (const s of BUILTIN_STYLES) expect(s.builtIn).toBe(true);
  });
});

describe("Styles — fusion avec ceux du document", () => {
  it("ajoute les styles propres au document", () => {
    const merged = mergeStyles([{ id: "Perso", name: "Perso", kind: "paragraph" }]);
    expect(findStyle(merged, "Perso")).toBeTruthy();
    expect(merged.length).toBe(BUILTIN_STYLES.length + 1);
  });

  it("laisse le document redéfinir un style intégré, sans le rendre supprimable", () => {
    const merged = mergeStyles([{ id: "Titre1", name: "Mon Titre 1", kind: "paragraph", char: { fontSize: 40 } }]);
    const t1 = findStyle(merged, "Titre1")!;
    expect(t1.name).toBe("Mon Titre 1");
    expect(t1.char?.fontSize).toBe(40);
    expect(t1.builtIn).toBe(true);
  });

  it("tolère l'absence de styles propres", () => {
    expect(mergeStyles(undefined).length).toBe(BUILTIN_STYLES.length);
  });
});

describe("Styles — héritage basedOn", () => {
  const styles: DocStyle[] = [
    { id: "A", name: "A", kind: "paragraph", char: { fontSize: 12, bold: true }, para: { spaceAfter: 4 } },
    { id: "B", name: "B", kind: "paragraph", basedOn: "A", char: { fontSize: 20 } },
    { id: "C", name: "C", kind: "paragraph", basedOn: "B", para: { align: "center" } },
  ];

  it("écrase la propriété héritée et garde le reste", () => {
    const r = resolveStyle(styles, "B")!;
    expect(r.char?.fontSize).toBe(20);
    expect(r.char?.bold).toBe(true);
    expect(r.para?.spaceAfter).toBe(4);
  });

  it("remonte toute la chaîne", () => {
    const r = resolveStyle(styles, "C")!;
    expect(r.char?.bold).toBe(true);
    expect(r.char?.fontSize).toBe(20);
    expect(r.para?.align).toBe("center");
  });

  it("coupe un cycle au lieu de boucler", () => {
    const cyclic: DocStyle[] = [
      { id: "X", name: "X", kind: "paragraph", basedOn: "Y", char: { bold: true } },
      { id: "Y", name: "Y", kind: "paragraph", basedOn: "X", char: { italic: true } },
    ];
    const r = resolveStyle(cyclic, "X");
    expect(r).toBeTruthy();
    expect(r!.char?.bold).toBe(true);
  });

  it("rend null pour un id inconnu", () => {
    expect(resolveStyle(styles, "inconnu")).toBeNull();
    expect(resolveStyle(styles, null)).toBeNull();
  });
});

describe("Styles — rendu CSS", () => {
  it("traduit les propriétés de caractère et de paragraphe", () => {
    const css = styleCss(
      resolveStyle(
        [
          {
            id: "S",
            name: "S",
            kind: "paragraph",
            char: { bold: true, italic: true, fontSize: 20, color: "#ff0000", smallCaps: true },
            para: { align: "center", spaceAfter: 12, lineHeight: "1.6" },
          },
        ],
        "S",
      ),
    );
    expect(css).toContain("font-weight:700");
    expect(css).toContain("font-style:italic");
    expect(css).toContain("font-size:20px");
    expect(css).toContain("color:#ff0000");
    expect(css).toContain("font-variant-caps:small-caps");
    expect(css).toContain("text-align:center");
    expect(css).toContain("margin-bottom:12px");
    expect(css).toContain("line-height:1.6");
  });

  it("ignore une couleur invalide", () => {
    expect(styleCss({ id: "S", name: "S", kind: "paragraph", char: { color: "rouge" } })).not.toContain("color:");
  });

  it("combine soulignement et barré en une déclaration", () => {
    const css = styleCss({ id: "S", name: "S", kind: "paragraph", char: { underline: true, strike: true } });
    expect(css).toContain("text-decoration-line:underline line-through");
  });

  it("ne produit rien pour un style vide ou nul", () => {
    expect(styleCss(null)).toBe("");
    expect(styleCss({ id: "S", name: "S", kind: "paragraph" })).toBe("");
  });
});

describe("Styles — attributs appliqués", () => {
  it("porte l'id et les propriétés de paragraphe", () => {
    const s = resolveStyle(BUILTIN_STYLES, "Titre1")!;
    const attrs = styleAttrs(s);
    expect(attrs.styleId).toBe("Titre1");
    expect(attrs.spaceBefore).toBe(18);
    expect(attrs.keepNext).toBe(true);
  });

  it("efface explicitement ce que le style ne définit pas", () => {
    // Sans quoi un style « propre » hériterait des réglages du paragraphe visé.
    const attrs = styleAttrs({ id: "S", name: "S", kind: "paragraph" });
    expect(attrs.spaceBefore).toBeNull();
    expect(attrs.shading).toBeNull();
    expect(attrs.textAlign).toBeNull();
  });

  it("traduit la part caractère en attributs de marque", () => {
    const ts = styleTextStyleAttrs(resolveStyle(BUILTIN_STYLES, "ReferenceIntense"));
    expect(ts.smallCaps).toBe(true);
    expect(ts.color).toBe("#1d4ed8");
  });

  it("expose les marques à activer", () => {
    expect(styleMarks(resolveStyle(BUILTIN_STYLES, "EmphaseIntense"))).toMatchObject({ bold: true, italic: true });
    expect(styleMarks(resolveStyle(BUILTIN_STYLES, "MotCle")).highlight).toBe("#fef08a");
    expect(styleMarks(null)).toMatchObject({ bold: false, highlight: null });
  });
});

describe("Styles — identifiants", () => {
  it("dérive un id du nom, sans accents ni espaces", () => {
    expect(newStyleId("Intertitré n°2", [])).toBe("Intertitren2");
  });

  it("évite les collisions", () => {
    const existing: DocStyle[] = [{ id: "Perso", name: "Perso", kind: "paragraph" }];
    expect(newStyleId("Perso", existing)).toBe("Perso2");
  });

  it("retombe sur un nom générique", () => {
    expect(newStyleId("!!!", [])).toBe("Style");
  });
});

describe("Styles — export DOCX", () => {
  it("écrit un w:style par style, avec pPr et rPr", () => {
    const xml = styleToDocxXml(resolveStyle(BUILTIN_STYLES, "Titre1")!);
    expect(xml).toContain('w:styleId="Titre1"');
    expect(xml).toContain("<w:b/>");
    expect(xml).toContain("<w:keepNext/>");
    expect(xml).toMatch(/<w:sz w:val="39"\/>/); // 26px → 39 demi-points
  });

  it("donne aux titres le nom canonique que Word reconnaît", () => {
    // Word identifie ses styles de titre par le NOM, pas par l'id : sans cela
    // le plan, le volet de navigation et sa table des matières les ignorent.
    expect(styleToDocxXml(resolveStyle(BUILTIN_STYLES, "Titre2")!)).toContain('w:name w:val="heading 2"');
    expect(styleToDocxXml(resolveStyle(BUILTIN_STYLES, "Titre2")!)).toContain('<w:outlineLvl w:val="1"/>');
  });

  it("marque Normal comme style par défaut", () => {
    expect(styleToDocxXml(findStyle(BUILTIN_STYLES, "Normal")!)).toContain('w:default="1"');
  });

  it("n'écrit pas de pPr pour un style de caractère", () => {
    const xml = styleToDocxXml(findStyle(BUILTIN_STYLES, "Emphase")!);
    expect(xml).toContain('w:type="character"');
    expect(xml).not.toContain("<w:pPr>");
  });

  it("assemble un styles.xml valide incluant le style de tableau", () => {
    const xml = stylesXml(mergeStyles(undefined));
    expect(xml).toContain("<w:styles");
    expect(xml).toContain('w:styleId="Normal"');
    expect(xml).toContain('w:styleId="TableGrid"');
  });

  it("inclut les styles du document dans le paquet exporté", async () => {
    const file = await fileWith(doc({ type: "paragraph", content: [{ type: "text", text: "x" }] }), [
      { id: "Perso", name: "Mon style", kind: "paragraph", char: { bold: true } },
    ]);
    expect(part(file, "word/styles.xml")).toContain('w:styleId="Perso"');
  });

  it("référence le style du paragraphe par w:pStyle", async () => {
    const file = await fileWith(
      doc({ type: "paragraph", attrs: { styleId: "CorpsDeTexte" }, content: [{ type: "text", text: "x" }] }),
    );
    expect(part(file, "word/document.xml")).toContain('<w:pStyle w:val="CorpsDeTexte"/>');
  });

  it("référence le style de titre, et retombe sur le built-in de son niveau", async () => {
    const file = await fileWith(doc({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "T" }] }));
    expect(part(file, "word/document.xml")).toContain('<w:pStyle w:val="Titre2"/>');
  });

  it("référence un style de caractère par w:rStyle", async () => {
    const file = await fileWith(
      doc({
        type: "paragraph",
        content: [{ type: "text", text: "x", marks: [{ type: "textStyle", attrs: { styleId: "Emphase" } }] }],
      }),
    );
    expect(part(file, "word/document.xml")).toContain('<w:rStyle w:val="Emphase"/>');
  });
});
