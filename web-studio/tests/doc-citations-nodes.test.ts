import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { docToDocx } from "../src/format/docx";
import { createEliumFile, createDocumentModel } from "../src/format/document";
import { docToHtml, docToMarkdown, docToText } from "../src/export/exporters";
import { bibliographyStale, buildBibliography, formatCitation, type BibSource } from "../src/editor/citations";
import {
  loadLibrary,
  mergeSources,
  removeSource,
  saveLibrary,
  upsertSource,
  type KeyValueStorage,
} from "../src/editor/sourceLibrary";
import type { ProseMirrorNode } from "../src/format/types";

const src: BibSource = {
  key: "d2020",
  type: "book",
  authors: "Dupont, Marie",
  title: "Le savoir",
  year: "2020",
  publisher: "PUF",
};
const mkDoc = (style: "apa" | "mla", stale = false): ProseMirrorNode => ({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "text", text: "Comme le dit " },
        {
          type: "citation",
          attrs: { source: src, page: "12", text: stale ? "(ancien)" : formatCitation(src, style, "12") },
        },
      ],
    },
    { type: "bibliography", attrs: { style, entries: buildBibliography([src], style) } },
  ],
});

const memory = (): KeyValueStorage & { data: Record<string, string> } => {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) };
};

describe("citations dans le document", () => {
  it("export HTML, Markdown, texte", () => {
    const model = createDocumentModel(mkDoc("apa"));
    const html = docToHtml(model);
    expect(html).toContain('<span class="elium-citation">(Dupont, 2020, p. 12)</span>');
    expect(html).toContain("<h2>Références</h2>");
    expect(html).toContain("<i>Le savoir</i>");
    expect(docToMarkdown(model)).toContain("- Dupont, M. (2020). *Le savoir*. PUF.");
    expect(docToText(model)).toContain("Références\nDupont, M. (2020). Le savoir. PUF.");
  });
  it("DOCX : texte de la citation, titre et paragraphe à retrait suspendu avec italique", async () => {
    const f = await createEliumFile({ title: "C", doc: mkDoc("mla") });
    const xml = strFromU8(unzipSync(docToDocx(f))["word/document.xml"]!);
    expect(xml).toContain("(Dupont 12)");
    expect(xml).toContain("Ouvrages cités");
    expect(xml).toContain('w:hanging="567"');
    expect(xml).toContain("<w:i/>");
  });
  it("détection d'obsolescence selon le style et les citations", () => {
    expect(bibliographyStale(mkDoc("apa") as never, "apa")).toBe(false);
    expect(bibliographyStale(mkDoc("apa") as never, "mla")).toBe(true);
    expect(bibliographyStale(mkDoc("apa", true) as never, "apa")).toBe(true);
  });
});

describe("bibliothèque de sources", () => {
  it("enregistre, recharge, remplace par clé, supprime", () => {
    const st = memory();
    expect(loadLibrary(st)).toEqual([]);
    expect(saveLibrary(upsertSource([], src), st)).toBe(true);
    expect(loadLibrary(st)).toEqual([src]);
    const edited = { ...src, year: "2021" };
    expect(upsertSource([src], edited)).toEqual([edited]);
    expect(removeSource([src], "d2020")).toEqual([]);
  });
  it("stockage absent, bloqué ou corrompu : jamais d'exception", () => {
    expect(loadLibrary(null)).toEqual([]);
    expect(saveLibrary([src], null)).toBe(false);
    const broken: KeyValueStorage = {
      getItem: () => "{pas du json",
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadLibrary(broken)).toEqual([]);
    expect(saveLibrary([src], broken)).toBe(false);
    const junk = memory();
    junk.setItem("elium.bibliography.sources.v1", JSON.stringify([src, 42, { nope: 1 }]));
    expect(loadLibrary(junk)).toEqual([src]);
  });
  it("fusion : les sources du document priment, sans doublon", () => {
    const other = { ...src, key: "x", title: "Autre" };
    expect(mergeSources([src], [{ ...src, title: "Ancien" }, other]).map((s) => s.title)).toEqual([
      "Le savoir",
      "Autre",
    ]);
  });
});
