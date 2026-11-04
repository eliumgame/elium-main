import { describe, it, expect, afterEach } from "vitest";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
import { DOCX_LIMITS, docxToDoc, docToDocx } from "../src/format/docx";
import { unzipBoundedSync, unzipCooperative, zipCooperative } from "../src/format/coop-zip";
import { markdownToDoc } from "../src/format/importers";
import { createEliumFile } from "../src/format/document";
import { collectNotesJson } from "../src/editor/notes";
import { withReadableCheckboxes } from "../src/passport/ficheImport";
import { csvSafeCell, parseCsv } from "../src/sheet/csv";
const xml =
  '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Text</w:t></w:r></w:p></w:body></w:document>';
const pkg = (parts: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, strToU8(v)])));
const saved = { ...DOCX_LIMITS };
afterEach(() => Object.assign(DOCX_LIMITS, saved));
function lie(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < bytes.length - 30; i++) {
    if (dv.getUint32(i, true) === 0x04034b50) dv.setUint32(i + 22, 1, true);
    if (i + 46 <= bytes.length && dv.getUint32(i, true) === 0x02014b50) dv.setUint32(i + 24, 1, true);
  }
  return bytes;
}
describe("F-00 bounded ZIP imports", () => {
  it("rejects oversized non-document parts before extracting", () => {
    DOCX_LIMITS.partBytes = 1024;
    expect(() => docxToDoc(pkg({ "word/document.xml": xml, "word/styles.xml": "x".repeat(2048) }))).toThrow(
      /volumineu/,
    );
  });
  it("counts ignored entries in the total budget", () => {
    DOCX_LIMITS.totalBytes = 600;
    expect(() =>
      docxToDoc(pkg({ "word/document.xml": xml, "unused/a.bin": "x".repeat(300), "unused/b.bin": "x".repeat(300) })),
    ).toThrow(/volumineu/);
  });
  it("rejects under-declared inflation in synchronous and cooperative readers", async () => {
    const bytes = lie(pkg({ "word/document.xml": "x".repeat(100000) }));
    expect(() => unzipBoundedSync(bytes)).toThrow(/décompressée/);
    await expect(unzipCooperative(bytes)).rejects.toThrow(/décompressée/);
    expect(() => docxToDoc(bytes)).toThrow(/décompressée/);
  });
  it("reads archives made by the streaming writer with data descriptors", async () => {
    const bytes = await zipCooperative({ one: strToU8("one"), empty: new Uint8Array() });
    expect(strFromU8(unzipBoundedSync(bytes).one)).toBe("one");
    expect((await unzipCooperative(bytes)).empty).toHaveLength(0);
  });
  it("refuses the checkbox preprocessing bomb before rewriting the archive", async () => {
    const bytes = lie(pkg({ "word/document.xml": '<w:sym w:font="Wingdings" w:char="F0FE"/>'.repeat(1000) }));
    await expect(withReadableCheckboxes(new File([bytes as BlobPart], "bad.docx"))).rejects.toThrow(/DOCX/);
  });
});
describe("F-04 bounded Markdown tokenizer", () => {
  it("preserves a 2 MiB unmatched delimiter line without rescanning suffixes", () => {
    const source = "[".repeat(2 * 1024 * 1024);
    expect(markdownToDoc(source).content?.[0].content?.[0].text).toBe(source);
  }, 2000);
  it("keeps formatting and sanitizes links", () => {
    const result = markdownToDoc(
      "**bold** _italic_ ~~strike~~ `code` [ok](https://example.org) [bad](javascript:evil)",
    );
    const nodes = result.content![0].content!;
    expect(nodes.filter((n) => n.marks?.length).map((n) => n.marks![0].type)).toEqual([
      "bold",
      "italic",
      "strike",
      "code",
      "link",
      "link",
    ]);
    expect(nodes.at(-1)?.marks?.[0].attrs?.href).toBe("#");
  });
});
describe("F-03 CSV export", () => {
  it.each(["=1+1", '+HYPERLINK("https://example.org")', "@SUM(A1:A2)", "-cmd|x", "\t=1", "\r=1", "  =1"])(
    "neutralizes %s",
    (value) => {
      expect(parseCsv(csvSafeCell(value))[0][0]).toBe("'" + value);
    },
  );
  it("preserves ordinary numbers and escapes CR and quotes", () => {
    for (const value of ["-12.5", "+12", "-1e3", "ordinary", "a\rb", '"quoted"', "a,b"])
      expect(parseCsv(csvSafeCell(value))[0][0]).toBe(value);
  });
});
describe("F-10 Word notes", () => {
  it("roundtrips footnotes and endnotes with reference order preserved", async () => {
    const file = await createEliumFile({
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "before" },
              { type: "footnote", attrs: { id: "f", text: "Footnote body" } },
              { type: "text", text: "between" },
              { type: "endnote", attrs: { id: "e", text: "Endnote body" } },
              { type: "text", text: "after" },
            ],
          },
        ],
      },
    });
    const imported = docxToDoc(docToDocx(file));
    expect(collectNotesJson(imported.doc, "footnote")[0].text).toBe("Footnote body");
    expect(collectNotesJson(imported.doc, "endnote")[0].text).toBe("Endnote body");
    expect(
      imported.doc.content!.find((p) => p.content?.some((n) => n.type === "footnote"))!.content!.map((n) => n.type),
    ).toEqual(["text", "footnote", "text", "endnote", "text"]);
    expect(imported.warnings).toBeUndefined();
    const second = await createEliumFile({ doc: imported.doc });
    expect(strFromU8(unzipSync(docToDocx(second))["word/footnotes.xml"])).toContain("Footnote body");
  });
  it("warns and keeps a visible placeholder when a note body is missing", () => {
    const imported = docxToDoc(
      pkg({
        "word/document.xml": xml.replace(
          "<w:t>Text</w:t>",
          '<w:t>Before</w:t><w:footnoteReference w:id="7"/><w:t>After</w:t>',
        ),
      }),
    );
    expect(imported.warnings?.join(" ")).toContain("absente");
    expect(collectNotesJson(imported.doc, "footnote")[0].text).toContain("Note absente");
    expect(imported.doc.content![0].content!.map((n) => n.type)).toEqual(["text", "footnote", "text"]);
  });
});
