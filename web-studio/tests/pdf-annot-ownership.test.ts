// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { buildPdf } from "../src/pdf/ops/save";
import { importPageAnnots, ownedAnnotations, type RawAnnotation } from "../src/pdf/ops/import-annots";
import * as D from "../src/pdf/model/doc";
import { emptyState, type Annot, type PdfState } from "../src/pdf/model/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

/**
 * Only what Elium models is rewritten at save; the rest of a file's comments —
 * Acrobat's « Remplacer le texte » (StrikeOut + Caret grouped by /IRT /RT
 * /Group), attachments, replies from other apps, their pop-ups — must come
 * out as they went in. They used to be deleted on a save with no edit at all.
 */

async function acrobatLike(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const ctx = doc.context;
  const add = (o: Record<string, unknown>) => {
    const ref = ctx.register(ctx.obj(o as never));
    return ref;
  };
  const date = PDFString.of("D:20260101120000Z");
  const hl = add({
    Type: "Annot",
    Subtype: "Highlight",
    Rect: [100, 700, 200, 715],
    QuadPoints: [100, 715, 200, 715, 100, 700, 200, 700],
    C: [1, 1, 0],
    T: PDFString.of("Relecteur"),
    Contents: PDFString.of("À revoir"),
    M: date,
  });
  const hlPopup = add({ Type: "Annot", Subtype: "Popup", Rect: [300, 600, 500, 700], Parent: hl });
  (ctx.lookup(hl) as PDFDict).set(PDFName.of("Popup"), hlPopup);
  const reply = add({
    Type: "Annot",
    Subtype: "Text",
    Rect: [100, 700, 120, 720],
    IRT: hl,
    T: PDFString.of("Auteur"),
    Contents: PDFString.of("D'accord"),
    M: date,
  });
  const replyToReply = add({
    Type: "Annot",
    Subtype: "Text",
    Rect: [100, 700, 120, 720],
    IRT: reply,
    T: PDFString.of("Relecteur"),
    Contents: PDFString.of("Merci"),
    M: date,
  });
  const strike = add({
    Type: "Annot",
    Subtype: "StrikeOut",
    Rect: [100, 600, 180, 612],
    QuadPoints: [100, 612, 180, 612, 100, 600, 180, 600],
    C: [1, 0, 0],
    T: PDFString.of("Relecteur"),
    M: date,
  });
  const caret = add({
    Type: "Annot",
    Subtype: "Caret",
    Rect: [178, 598, 190, 614],
    IRT: strike,
    RT: PDFName.of("Group"),
    Contents: PDFString.of("texte de remplacement"),
    T: PDFString.of("Relecteur"),
    M: date,
  });
  const attach = add({
    Type: "Annot",
    Subtype: "FileAttachment",
    Rect: [400, 500, 414, 520],
    Contents: PDFString.of("annexe.txt"),
    T: PDFString.of("Relecteur"),
  });
  const attachPopup = add({ Type: "Annot", Subtype: "Popup", Rect: [420, 400, 580, 500], Parent: attach });
  (ctx.lookup(attach) as PDFDict).set(PDFName.of("Popup"), attachPopup);
  page.node.set(PDFName.of("Annots"), ctx.obj([hl, hlPopup, reply, replyToReply, strike, caret, attach, attachPopup]));
  return doc.save({ useObjectStreams: false });
}

async function imported(bytes: Uint8Array): Promise<PdfState> {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const js = await task.promise;
  const raw = (await (await js.getPage(1)).getAnnotations()) as RawAnnotation[];
  await task.destroy();
  const state: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
  const { annots } = importPageAnnots(raw, state.pages[0].id, 800, "Moi");
  return { ...state, annots, importedAnnots: true };
}

/** Subtypes on the page, with the subtype each /IRT and /Parent points at. */
async function inventory(bytes: Uint8Array) {
  const doc = await PDFDocument.load(bytes);
  const annots = doc.getPage(0).node.Annots() as PDFArray;
  const sub = (d: PDFDict | undefined) =>
    (d?.lookup(PDFName.of("Subtype")) as PDFName | undefined)?.asString().slice(1) ?? "∅";
  const out: string[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const d = annots.lookup(i, PDFDict);
    const link = (k: string) => {
      const r = d.get(PDFName.of(k));
      if (!(r instanceof PDFRef)) return "";
      const target = doc.context.lookup(r);
      return ` ${k}→${target instanceof PDFDict ? sub(target) : "MISSING"}`;
    };
    out.push(`${sub(d)}${link("IRT")}${link("Parent")}`);
  }
  return out.sort();
}

describe("ownership of a file's annotations", () => {
  it("owns comments, their threads and pop-ups — nothing else", () => {
    const owned = ownedAnnotations([
      { key: "1 0", subtype: "Highlight" },
      { key: "2 0", subtype: "Popup", parent: "1 0" },
      { key: "3 0", subtype: "Text", irt: "1 0" },
      { key: "4 0", subtype: "Text", irt: "3 0", rt: "R" },
      { key: "5 0", subtype: "StrikeOut" },
      { key: "6 0", subtype: "Caret", irt: "5 0", rt: "Group" },
      { key: "7 0", subtype: "StrikeOut", irt: "5 0", rt: "Group" },
      { key: "8 0", subtype: "FileAttachment" },
      { key: "9 0", subtype: "Popup", parent: "8 0" },
      { key: "10 0", subtype: "Text", irt: "8 0" },
      { key: "11 0", subtype: "Text", irt: "12 0" },
      { key: "12 0", subtype: "Text", irt: "11 0" },
    ]);
    expect([...owned]).toEqual([
      ["1 0", "1 0"],
      ["3 0", "1 0"],
      ["4 0", "1 0"],
      ["5 0", "5 0"],
      ["2 0", "1 0"],
    ]);
  });

  it("imports a reply to a reply into the comment's thread", async () => {
    const state = await imported(await acrobatLike());
    expect(state.annots.map((a) => a.kind).sort()).toEqual(["highlight", "strikeout"]);
    const hl = state.annots.find((a) => a.kind === "highlight")!;
    expect(hl.replies?.map((r) => r.text)).toEqual(["D'accord", "Merci"]);
  });

  it("a save with no edit keeps every annotation and every link", async () => {
    const src = await acrobatLike();
    const state = await imported(src);
    const { bytes } = await buildPdf(src, state, { pristineAnnots: new Set(state.annots) });
    expect(await inventory(bytes)).toEqual(await inventory(src));
  });

  it("an edited comment is rewritten; what hangs on it follows the rewrite", async () => {
    const src = await acrobatLike();
    let state = await imported(src);
    const strike = state.annots.find((a) => a.kind === "strikeout")!;
    const pristine = new Set(state.annots.filter((a) => a !== strike));
    state = D.updateAnnot(state, strike.id, { color: "#0000ff" });
    const { bytes } = await buildPdf(src, state, { pristineAnnots: pristine });
    const inv = await inventory(bytes);
    // The Caret now points at the rewritten StrikeOut; the attachment and its pop-up are untouched.
    expect(inv).toContain("Caret IRT→StrikeOut");
    expect(inv).toContain("FileAttachment");
    expect(inv).toContain("Popup Parent→FileAttachment");
    expect(inv.filter((x) => x.startsWith("StrikeOut"))).toHaveLength(1);
    expect(inv.join()).not.toContain("MISSING");
  });

  it("a deleted comment takes its grouped Caret with it", async () => {
    const src = await acrobatLike();
    let state = await imported(src);
    const strike = state.annots.find((a) => a.kind === "strikeout")!;
    const pristine = new Set(state.annots.filter((a) => a !== strike));
    state = D.removeAnnots(state, [strike.id]);
    const inv = await inventory((await buildPdf(src, state, { pristineAnnots: pristine })).bytes);
    expect(inv.some((x) => x.startsWith("Caret") || x.startsWith("StrikeOut"))).toBe(false);
    expect(inv).toContain("FileAttachment");
    expect(inv.join()).not.toContain("MISSING");
  });

  it("keeps edits of the other comments working (the highlight rewritten with its thread)", async () => {
    const src = await acrobatLike();
    let state = await imported(src);
    const hl = state.annots.find((a) => a.kind === "highlight")!;
    const pristine = new Set(state.annots.filter((a) => a !== hl));
    state = D.updateAnnot(state, hl.id, { contents: "Revu" } as Partial<Annot>);
    const inv = await inventory((await buildPdf(src, state, { pristineAnnots: pristine })).bytes);
    expect(inv.filter((x) => x === "Text IRT→Highlight")).toHaveLength(2);
    expect(inv.join()).not.toContain("MISSING");
  });
});
