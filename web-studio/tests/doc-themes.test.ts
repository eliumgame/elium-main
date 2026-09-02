import { describe, it, expect } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { DOC_THEMES, applyDocTheme, findTheme, themeStyleOverrides } from "../src/editor/themes";
import { BUILTIN_STYLES, findStyle, mergeStyles, styleCss } from "../src/editor/styles";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import type { EliumDocStyle, EliumFile, ProseMirrorNode } from "../src/format/types";

const heading = (level: number, text: string): ProseMirrorNode => ({
  type: "heading",
  attrs: { level },
  content: [{ type: "text", text }],
});
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

async function fileWith(node: ProseMirrorNode, styles?: EliumDocStyle[], theme?: string): Promise<EliumFile> {
  const file = await createEliumFile({ title: "Doc thème", profile: "standard", doc: node });
  if (styles) file.document.styles = styles;
  if (theme) file.document.theme = theme;
  return file;
}
const part = (file: EliumFile, name: string) => strFromU8(unzipSync(docToDocx(file))[name]!);

describe("Thèmes — jeu prédéfini", () => {
  it("expose plusieurs thèmes nommés avec des accents distincts", () => {
    expect(DOC_THEMES.length).toBeGreaterThanOrEqual(3);
    const accents = new Set(DOC_THEMES.map((t) => t.accent));
    expect(accents.size).toBe(DOC_THEMES.length);
    for (const t of DOC_THEMES) {
      expect(t.name).toBeTruthy();
      expect(t.accent).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it("findTheme retrouve un thème par id, ou null si inconnu", () => {
    expect(findTheme("ardoise")?.name).toBe("Ardoise");
    expect(findTheme("inexistant")).toBeNull();
  });
});

describe("Thèmes — overrides de style", () => {
  it("recolore les quatre titres et les styles d'accentuation, sans toucher au reste", () => {
    const theme = findTheme("emeraude")!;
    const overrides = themeStyleOverrides(undefined, theme);
    const ids = overrides.map((s) => s.id);
    for (const id of [
      "Titre1",
      "Titre2",
      "Titre3",
      "Titre4",
      "CitationIntense",
      "EmphaseIntense",
      "ReferenceIntense",
    ]) {
      expect(ids).toContain(id);
    }
    for (const s of overrides) expect(s.char?.color).toBe(theme.accent);
    // Un style qui n'est pas dans le thème n'est jamais touché.
    expect(ids).not.toContain("CorpsDeTexte");
  });

  it("préserve les autres propriétés du style d'origine (basé sur le built-in)", () => {
    const theme = findTheme("elium")!;
    const overrides = themeStyleOverrides(undefined, theme);
    const titre1 = overrides.find((s) => s.id === "Titre1")!;
    const builtinTitre1 = findStyle(BUILTIN_STYLES, "Titre1")!;
    expect(titre1.para?.keepNext).toBe(builtinTitre1.para?.keepNext);
    expect(titre1.char?.bold).toBe(builtinTitre1.char?.bold);
    expect(titre1.block).toEqual(builtinTitre1.block);
  });

  it("applique une police de titre quand le thème en définit une", () => {
    const theme = findTheme("ardoise")!;
    expect(theme.headingFont).toBeTruthy();
    const overrides = themeStyleOverrides(undefined, theme);
    for (const id of ["Titre1", "Titre2", "Titre3", "Titre4"]) {
      expect(overrides.find((s) => s.id === id)?.char?.fontFamily).toBe(theme.headingFont);
    }
  });

  it("fusionne dans le style COURANT du document : une personnalisation manuelle (taille, graisse) survit à l'application d'un thème", () => {
    // Non-régression : appliquer un thème ne doit changer que la couleur (et,
    // si le thème en définit une, la police de titre) — pas repartir de zéro
    // depuis BUILTIN_STYLES et donc écraser silencieusement une taille ou une
    // graisse personnalisée par l'utilisateur dans le gestionnaire de styles.
    const custom: EliumDocStyle[] = [
      { id: "Titre1", name: "Titre 1", kind: "paragraph", char: { bold: false, fontSize: 40 } },
    ];
    const theme = findTheme("emeraude")!; // pas de headingFont
    const overrides = themeStyleOverrides(custom, theme);
    const titre1 = overrides.find((s) => s.id === "Titre1")!;
    expect(titre1.char?.bold).toBe(false); // personnalisation utilisateur conservée
    expect(titre1.char?.fontSize).toBe(40); // personnalisation utilisateur conservée
    expect(titre1.char?.color).toBe(theme.accent); // le thème a bien recoloré

    // Et via applyDocTheme (le chemin réellement emprunté par l'UI) aussi.
    const next = applyDocTheme(custom, theme);
    const titre1Next = next.find((s) => s.id === "Titre1")!;
    expect(titre1Next.char?.bold).toBe(false);
    expect(titre1Next.char?.fontSize).toBe(40);
    expect(titre1Next.char?.color).toBe(theme.accent);
  });
});

describe("Thèmes — application au document (persistance)", () => {
  it("applyDocTheme upserte les styles du thème sans effacer les styles personnalisés existants", () => {
    const custom: EliumDocStyle[] = [
      { id: "CorpsDeTexte", name: "Corps de texte", kind: "paragraph", char: { fontSize: 15 } },
    ];
    const next = applyDocTheme(custom, findTheme("aubergine")!);
    expect(next.find((s) => s.id === "CorpsDeTexte")).toEqual(custom[0]);
    expect(next.find((s) => s.id === "Titre1")?.char?.color).toBe("#7c3aed");
  });

  it("ré-appliquer un thème remplace proprement les valeurs du thème précédent", () => {
    const afterFirst = applyDocTheme(undefined, findTheme("ambre")!);
    const afterSecond = applyDocTheme(afterFirst, findTheme("emeraude")!);
    const titre1 = afterSecond.find((s) => s.id === "Titre1");
    expect(titre1?.char?.color).toBe("#047857");
    // Une seule entrée par id : pas d'accumulation de doublons.
    expect(afterSecond.filter((s) => s.id === "Titre1")).toHaveLength(1);
  });

  it("le style effectif (mergeStyles) reflète bien la couleur du thème à l'écran", () => {
    const styles = applyDocTheme(undefined, findTheme("emeraude")!);
    const merged = mergeStyles(styles as never);
    const css = styleCss(findStyle(merged, "Titre2"));
    expect(css).toContain("color:#047857");
  });
});

describe("Thèmes — export DOCX", () => {
  it("le style Titre 1 du styles.xml exporté porte la couleur du thème appliqué", async () => {
    const theme = findTheme("aubergine")!;
    const styles = applyDocTheme(undefined, theme);
    const file = await fileWith(doc(heading(1, "Un titre")), styles, theme.id);
    const xml = part(file, "word/styles.xml");
    expect(xml).toContain('w:styleId="Titre1"');
    // La couleur DOCX est en hex SANS le "#" (voir styles.ts:hex6/styleToDocxXml).
    expect(xml).toContain(`<w:color w:val="${theme.accent.replace("#", "")}"/>`);
  });
});
