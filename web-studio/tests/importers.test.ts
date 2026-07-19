import { describe, it, expect } from "vitest";
import { textToDoc, htmlToDoc, importToDoc } from "../src/format/importers";
import type { ProseMirrorNode } from "../src/format/types";

function flatText(node: ProseMirrorNode): string {
  if (node.text) return node.text;
  return (node.content ?? []).map(flatText).join(" ");
}

describe("importers — textToDoc", () => {
  it("makes one paragraph per line (blank lines kept)", () => {
    const doc = textToDoc("Ligne 1\nLigne 2\n\nLigne 4");
    expect(doc.type).toBe("doc");
    expect(doc.content).toHaveLength(4);
    expect(flatText(doc)).toContain("Ligne 1");
    expect(flatText(doc)).toContain("Ligne 4");
  });

  it("normalises CRLF / CR line endings", () => {
    expect(textToDoc("a\r\nb\rc").content).toHaveLength(3);
  });
});

describe("importers — htmlToDoc (node fallback strips tags)", () => {
  it("keeps the text content when DOMParser is unavailable", () => {
    const doc = htmlToDoc("<h1>Titre</h1><p>Corps <b>gras</b></p>");
    const flat = flatText(doc);
    expect(flat).toContain("Titre");
    expect(flat).toContain("Corps");
    expect(flat).toContain("gras");
    expect(flat).not.toContain("<"); // tags removed
  });
});

describe("importers — importToDoc routes by extension", () => {
  it("handles .txt / .md / .html / .htm", () => {
    expect(importToDoc("notes.txt", "hello").type).toBe("doc");
    expect(importToDoc("notes.md", "# Titre\n\nCorps").type).toBe("doc");
    expect(importToDoc("page.html", "<p>x</p>").type).toBe("doc");
    expect(importToDoc("page.htm", "<p>y</p>").type).toBe("doc");
  });

  it("falls back to plain text for unknown extensions", () => {
    const doc = importToDoc("data.unknown", "just text");
    expect(flatText(doc)).toContain("just text");
  });
});
