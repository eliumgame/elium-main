// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { PdfEngine } from "../src/pdf/core/engine";
import { buildPdf } from "../src/pdf/ops/save";
import * as D from "../src/pdf/model/doc";
import { emptyState, type Annot, type PdfState } from "../src/pdf/model/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

/** Defects found by the adversarial review of the navigation work (T6), kept fixed. */

async function withEngine<T>(bytes: Uint8Array, fn: (e: PdfEngine) => Promise<T>): Promise<T> {
  const engine = await PdfEngine.open(bytes);
  try {
    return await fn(engine);
  } finally {
    engine.destroy();
  }
}

describe("layers", () => {
  it("no /Order: every group is listed, flat", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const ctx = doc.context;
    const a = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("A") } as never));
    const b = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("B") } as never));
    doc.catalog.set(PDFName.of("OCProperties"), ctx.obj({ OCGs: [a, b], D: { OFF: [b] } } as never));
    const bytes = await doc.save();
    const rows = await withEngine(bytes, async (e) => {
      return e.layers();
    });
    expect(rows.map((r) => [r.name, r.visible])).toEqual([
      ["A", true],
      ["B", false],
    ]);
  });

  it("save default: a group outside /Order keeps its default", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    const ctx = doc.context;
    const a = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("A") } as never));
    const hidden = ctx.register(ctx.obj({ Type: "OCG", Name: PDFString.of("PrintOnly") } as never));
    doc.catalog.set(
      PDFName.of("OCProperties"),
      ctx.obj({ OCGs: [a, hidden], D: { Order: [a], OFF: [hidden] } } as never),
    );
    const bytes = await doc.save();
    const rows = await withEngine(bytes, (e) => e.layers());
    // what the UI does
    const ocDefaults = Object.fromEntries(rows.filter((l) => !l.heading).map((l) => [l.id, l.visible]));
    const s: PdfState = { ...emptyState(), pages: D.pagesFromSource(1), ocDefaults };
    const out = (await buildPdf(bytes, s)).bytes;
    const vis = await withEngine(out, async (e) => {
      const cfg = await e.raw.getOptionalContentConfig();
      return (cfg as any).isVisible ? [...(cfg as any)].map(([id, g]: any) => [id, g.name, g.visible]) : null;
    });
    expect(vis!.find((v: any) => v[1] === "PrintOnly")[2]).toBe(false);
    expect(vis!.find((v: any) => v[1] === "A")[2]).toBe(true);
  });
});

async function attachSource(kids: boolean, names: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage();
  const ctx = doc.context;
  const spec = (n: string, content: string) => {
    const s = ctx.register(ctx.stream(new TextEncoder().encode(content), { Type: "EmbeddedFile" }));
    return ctx.register(
      ctx.obj({ Type: "Filespec", F: PDFString.of(n), UF: PDFHexString.fromText(n), EF: { F: s } } as never),
    );
  };
  const arr: unknown[] = [];
  names.forEach((n, i) => arr.push(PDFHexString.fromText(n), spec(n, `c${i}`)));
  let tree;
  if (kids) {
    const leaf = ctx.register(
      ctx.obj({
        Names: arr,
        Limits: [PDFHexString.fromText(names[0]), PDFHexString.fromText(names[names.length - 1])],
      } as never),
    );
    tree = ctx.obj({ Kids: [leaf] } as never);
  } else tree = ctx.obj({ Names: arr } as never);
  doc.catalog.set(PDFName.of("Names"), ctx.obj({ EmbeddedFiles: tree } as never));
  return doc.save();
}
const list = (b: Uint8Array) =>
  withEngine(b, async (e) => (await e.attachments()).map((a) => [a.key, a.name, new TextDecoder().decode(a.bytes)]));

describe("attachments", () => {
  it("added to a /Kids name tree: listed after reopen", async () => {
    const bytes = await attachSource(true, ["m.txt", "n.txt"]);
    const s: PdfState = {
      ...emptyState(),
      pages: D.pagesFromSource(1),
      attachmentEdits: {
        removed: [],
        described: {},
        added: [{ id: "x", name: "a.txt", mime: "text/plain", data: `data:text/plain;base64,${btoa("new")}` }],
      },
    };
    const out = (await buildPdf(bytes, s)).bytes;
    const l = await list(out);
    expect(l.map((x) => x[1])).toEqual(["a.txt", "m.txt", "n.txt"]);
  });
  it("added to a flat tree: /Names stays sorted", async () => {
    const bytes = await attachSource(false, ["m.txt", "n.txt"]);
    const s: PdfState = {
      ...emptyState(),
      pages: D.pagesFromSource(1),
      attachmentEdits: {
        removed: [],
        described: {},
        added: [{ id: "x", name: "a.txt", mime: "text/plain", data: `data:text/plain;base64,${btoa("new")}` }],
      },
    };
    const out = (await buildPdf(bytes, s)).bytes;
    const back = await PDFDocument.load(out);
    const arr = (
      (back.catalog.lookup(PDFName.of("Names")) as PDFDict).lookup(PDFName.of("EmbeddedFiles")) as PDFDict
    ).lookup(PDFName.of("Names")) as PDFArray;
    const keys: string[] = [];
    for (let i = 0; i < arr.size(); i += 2) keys.push((arr.lookup(i) as PDFHexString).decodeText());
    // pdf-lib lookup by key? use pdf.js getDestination analog: none; show sorted violation
    expect(keys).toEqual(["a.txt", "m.txt", "n.txt"]);
  });
  it("duplicate names: both listed, removing one keeps the other", async () => {
    const bytes = await attachSource(false, ["a.txt", "a.txt"]);
    const before = await list(bytes);
    const s: PdfState = {
      ...emptyState(),
      pages: D.pagesFromSource(1),
      attachmentEdits: { removed: [before[0][0] as string], described: {}, added: [] },
    };
    const out = (await buildPdf(bytes, s)).bytes;
    const back = await PDFDocument.load(out);
    const names = back.catalog.lookup(PDFName.of("Names")) as PDFDict;
    const arr = (names.lookup(PDFName.of("EmbeddedFiles")) as PDFDict).lookup(PDFName.of("Names")) as PDFArray;
    expect(before.length).toBe(2);
    expect(arr.size()).toBe(2);
  });
});

async function pagesSource(n: number): Promise<Uint8Array> {
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
async function linkDests(bytes: Uint8Array) {
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
      return dest instanceof PDFArray ? [widthOf(dest.get(0)), ...dest.asArray().slice(1).map(String)] : null;
    });
  });
}

describe("links to a removed page", () => {
  it("deleted target page: no destination, never another page", async () => {
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(4) };
    const third = s.pages[2].id;
    s = D.addAnnot(s, link(s.pages[0].id, { action: { type: "page", page: 3, pageId: third, fit: "Fit" } }));
    s = D.deletePages(s, [third]);
    const d = await linkDests((await buildPdf(await pagesSource(4), s)).bytes);
    expect(d).toEqual([null]);
  });
  it("excluded target page: no destination either", async () => {
    let s: PdfState = { ...emptyState(), pages: D.pagesFromSource(4) };
    const second = s.pages[1].id;
    s = D.addAnnot(s, link(s.pages[0].id, { action: { type: "page", page: 2, pageId: second, fit: "Fit" } }));
    s = D.setPageSkipped(s, [second], true);
    const d = await linkDests((await buildPdf(await pagesSource(4), s)).bytes);
    expect(d).toEqual([null]);
  });
});

describe("initial view", () => {
  it("a layout change keeps the file's opening action (a script, an exact position)", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    doc.catalog.set(
      PDFName.of("OpenAction"),
      doc.context.obj({ S: "JavaScript", JS: PDFString.of("app.alert(1)") } as never),
    );
    const s: PdfState = {
      ...emptyState(),
      pages: D.pagesFromSource(1),
      initialView: { pageMode: "UseNone", pageLayout: "OneColumn", openPage: 1 },
    };
    const out = await PDFDocument.load((await buildPdf(await doc.save(), s)).bytes);
    expect(String(out.catalog.lookup(PDFName.of("OpenAction")))).toContain("JavaScript");
    expect(String(out.catalog.get(PDFName.of("PageLayout")))).toBe("/OneColumn");
  });
});
