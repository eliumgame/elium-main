import { afterEach, describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { DOCX_LIMITS, docToDocx, docxToDoc } from "../src/format/docx";
import { createEliumFile } from "../src/format/document";
import type { ProseMirrorNode } from "../src/format/types";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const png = (padding: number) => {
  const b = Buffer.from(PNG_1X1, "base64");
  return `data:image/png;base64,${Buffer.concat([b, Buffer.alloc(padding, 1)]).toString("base64")}`;
};
const fig = (src: string): ProseMirrorNode => ({
  type: "figure",
  attrs: { src, alt: "", align: "center", width: "" },
  content: [],
});

async function build(srcs: string[]) {
  const doc: ProseMirrorNode = { type: "doc", content: srcs.map(fig) };
  const file = await createEliumFile({ title: "T", profile: "standard", doc });
  return docToDocx(file);
}
const figures = (n: ProseMirrorNode): ProseMirrorNode[] =>
  n.type === "figure" ? [n] : (n.content ?? []).flatMap(figures);

const saved = { ...DOCX_LIMITS };
afterEach(() => Object.assign(DOCX_LIMITS, saved));

describe("import .docx — plafonds", () => {
  it("importe normalement les images sous le plafond, sans avertissement", async () => {
    const out = docxToDoc(await build([png(10), png(20)]));
    expect(figures(out.doc)).toHaveLength(2);
    expect(out.warnings).toBeUndefined();
  });

  it("écarte une image trop volumineuse sans décompresser le reste en moins, avec un avertissement", async () => {
    DOCX_LIMITS.imageBytes = 400;
    const out = docxToDoc(await build([png(10), png(5000)]));
    expect(figures(out.doc)).toHaveLength(1);
    expect(out.warnings?.[0]).toMatch(/1 image trop volumineuse/);
  });

  it("plafonne le cumul des images", async () => {
    DOCX_LIMITS.mediaTotalBytes = 250;
    const out = docxToDoc(await build([png(10), png(20), png(30)]));
    expect(figures(out.doc).length).toBeLessThan(3);
    expect(out.warnings).toBeDefined();
  });

  it("une même image reprise plusieurs fois partage une seule chaîne encodée", async () => {
    const src = png(50);
    const out = docxToDoc(await build([src, src, src]));
    const srcs = figures(out.doc).map((f) => f.attrs!.src as string);
    expect(srcs).toHaveLength(3);
    expect(new Set(srcs).size).toBe(1);
  });

  it("refuse un .docx dont le texte dépasse le plafond, avec un message clair", async () => {
    const bytes = await build([]);
    DOCX_LIMITS.documentXmlBytes = 10;
    expect(() => docxToDoc(bytes)).toThrow(/trop volumineux/);
  });

  it("refuse un fichier trop gros", () => {
    DOCX_LIMITS.fileBytes = 5;
    expect(() => docxToDoc(new Uint8Array(10))).toThrow(/trop volumineux/);
  });

  it("nettoie les sdtPr auto-fermants sans avaler le contenu qui suit", () => {
    const xml =
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      "<w:p><w:r><w:t>avant</w:t></w:r></w:p>" +
      '<w:sdt><w:sdtPr w:rsid="1"/><w:sdtContent><w:p><w:r><w:t>dedans</w:t></w:r></w:p></w:sdtContent></w:sdt>' +
      "<w:p><w:r><w:t>après</w:t></w:r></w:p>" +
      "</w:body></w:document>";
    const zip = zipSync({ "word/document.xml": strToU8(xml) });
    const text = JSON.stringify(docxToDoc(zip).doc);
    expect(text).toContain("avant");
    expect(text).toContain("dedans");
    expect(text).toContain("après");
  });
});
