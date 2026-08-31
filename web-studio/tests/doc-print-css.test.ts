import { describe, it, expect } from "vitest";
import { buildStandaloneHtml, docToHtml } from "../src/export/exporters";
import { createEliumFile } from "../src/format/document";
import type { EliumFile, ProseMirrorNode } from "../src/format/types";

const para = (text: string, attrs?: Record<string, unknown>): ProseMirrorNode => ({
  type: "paragraph",
  ...(attrs ? { attrs } : {}),
  content: [{ type: "text", text }],
});
const heading = (level: number, text: string, attrs?: Record<string, unknown>): ProseMirrorNode => ({
  type: "heading",
  attrs: { level, ...(attrs ?? {}) },
  content: [{ type: "text", text }],
});
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
  return createEliumFile({ title: "Doc pagination export", profile: "standard", doc: node });
}

describe("Export PDF/HTML — enchaînements (keepNext/keepLines)", () => {
  it("PRINT_CSS traduit data-keep-next et data-keep-lines en règles de saut de page", async () => {
    // Non-régression du constat P1 : keepNext/keepLines pilotent la
    // pagination écran (Pagination.ts) mais n'avaient aucune traduction dans
    // la feuille imprimée — un titre "solidaire du suivant" pouvait donc se
    // retrouver orphelin en bas de page PDF alors que l'écran l'avait déplacé.
    const html = buildStandaloneHtml(await fileWith(doc(para("contenu"))));
    expect(html).toContain("[data-keep-next]{break-after:avoid-page;page-break-after:avoid}");
    expect(html).toContain("[data-keep-lines]{break-inside:avoid-page;page-break-inside:avoid}");
  });

  it("marque un paragraphe/titre solidaire avec data-keep-next / data-keep-lines", () => {
    const html = docToHtml(
      model(
        doc(
          heading(1, "Titre solidaire", { keepNext: true, keepLines: true }),
          para("lignes solidaires", { keepLines: true }),
          para("normal"),
        ),
      ),
    );
    expect(html).toMatch(/<h1[^>]*data-keep-next="true"[^>]*data-keep-lines="true"[^>]*>Titre solidaire<\/h1>/);
    expect(html).toMatch(/<p[^>]*data-keep-lines="true"[^>]*>lignes solidaires<\/p>/);
    // Le paragraphe normal ne doit porter aucun des deux attributs.
    expect(html).not.toMatch(/<p[^>]*data-keep-(next|lines)[^>]*>normal<\/p>/);
  });

  it("garde le saut de page avant en style en ligne (déjà correct, non régressé)", () => {
    const html = docToHtml(model(doc(para("suivant", { pageBreakBefore: true }))));
    expect(html).toContain("break-before:page");
  });
});
