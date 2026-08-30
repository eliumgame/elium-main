// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Equation } from "../src/editor/equationExtension";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import { docToHtml, docToMarkdown, docToText } from "../src/export/exporters";
import type { EliumFile, ProseMirrorNode } from "../src/format/types";

const para = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "paragraph", content });
const text = (t: string): ProseMirrorNode => ({ type: "text", text: t });
const equation = (latex: string): ProseMirrorNode => ({ type: "equation", attrs: { latex } });
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
  return createEliumFile({ title: "Doc équation", profile: "standard", doc: node });
}

const documentXml = (file: EliumFile) => strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);

function makeEditor() {
  return new Editor({
    extensions: [StarterKit.configure({ codeBlock: false }), Equation],
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "abc" }] }] },
  });
}

let editor: Editor | null = null;
afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("Équation — insertion et édition (TipTap)", () => {
  it("insertEquation insère un nœud equation portant la source LaTeX", () => {
    editor = makeEditor();
    editor.commands.setTextSelection(1);
    editor.commands.insertEquation("x^2 + y^2 = z^2");
    let found: ProseMirrorNode | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === "equation") found = node.toJSON() as ProseMirrorNode;
    });
    expect(found).not.toBeNull();
    expect((found as unknown as ProseMirrorNode).attrs?.latex).toBe("x^2 + y^2 = z^2");
  });

  it("updateEquation modifie la source d'une équation existante en place", () => {
    editor = makeEditor();
    editor.commands.setTextSelection(1);
    editor.commands.insertEquation("a+b");
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.type.name === "equation") pos = p;
    });
    expect(pos).toBeGreaterThanOrEqual(0);
    editor.commands.updateEquation(pos, "a-b");
    const node = editor.state.doc.nodeAt(pos);
    expect(node?.attrs.latex).toBe("a-b");
  });

  it("updateEquation à une position qui n'est pas une équation est un no-op", () => {
    editor = makeEditor();
    const before = editor.getJSON();
    expect(editor.commands.updateEquation(0, "x")).toBe(false);
    expect(editor.getJSON()).toEqual(before);
  });

  it("la vue du nœud rend vraiment la formule via KaTeX (pas juste la source affichée)", async () => {
    // Vérifie le VRAI chemin de rendu (import() différé + katex.render), pas
    // seulement que la commande pose le bon attribut — voir addNodeView dans
    // equationExtension.ts.
    editor = makeEditor();
    editor.commands.setTextSelection(1);
    editor.commands.insertEquation("x^2");
    let pos = -1;
    editor.state.doc.descendants((node, p) => {
      if (node.type.name === "equation") pos = p;
    });
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
    expect(dom).not.toBeNull();
    // Le rendu KaTeX arrive après le microtask de l'import() dynamique.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(dom!.querySelector(".katex")).not.toBeNull();
  });
});

describe("Équation — repli d'export (source LaTeX, pas de rendu riche)", () => {
  // Non-régression du constat P2 : aucun éditeur d'équations n'existait ; le
  // repli d'export est volontaire (voir editor/equationExtension.ts) — la
  // source LaTeX reste lisible et réimportable plutôt qu'un rendu KaTeX
  // embarquant sa feuille de style et ses polices dans chaque export.
  const LATEX = "\\frac{a}{b}";

  it('HTML : la source LaTeX apparaît, échappée, dans un <code class="elium-equation">', async () => {
    const html = docToHtml(model(doc(para(equation(LATEX)))));
    expect(html).toContain('<code class="elium-equation">\\frac{a}{b}</code>');
  });

  it("Markdown : la source LaTeX apparaît en code inline", () => {
    const md = docToMarkdown(model(doc(para(equation(LATEX)))));
    expect(md).toContain(`\`${LATEX}\``);
  });

  it("texte brut : la source LaTeX apparaît telle quelle", () => {
    const txt = docToText(model(doc(para(equation(LATEX)))));
    expect(txt).toContain(LATEX);
  });

  it("DOCX : la source LaTeX apparaît dans document.xml", async () => {
    const xml = documentXml(await fileWith(doc(para(text("Voir "), equation(LATEX)))));
    expect(xml).toContain(LATEX);
  });

  it("une équation à côté de texte normal n'efface pas ce texte", () => {
    const html = docToHtml(model(doc(para(text("Voir "), equation(LATEX), text(" ci-dessus.")))));
    expect(html).toContain("Voir");
    expect(html).toContain("ci-dessus");
    expect(html).toContain(LATEX);
  });
});
