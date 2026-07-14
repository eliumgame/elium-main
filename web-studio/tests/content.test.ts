import { describe, it, expect, vi } from "vitest";
import { textToDoc, markdownToDoc, htmlToDoc, importToDoc } from "../src/format/importers";
import { docToHtml, docToMarkdown, docToText, buildStandaloneHtml } from "../src/export/exporters";
import { createDocumentModel, createEliumFile } from "../src/format/document";
import { writeEliumPackage, readEliumPackage } from "../src/format/elium-package";
import type { ProseMirrorNode } from "../src/format/types";

const model = (doc: ProseMirrorNode) => createDocumentModel(doc);

describe("importers", () => {
  it("textToDoc splits lines into paragraphs", () => {
    const doc = textToDoc("ligne 1\nligne 2");
    expect(doc.type).toBe("doc");
    expect(doc.content?.length).toBe(2);
    expect(doc.content?.[0].content?.[0].text).toBe("ligne 1");
  });

  it("markdownToDoc parses headings, lists, marks and code fences", () => {
    const doc = markdownToDoc(
      "# Titre\n\nUn **gras** et `code`.\n\n- a\n- b\n\n```python\nprint(1)\n```",
    );
    const types = (doc.content ?? []).map((n) => n.type);
    expect(types).toEqual(["heading", "paragraph", "bulletList", "codeBlock"]);
    expect(doc.content?.[0].attrs?.level).toBe(1);
    const marks = (doc.content?.[1].content ?? []).flatMap((n) => n.marks?.map((m) => m.type) ?? []);
    expect(marks).toContain("bold");
    expect(marks).toContain("code");
    expect(doc.content?.[3].attrs?.language).toBe("python");
  });

  it("htmlToDoc extracts text (DOM walk in browser, tag-strip fallback in node)", () => {
    const doc = htmlToDoc("<h1>Titre</h1><p>Bonjour <strong>monde</strong></p>");
    expect(JSON.stringify(doc)).toContain("Titre");
    expect(JSON.stringify(doc)).toContain("monde");
  });

  it("importToDoc dispatches by extension", () => {
    expect(importToDoc("a.md", "# H").content?.[0].type).toBe("heading");
    expect(importToDoc("a.txt", "# H").content?.[0].type).toBe("paragraph");
  });
});

describe("exporters", () => {
  const doc: ProseMirrorNode = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Titre <x>" }] },
      { type: "paragraph", attrs: { indent: 2 }, content: [{ type: "text", text: "indenté" }] },
      { type: "pageBreak" },
      { type: "paragraph", content: [{ type: "text", text: "lien", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }] },
    ],
  };

  it("docToHtml escapes content, renders indent + page break, strips javascript: links", () => {
    const html = docToHtml(model(doc));
    expect(html).toContain("Titre &lt;x&gt;");
    expect(html).toContain("margin-left:4em");
    expect(html).toContain("page-break-after:always");
    expect(html).toContain('href="#"');
    expect(html).not.toContain("javascript:");
  });

  it("docToText produces clean plain text (no markup)", () => {
    const txt = docToText(model(doc));
    expect(txt).toContain("Titre <x>"); // literal text preserved
    expect(txt).toContain("indenté");
    expect(txt).toContain("lien");
    expect(txt).not.toMatch(/<\/?(p|h1|strong|span|div)/); // but no HTML tags
    expect(txt).not.toContain("margin-left");
  });

  it("docToMarkdown round-trips bold", () => {
    const md = docToMarkdown(markdownToDoc("**gras**") && model(markdownToDoc("**gras**")));
    expect(md).toContain("**gras**");
  });

  it("buildStandaloneHtml is a complete document", () => {
    const html = buildStandaloneHtml({
      manifest: { title: "Doc", language: "fr" } as never,
      document: model(doc), signatures: [], resources: new Map(), resourceIndex: [], journal: { version: 1, events: [] },
    });
    expect(html.startsWith("<!doctype html>")).toBe(true);
  });

  it("footnotes and bookmarks are exported (no silent data loss)", () => {
    const fnDoc: ProseMirrorNode = {
      type: "doc",
      content: [
        { type: "paragraph", content: [
          { type: "text", text: "Affirmation" },
          { type: "footnote", attrs: { id: "f1", text: "Source détaillée" } },
          { type: "bookmark", attrs: { id: "bm1", label: "repère" } },
        ] },
        { type: "footnotesList" },
      ],
    };
    const html = docToHtml(model(fnDoc));
    expect(html).toContain("Source détaillée");
    expect(html).toContain('id="fn-1"');
    expect(html).toContain("fnref-1");
    expect(html).toContain('id="bm1"');
    const md = docToMarkdown(model(fnDoc));
    expect(md).toContain("[^1]");
    expect(md).toContain("[^1]: Source détaillée");
    const txt = docToText(model(fnDoc));
    expect(txt).toContain("[1]");
    expect(txt).toContain("Source détaillée");
  });

  it("buildStandaloneHtml honours page settings (size, header tokens, page numbers)", () => {
    const m = model(doc);
    (m as { page: unknown }).page = {
      format: "A4", orientation: "landscape",
      margins: { top: 10, right: 10, bottom: 10, left: 10 },
      header: "{titre} — interne", footer: "", showPageNumbers: true,
    };
    const html = buildStandaloneHtml({
      manifest: { title: "MonDoc", language: "fr" } as never,
      document: m, signatures: [], resources: new Map(), resourceIndex: [], journal: { version: 1, events: [] },
    });
    expect(html).toContain("@page");
    expect(html).toContain("landscape");
    expect(html).toContain("counter(page)");
    expect(html).toContain("MonDoc — interne"); // {titre} expanded into the running header
  });

  it("table of contents lists headings with anchors matching heading ids", () => {
    const tocDoc: ProseMirrorNode = {
      type: "doc",
      content: [
        { type: "tableOfContents" },
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Intro" }] },
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Détails" }] },
      ],
    };
    const html = docToHtml(model(tocDoc));
    expect(html).toContain('class="elium-toc"');
    expect(html).toContain('href="#toc-h-0"');
    expect(html).toContain('id="toc-h-0"');
    expect(html).toContain('href="#toc-h-1"');
    expect(html).toContain('id="toc-h-1"');
    // Markdown + text render a TOC heading too.
    expect(docToMarkdown(model(tocDoc))).toContain("Table des matières");
    expect(docToText(model(tocDoc))).toContain("Table des matières");
  });

  it("figure renders an image with caption and alignment; comment marks never leak", () => {
    const figDoc: ProseMirrorNode = {
      type: "doc",
      content: [
        { type: "figure", attrs: { src: "data:image/png;base64,AAA", alt: "schéma", align: "right", width: "50%" },
          content: [{ type: "text", text: "Figure 1" }] },
        { type: "paragraph", content: [
          { type: "text", text: "secret", marks: [{ type: "comment", attrs: { id: "c1", author: "Bob", text: "à revoir", resolved: false, createdAt: "" } }] },
        ] },
      ],
    };
    const html = docToHtml(model(figDoc));
    expect(html).toContain("<figure");
    expect(html).toContain("elium-figure--right");
    expect(html).toContain("width:50%");
    expect(html).toContain("<figcaption>Figure 1</figcaption>");
    // The annotated text is exported, but the comment annotation itself is not.
    expect(html).toContain("secret");
    expect(html).not.toContain("data-comment-id");
    expect(html).not.toContain("à revoir");
    expect(docToMarkdown(model(figDoc))).toContain("*Figure 1*");
    expect(docToText(model(figDoc))).toContain("[image: schéma] — Figure 1");
  });
});

describe("rich nodes persist through the .elium package", () => {
  it("table of contents, figure and comment marks round-trip unchanged", async () => {
    const doc: ProseMirrorNode = {
      type: "doc",
      content: [
        { type: "tableOfContents" },
        { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Titre" }] },
        { type: "figure", attrs: { src: "data:image/png;base64,AAA", alt: "img", align: "left", width: "25%" },
          content: [{ type: "text", text: "Légende" }] },
        { type: "paragraph", content: [
          { type: "text", text: "noté", marks: [{ type: "comment", attrs: { id: "c1", author: "A", text: "revoir", resolved: false, createdAt: "2026-01-01T00:00:00Z" } }] },
        ] },
      ],
    };
    const file = await createEliumFile({ title: "Riche", profile: "standard", doc });
    const bytes = await writeEliumPackage(file);
    const { file: reopened } = await readEliumPackage(bytes);
    const json = JSON.stringify(reopened.document.doc);
    expect(json).toContain('"tableOfContents"');
    expect(json).toContain('"figure"');
    expect(json).toContain('"align":"left"');
    expect(json).toContain('"comment"');
    expect(json).toContain('"id":"c1"');
    expect(json).toContain("revoir");
  });

  it("access expiry persists through write/read", async () => {
    const file = await createEliumFile({ title: "Expirable", profile: "standard", doc: textToDoc("x") });
    file.manifest.accessExpiresAt = "2026-12-31T23:59:59Z";
    const bytes = await writeEliumPackage(file);
    const { file: reopened } = await readEliumPackage(bytes);
    expect(reopened.manifest.accessExpiresAt).toBe("2026-12-31T23:59:59Z");
  });
});

describe("local-first", () => {
  it("never touches the network during create/write/read/export", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      throw new Error("network access is forbidden in local-first mode");
    });
    try {
      const file = await createEliumFile({ title: "Local", profile: "standard", doc: textToDoc("contenu local") });
      const bytes = await writeEliumPackage(file);
      const { file: reopened } = await readEliumPackage(bytes);
      docToHtml(reopened.document);
      docToMarkdown(reopened.document);
      docToText(reopened.document);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
