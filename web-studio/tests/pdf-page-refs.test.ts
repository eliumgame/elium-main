// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { buildPdf } from "../src/pdf/ops/save";
import * as D from "../src/pdf/model/doc";
import { emptyState, type PdfState } from "../src/pdf/model/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

/** Pages removed or duplicated, and the objects that pointed at them. */

async function source(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  for (let i = 0; i < 4; i++) {
    const p = doc.addPage([600, 800]);
    p.drawText(`Contenu secret de la page ${i + 1}`, { x: 40, y: 760, size: 12, font });
    form.createTextField(`champ${i + 1}`).addToPage(p, { x: 50, y: 50, width: 200, height: 20 });
  }
  const ctx = doc.context;
  const pages = doc.getPages();
  // A bookmark, a named destination, a link and the opening action, all to page 3.
  const item = ctx.register(
    ctx.obj({ Title: PDFString.of("Page trois"), Dest: [pages[2].ref, PDFName.of("Fit")] } as never),
  );
  const outlines = ctx.register(ctx.obj({ Type: "Outlines", First: item, Last: item, Count: 1 } as never));
  (ctx.lookup(item) as PDFDict).set(PDFName.of("Parent"), outlines);
  doc.catalog.set(PDFName.of("Outlines"), outlines);
  doc.catalog.set(PDFName.of("Dests"), ctx.obj({ trois: [pages[2].ref, PDFName.of("Fit")] } as never));
  doc.catalog.set(PDFName.of("OpenAction"), ctx.obj([pages[2].ref, PDFName.of("Fit")]));
  const link = ctx.register(
    ctx.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [40, 700, 200, 720],
      Dest: [pages[2].ref, PDFName.of("Fit")],
    } as never),
  );
  pages[0].node.addAnnot(link);
  return doc.save({ useObjectStreams: false });
}

describe("removed pages leave nothing pointing at them", () => {
  it("drops their fields, retargets bookmarks, removes named destinations and links, and their content", async () => {
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(4) };
    s = D.deletePages(s, [s.pages[2].id]);
    const out = (await buildPdf(await source(), s)).bytes;
    const doc = await PDFDocument.load(out);
    expect(
      doc
        .getForm()
        .getFields()
        .map((f) => f.getName())
        .sort(),
    ).toEqual(["champ1", "champ2", "champ4"]);
    expect(doc.catalog.lookup(PDFName.of("Dests"), PDFDict).get(PDFName.of("trois"))).toBeUndefined();
    const links = (doc.getPage(0).node.Annots() as PDFArray)
      .asArray()
      .map((r) => doc.context.lookup(r, PDFDict))
      .filter((d) => d.lookup(PDFName.of("Subtype"))?.toString() === "/Link");
    expect(links).toHaveLength(0);
    // The bookmark now goes to the page after (the old page 4, now 3); the file opens on page 1.
    const task = pdfjsLib.getDocument({ data: out.slice(), isEvalSupported: false });
    const js = await task.promise;
    const [bm] = (await js.getOutline()) as { title: string; dest: unknown[] }[];
    expect(bm.title).toBe("Page trois");
    expect((await js.getPageIndex(bm.dest[0] as never)) + 1).toBe(3);
    await task.destroy();
    const open = doc.catalog.lookup(PDFName.of("OpenAction"), PDFArray);
    expect(open.get(0).toString()).toBe(doc.getPage(0).ref.toString());
    // The deleted page's content is gone from the file.
    const text = new TextDecoder("latin1").decode(out);
    expect(text).not.toContain("page 3)");
    expect(doc.context.enumerateIndirectObjects().length).toBeLessThan(
      (await PDFDocument.load(await source())).context.enumerateIndirectObjects().length,
    );
  });
});

describe("a duplicated page shares its fields", () => {
  it("adds a widget to the same field (same name, same value)", async () => {
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(4) };
    s = D.duplicatePages(s, [s.pages[0].id]);
    s = D.setFormValue(s, "champ1", "Bonjour");
    const out = (await buildPdf(await source(), s)).bytes;
    const doc = await PDFDocument.load(out);
    expect(doc.getForm().getFields()).toHaveLength(4);
    const task = pdfjsLib.getDocument({ data: out.slice(), isEvalSupported: false });
    const js = await task.promise;
    const objs = (await js.getFieldObjects()) as Record<string, { value?: string; page?: number }[]>;
    const widgets = objs.champ1.filter((o) => o.page !== undefined && o.page >= 0);
    expect(widgets.map((w) => w.page).sort()).toEqual([0, 1]);
    expect(widgets.every((w) => w.value === "Bonjour")).toBe(true);
    await task.destroy();
  });
});

describe("inserting a PDF", () => {
  it("puts its pages where asked, with its fields and its bookmarks", async () => {
    const { appendPdfPages } = await import("../src/pdf/ops/organize");
    const host = await PDFDocument.load(await source());
    const other = await PDFDocument.create();
    const font = await other.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) {
      const p = other.addPage([500, 700]);
      p.drawText(`Annexe ${i + 1}`, { x: 40, y: 650, size: 12, font });
    }
    other.getForm().createTextField("annexe.nom").addToPage(other.getPage(1), { x: 40, y: 40, width: 200, height: 20 });
    const ctx = other.context;
    const item = ctx.register(
      ctx.obj({ Title: PDFString.of("Deuxième annexe"), Dest: [other.getPage(1).ref, PDFName.of("Fit")] } as never),
    );
    const root = ctx.register(ctx.obj({ Type: "Outlines", First: item, Last: item, Count: 1 } as never));
    (ctx.lookup(item) as PDFDict).set(PDFName.of("Parent"), root);
    other.catalog.set(PDFName.of("Outlines"), root);
    const res = await appendPdfPages(host, [{ name: "annexes.pdf", bytes: await other.save() }], undefined, 1);
    expect(res.inserted).toBe(2);
    const out = await host.save();
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(6);
    expect(doc.getPage(1).getSize()).toEqual({ width: 500, height: 700 });
    expect(
      doc
        .getForm()
        .getFields()
        .map((f) => f.getName()),
    ).toContain("annexe.nom");
    const task = pdfjsLib.getDocument({ data: out.slice(), isEvalSupported: false });
    const js = await task.promise;
    const outline = (await js.getOutline()) as {
      title: string;
      dest: unknown[];
      items: { title: string; dest: unknown[] }[];
    }[];
    const top = outline.find((o) => o.title === "annexes")!;
    expect((await js.getPageIndex(top.dest[0] as never)) + 1).toBe(2);
    expect(top.items[0].title).toBe("Deuxième annexe");
    expect((await js.getPageIndex(top.items[0].dest[0] as never)) + 1).toBe(3);
    const fields = (await js.getFieldObjects()) as Record<string, { page?: number }[]>;
    expect(fields["annexe.nom"].some((w) => w.page === 2)).toBe(true);
    await task.destroy();
  });
});

describe("resizePage", () => {
  it("fits the content to the new paper, centred, or only changes the paper", async () => {
    const { resizePage } = await import("../src/pdf/ops/organize");
    const doc = await PDFDocument.create();
    const a = doc.addPage([600, 800]);
    resizePage(a, 300, 300, true);
    expect(a.getCropBox()).toMatchObject({ width: 300, height: 300 });
    // Scale 0.375: content 225 × 300, centred horizontally.
    expect(a.getCropBox().x).toBeCloseTo(-37.5, 3);
    const b = doc.addPage([600, 800]);
    resizePage(b, 800, 1000, false);
    expect(b.getCropBox()).toMatchObject({ x: -100, y: -100, width: 800, height: 1000 });
    // On a page turned 90°, the size asked is the size seen.
    const c = doc.addPage([600, 800]);
    const { degrees } = await import("pdf-lib");
    c.setRotation(degrees(90));
    resizePage(c, 842, 595, true);
    expect(c.getCropBox()).toMatchObject({ width: 595, height: 842 });
  });
});

describe("cropping", () => {
  it("keeps what lies on the page on the same spot of its content", () => {
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    const id = s.pages[0].id;
    s = {
      ...s,
      annots: [
        {
          id: "a",
          pageId: id,
          kind: "square",
          rect: { x: 100, y: 200, w: 50, h: 50 },
          color: "#000000",
          opacity: 1,
          strokeWidth: 1,
          author: "M",
          createdAt: "",
          modifiedAt: "",
          replies: [],
        },
      ],
    };
    s = D.cropPages(s, [id], { top: 30, right: 0, bottom: 0, left: 20 });
    expect(s.annots[0].rect).toEqual({ x: 80, y: 170, w: 50, h: 50 });
    s = D.cropPages(s, [id], null);
    expect(s.annots[0].rect).toEqual({ x: 100, y: 200, w: 50, h: 50 });
  });

  it("turns margins as seen into the unturned page's, and back", () => {
    const seen = { top: 1, right: 2, bottom: 3, left: 4 };
    for (const r of [0, 90, 180, 270]) {
      expect(D.sourceToVisualInsets(D.visualToSourceInsets(seen, r), r)).toEqual(seen);
    }
    // At 90°, the top as seen is the page's left edge.
    expect(D.visualToSourceInsets(seen, 90).left).toBe(1);
  });
});

describe("extracted and split parts stand on their own", () => {
  it("keep fields, labels, the bookmarks in them and the metadata — not what links drag in", async () => {
    const { extractPages, writePageLabels } = await import("../src/pdf/ops/organize");
    const doc = await PDFDocument.load(await source());
    doc.setTitle("Rapport complet");
    writePageLabels(doc, [
      { style: "roman", prefix: "", num: 1 },
      { style: "roman", prefix: "", num: 2 },
      { style: "decimal", prefix: "", num: 1 },
      { style: "decimal", prefix: "", num: 2 },
    ]);
    const out = await extractPages(await doc.save(), [0, 1]);
    const part = await PDFDocument.load(out);
    expect(part.getTitle()).toBe("Rapport complet");
    expect(
      part
        .getForm()
        .getFields()
        .map((f) => f.getName())
        .sort(),
    ).toEqual(["champ1", "champ2"]);
    const task = pdfjsLib.getDocument({ data: out.slice(), isEvalSupported: false });
    const js = await task.promise;
    expect(await js.getPageLabels()).toEqual(["i", "ii"]);
    // The bookmark to page 3 is not in pages 1-2; the link to page 3 went, and so did page 3's content.
    expect(await js.getOutline()).toBeNull();
    await task.destroy();
    expect(new TextDecoder("latin1").decode(out)).not.toContain("page 3)");
  });

  it("splits by size without rebuilding for every page", async () => {
    const { splitDocument } = await import("../src/pdf/ops/organize");
    const big = await PDFDocument.create();
    const font = await big.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 12; i++) {
      const p = big.addPage([600, 800]);
      for (let k = 0; k < 60; k++)
        p.drawText(`Ligne ${k} de la page ${i} ${"x".repeat(40)}`, { x: 20, y: 780 - k * 12, size: 8, font });
    }
    const bytes = await big.save({ useObjectStreams: false });
    const parts = await splitDocument(bytes, { kind: "maxSize", bytes: Math.ceil(bytes.length / 3) }, "doc");
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((p) => p.pages)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    for (const p of parts) expect(p.bytes.length).toBeLessThanOrEqual(Math.ceil(bytes.length / 3) * 1.25);
  });
});
