import { describe, it, expect } from "vitest";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";
import { docToDocx, docxToDoc } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import type { EliumFile, ProseMirrorNode } from "../src/format/types";

// A 1×1 transparent PNG (valid header so imageSize can read dimensions).
const PNG_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const richDoc: ProseMirrorNode = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Titre principal" }] },
    { type: "paragraph", content: [
      { type: "text", text: "Du " },
      { type: "text", text: "gras", marks: [{ type: "bold" }] },
      { type: "text", text: " et de l'" },
      { type: "text", text: "italique", marks: [{ type: "italic" }] },
      { type: "text", text: "." },
    ] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Sous-section" }] },
    { type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "puce A" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "puce B" }] }] },
    ] },
    { type: "orderedList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "étape 1" }] }] },
    ] },
    { type: "paragraph", content: [
      { type: "text", text: "un lien", marks: [{ type: "link", attrs: { href: "https://elium.example/doc" } }] },
    ] },
    { type: "table", content: [
      { type: "tableRow", content: [
        { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Clé" }] }] },
        { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Valeur" }] }] },
      ] },
      { type: "tableRow", content: [
        { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
        { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] },
      ] },
    ] },
    { type: "figure", attrs: { src: PNG_1x1, alt: "pixel", align: "center", width: "" },
      content: [{ type: "text", text: "Figure de test" }] },
    { type: "pageBreak" },
    { type: "paragraph", content: [{ type: "text", text: "après saut de page" }] },
  ],
};

async function fileWith(doc: ProseMirrorNode): Promise<EliumFile> {
  return createEliumFile({ title: "Doc DOCX", profile: "standard", doc });
}

describe("DOCX export", () => {
  it("produces a valid OOXML package with the required parts", async () => {
    const bytes = docToDocx(await fileWith(richDoc));
    const zip = unzipSync(bytes);
    expect(Object.keys(zip)).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "word/styles.xml",
        "word/numbering.xml",
        "word/_rels/document.xml.rels",
      ]),
    );
    const doc = strFromU8(zip["word/document.xml"]);
    expect(doc).toContain("<w:document");
    expect(doc).toContain("Titre principal");
    expect(doc).toContain("<w:b/>");
    expect(doc).toContain("<w:tbl>");
    expect(doc).toContain('<w:br w:type="page"/>');
    // Image embedded as media + hyperlink relationship recorded.
    expect(Object.keys(zip).some((k) => k.startsWith("word/media/image"))).toBe(true);
    const rels = strFromU8(zip["word/_rels/document.xml.rels"]);
    expect(rels).toContain("hyperlink");
    expect(rels).toContain("elium.example");
  });
});

describe("DOCX round-trip (export → import)", () => {
  it("recovers headings, marks, lists, links, tables, figures and page breaks", async () => {
    const bytes = docToDocx(await fileWith(richDoc));
    const { doc } = docxToDoc(bytes);
    const types = (doc.content ?? []).map((n) => n.type);

    // Title heading is emitted first, then the document's own H1.
    expect(types).toContain("heading");
    expect(types).toContain("bulletList");
    expect(types).toContain("orderedList");
    expect(types).toContain("table");
    expect(types).toContain("figure");
    expect(types).toContain("pageBreak");

    const json = JSON.stringify(doc);
    expect(json).toContain("Titre principal");
    expect(json).toContain("gras");
    expect(json).toContain('"bold"');
    expect(json).toContain('"italic"');
    expect(json).toContain("https://elium.example/doc");
    expect(json).toContain('"link"');
    expect(json).toContain("après saut de page");
    expect(json).toContain("data:image/png;base64,");

    // Bullet vs ordered distinguished via numbering.xml.
    const lists = (doc.content ?? []).filter((n) => n.type === "bulletList" || n.type === "orderedList");
    expect(lists.map((l) => l.type)).toContain("bulletList");
    expect(lists.map((l) => l.type)).toContain("orderedList");
  });

  it("imports a minimal external-style docx (heading + paragraph)", () => {
    // Hand-built document.xml as a third-party tool might emit it.
    const docXml =
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body><w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:t>Externe</w:t></w:r></w:p>" +
      "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>gras</w:t></w:r><w:r><w:t> normal</w:t></w:r></w:p>" +
      "</w:body></w:document>";
    // Build a tiny zip with just document.xml.
    const bytes = zipSync({ "word/document.xml": strToU8(docXml) });
    const { doc } = docxToDoc(bytes);
    expect(doc.content?.[0].type).toBe("heading");
    expect(doc.content?.[0].attrs?.level).toBe(1);
    expect(JSON.stringify(doc)).toContain("Externe");
    expect(JSON.stringify(doc)).toContain('"bold"');
  });
});
