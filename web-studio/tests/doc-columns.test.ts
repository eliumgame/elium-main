/**
 * Colonnes de mise en page (ColumnSection, wordExtensions.ts) — fichier dédié
 * (constat d'audit P3 : la fonctionnalité n'avait aucun test propre, seulement
 * des mentions incidentes dans doc-docx-word.test.ts/doc-compare.test.ts).
 * Couvre : les commandes de l'éditeur, le rendu HTML, l'export DOCX (y compris
 * le repli d'un bloc de colonnes imbriqué, que Word ne peut pas exprimer), et
 * la marque de changement en comparaison (constat P2).
 */
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { unzipSync, strFromU8 } from "fflate";
import { ColumnSection, MAX_COLUMNS, MIN_COLUMNS, clampColumns } from "../src/editor/wordExtensions";
import { docToHtml } from "../src/export/exporters";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { compareDocuments, hasChanges } from "../src/editor/compare";
import type { EliumFile, ProseMirrorNode } from "../src/format/types";

const t = (text: string): ProseMirrorNode => ({ type: "text", text });
const para = (text: string): ProseMirrorNode => ({ type: "paragraph", content: [t(text)] });
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

const model = (node: ProseMirrorNode) => ({
  schema: "elium-doc/1" as const,
  page: {
    format: "A4" as const,
    orientation: "portrait" as const,
    margins: { top: 25, right: 20, bottom: 25, left: 20 },
  },
  doc: node,
});

async function fileWith(node: ProseMirrorNode): Promise<EliumFile> {
  return createEliumFile({ title: "Doc colonnes", profile: "standard", doc: node });
}
const partOf = (file: EliumFile, name: string) => strFromU8(unzipSync(docToDocx(file))[name]!);

// =========================================================================
// Commandes de l'éditeur
// =========================================================================

function makeEditor(content: string) {
  return new Editor({ extensions: [StarterKit.configure({ codeBlock: false }), ColumnSection], content });
}

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("Colonnes — commandes de l'éditeur", () => {
  it("setColumns englobe le paragraphe courant dans une section à colonnes", () => {
    editor = makeEditor("<p>alpha</p>");
    editor.commands.setTextSelection(2);
    expect(editor.commands.setColumns({ count: 3, gapMm: 12, separator: true })).toBe(true);
    const json = editor.getJSON();
    const section = json.content!.find((n) => n.type === "columnSection");
    expect(section).toBeDefined();
    expect(section!.attrs).toMatchObject({ count: 3, gapMm: 12, separator: true });
    expect(section!.content![0]!.content![0]!.text).toBe("alpha");
  });

  it("updateColumns modifie la section existante sans la redoubler", () => {
    editor = makeEditor("<p>alpha</p>");
    editor.commands.setTextSelection(2);
    editor.commands.setColumns({ count: 2 });
    editor.commands.updateColumns({ count: 4, separator: true });
    const sections = (editor.getJSON().content ?? []).filter((n) => n.type === "columnSection");
    expect(sections).toHaveLength(1);
    expect(sections[0]!.attrs).toMatchObject({ count: 4, separator: true });
  });

  it("unsetColumns retire la section et rend le contenu au premier niveau", () => {
    editor = makeEditor("<p>alpha</p>");
    editor.commands.setTextSelection(2);
    editor.commands.setColumns({ count: 2 });
    expect(editor.commands.unsetColumns()).toBe(true);
    const json = editor.getJSON();
    expect(json.content!.some((n) => n.type === "columnSection")).toBe(false);
    expect(json.content!.some((n) => n.content?.[0]?.text === "alpha")).toBe(true);
  });

  it("clampColumns borne au créneau [MIN_COLUMNS, MAX_COLUMNS]", () => {
    expect(clampColumns(0)).toBe(MIN_COLUMNS);
    expect(clampColumns(1)).toBe(1);
    expect(clampColumns(MAX_COLUMNS)).toBe(MAX_COLUMNS);
    expect(clampColumns(99)).toBe(MAX_COLUMNS);
    expect(clampColumns(2.6)).toBe(3);
    expect(clampColumns(Number.NaN)).toBe(2); // repli documenté
  });
});

// =========================================================================
// Rendu HTML
// =========================================================================

describe("Colonnes — rendu HTML/export", () => {
  it("rend un column-count/column-gap CSS d'après les attributs", () => {
    const html = docToHtml(model(doc({ type: "columnSection", attrs: { count: 3, gapMm: 12 }, content: [para("x")] })));
    expect(html).toContain('<div class="elium-columns" style="column-count:3;column-gap:12mm">');
  });

  it("ajoute un column-rule quand le séparateur est activé", () => {
    const html = docToHtml(
      model(doc({ type: "columnSection", attrs: { count: 2, gapMm: 8, separator: true }, content: [para("x")] })),
    );
    expect(html).toContain("column-rule:1px solid #cbd5e1");
  });

  it("retombe sur 2 colonnes et 8mm quand les attributs sont absents, et borne un compte excessif", () => {
    const html = docToHtml(model(doc({ type: "columnSection", attrs: { count: 12 }, content: [para("x")] })));
    expect(html).toContain("column-count:4"); // borné à MAX_COLUMNS
    expect(html).toContain("column-gap:8mm"); // repli par défaut
  });

  it("conserve le contenu des colonnes dans le HTML rendu", () => {
    const html = docToHtml(
      model(doc({ type: "columnSection", attrs: { count: 2 }, content: [para("colonne un"), para("colonne deux")] })),
    );
    expect(html).toContain("colonne un");
    expect(html).toContain("colonne deux");
  });
});

// =========================================================================
// Export DOCX
// =========================================================================

describe("Colonnes — export DOCX", () => {
  it("une section de colonnes au premier niveau devient un vrai saut de section w:cols", async () => {
    const xml = partOf(
      await fileWith(doc(para("avant"), { type: "columnSection", attrs: { count: 3 }, content: [para("x")] })),
      "word/document.xml",
    );
    expect(xml).toContain('<w:cols w:num="1"/>'); // ferme la section "avant" à 1 colonne
    expect(xml).toMatch(/<w:cols w:num="3" w:space="\d+"\/>/);
  });

  it("une section de colonnes IMBRIQUÉE (dans un item de liste) s'exporte sans colonnes plutôt que de produire un XML invalide", async () => {
    // Word ne sait exprimer les colonnes qu'au niveau section (premier niveau du
    // corps) : un `w:sectPr` n'est valide que sur un paragraphe de tête de
    // section. Un bloc de colonnes imbriqué (docx.ts:849-855) écrit donc son
    // contenu tel quel, sans colonnes — jamais un `w:sectPr` invalide.
    const nested = doc({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [para("puce"), { type: "columnSection", attrs: { count: 3 }, content: [para("dans la liste")] }],
        },
      ],
    });
    const xml = partOf(await fileWith(nested), "word/document.xml");
    expect(xml).toContain("dans la liste");
    expect(xml).not.toContain("w:cols");
  });
});

// =========================================================================
// Comparaison (constat P2 : le nombre de colonnes doit se voir dans le diff)
// =========================================================================

describe("Colonnes — comparaison de documents", () => {
  const section = (count: number, text: string): ProseMirrorNode => ({
    type: "columnSection",
    attrs: { count, gapMm: 8, separator: false },
    content: [para(text)],
  });

  it("un changement de nombre de colonnes est signalé même si le texte est identique", () => {
    const { doc: merged, summary } = compareDocuments(doc(section(2, "texte")), doc(section(3, "texte")));
    expect(hasChanges(summary)).toBe(true);
    expect(summary.blocksChanged).toBeGreaterThanOrEqual(1);
    expect(merged.content![0]!.attrs).toMatchObject({ count: 3 });
  });

  it("deux sections identiques (mêmes colonnes, même texte) ne sont pas marquées", () => {
    const a = doc(section(2, "texte"));
    const { summary } = compareDocuments(a, structuredClone(a));
    expect(hasChanges(summary)).toBe(false);
  });

  it("un changement de séparateur seul (texte et nombre de colonnes inchangés) est aussi signalé", () => {
    const withSep = (sep: boolean): ProseMirrorNode => ({
      type: "columnSection",
      attrs: { count: 2, gapMm: 8, separator: sep },
      content: [para("texte")],
    });
    const { summary } = compareDocuments(doc(withSep(false)), doc(withSep(true)));
    expect(hasChanges(summary)).toBe(true);
  });
});
