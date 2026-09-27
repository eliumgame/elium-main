import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName } from "pdf-lib";
import { buildPdf } from "../src/pdf/ops/save";
import * as D from "../src/pdf/model/doc";
import { emptyState, type Annot, type PdfState } from "../src/pdf/model/types";

/** Links drawn in Elium, as saved. */

async function source(n = 3): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i++) doc.addPage([400 + i * 10, 600]);
  return doc.save();
}

function link(pageId: string, extra: Partial<Annot>): Annot {
  const now = new Date().toISOString();
  return {
    id: `an_${Math.random()}`,
    pageId,
    kind: "link",
    rect: { x: 10, y: 10, w: 100, h: 20 },
    color: "#ff0000",
    fill: null,
    opacity: 1,
    strokeWidth: 0,
    author: "a",
    createdAt: now,
    modifiedAt: now,
    replies: [],
    ...extra,
  } as Annot;
}

async function links(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const widthOf = (ref: unknown) =>
    doc
      .getPages()
      .find((p) => p.ref === ref)
      ?.getWidth();
  return doc.getPages().flatMap((p) => {
    const annots = p.node.Annots();
    if (!(annots instanceof PDFArray)) return [];
    return annots.asArray().map((r) => {
      const d = doc.context.lookup(r, PDFDict);
      const dest = d.lookup(PDFName.of("Dest"));
      return {
        dest: dest instanceof PDFArray ? [widthOf(dest.get(0)), ...dest.asArray().slice(1).map(String)] : undefined,
        a: d.lookup(PDFName.of("A"))?.toString().replace(/\s+/g, " "),
        bs: d.lookup(PDFName.of("BS"))?.toString().replace(/\s+/g, " "),
        border: d.lookup(PDFName.of("Border"))?.toString(),
        c: d.lookup(PDFName.of("C"))?.toString(),
        h: d.lookup(PDFName.of("H"))?.toString(),
      };
    });
  });
}

describe("links drawn in Elium", () => {
  it("go to the page they name even after the pages moved, with the view they were given", async () => {
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(3) };
    const third = s.pages[2].id;
    s = D.addAnnot(
      s,
      link(s.pages[0].id, { action: { type: "page", page: 3, pageId: third, fit: "XYZ", y: 100, zoom: 2 } }),
    );
    // The third page moved to the front.
    s = D.reorderPages(s, [third], 0);
    const [l] = await links((await buildPdf(await source(), s)).bytes);
    expect(l.dest).toEqual([420, "/XYZ", "null", "500", "2"]);
  });

  it("an older session's link (a page number only) still works", async () => {
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(3) };
    s = D.addAnnot(s, link(s.pages[0].id, { action: { type: "page", page: 2 } }));
    const [l] = await links((await buildPdf(await source(), s)).bytes);
    expect(l.dest).toEqual([410, "/Fit"]);
  });

  it("writes its look (visible border, style, colour, highlight) and named actions", async () => {
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    s = D.addAnnot(
      s,
      link(s.pages[0].id, {
        action: { type: "named", name: "NextPage" },
        linkStyle: { visible: true, line: "dashed", width: 2, highlight: "O" },
      }),
    );
    s = D.addAnnot(s, link(s.pages[0].id, { action: { type: "url", url: "https://example.org/" } }));
    const [named, url] = await links((await buildPdf(await source(1), s)).bytes);
    expect(named.a).toContain("/S /Named");
    expect(named.a).toContain("/N /NextPage");
    expect(named.bs).toContain("/W 2");
    expect(named.bs).toContain("/S /D");
    expect(named.c).toBe("[ 1 0 0 ]");
    expect(named.h).toBe("/O");
    // Invisible (Acrobat's default): no border, no colour.
    expect(url.border).toBe("[ 0 0 0 ]");
    expect(url.c).toBeUndefined();
    expect(url.a).toContain("https://example.org/");
  });
});
