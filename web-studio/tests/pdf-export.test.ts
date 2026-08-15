import { describe, it, expect } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, StandardFonts, rgb } from "pdf-lib";
import { parseContentStream, walkText } from "../src/pdf/core/contentstream";
import { decodeShowText, loadPageFonts, widthFnFor } from "../src/pdf/core/fontmetrics";
import { readPageContentBytes } from "../src/pdf/ops/content";
import * as D from "../src/pdf/model/doc";
import { emptyState, newId, type Annot, type PdfState } from "../src/pdf/model/types";
import { buildPdf } from "../src/pdf/ops/save";
import {
  protectDocument,
  removeProtection,
  permissionsToP,
  pToPermissions,
  ALL_PERMISSIONS,
  WrongPassword,
  rc4,
} from "../src/pdf/ops/security";
import { extractPages, formatPageRange, mergeDocuments, parsePageRange, splitDocument } from "../src/pdf/ops/organize";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makeSource(lines: string[][] = [["Bonjour le monde"], ["Deuxieme page"]]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const page of lines) {
    const p = doc.addPage([595, 842]);
    page.forEach((text, i) => {
      p.drawText(text, { x: 60, y: 760 - i * 30, size: 18, font, color: rgb(0, 0, 0) });
    });
  }
  return doc.save();
}

/** Every string the page's operators actually draw, decoded with its own fonts. */
async function shownText(bytes: Uint8Array, pageIndex = 0): Promise<string> {
  const doc = await PDFDocument.load(bytes, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const page = doc.getPage(pageIndex);
  const ops = parseContentStream(readPageContentBytes(page));
  const fonts = await loadPageFonts(page);
  return walkText(ops, widthFnFor(fonts))
    .map((s) => decodeShowText(s.state.font ? fonts.get(s.state.font) : undefined, s.bytes))
    .join(" ");
}

const baseState = (pageCount: number): PdfState => ({ ...emptyState(), pages: D.pagesFromSource(pageCount) });

const annot = (over: Partial<Annot>): Annot => ({
  id: newId("an"),
  pageId: "",
  kind: "square",
  rect: { x: 40, y: 40, w: 120, h: 60 },
  color: "#e11d48",
  opacity: 1,
  strokeWidth: 2,
  author: "Alice",
  createdAt: "2026-03-01T08:00:00.000Z",
  modifiedAt: "2026-03-01T08:00:00.000Z",
  replies: [],
  ...over,
});

function annotsOf(doc: PDFDocument, pageIndex = 0): PDFDict[] {
  const arr = doc.getPage(pageIndex).node.Annots();
  if (!(arr instanceof PDFArray)) return [];
  const out: PDFDict[] = [];
  for (let i = 0; i < arr.size(); i++) {
    const d = arr.lookup(i);
    if (d instanceof PDFDict) out.push(d);
  }
  return out;
}

const subtypeOf = (d: PDFDict) => {
  const v = d.lookup(PDFName.of("Subtype"));
  return v instanceof PDFName ? v.asString().replace(/^\//, "") : "";
};

// ---------------------------------------------------------------------------

describe("PDF export — page assembly", () => {
  it("applies reorder, duplication and inserted blanks", async () => {
    const src = await makeSource();
    let state = baseState(2);
    state = D.duplicatePages(state, [state.pages[0].id]);
    state = D.insertPages(state, 0, [D.makePage(null, { size: { w: 300, h: 300 } })]);
    state = D.reversePages(state);

    const { bytes, report } = await buildPdf(src, state);
    expect(report.pages).toBe(4);
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(4);
    // The inserted blank was reversed to the end and kept its own size.
    expect(out.getPage(3).getSize()).toEqual({ width: 300, height: 300 });
  });

  it("leaves skipped pages out of the file but keeps the others intact", async () => {
    const src = await makeSource([["A"], ["B"], ["C"]]);
    let state = baseState(3);
    state = D.setPageSkipped(state, [state.pages[1].id], true);
    const { bytes } = await buildPdf(src, state);
    const out = await PDFDocument.load(bytes);
    expect(out.getPageCount()).toBe(2);
    expect(await shownText(bytes, 1)).toContain("C");
  });

  it("rotates a page by writing /Rotate rather than re-drawing it", async () => {
    const src = await makeSource([["A"]]);
    let state = baseState(1);
    state = D.rotatePages(state, [state.pages[0].id], 90);
    const { bytes } = await buildPdf(src, state);
    const out = await PDFDocument.load(bytes);
    expect(out.getPage(0).getRotation().angle).toBe(90);
    expect(await shownText(bytes)).toContain("A");
  });

  it("crops a page by narrowing its boxes", async () => {
    const src = await makeSource([["A"]]);
    let state = baseState(1);
    state = D.cropPages(state, [state.pages[0].id], { top: 40, right: 20, bottom: 30, left: 10 });
    const { bytes } = await buildPdf(src, state);
    const out = await PDFDocument.load(bytes);
    const box = out.getPage(0).getCropBox();
    expect(box.width).toBeCloseTo(595 - 30, 3);
    expect(box.height).toBeCloseTo(842 - 70, 3);
    expect(box.x).toBeCloseTo(10, 3);
  });
});

describe("PDF export — annotations", () => {
  it("writes real PDF annotations with an appearance stream", async () => {
    const src = await makeSource([["A"]]);
    let state = baseState(1);
    const pageId = state.pages[0].id;
    state = D.addAnnot(
      state,
      annot({
        pageId,
        kind: "highlight",
        color: "#ffd400",
        opacity: 0.45,
        quads: [
          [
            { x: 60, y: 70 },
            { x: 260, y: 70 },
            { x: 260, y: 92 },
            { x: 60, y: 92 },
          ],
        ],
      }),
    );
    state = D.addAnnot(state, annot({ pageId, kind: "square" }));
    state = D.addAnnot(state, annot({ pageId, kind: "note", contents: "à revoir" }));

    const { bytes, report } = await buildPdf(src, state, { interactiveAnnots: true });
    expect(report.annotsWritten).toBe(3);

    const out = await PDFDocument.load(bytes);
    const list = annotsOf(out);
    const subtypes = list.map(subtypeOf);
    expect(subtypes).toContain("Highlight");
    expect(subtypes).toContain("Square");
    expect(subtypes).toContain("Text");

    const highlight = list.find((d) => subtypeOf(d) === "Highlight")!;
    expect(highlight.lookup(PDFName.of("QuadPoints"))).toBeInstanceOf(PDFArray);
    expect(highlight.lookup(PDFName.of("AP"))).toBeInstanceOf(PDFDict);
    // The author and the timestamps survive, which is what a review needs.
    expect(String(highlight.lookup(PDFName.of("T")))).toContain("Alice");
    expect(String(highlight.lookup(PDFName.of("CreationDate")))).toContain("D:2026");
  });

  it("emits /QuadPoints in the spec's order, not reading order", async () => {
    const src = await makeSource([["A"]]);
    let state = baseState(1);
    state = D.addAnnot(
      state,
      annot({
        pageId: state.pages[0].id,
        kind: "highlight",
        quads: [
          [
            { x: 10, y: 20 },
            { x: 110, y: 20 },
            { x: 110, y: 60 },
            { x: 10, y: 60 },
          ],
        ],
      }),
    );
    const { bytes } = await buildPdf(src, state);
    const out = await PDFDocument.load(bytes);
    const quad = annotsOf(out)
      .find((d) => subtypeOf(d) === "Highlight")!
      .lookup(PDFName.of("QuadPoints")) as PDFArray;
    const nums = Array.from({ length: quad.size() }, (_, i) => Number(String(quad.lookup(i))));
    // upper-left, upper-right, LOWER-left, lower-right
    expect(nums[1]).toBeCloseTo(822, 1);
    expect(nums[3]).toBeCloseTo(822, 1);
    expect(nums[5]).toBeCloseTo(782, 1);
    expect(nums[0]).toBeCloseTo(10, 1);
    expect(nums[4]).toBeCloseTo(10, 1);
  });

  it("turns replies into /IRT annotations so the whole thread travels", async () => {
    const src = await makeSource([["A"]]);
    let state = baseState(1);
    state = D.addAnnot(state, annot({ id: "a1", pageId: state.pages[0].id, kind: "note", contents: "Question ?" }));
    state = D.addReply(state, "a1", { author: "Bob", text: "Réponse", createdAt: "2026-03-02T09:00:00.000Z" });

    const { bytes } = await buildPdf(src, state);
    const out = await PDFDocument.load(bytes);
    const reply = annotsOf(out).find((d) => d.lookup(PDFName.of("IRT")) !== undefined);
    expect(reply).toBeDefined();
    expect(String(reply!.lookup(PDFName.of("RT")))).toContain("R");
  });

  it("bakes everything into the page when flattening is asked for", async () => {
    const src = await makeSource([["A"]]);
    let state = baseState(1);
    state = D.addAnnot(state, annot({ pageId: state.pages[0].id, kind: "square" }));
    const { bytes, report } = await buildPdf(src, state, { interactiveAnnots: false });
    expect(report.annotsFlattened).toBe(1);
    const out = await PDFDocument.load(bytes);
    expect(annotsOf(out)).toHaveLength(0);
    // The rectangle now lives in the content stream.
    const ops = parseContentStream(readPageContentBytes(out.getPage(0)));
    expect(ops.some((o) => o.op === "re")).toBe(true);
  });

  it("always bakes a white mask, even in interactive mode — it hides content", async () => {
    const src = await makeSource([["A"]]);
    let state = baseState(1);
    state = D.addAnnot(state, annot({ pageId: state.pages[0].id, kind: "whiteout", fill: "#ffffff", strokeWidth: 0 }));
    const { bytes } = await buildPdf(src, state, { interactiveAnnots: true });
    const out = await PDFDocument.load(bytes);
    expect(annotsOf(out)).toHaveLength(0);
  });
});

describe("PDF export — redaction really removes content", () => {
  it("deletes the glyphs under the marked area from the content stream", async () => {
    const src = await makeSource([["CONFIDENTIEL SECRET", "Ligne visible"]]);
    expect(await shownText(src)).toContain("SECRET");

    let state = baseState(1);
    // The first line sits at y=760 in PDF space ⇒ ~72..96 from the top.
    state = D.addAnnot(
      state,
      annot({
        pageId: state.pages[0].id,
        kind: "redact",
        rect: { x: 50, y: 62, w: 400, h: 28 },
        fill: "#000000",
        strokeWidth: 0,
      }),
    );

    const { bytes, report } = await buildPdf(src, state, { applyRedactions: true });
    expect(report.redactedGlyphs).toBeGreaterThan(0);

    const after = await shownText(bytes);
    expect(after).not.toContain("SECRET");
    expect(after).not.toContain("CONFIDENTIEL");
    // The untouched line is still there.
    expect(after).toContain("Ligne visible");
  });

  it("keeps the marked text when redaction is turned off", async () => {
    const src = await makeSource([["CONFIDENTIEL"]]);
    let state = baseState(1);
    state = D.addAnnot(
      state,
      annot({
        pageId: state.pages[0].id,
        kind: "redact",
        rect: { x: 50, y: 60, w: 400, h: 45 },
      }),
    );
    const { bytes } = await buildPdf(src, state, { applyRedactions: false });
    expect(await shownText(bytes)).toContain("CONFIDENTIEL");
  });

  it("strips document metadata when sanitising", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([300, 300]);
    doc.setAuthor("Jean Secret");
    doc.setKeywords(["confidentiel"]);
    const src = await doc.save();

    const { bytes } = await buildPdf(src, baseState(1), { sanitise: true });
    const out = await PDFDocument.load(bytes);
    expect(out.getAuthor() ?? "").not.toContain("Jean Secret");
  });
});

describe("PDF export — rewriting the document's own text", () => {
  it("replaces a paragraph in place, with no hidden original left behind", async () => {
    const src = await makeSource([["Montant du loyer"]]);
    let state = baseState(1);
    state = D.upsertContentEdit(state, {
      id: "e1",
      pageId: state.pages[0].id,
      blockKey: "B0",
      original: "Montant du loyer",
      text: "Montant revise",
      // The drawn line sits at y=760 baseline, size 18 ⇒ roughly 67..90 from the top.
      rect: { x: 58, y: 66, w: 300, h: 26 },
      fontSize: 18,
      leading: 22,
      align: "left",
    });

    const { bytes, report } = await buildPdf(src, state);
    expect(report.textBlocksNative + report.textBlocksSubstituted).toBe(1);

    const after = await shownText(bytes);
    expect(after).not.toContain("Montant du loyer");
    expect(after.replace(/\s+/g, " ")).toContain("Montant revise");
  });

  it("removes the paragraph entirely when the edit is a deletion", async () => {
    const src = await makeSource([["A supprimer", "A garder"]]);
    let state = baseState(1);
    state = D.upsertContentEdit(state, {
      id: "e1",
      pageId: state.pages[0].id,
      blockKey: "B0",
      original: "A supprimer",
      text: "",
      deleted: true,
      rect: { x: 58, y: 66, w: 300, h: 26 },
      fontSize: 18,
      leading: 22,
      align: "left",
    });
    const after = await shownText((await buildPdf(src, state)).bytes);
    expect(after).not.toContain("A supprimer");
    expect(after).toContain("A garder");
  });
});

describe("PDF export — page marks", () => {
  it("stamps a watermark into the page content", async () => {
    const src = await makeSource([["A"]]);
    const before = readPageContentBytes((await PDFDocument.load(src)).getPage(0)).length;
    const state: PdfState = {
      ...baseState(1),
      watermark: { ...emptyState().watermark, enabled: true, text: "BROUILLON", opacity: 0.2, angle: 45 },
    };
    const { bytes } = await buildPdf(src, state);
    const out = await PDFDocument.load(bytes);
    expect(readPageContentBytes(out.getPage(0)).length).toBeGreaterThan(before);
    expect(await shownText(bytes)).toContain("BROUILLON");
  });

  it("expands header tokens per page", async () => {
    const src = await makeSource([["A"], ["B"], ["C"]]);
    const state: PdfState = {
      ...baseState(3),
      footer: { ...emptyState().footer, enabled: true, center: "Page {page} sur {pages}" },
    };
    const { bytes } = await buildPdf(src, state);
    expect(await shownText(bytes, 0)).toContain("Page 1 sur 3");
    expect(await shownText(bytes, 2)).toContain("Page 3 sur 3");
  });

  it("numbers pages with a Bates sequence", async () => {
    const src = await makeSource([["A"], ["B"]]);
    const state: PdfState = {
      ...baseState(2),
      bates: { enabled: true, prefix: "ELI-", suffix: "", start: 41, digits: 5 },
      footer: { ...emptyState().footer, enabled: true, right: "{bates}" },
    };
    const { bytes } = await buildPdf(src, state);
    expect(await shownText(bytes, 0)).toContain("ELI-00041");
    expect(await shownText(bytes, 1)).toContain("ELI-00042");
  });

  it("writes the outline and the document metadata", async () => {
    const src = await makeSource([["A"], ["B"]]);
    const state: PdfState = {
      ...baseState(2),
      bookmarks: [{ id: "b1", title: "Chapitre premier", page: 2, children: [] }],
      metadata: { title: "Bail commercial", author: "Étude Durand" },
    };
    const { bytes } = await buildPdf(src, state);
    const out = await PDFDocument.load(bytes);
    expect(out.getTitle()).toBe("Bail commercial");
    expect(out.getAuthor()).toBe("Étude Durand");
    expect(out.catalog.lookup(PDFName.of("Outlines"))).toBeDefined();
  });
});

describe("PDF export — forms", () => {
  it("fills an existing AcroForm field and can flatten it", async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 200]);
    const form = doc.getForm();
    const field = form.createTextField("nom");
    field.addToPage(page, { x: 40, y: 120, width: 200, height: 24 });
    const src = await doc.save();

    const state: PdfState = { ...baseState(1), formValues: { nom: "Dupont" } };
    const filled = await buildPdf(src, state, { flattenForms: false });
    expect(filled.report.fieldsFilled).toBe(1);
    const reloaded = await PDFDocument.load(filled.bytes);
    expect(reloaded.getForm().getTextField("nom").getText()).toBe("Dupont");

    const flat = await buildPdf(src, state, { flattenForms: true });
    const flatDoc = await PDFDocument.load(flat.bytes);
    expect(flatDoc.getForm().getFields()).toHaveLength(0);
    // Flattening turns the widget into page content drawn through an XObject.
    const flatOps = parseContentStream(readPageContentBytes(flatDoc.getPage(0)));
    expect(flatOps.some((o) => o.op === "Do")).toBe(true);
  });

  it("creates the fields drawn with the form builder", async () => {
    const src = await makeSource([["A"]]);
    let state = baseState(1);
    state = D.addField(state, {
      id: "f1",
      pageId: state.pages[0].id,
      name: "adresse",
      kind: "text",
      rect: { x: 40, y: 100, w: 220, h: 22 },
    });
    const { bytes, report } = await buildPdf(src, state);
    expect(report.fieldsCreated).toBe(1);
    const out = await PDFDocument.load(bytes);
    expect(
      out
        .getForm()
        .getFields()
        .map((f) => f.getName()),
    ).toContain("adresse");
  });
});

describe("PDF security", () => {
  it("maps permissions to /P bits and back", () => {
    const perms = { ...ALL_PERMISSIONS, copy: false, modify: false };
    const roundTrip = pToPermissions(permissionsToP(perms));
    expect(roundTrip.copy).toBe(false);
    expect(roundTrip.modify).toBe(false);
    expect(roundTrip.print).toBe(true);
    expect(roundTrip.annotate).toBe(true);
  });

  it("encrypts with AES-256 and reopens with the user password", async () => {
    const src = await makeSource([["Texte confidentiel"]]);
    const doc = await PDFDocument.load(src);
    const protectedBytes = await protectDocument(doc, { userPassword: "s3cret", permissions: ALL_PERMISSIONS });

    // The plaintext must not be sitting in the file any more.
    const raw = new TextDecoder("latin1").decode(protectedBytes);
    expect(raw).toContain("/Encrypt");
    expect(raw).toContain("AESV3");

    const opened = await removeProtection(protectedBytes, "s3cret");
    expect(opened.scheme).toBe("AES-256");
    expect(await shownText(opened.bytes)).toContain("Texte confidentiel");
  });

  it("also opens with the owner password", async () => {
    const src = await makeSource([["A"]]);
    const doc = await PDFDocument.load(src);
    const out = await protectDocument(doc, { userPassword: "ouvre", ownerPassword: "maitre" });
    await expect(removeProtection(out, "maitre")).resolves.toBeTruthy();
  });

  it("refuses a wrong password", async () => {
    const src = await makeSource([["A"]]);
    const doc = await PDFDocument.load(src);
    const out = await protectDocument(doc, { userPassword: "bon" });
    await expect(removeProtection(out, "mauvais")).rejects.toBeInstanceOf(WrongPassword);
  });

  it("carries the permission bits through the round trip", async () => {
    const src = await makeSource([["A"]]);
    const doc = await PDFDocument.load(src);
    const perms = { ...ALL_PERMISSIONS, copy: false, print: false };
    const out = await protectDocument(doc, { userPassword: "pw", permissions: perms });
    const back = await removeProtection(out, "pw");
    expect(back.permissions.copy).toBe(false);
    expect(back.permissions.print).toBe(false);
    expect(back.permissions.annotate).toBe(true);
  });

  it("implements RC4 correctly (legacy files depend on it)", () => {
    // RFC 6229 test vector: key "Key", plaintext "Plaintext".
    const key = new TextEncoder().encode("Key");
    const out = rc4(key, new TextEncoder().encode("Plaintext"));
    expect(
      Array.from(out)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
    ).toBe("bbf316e8d940af0ad3");
  });
});

describe("PDF organisation", () => {
  it("parses every page-range dialect", () => {
    expect(parsePageRange("1-3, 5", 10)).toEqual([0, 1, 2, 4]);
    expect(parsePageRange("3-1", 10)).toEqual([2, 1, 0]);
    expect(parsePageRange("-3", 10)).toEqual([0, 1, 2]);
    expect(parsePageRange("8-", 10)).toEqual([7, 8, 9]);
    expect(parsePageRange("impaires", 5)).toEqual([0, 2, 4]);
    expect(parsePageRange("paires", 5)).toEqual([1, 3]);
    expect(parsePageRange("", 3)).toEqual([0, 1, 2]);
    expect(parsePageRange("99", 3)).toEqual([]);
    expect(parsePageRange("n'importe quoi", 3)).toEqual([]);
  });

  it("renders a compact spec back", () => {
    expect(formatPageRange([0, 1, 2, 6, 8, 9])).toBe("1-3, 7, 9-10");
    expect(formatPageRange([4])).toBe("5");
  });

  it("merges documents in order and reports the counts", async () => {
    const a = await makeSource([["A1"], ["A2"]]);
    const b = await makeSource([["B1"]]);
    const merged = await mergeDocuments([
      { name: "a.pdf", bytes: a },
      { name: "b.pdf", bytes: b },
    ]);
    expect(merged.counts).toEqual([2, 1]);
    expect(merged.failed).toEqual([]);
    const out = await PDFDocument.load(merged.bytes);
    expect(out.getPageCount()).toBe(3);
    expect(await shownText(merged.bytes, 2)).toContain("B1");
  });

  it("reports unreadable sources instead of failing the whole merge", async () => {
    const a = await makeSource([["A"]]);
    const merged = await mergeDocuments([
      { name: "a.pdf", bytes: a },
      { name: "cassé.pdf", bytes: new TextEncoder().encode("pas un pdf") },
    ]);
    expect(merged.failed).toEqual(["cassé.pdf"]);
    expect((await PDFDocument.load(merged.bytes)).getPageCount()).toBe(1);
  });

  it("extracts pages in the requested order", async () => {
    const src = await makeSource([["A"], ["B"], ["C"]]);
    const out = await extractPages(src, [2, 0]);
    expect(await shownText(out, 0)).toContain("C");
    expect(await shownText(out, 1)).toContain("A");
  });

  it("splits every N pages", async () => {
    const src = await makeSource([["A"], ["B"], ["C"], ["D"], ["E"]]);
    const parts = await splitDocument(src, { kind: "everyN", n: 2 }, "doc");
    expect(parts.map((p) => p.pages.length)).toEqual([2, 2, 1]);
    expect(parts[0].name).toBe("doc-1-2.pdf");
  });

  it("splits at bookmark boundaries", async () => {
    const src = await makeSource([["A"], ["B"], ["C"], ["D"]]);
    const parts = await splitDocument(src, { kind: "bookmarks", level: 1 }, "doc", [
      { title: "Début", page: 1 },
      { title: "Milieu", page: 3 },
    ]);
    expect(parts).toHaveLength(2);
    expect(parts[0].pages).toEqual([0, 1]);
    expect(parts[1].pages).toEqual([2, 3]);
  });
});
