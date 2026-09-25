// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { buildPdf } from "../src/pdf/ops/save";
import {
  importPageAnnots,
  ownedAnnotations,
  resolveAnnotExtras,
  withExtras,
  type RawAnnotation,
} from "../src/pdf/ops/import-annots";
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
  // As the workspace does: pdf.js' data completed from the file (stamp /Name…).
  const extras = (await resolveAnnotExtras(bytes)).get(0);
  const { annots } = importPageAnnots(withExtras(raw, extras), state.pages[0].id, 800, "Moi");
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
    // The group members of a comment the model owns (« Remplacer le texte »)
    // are their own annotations; an attachment, its pop-up and replies are not.
    expect([...owned]).toEqual([
      ["1 0", "1 0"],
      ["3 0", "1 0"],
      ["4 0", "1 0"],
      ["5 0", "5 0"],
      ["6 0", "6 0"],
      ["7 0", "7 0"],
      ["2 0", "1 0"],
    ]);
  });

  it("imports a reply to a reply into the comment's thread", async () => {
    const state = await imported(await acrobatLike());
    expect(state.annots.map((a) => a.kind).sort()).toEqual(["caret", "highlight", "strikeout"]);
    const caret = state.annots.find((a) => a.kind === "caret")!;
    const strike = state.annots.find((a) => a.kind === "strikeout")!;
    expect(caret.group).toBe(strike.id);
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

describe("FreeText colours, as Acrobat reads them", () => {
  it("round-trips text colour, box colour and the typewriter kind", async () => {
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    const bytes = await src.save();
    const base: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    const pageId = base.pages[0].id;
    const now = new Date().toISOString();
    const mk = (id: string, kind: Annot["kind"], textBg: string | null, y: number): Annot =>
      ({
        id,
        pageId,
        kind,
        rect: { x: 50, y, w: 200, h: 40 },
        color: "#cc0000",
        opacity: 1,
        strokeWidth: 0,
        text: "Bonjour",
        fontSize: 14,
        textBg,
        author: "Moi",
        createdAt: now,
        modifiedAt: now,
        replies: [],
      }) as Annot;
    const state = {
      ...base,
      annots: [
        mk("a1", "freetext", null, 100),
        mk("a2", "freetext", "#ffff00", 200),
        mk("a3", "typewriter", null, 300),
      ],
    };
    const out = (await buildPdf(bytes, state)).bytes;
    const doc = await PDFDocument.load(out);
    const dicts = (doc.getPage(0).node.Annots() as PDFArray).asArray().map((r) => doc.context.lookup(r, PDFDict));
    expect(dicts[0].get(PDFName.of("C"))).toBeUndefined();
    expect(dicts[1].lookup(PDFName.of("C"), PDFArray).asArray().map(String)).toEqual(["1", "1", "0"]);
    const back = await imported(out);
    const got = back.annots.map((a) => [a.kind, a.color, a.textBg]);
    expect(got).toEqual([
      ["freetext", "#cc0000", null],
      ["freetext", "#cc0000", "#ffff00"],
      ["typewriter", "#cc0000", null],
    ]);
  });
});

describe("review status, as Acrobat keeps it", () => {
  it("is written as a /State reply and read back", async () => {
    const src = await acrobatLike();
    let state = await imported(src);
    const hl = state.annots.find((a) => a.kind === "highlight")!;
    state = D.setStatus(state, [hl.id], "accepted", "Chef", "2026-02-01T10:00:00.000Z");
    const out = (await buildPdf(src, state)).bytes;
    const doc = await PDFDocument.load(out);
    const dicts = (doc.getPage(0).node.Annots() as PDFArray).asArray().map((r) => doc.context.lookup(r, PDFDict));
    const states = dicts.filter((d) => d.get(PDFName.of("State")));
    expect(states).toHaveLength(1);
    expect(states[0].lookup(PDFName.of("State"), PDFString).decodeText()).toBe("Accepted");
    expect(states[0].lookup(PDFName.of("StateModel"), PDFString).decodeText()).toBe("Review");
    // Not on the parent any more.
    expect(dicts.filter((d) => d.get(PDFName.of("StateModel")))).toHaveLength(1);
    const back = (await imported(out)).annots.find((a) => a.kind === "highlight")!;
    expect(back.status).toBe("accepted");
    expect(back.replies?.at(-1)).toMatchObject({ author: "Chef", status: "accepted" });
  });
});

describe("stamp library", () => {
  it("writes Acrobat's /Name and reads the stamp back as its entry, dynamic line painted", async () => {
    const { stampById, stampFields, stampByName } = await import("../src/pdf/model/stamps");
    expect(stampByName("Approved")?.id).toBe("approved");
    expect(stampByName("SBApproved")?.id).toBe("approved");
    expect(stampByName("#DReceived")?.id).toBe("dynReceived");
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    const base: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    const now = new Date("2026-03-04T09:05:00");
    const fields = stampFields(stampById("dynReceived"), "Marie", now);
    expect(fields.stampSub).toBe("par Marie, le 04/03/2026 09:05");
    const stamp = {
      id: "s1",
      pageId: base.pages[0].id,
      kind: "stamp",
      rect: { x: 50, y: 50, w: 200, h: 58 },
      color: "#000000",
      opacity: 1,
      strokeWidth: 0,
      author: "Marie",
      createdAt: now.toISOString(),
      modifiedAt: now.toISOString(),
      replies: [],
      ...fields,
    } as Annot;
    const out = (await buildPdf(await src.save(), { ...base, annots: [stamp] })).bytes;
    const doc = await PDFDocument.load(out);
    const d = doc.context.lookup((doc.getPage(0).node.Annots() as PDFArray).get(0), PDFDict);
    expect(d.lookup(PDFName.of("Name"), PDFName).decodeText()).toBe("#DReceived");
    // The appearance holds both lines.
    const task = pdfjsLib.getDocument({ data: out.slice(), isEvalSupported: false });
    const js = await task.promise;
    const ops = await (await js.getPage(1)).getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.ENABLE });
    const glyphs = ops.argsArray
      .filter((_, i) => ops.fnArray[i] === pdfjsLib.OPS.showText)
      .map((a) => (a[0] as { unicode?: string }[]).map((g) => g.unicode ?? "").join(""))
      .join("|");
    await task.destroy();
    expect(glyphs).toContain("REÇU");
    expect(glyphs).toContain("par Marie");
    const back = (await imported(out)).annots[0];
    expect(back).toMatchObject({ kind: "stamp", stampLabel: "Reçu", stampTone: "blue", stampName: "#DReceived" });
  });
});

describe("locked comments", () => {
  it("take no change but their unlocking", () => {
    const base: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    const a = {
      id: "x",
      pageId: base.pages[0].id,
      kind: "square",
      rect: { x: 0, y: 0, w: 10, h: 10 },
      locked: true,
    } as Annot;
    let s = { ...base, annots: [a] };
    s = D.updateAnnots(s, ["x"], { color: "#00ff00" });
    expect(s.annots[0].color).toBeUndefined();
    s = D.updateAnnot(s, "x", { color: "#00ff00" });
    expect(s.annots[0].color).toBeUndefined();
    s = D.updateAnnots(s, ["x"], { locked: false });
    expect(s.annots[0].locked).toBe(false);
    s = D.updateAnnot(s, "x", { color: "#00ff00" });
    expect(s.annots[0].color).toBe("#00ff00");
  });
});

describe("an edited import keeps what the model does not edit", () => {
  async function withNote(): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([600, 800]);
    const ctx = doc.context;
    const note = ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Text",
        Rect: [100, 700, 120, 720],
        Name: PDFName.of("Key"),
        NM: PDFString.of("acrobat-uuid-1"),
        F: 4 | 8 | 16,
        T: PDFString.of("Relecteur"),
        Contents: PDFString.of("Texte riche"),
        RC: PDFString.of('<body xmlns="http://www.w3.org/1999/xhtml"><p><b>Texte</b> riche</p></body>'),
        C: [1, 0.8, 0],
      } as never),
    );
    const popup = ctx.register(
      ctx.obj({ Type: "Annot", Subtype: "Popup", Rect: [130, 600, 330, 700], Parent: note, Open: true } as never),
    );
    (ctx.lookup(note) as PDFDict).set(PDFName.of("Popup"), popup);
    const redact = ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Redact",
        Rect: [100, 500, 300, 520],
        QuadPoints: [100, 520, 300, 520, 100, 500, 300, 500],
        OverlayText: PDFString.of("CAVIARDÉ"),
        IC: [0.2, 0.2, 0.2],
      } as never),
    );
    page.node.set(PDFName.of("Annots"), ctx.obj([note, popup, redact]));
    return doc.save({ useObjectStreams: false });
  }

  it("imports the icon, the overlay text and the file's own fields", async () => {
    const state = await imported(await withNote());
    const note = state.annots.find((a) => a.kind === "note")!;
    expect(note.icon).toBe("Key");
    expect(note.pdf).toMatchObject({ nm: "acrobat-uuid-1", flags: 28, open: true });
    expect(note.pdf?.rc).toContain("<b>Texte</b>");
    const redact = state.annots.find((a) => a.kind === "redact")!;
    expect(redact).toMatchObject({ redactText: "CAVIARDÉ", redactFill: "#333333" });
  });

  it("writes them back on a rewrite; the rich text goes once the text changes", async () => {
    const src = await withNote();
    let state = await imported(src);
    const note = state.annots.find((a) => a.kind === "note")!;
    state = D.updateAnnot(state, note.id, { color: "#00aa00" });
    const read = async (s: PdfState) => {
      const doc = await PDFDocument.load((await buildPdf(src, s, { applyRedactions: false })).bytes);
      return (doc.getPage(0).node.Annots() as PDFArray)
        .asArray()
        .map((r) => doc.context.lookup(r, PDFDict))
        .find((d) => d.lookup(PDFName.of("Subtype"), PDFName).decodeText() === "Text")!;
    };
    const d = await read(state);
    expect(d.lookup(PDFName.of("NM"), PDFString).decodeText()).toBe("acrobat-uuid-1");
    expect(d.lookup(PDFName.of("Name"), PDFName).decodeText()).toBe("Key");
    expect(d.lookup(PDFName.of("F"))?.toString()).toBe("28");
    expect(d.lookup(PDFName.of("RC"))).toBeDefined();
    const changed = await read(D.updateAnnot(state, note.id, { contents: "Autre texte" }));
    expect(changed.lookup(PDFName.of("RC"))).toBeUndefined();
  });
});

describe("no growth on round trips", () => {
  it("keeps the box of shapes, callouts and stamps through three save/reopen cycles", async () => {
    const blank = await PDFDocument.create();
    blank.addPage([600, 800]);
    let bytes = await blank.save();
    const base: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    const pageId = base.pages[0].id;
    const now = new Date().toISOString();
    const mk = (id: string, kind: Annot["kind"], rect: Annot["rect"], extra: Partial<Annot> = {}): Annot =>
      ({
        id,
        pageId,
        kind,
        rect,
        color: "#cc0000",
        opacity: 1,
        strokeWidth: 4,
        author: "Moi",
        createdAt: now,
        modifiedAt: now,
        replies: [],
        ...extra,
      }) as Annot;
    let annots: Annot[] = [
      mk("sq", "square", { x: 50, y: 50, w: 100, h: 60 }),
      mk("ci", "circle", { x: 200, y: 50, w: 80, h: 80 }),
      mk(
        "co",
        "callout",
        { x: 300, y: 300, w: 150, h: 40 },
        {
          text: "Note",
          fontSize: 12,
          textBg: "#ffffff",
          strokeWidth: 1,
          callout: [
            { x: 200, y: 420 },
            { x: 250, y: 380 },
            { x: 300, y: 340 },
          ],
        },
      ),
      mk(
        "st",
        "stamp",
        { x: 50, y: 500, w: 160, h: 44 },
        { stampLabel: "Approuvé", stampName: "Approved", strokeWidth: 0 },
      ),
    ];
    const boxes = (list: Annot[]) =>
      Object.fromEntries(list.map((a) => [a.kind, Object.values(a.rect).map((v) => Math.round(v * 10) / 10)]));
    const first = boxes(annots);
    let state: PdfState = { ...base, annots };
    for (let i = 0; i < 3; i++) {
      bytes = (await buildPdf(bytes, state)).bytes;
      state = await imported(bytes);
      annots = state.annots;
    }
    expect(boxes(annots)).toEqual(first);
    // The callout keeps its line (and stays a callout).
    const co = annots.find((a) => a.kind === "callout")!;
    expect(co.callout?.map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual([
      [200, 420],
      [250, 380],
      [300, 340],
    ]);
  });
});

describe("text boxes and stamps on a turned page", () => {
  for (const rot of [90, 180, 270]) {
    it(`read upright on a page turned ${rot}°, inside their box`, async () => {
      const src = await PDFDocument.create();
      const pg = src.addPage([600, 800]);
      pg.setRotation((await import("pdf-lib")).degrees(rot));
      const bytes = await src.save();
      const base: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
      const now = new Date().toISOString();
      const rect = { x: 100, y: 200, w: 60, h: 180 };
      const box = {
        id: "t",
        pageId: base.pages[0].id,
        kind: "freetext",
        rect,
        color: "#000000",
        opacity: 1,
        strokeWidth: 0,
        text: "Haut",
        fontSize: 12,
        textBg: null,
        author: "Moi",
        createdAt: now,
        modifiedAt: now,
        replies: [],
      } as Annot;
      const out = (await buildPdf(bytes, { ...base, annots: [box] }, { interactiveAnnots: false })).bytes;
      const task = pdfjsLib.getDocument({ data: out.slice(), isEvalSupported: false });
      const page = await (await task.promise).getPage(1);
      const tc = await page.getTextContent();
      const item = (tc.items as { str: string; transform: number[] }[]).find((i) => i.str.includes("Haut"))!;
      // On screen (pdf.js' viewport, which applies /Rotate), the text runs left to right.
      const vp = page.getViewport({ scale: 1 });
      const [a, b] = item.transform;
      const dir = { x: vp.transform[0] * a + vp.transform[2] * b, y: vp.transform[1] * a + vp.transform[3] * b };
      expect(dir.x).toBeGreaterThan(0);
      expect(Math.abs(dir.y)).toBeLessThan(1e-6);
      // And it starts inside the box (page space: x 100..160, y from 800-380 to 800-200).
      const [x, y] = [item.transform[4], item.transform[5]];
      expect(x).toBeGreaterThanOrEqual(100 - 0.5);
      expect(x).toBeLessThanOrEqual(160 + 0.5);
      expect(y).toBeGreaterThanOrEqual(420 - 0.5);
      expect(y).toBeLessThanOrEqual(600 + 0.5);
      await task.destroy();
    });
  }

  it("writes /Rotate for Acrobat, and a turned stamp's /Rect holds its corners", async () => {
    const src = await PDFDocument.create();
    const pg = src.addPage([600, 800]);
    pg.setRotation((await import("pdf-lib")).degrees(90));
    const base: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    const now = new Date().toISOString();
    const stamp = {
      id: "s",
      pageId: base.pages[0].id,
      kind: "stamp",
      rect: { x: 100, y: 100, w: 200, h: 50 },
      rotation: 90,
      color: "#000000",
      opacity: 1,
      strokeWidth: 0,
      stampLabel: "Approuvé",
      author: "Moi",
      createdAt: now,
      modifiedAt: now,
      replies: [],
    } as Annot;
    const out = (await buildPdf(await src.save(), { ...base, annots: [stamp] })).bytes;
    const doc = await PDFDocument.load(out);
    const d = doc.context.lookup((doc.getPage(0).node.Annots() as PDFArray).get(0), PDFDict);
    expect(d.lookup(PDFName.of("Rotate"))?.toString()).toBe("90");
    const r = d
      .lookup(PDFName.of("Rect"), PDFArray)
      .asArray()
      .map((v) => Number(v.toString()));
    expect(Math.round(r[2] - r[0])).toBe(50);
    expect(Math.round(r[3] - r[1])).toBe(200);
  });
});

describe("comments pane: checkmark, filters, replies, note icons", () => {
  const note = (over: Partial<Annot> = {}): Annot =>
    ({
      id: "n1",
      pageId: "",
      kind: "note",
      rect: { x: 100, y: 100, w: 20, h: 20 },
      color: "#ffd400",
      opacity: 1,
      strokeWidth: 0,
      text: "À voir",
      author: "Alice",
      createdAt: "2026-03-01T08:00:00.000Z",
      modifiedAt: "2026-03-01T08:00:00.000Z",
      replies: [],
      ...over,
    }) as Annot;

  it("keeps Acrobat's checkmark through a save, apart from the thread", async () => {
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    const base: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    let s: PdfState = { ...base, annots: [note({ pageId: base.pages[0].id })] };
    s = D.addReply(s, "n1", { author: "Bob", text: "Oui", createdAt: "2026-03-02T08:00:00.000Z" });
    s = D.setChecked(s, ["n1"], true);
    const out = (await buildPdf(await src.save(), s)).bytes;
    const back = (await imported(out)).annots[0];
    expect(back.checked).toBe(true);
    expect(back.replies?.map((r) => r.text)).toEqual(["Oui"]);
  });

  it("filters by page and by checkmark, and edits a reply", () => {
    const base: PdfState = { ...emptyState(), pages: D.pagesFromSource(2) };
    const [p1, p2] = base.pages.map((p) => p.id);
    let s: PdfState = {
      ...base,
      annots: [
        note({ id: "a", pageId: p1 }),
        note({ id: "b", pageId: p2, checked: true }),
        note({ id: "w", pageId: p1, kind: "whiteout" }),
      ],
    };
    const order = new Map([
      [p1, 1],
      [p2, 2],
    ]);
    const ids = (f: Partial<D.CommentFilter>) =>
      D.filterComments(s.annots, { ...D.EMPTY_FILTER, ...f }, order, "page").map((a) => a.id);
    expect(ids({})).toEqual(["a", "b"]);
    expect(ids({ pages: [2] })).toEqual(["b"]);
    expect(ids({ checked: "checked" })).toEqual(["b"]);
    expect(ids({ checked: "unchecked" })).toEqual(["a"]);
    s = D.addReply(s, "a", { author: "Bob", text: "v1", createdAt: "2026-03-02T08:00:00.000Z" });
    const rid = s.annots[0].replies![0].id;
    s = D.updateReply(s, "a", rid, "v2", "2026-03-03T08:00:00.000Z");
    expect(s.annots[0].replies![0].text).toBe("v2");
    s = D.removeReply(s, "a", rid);
    expect(s.annots[0].replies).toEqual([]);
  });

  it("paints the chosen note icon in the file (the ? of Help), and keeps its /Name", async () => {
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    const base: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    const s: PdfState = { ...base, annots: [note({ pageId: base.pages[0].id, icon: "Help" })] };
    const flat = (await buildPdf(await src.save(), s, { interactiveAnnots: false })).bytes;
    const task = pdfjsLib.getDocument({ data: flat.slice(), isEvalSupported: false });
    const tc = await (await (await task.promise).getPage(1)).getTextContent();
    expect((tc.items as { str: string }[]).map((i) => i.str).join("")).toContain("?");
    await task.destroy();
    const back = (await imported((await buildPdf(await src.save(), s)).bytes)).annots[0];
    expect(back.icon).toBe("Help");
  });
});

describe("text edits in the file", () => {
  it("writes a replaced text as Acrobat does and reads it back as one group", async () => {
    const src = await PDFDocument.create();
    src.addPage([600, 800]);
    const base: PdfState = { ...emptyState(), pages: D.pagesFromSource(1) };
    const pageId = base.pages[0].id;
    const now = new Date().toISOString();
    const common = {
      pageId,
      opacity: 1,
      strokeWidth: 1,
      author: "Marie",
      createdAt: now,
      modifiedAt: now,
      replies: [],
    };
    const caret = {
      ...common,
      id: "c",
      kind: "caret",
      rect: { x: 197, y: 108, w: 8, h: 8 },
      color: "#1d4ed8",
      contents: "remplaçant",
    } as Annot;
    const strike = {
      ...common,
      id: "s",
      kind: "strikeout",
      group: "c",
      color: "#1d4ed8",
      rect: { x: 100, y: 100, w: 100, h: 14 },
      quads: [
        [
          { x: 100, y: 100 },
          { x: 200, y: 100 },
          { x: 200, y: 114 },
          { x: 100, y: 114 },
        ],
      ],
    } as Annot;
    const out = (await buildPdf(await src.save(), { ...base, annots: [caret, strike] })).bytes;
    const doc = await PDFDocument.load(out);
    const refs = (doc.getPage(0).node.Annots() as PDFArray).asArray();
    const dicts = refs.map((r) => doc.context.lookup(r, PDFDict));
    const so = dicts.find((d) => d.lookup(PDFName.of("Subtype"), PDFName).decodeText() === "StrikeOut")!;
    const ca = refs[dicts.findIndex((d) => d.lookup(PDFName.of("Subtype"), PDFName).decodeText() === "Caret")];
    expect(so.get(PDFName.of("IRT"))?.toString()).toBe(ca.toString());
    expect(so.lookup(PDFName.of("RT"), PDFName).decodeText()).toBe("Group");
    expect(so.lookup(PDFName.of("IT"), PDFName).decodeText()).toBe("StrikeOutTextEdit");
    const back = await imported(out);
    const c2 = back.annots.find((a) => a.kind === "caret")!;
    const s2 = back.annots.find((a) => a.kind === "strikeout")!;
    expect(c2.contents).toBe("remplaçant");
    expect(s2.group).toBe(c2.id);
    // One comment in the pane, deleted as one.
    expect(D.commentable(back.annots).map((a) => a.kind)).toEqual(["caret"]);
    expect(D.removeAnnots(back, [c2.id]).annots).toEqual([]);
  });
});
