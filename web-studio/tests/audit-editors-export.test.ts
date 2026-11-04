import { describe, it, expect } from "vitest";
import { docToHtml, docToMarkdown, docToText } from "../src/export/exporters";
import { planPages } from "../src/editor/Pagination";
import type { EliumDocumentModel } from "../src/format/types";
describe("audit F exports and pagination", () => {
  it("exports final revision text including generated headings", () => {
    const model = {
      schema: "elium-doc/1",
      page: { format: "A4" as const, orientation: "portrait" as const, margins: { top: 20, right: 20, bottom: 20, left: 20 } },
      doc: {
        type: "doc",
        content: [
          { type: "tableOfContents" },
          {
            type: "heading",
            attrs: { level: 1 },
            content: [
              { type: "text", text: "SECRET", marks: [{ type: "deletion" }] },
              { type: "text", text: "PUBLIC", marks: [{ type: "insertion" }] },
            ],
          },
        ],
      },
    } as EliumDocumentModel;
    for (const exportFn of [docToHtml, docToMarkdown, docToText]) {
      expect(exportFn(model)).not.toContain("SECRET");
      expect(exportFn(model)).toContain("PUBLIC");
    }
    expect(JSON.stringify(model)).toContain("SECRET");
  });
  it("keeps paragraph formatting and dropcap in a single style attribute", () => {
    const model = {
      schema: "elium-doc/1",
      page: { format: "A4" as const, orientation: "portrait" as const, margins: { top: 20, right: 20, bottom: 20, left: 20 } },
      doc: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            attrs: {
              spaceBefore: 12,
              spaceAfter: 18,
              firstLineIndent: -20,
              borders: { top: true, color: "#123456" },
              shading: "#abcdef",
              dropCap: "drop",
              textAlign: "center",
            },
            content: [{ type: "text", text: "Test" }],
          },
        ],
      },
    } as EliumDocumentModel;
    const html = docToHtml(model);
    expect(html.match(/ style=/g)).toHaveLength(1);
    for (const css of [
      "margin-top:12px",
      "margin-bottom:18px",
      "text-indent:-20px",
      "padding-left:20px",
      "border-top:1px solid #123456",
      "background-color:#abcdef",
      "text-align:center",
      "--elium-dropcap:",
    ])
      expect(html).toContain(css);
  });
  it("does not invent unrendered gaps inside oversized blocks", () => {
    const plan = planPages(
      [
        { pos: 0, height: 250, isPageBreak: false },
        { pos: 1, height: 60, isPageBreak: false },
      ],
      { pageContentPx: 100, gapPx: 40, marginLeftPx: 20, marginRightPx: 20 },
    );
    expect(plan.pages.map((p) => p.top)).toEqual([0, 100, 200, 340]);
    expect(plan.spacers).toEqual([{ pos: 1, height: 90 }]);
  });
});
