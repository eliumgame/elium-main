// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFString } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { PdfEngine } from "../src/pdf/core/engine";
import { buildPdf } from "../src/pdf/ops/save";
import * as D from "../src/pdf/model/doc";
import { emptyState, type Bookmark, type PdfState } from "../src/pdf/model/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

/** Bookmarks: what the file's outline holds survives Elium's edits. */

/** Four pages (page 2's crop box starts at y 100); an outline of every kind of item. */
async function source(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 4; i++) doc.addPage([600, 800]);
  const pages = doc.getPages();
  pages[1].setCropBox(0, 100, 600, 700);
  const ctx = doc.context;
  const item = (title: string, extra: Record<string, unknown>) =>
    ctx.register(ctx.obj({ Title: PDFString.of(title), ...extra } as never));
  const items = [
    item("Site web", { A: { S: "URI", URI: PDFString.of("https://example.org/") } }),
    item("Suivante", { A: { S: "Named", N: "NextPage" } }),
    item("Zoom", { Dest: [pages[1].ref, PDFName.of("XYZ"), 100, 500, 2] }),
    item("Largeur", { Dest: [pages[2].ref, PDFName.of("FitH"), 700], C: [1, 0, 0], F: 2 }),
    item("Chapitre", { Dest: [pages[3].ref, PDFName.of("Fit")] }),
  ];
  const child = item("Section", { Dest: [pages[3].ref, PDFName.of("XYZ"), null, 400, null] });
  const root = ctx.register(ctx.obj({ Type: "Outlines" } as never));
  items.forEach((ref, i) => {
    const d = ctx.lookup(ref) as PDFDict;
    d.set(PDFName.of("Parent"), root);
    if (i > 0) d.set(PDFName.of("Prev"), items[i - 1]);
    if (i < items.length - 1) d.set(PDFName.of("Next"), items[i + 1]);
  });
  const chapter = ctx.lookup(items[4]) as PDFDict;
  chapter.set(PDFName.of("First"), child);
  chapter.set(PDFName.of("Last"), child);
  chapter.set(PDFName.of("Count"), PDFNumber.of(-1));
  (ctx.lookup(child) as PDFDict).set(PDFName.of("Parent"), items[4]);
  const r = ctx.lookup(root) as PDFDict;
  r.set(PDFName.of("First"), items[0]);
  r.set(PDFName.of("Last"), items[4]);
  r.set(PDFName.of("Count"), PDFNumber.of(5));
  doc.catalog.set(PDFName.of("Outlines"), root);
  doc.catalog.set(PDFName.of("PageMode"), PDFName.of("UseThumbs"));
  return doc.save({ useObjectStreams: false });
}

async function read(bytes: Uint8Array): Promise<Bookmark[]> {
  const engine = await PdfEngine.open(bytes);
  try {
    return D.outlineToBookmarks(await engine.outline());
  } finally {
    engine.destroy();
  }
}

/** Each item of the saved outline, as raw PDF: title → its entries. */
async function raw(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const pageNo = (v: unknown) => doc.getPages().findIndex((p) => p.ref === v) + 1;
  const out: Record<string, string> = {};
  const walk = (ref: unknown) => {
    while (ref instanceof PDFRef) {
      const d = doc.context.lookup(ref, PDFDict);
      const title = (d.lookup(PDFName.of("Title")) as PDFString).decodeText();
      const dest = d.lookup(PDFName.of("Dest"));
      const parts = [
        dest instanceof PDFArray
          ? `Dest=p${pageNo(dest.get(0))} ${dest
              .asArray()
              .slice(1)
              .map((v) => v.toString())
              .join(" ")}`
          : "",
        d.get(PDFName.of("A")) ? `A=${d.lookup(PDFName.of("A"))!.toString().replace(/\s+/g, " ")}` : "",
        d.get(PDFName.of("Count")) ? `Count=${d.get(PDFName.of("Count"))}` : "",
        d.get(PDFName.of("C")) ? `C=${d.get(PDFName.of("C"))}` : "",
        d.get(PDFName.of("F")) ? `F=${d.get(PDFName.of("F"))}` : "",
      ];
      out[title] = parts.filter(Boolean).join(" | ");
      walk(d.get(PDFName.of("First")));
      ref = d.get(PDFName.of("Next"));
    }
  };
  walk(doc.catalog.lookup(PDFName.of("Outlines"), PDFDict).get(PDFName.of("First")));
  return { items: out, pageMode: doc.catalog.get(PDFName.of("PageMode"))?.toString() };
}

describe("bookmarks read from the file", () => {
  it("keep their action, view, zoom, style and closed state", async () => {
    const marks = await read(await source());
    const [site, next, zoom, width, chapter] = marks;
    expect(site.action).toEqual({ kind: "uri", url: "https://example.org/" });
    expect(next.action).toEqual({ kind: "named", name: "NextPage" });
    // The crop box of page 2 runs from 100 to 800: top 500 is 300 below its top edge.
    expect(zoom).toMatchObject({ page: 2, fit: "XYZ", x: 100, y: 300, zoom: 2 });
    expect(width).toMatchObject({ page: 3, fit: "FitH", y: 100, bold: true });
    expect(chapter).toMatchObject({ page: 4, fit: "Fit", closed: true, src: "4" });
    expect(chapter.children[0].src).toBe("4.0");
  });
});

describe("saving bookmarks", () => {
  it("collapsing or renaming one leaves every other item as the file had it", async () => {
    const bytes = await source();
    const before = await raw(bytes);
    const marks = await read(bytes);
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(4), bookmarks: marks };
    s = {
      ...s,
      bookmarks: D.mapBookmarks(s.bookmarks!, (b) =>
        b.title === "Chapitre" ? { ...b, closed: false } : b.title === "Zoom" ? { ...b, title: "Zoom ×2" } : b,
      ),
    };
    const after = await raw((await buildPdf(bytes, s)).bytes);
    expect(after.pageMode).toBe("/UseThumbs");
    expect(after.items["Site web"]).toBe(before.items["Site web"]);
    expect(after.items["Suivante"]).toBe(before.items["Suivante"]);
    expect(after.items["Zoom ×2"]).toBe(before.items["Zoom"]);
    expect(after.items["Largeur"]).toBe(before.items["Largeur"]);
    expect(after.items["Section"]).toBe(before.items["Section"]);
    expect(before.items["Chapitre"]).toContain("Count=-1");
    expect(after.items["Chapitre"]).toBe(before.items["Chapitre"].replace("Count=-1", "Count=1"));
  });

  it("a bookmark retargeted or added in Elium lands where it says, crop box origin included", async () => {
    const bytes = await source();
    const marks = await read(bytes);
    const added: Bookmark = { id: "n", title: "Nouveau", page: 2, x: 50, y: 250, fit: "XYZ", zoom: 1.5, children: [] };
    const s: PdfState = {
      ...emptyState(),
      pages: D.pagesFromSource(4),
      bookmarks: [
        ...D.mapBookmarks(marks, (b) =>
          b.title === "Site web" ? { ...b, page: 3, y: 0, fit: "XYZ", action: undefined, retargeted: true } : b,
        ),
        added,
      ],
    };
    const out = (await buildPdf(bytes, s)).bytes;
    const after = await raw(out);
    expect(after.items["Site web"]).toBe("Dest=p3 /XYZ null 800 null");
    expect(after.items["Nouveau"]).toBe("Dest=p2 /XYZ 50 550 1.5");
    // Read back: the same place.
    const again = await read(out);
    expect(again.find((b) => b.title === "Nouveau")).toMatchObject({ page: 2, x: 50, y: 250, zoom: 1.5 });
  });

  it("deleting pages keeps the actions of bookmarks (a web link stays a web link)", async () => {
    const bytes = await source();
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(4), bookmarks: await read(bytes) };
    s = D.deletePages(s, [s.pages[1].id, s.pages[2].id]);
    const after = await raw((await buildPdf(bytes, s)).bytes);
    expect(after.items["Site web"]).toContain("URI");
    expect(after.items["Suivante"]).toContain("NextPage");
    expect(after.items["Chapitre"]).toContain("Dest=p2 /Fit");
  });
});

describe("editing the bookmark tree", () => {
  const mk = (id: string, children: Bookmark[] = []): Bookmark => ({ id, title: id, page: 1, children });
  const shape = (t: Bookmark[]): unknown => t.map((b) => (b.children.length ? [b.id, shape(b.children)] : b.id));
  it("moves a bookmark before, after or inside another, never into its own branch", () => {
    const tree = [mk("a", [mk("a1"), mk("a2")]), mk("b"), mk("c")];
    expect(shape(D.moveBookmark(tree, "c", "a", "before"))).toEqual(["c", ["a", ["a1", "a2"]], "b"]);
    expect(shape(D.moveBookmark(tree, "a1", "b", "after"))).toEqual([["a", ["a2"]], "b", "a1", "c"]);
    expect(shape(D.moveBookmark(tree, "c", "a2", "inside"))).toEqual([["a", ["a1", ["a2", ["c"]]]], "b"]);
    expect(D.moveBookmark(tree, "a", "a1", "inside")).toBe(tree);
  });
});

describe("initial view", () => {
  it("is written as Acrobat's Initial View and read back", async () => {
    const bytes = await source();
    const s: PdfState = {
      ...emptyState(),
      pages: D.pagesFromSource(4),
      initialView: {
        pageMode: "UseOutlines",
        pageLayout: "TwoColumnRight",
        openPage: 3,
        openZoom: 1.5,
        openChanged: true,
        displayDocTitle: true,
        fitWindow: true,
      },
    };
    const out = (await buildPdf(bytes, s)).bytes;
    const engine = await PdfEngine.open(out);
    try {
      expect(await engine.initialView()).toMatchObject({
        pageMode: "UseOutlines",
        pageLayout: "TwoColumnRight",
        openPage: 3,
        openZoom: 1.5,
        displayDocTitle: true,
        fitWindow: true,
      });
    } finally {
      engine.destroy();
    }
  });
});

describe("document attachments", () => {
  it("removes, describes and adds attached files", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    await doc.attach(new TextEncoder().encode("un"), "a.txt", { mimeType: "text/plain", description: "Premier" });
    await doc.attach(new TextEncoder().encode("deux"), "b.txt", { mimeType: "text/plain" });
    const bytes = await doc.save();
    const list = async (b: Uint8Array) => {
      const engine = await PdfEngine.open(b);
      try {
        return (await engine.attachments()).map((a) => [
          a.name,
          a.description ?? "",
          new TextDecoder().decode(a.bytes),
        ]);
      } finally {
        engine.destroy();
      }
    };
    expect(await list(bytes)).toEqual([
      ["a.txt", "Premier", "un"],
      ["b.txt", "", "deux"],
    ]);
    const s: PdfState = {
      ...emptyState(),
      pages: D.pagesFromSource(1),
      attachmentEdits: {
        removed: ["#0"],
        described: { "#1": "Deuxième" },
        added: [{ id: "x", name: "c.txt", mime: "text/plain", data: `data:text/plain;base64,${btoa("trois")}` }],
      },
    };
    expect(await list((await buildPdf(bytes, s)).bytes)).toEqual([
      ["b.txt", "Deuxième", "deux"],
      ["c.txt", "", "trois"],
    ]);
  });
});

describe("named destinations", () => {
  it("removes and adds destinations, the name tree kept sorted and resolvable", async () => {
    const doc = await PDFDocument.create();
    for (let i = 0; i < 3; i++) doc.addPage([600, 800]);
    const ctx = doc.context;
    doc.catalog.set(
      PDFName.of("Names"),
      ctx.obj({
        Dests: {
          Names: [
            PDFString.of("annexe"),
            [doc.getPage(2).ref, PDFName.of("Fit")],
            PDFString.of("debut"),
            [doc.getPage(0).ref, PDFName.of("Fit")],
          ],
        },
      } as never),
    );
    const bytes = await doc.save();
    const s: PdfState = {
      ...emptyState(),
      pages: D.pagesFromSource(3),
    };
    s.destEdits = { removed: ["debut"], added: [{ name: "chapitre", pageId: s.pages[1].id, y: 100 }] };
    const out = (await buildPdf(bytes, s)).bytes;
    const engine = await PdfEngine.open(out);
    try {
      expect(await engine.destinationNames()).toEqual(["annexe", "chapitre"]);
      expect(await engine.resolveDest("chapitre")).toMatchObject({ page: 2, y: 100 });
      expect(await engine.resolveDest("annexe")).toMatchObject({ page: 3 });
    } finally {
      engine.destroy();
    }
  });
});
