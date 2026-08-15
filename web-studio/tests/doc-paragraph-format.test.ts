import { describe, it, expect } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { bordersCss, paragraphPaginationFlags } from "../src/editor/paragraphFormat";
import { planPages, type MeasuredBlock } from "../src/editor/Pagination";
import { docToDocx } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import type { EliumFile, ProseMirrorNode } from "../src/format/types";

const para = (text: string, attrs?: Record<string, unknown>): ProseMirrorNode => ({
  type: "paragraph",
  ...(attrs ? { attrs } : {}),
  content: [{ type: "text", text }],
});
const doc = (...content: ProseMirrorNode[]): ProseMirrorNode => ({ type: "doc", content });

async function fileWith(node: ProseMirrorNode): Promise<EliumFile> {
  return createEliumFile({ title: "Doc paragraphes", profile: "standard", doc: node });
}
const documentXml = (file: EliumFile) => strFromU8(unzipSync(docToDocx(file))["word/document.xml"]!);

const metrics = { pageContentPx: 100, gapPx: 40, marginLeftPx: 0, marginRightPx: 0 };
const block = (pos: number, height: number, extra: Partial<MeasuredBlock> = {}): MeasuredBlock => ({
  pos,
  height,
  isPageBreak: false,
  ...extra,
});

describe("Paragraphe — bordures", () => {
  it("ne produit rien sans bordure", () => {
    expect(bordersCss(null)).toBe("");
    expect(bordersCss({})).toBe("");
  });

  it("écrit une règle par côté demandé, avec un retrait", () => {
    const css = bordersCss({ top: true, bottom: true, color: "#ff0000", width: 2 });
    expect(css).toContain("border-top:2px solid #ff0000");
    expect(css).toContain("border-bottom:2px solid #ff0000");
    expect(css).not.toContain("border-left");
    expect(css).toContain("padding:");
  });

  it("retombe sur des valeurs saines", () => {
    const css = bordersCss({ left: true, color: "pas-une-couleur", width: -3 });
    expect(css).toContain("border-left:1px solid #cbd5e1");
  });
});

describe("Paragraphe — drapeaux d'enchaînement", () => {
  it("lit les trois drapeaux", () => {
    expect(paragraphPaginationFlags({ keepNext: true, keepLines: true, pageBreakBefore: true })).toEqual({
      keepNext: true,
      keepLines: true,
      pageBreakBefore: true,
    });
  });

  it("répond faux par défaut", () => {
    expect(paragraphPaginationFlags(undefined)).toEqual({ keepNext: false, keepLines: false, pageBreakBefore: false });
    expect(paragraphPaginationFlags({ keepNext: "oui" })).toMatchObject({ keepNext: false });
  });
});

describe("Paragraphe — pagination", () => {
  it("ouvre une page sur « saut de page avant »", () => {
    const plan = planPages([block(0, 20), block(1, 20, { pageBreakBefore: true })], metrics);
    expect(plan.pageCount).toBe(2);
    expect(plan.pageStartByPos.get(1)).toBe(2);
  });

  it("n'ouvre pas de page si le saut avant tombe en début de page", () => {
    const plan = planPages([block(0, 20, { pageBreakBefore: true })], metrics);
    expect(plan.pageCount).toBe(1);
  });

  it("déplace un titre solidaire avec son paragraphe", () => {
    // 70 utilisés, puis un titre de 20 solidaire d'un paragraphe de 40 :
    // 20 tiendrait seul (90 < 100) mais le groupe (60) non → les deux passent.
    const plan = planPages([block(0, 70), block(1, 20, { keepNext: true }), block(2, 40)], metrics);
    expect(plan.pageStartByPos.get(1)).toBe(2);
    expect(plan.pageStartByPos.get(2)).toBe(2);
  });

  it("ne déplace rien quand le groupe tient", () => {
    const plan = planPages([block(0, 20), block(1, 20, { keepNext: true }), block(2, 30)], metrics);
    expect(plan.pageStartByPos.get(1)).toBe(1);
    expect(plan.pageStartByPos.get(2)).toBe(1);
  });

  it("chaîne plusieurs blocs solidaires", () => {
    const plan = planPages(
      [block(0, 60), block(1, 10, { keepNext: true }), block(2, 10, { keepNext: true }), block(3, 40)],
      metrics,
    );
    // Le groupe fait 60 : il ne tient pas dans les 40 restants.
    expect(plan.pageStartByPos.get(1)).toBe(2);
  });

  it("laisse un bloc solidaire en fin de document se poser normalement", () => {
    const plan = planPages([block(0, 20), block(1, 20, { keepNext: true })], metrics);
    expect(plan.pageCount).toBe(1);
  });
});

describe("Paragraphe — export DOCX", () => {
  it("écrit keepNext, keepLines et pageBreakBefore", async () => {
    const xml = documentXml(await fileWith(doc(para("a", { keepNext: true, keepLines: true, pageBreakBefore: true }))));
    expect(xml).toContain("<w:keepNext/>");
    expect(xml).toContain("<w:keepLines/>");
    expect(xml).toContain("<w:pageBreakBefore/>");
  });

  it("convertit l'espacement en twips", async () => {
    const xml = documentXml(await fileWith(doc(para("a", { spaceBefore: 12, spaceAfter: 8 }))));
    // 12px → 180 twips ; 8px → 120 twips.
    expect(xml).toContain('w:before="180"');
    expect(xml).toContain('w:after="120"');
  });

  it("écrit un retrait de première ligne et un retrait négatif", async () => {
    expect(documentXml(await fileWith(doc(para("a", { firstLineIndent: 20 }))))).toContain('w:firstLine="300"');
    expect(documentXml(await fileWith(doc(para("a", { firstLineIndent: -20 }))))).toContain('w:hanging="300"');
  });

  it("écrit les bordures de paragraphe", async () => {
    const xml = documentXml(
      await fileWith(doc(para("a", { borders: { top: true, bottom: true, color: "#ff0000", width: 2 } }))),
    );
    expect(xml).toContain("<w:pBdr>");
    expect(xml).toContain('<w:top w:val="single"');
    expect(xml).toContain('w:color="ff0000"');
  });

  it("écrit la trame de fond du paragraphe", async () => {
    const xml = documentXml(await fileWith(doc(para("a", { shading: "#eef2ff" }))));
    expect(xml).toContain('w:fill="eef2ff"');
  });

  it("n'ajoute rien pour un paragraphe sans réglage", async () => {
    const xml = documentXml(await fileWith(doc(para("a"))));
    expect(xml).not.toContain("<w:keepNext/>");
    expect(xml).not.toContain("<w:pBdr>");
    expect(xml).not.toContain("<w:spacing");
  });
});
