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
