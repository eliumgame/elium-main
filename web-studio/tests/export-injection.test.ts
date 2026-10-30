import { describe, it, expect } from "vitest";
import { buildStandaloneHtml, docToHtml } from "../src/export/exporters";
import { createEliumFile } from "../src/format/document";
import { fontFaceCss } from "../src/format/embedded-fonts";
import { htmlToDoc, markdownToDoc, safeImportHref } from "../src/format/importers";
import type { ProseMirrorNode } from "../src/format/types";

const doc = (...content: ProseMirrorNode[]) => ({
  schema: "elium-doc/1" as const,
  doc: { type: "doc", content } as ProseMirrorNode,
});

describe("Export : champs du document échappés (CLIENT-03)", () => {
  it("échappe le slug (refId) du sommaire", () => {
    const evil = 'x"><img src=x onerror=alert(1)>';
    const html = docToHtml(
      doc({ type: "tableOfContents" } as ProseMirrorNode, {
        type: "heading",
        attrs: { level: 1, refId: evil },
        content: [{ type: "text", text: "T" }],
      }),
    );
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("underlineStyle ne sort pas de l'attribut style", () => {
    const html = docToHtml(
      doc({
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "a",
            marks: [{ type: "textStyle", attrs: { underlineStyle: 'wavy" onmouseover="alert(1)' } }],
          },
        ],
      }),
    );
    expect(html).not.toContain('onmouseover="alert');
  });

  it("les marges sont numériques dans le @page", async () => {
    const file = await createEliumFile({ title: "t", profile: "standard", doc: doc({ type: "paragraph" }).doc });
    (file.document as unknown as { page?: unknown }).page = {
      format: "A4",
      orientation: "portrait",
      margins: { top: "0mm}</style><script>alert(1)</script>", right: 20, bottom: 20, left: 20 },
    };
    const html = buildStandaloneHtml(file);
    expect(html).not.toContain("<script>alert(1)");
  });

  it("le nom de police ne peut pas fermer la balise <style>", () => {
    const css = fontFaceCss([{ family: "A</style><script>x</script>", ext: "ttf", base64: "AA==" }]);
    expect(css).not.toContain("<");
    expect(css).not.toContain(">");
  });
});

describe("Import : liens sûrs (CLIENT-14)", () => {
  it("neutralise javascript:/data: et garde http(s)/mailto/relatifs", () => {
    expect(safeImportHref("javascript:alert(1)")).toBe("#");
    expect(safeImportHref("java\tscript:alert(1)")).toBe("#");
    expect(safeImportHref("data:text/html,x")).toBe("#");
    expect(safeImportHref("https://a.b/c")).toBe("https://a.b/c");
    expect(safeImportHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    expect(safeImportHref("page/x")).toBe("page/x");
  });
  it("appliqué par les importeurs Markdown et HTML", () => {
    expect(JSON.stringify(markdownToDoc("[x](javascript:alert(1))"))).not.toContain("javascript:");
    expect(JSON.stringify(htmlToDoc('<p><a href="javascript:alert(1)">x</a></p>'))).not.toContain("javascript:");
  });
});
