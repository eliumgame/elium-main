// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFDocument, PDFHexString, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { md5 } from "@noble/hashes/legacy.js";
import { readXrefTail, revisionCount } from "../src/pdf/ops/incremental";
import { savePdf, buildPdf, type DiskState } from "../src/pdf/ops/save";
import { createCrypt, openCrypt, permissionsToP, ALL_PERMISSIONS, rc4, writeEncrypted } from "../src/pdf/ops/security";
import { signPdfBytes, verifyPdfSignatures } from "../src/pdf/ops/pades";
import { generateSelfSignedP12 } from "../src/pdf/ops/self-cert";
import { createFields } from "../src/pdf/ops/forms";
import { importPageAnnots, type RawAnnotation } from "../src/pdf/ops/import-annots";
import * as D from "../src/pdf/model/doc";
import { emptyState, newId, type Annot, type PdfState } from "../src/pdf/model/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function makePdf(opts: { pages?: number; objectStreams?: boolean; text?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (opts.pages ?? 3); i++) {
    const page = doc.addPage([300, 200]);
    page.drawText(`${opts.text ?? "Page"} ${i + 1}`, { x: 20, y: 120, size: 14, font });
  }
  return doc.save({ useObjectStreams: opts.objectStreams ?? false });
}

function stateFor(pageCount: number): PdfState {
  return { ...emptyState(), pages: D.pagesFromSource(pageCount) };
}

function note(pageId: string, contents: string): Annot {
  const now = new Date().toISOString();
  return {
    id: newId("an"),
    pageId,
    kind: "note",
    rect: { x: 40, y: 40, w: 20, h: 20 },
    color: "#facc15",
    opacity: 1,
    strokeWidth: 1,
    author: "Test",
    contents,
    createdAt: now,
    modifiedAt: now,
    replies: [],
  } as Annot;
}

async function openJs(bytes: Uint8Array, password?: string) {
  const task = pdfjsLib.getDocument({ data: bytes.slice(), password, isEvalSupported: false });
  const doc = await task.promise;
  return Object.assign(doc, { destroy: () => task.destroy() });
}

async function pageText(doc: Awaited<ReturnType<typeof openJs>>, n: number): Promise<string> {
  const page = await doc.getPage(n);
  const tc = await page.getTextContent();
  return tc.items.map((i) => ("str" in i ? i.str : "")).join("");
}

async function annotationTexts(doc: Awaited<ReturnType<typeof openJs>>, n: number): Promise<string[]> {
  const page = await doc.getPage(n);
  const list = (await page.getAnnotations()) as { subtype: string; contentsObj?: { str: string } }[];
  return list.map((a) => `${a.subtype}:${a.contentsObj?.str ?? ""}`);
}

const startsWith = (whole: Uint8Array, prefix: Uint8Array) =>
  whole.length >= prefix.length && Buffer.from(whole.subarray(0, prefix.length)).equals(Buffer.from(prefix));

// --- legacy (revision 2–4) encryption fixtures -----------------------------
const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
const pad32 = (pw: string) => {
  const raw = new TextEncoder().encode(pw).subarray(0, 32);
  const out = new Uint8Array(32);
  out.set(raw);
  out.set(PAD.subarray(0, 32 - raw.length), raw.length);
  return out;
};
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
};
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Encrypt a plain PDF with RC4-128 (V2/R3) or AES-128 (V4/R4) — algorithms 2, 3 and 5 of ISO 32000. */
async function legacyEncrypted(plain: Uint8Array, scheme: "rc4" | "aes128", user: string, owner: string) {
  const doc = await PDFDocument.load(plain, { updateMetadata: false });
  const n = 16;
  const r = scheme === "rc4" ? 3 : 4;
  const p = permissionsToP({ ...ALL_PERMISSIONS, print: false });
  // Algorithm 3: /O
  let ok: Uint8Array = md5(pad32(owner));
  for (let i = 0; i < 50; i++) ok = md5(ok);
  const okey = ok.subarray(0, n);
  let o = rc4(okey, pad32(user));
  for (let i = 1; i <= 19; i++) o = rc4(okey.map((b) => b ^ i), o);
  // Algorithm 2: file key
  const id0 = new Uint8Array(16).map((_, i) => 0xa0 + i);
  const pb = new Uint8Array(4);
  new DataView(pb.buffer).setInt32(0, p, true);
  let key: Uint8Array = md5(cat(pad32(user), o, pb, id0));
  for (let i = 0; i < 50; i++) key = md5(key.subarray(0, n));
  key = key.subarray(0, n);
  // Algorithm 5: /U
  let u = rc4(key, md5(cat(PAD, id0)));
  for (let i = 1; i <= 19; i++) u = rc4(key.map((b) => b ^ i), u);
  u = cat(u, new Uint8Array(16));

  const ctx = doc.context;
  ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(hex(id0)), PDFHexString.of(hex(id0))]);
  const common = { Filter: "Standard", O: PDFHexString.of(hex(o)), U: PDFHexString.of(hex(u)), P: p };
  const dict =
    scheme === "rc4"
      ? ctx.obj({ ...common, V: 2, R: r, Length: 128 })
      : ctx.obj({
          ...common,
          V: 4,
          R: r,
          Length: 128,
          CF: { StdCF: { CFM: "AESV2", AuthEvent: "DocOpen", Length: 16 } },
          StmF: "StdCF",
          StrF: "StdCF",
        });
  const ref = ctx.register(dict);
  ctx.trailerInfo.Encrypt = ref;
  // The handler under test encrypts; pdf.js (an independent implementation) validates.
  const crypt = openCrypt(doc, user)!;
  crypt.encryptDocument(doc, new Set([String(ref)]));
  return doc.save({ useObjectStreams: false });
}

// ---------------------------------------------------------------------------

describe("readXrefTail", () => {
  it("recognises a classic table and a cross-reference stream", async () => {
    const table = readXrefTail(await makePdf({ objectStreams: false }));
    expect(table?.kind).toBe("table");
    expect(table!.size).toBeGreaterThan(5);
    const stream = readXrefTail(await makePdf({ objectStreams: true }));
    expect(stream?.kind).toBe("stream");
  });

  it("refuses a file whose startxref points nowhere", async () => {
    const bytes = await makePdf();
    const text = Buffer.from(bytes).toString("latin1").replace(/startxref\s+\d+/, "startxref\n12");
    expect(readXrefTail(new Uint8Array(Buffer.from(text, "latin1")))).toBeNull();
    expect(readXrefTail(new TextEncoder().encode("not a pdf"))).toBeNull();
  });
});

describe("savePdf — incremental update", () => {
  for (const objectStreams of [false, true]) {
    it(`appends only what changed (${objectStreams ? "xref stream" : "xref table"} source)`, async () => {
      const src = await makePdf({ objectStreams });
      const state = stateFor(3);
      const withNote = { ...state, annots: [note(state.pages[0].id, "Première note")] };
      const r1 = await savePdf({ source: src, state: withNote });

      expect(r1.report.mode).toBe("incremental");
      expect(startsWith(r1.bytes, src)).toBe(true); // original untouched, byte for byte
      expect(revisionCount(r1.bytes)).toBe(2);
      expect(readXrefTail(r1.bytes)?.kind).toBe(objectStreams ? "stream" : "table");
      // Page 1 dictionary + note (+ its appearance / popup) + Info — not the other pages.
      expect(r1.report.objectsWritten).toBeLessThan(8);

      const js = await openJs(r1.bytes);
      expect(js.numPages).toBe(3);
      expect(await pageText(js, 2)).toBe("Page 2");
      expect(await annotationTexts(js, 1)).toContain("Text:Première note");
      await js.destroy();
      const lib = await PDFDocument.load(r1.bytes);
      expect(lib.getPageCount()).toBe(3);

      // A second save, from the state of the file after the first one.
      const edited = {
        ...withNote,
        annots: [...withNote.annots, note(withNote.pages[2].id, "Deuxième note")],
      };
      const r2 = await savePdf({ source: src, state: edited, disk: r1.disk });
      expect(r2.report.mode).toBe("incremental");
      expect(startsWith(r2.bytes, r1.bytes)).toBe(true);
      expect(revisionCount(r2.bytes)).toBe(3);
      const js2 = await openJs(r2.bytes);
      expect(await annotationTexts(js2, 1)).toEqual(["Text:Première note"]); // not duplicated
      expect(await annotationTexts(js2, 3)).toContain("Text:Deuxième note");
      await js2.destroy();
    });
  }

  it("writes nothing new when saving the same state twice", async () => {
    const src = await makePdf();
    const state = { ...stateFor(3), annots: [] as Annot[] };
    state.annots = [note(state.pages[1].id, "x")];
    const r1 = await savePdf({ source: src, state });
    const r2 = await savePdf({ source: src, state, disk: r1.disk });
    // Only the Info dictionary (modification date) may differ.
    expect(r2.report.objectsWritten).toBeLessThanOrEqual(1);
  });

  it("keeps untouched imported annotations byte for byte", async () => {
    // A file that already carries a comment.
    const doc = await PDFDocument.create();
    const page = doc.addPage([300, 200]);
    const annot = doc.context.register(
      doc.context.obj({
        Type: "Annot",
        Subtype: "Square",
        Rect: [10, 10, 60, 60],
        C: [1, 0, 0],
        T: PDFHexString.fromText("Relecteur"),
        Contents: PDFHexString.fromText("Commentaire d'origine"),
      }),
    );
    page.node.set(PDFName.of("Annots"), doc.context.obj([annot]));
    const src = await doc.save({ useObjectStreams: false });

    const js = await openJs(src);
    const raw = (await (await js.getPage(1)).getAnnotations()) as RawAnnotation[];
    await js.destroy();
    const state = stateFor(1);
    const imported = importPageAnnots(raw, state.pages[0].id, 200, "Moi").annots;
    const withImport: PdfState = { ...state, annots: imported, importedAnnots: true };
    const pristineAnnots = new Set(imported);

    const r = await savePdf({
      source: src,
      state: { ...withImport, annots: [...imported, note(state.pages[0].id, "Réponse")] },
      options: { pristineAnnots },
    });
    const update = Buffer.from(r.bytes.subarray(src.length)).toString("latin1");
    expect(update).not.toContain(`${annot.objectNumber} 0 obj`); // the original comment was not rewritten
    const out = await openJs(r.bytes);
    const texts = await annotationTexts(out, 1);
    expect(texts).toContain("Square:Commentaire d'origine");
    expect(texts.filter((t) => t.startsWith("Square")).length).toBe(1);
    await out.destroy();

    // Edited → rewritten from the model, still only once.
    const edited = { ...imported[0], contents: "Modifié" } as Annot;
    const r2 = await savePdf({ source: src, state: { ...withImport, annots: [edited] }, options: { pristineAnnots } });
    const out2 = await openJs(r2.bytes);
    expect(await annotationTexts(out2, 1)).toEqual(["Square:Modifié"]);
    await out2.destroy();
  });
});

describe("savePdf — when a full rewrite is required", () => {
  it("applying a redaction rewrites the whole file and leaves no earlier revision", async () => {
    const src = await makePdf({ pages: 1, text: "Secret" });
    const state = stateFor(1);
    const redact = { ...note(state.pages[0].id, ""), kind: "redact", rect: { x: 10, y: 60, w: 200, h: 40 } } as Annot;
    const r = await savePdf({ source: src, state: { ...state, annots: [redact] } });
    expect(r.report.mode).toBe("full");
    expect(r.report.fullReasons.join(" ")).toMatch(/caviardage/);
    expect(revisionCount(r.bytes)).toBe(1);
    const js = await openJs(r.bytes);
    expect(await pageText(js, 1)).not.toContain("Secret");
    await js.destroy();
  });

  it("removing a page drops its content from the file", async () => {
    const src = await makePdf({ pages: 3, text: "Unique" });
    const state = stateFor(3);
    const r = await savePdf({ source: src, state: { ...state, pages: [state.pages[0], state.pages[2]] } });
    expect(r.report.mode).toBe("full");
    const lib = await PDFDocument.load(r.bytes);
    expect(lib.getPageCount()).toBe(2);
    // No stream of the output still says "Unique 2".
    for (const [, obj] of lib.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const text = Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1");
      expect(text).not.toMatch(/Unique 2|556e6971756520 ?32/i);
    }
  });
});

describe("savePdf — digitally signed documents", () => {
  it("adding a comment keeps the signature valid (the signed revision stays intact)", async () => {
    const p12 = generateSelfSignedP12("Signataire Test", "pw");
    const signed = await signPdfBytes(await makePdf({ pages: 2 }), p12, "pw", { reason: "test" });
    const before = verifyPdfSignatures(signed);
    expect(before[0]?.valid).toBe(true);

    const state = stateFor(2);
    const r = await savePdf({ source: signed, state: { ...state, annots: [note(state.pages[1].id, "Vu")] } });
    expect(r.report.mode).toBe("incremental");
    expect(startsWith(r.bytes, signed)).toBe(true);
    const after = verifyPdfSignatures(r.bytes);
    expect(after).toHaveLength(1);
    expect(after[0].digestMatches).toBe(true);
    expect(after[0].valid).toBe(true);
    expect(after[0].coversWholeDocument).toBe(false); // a later revision exists — as Acrobat reports it
    const js = await openJs(r.bytes);
    expect(await annotationTexts(js, 2)).toContain("Text:Vu");
    await js.destroy();

    // A forced full rewrite, by contrast, cannot keep it.
    const full = await savePdf({ source: signed, state, mode: "full" });
    expect(verifyPdfSignatures(full.bytes).some((v) => v.valid)).toBe(false);
  }, 30_000);

  it("filling a form field of a signed document keeps the signature valid", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    createFields(
      { doc, font },
      [{ id: "f1", pageId: "p", name: "nom", kind: "text", rect: { x: 20, y: 20, w: 150, h: 24 } }],
      () => ({ page, height: 200 }),
    );
    const p12 = generateSelfSignedP12("Signataire", "pw");
    const signed = await signPdfBytes(await doc.save({ useObjectStreams: false }), p12, "pw");
    const state = { ...stateFor(1), formValues: { nom: "Dupont" } };
    const r = await savePdf({ source: signed, state });
    expect(r.report.mode).toBe("incremental");
    expect(verifyPdfSignatures(r.bytes)[0].valid).toBe(true);
    const js = await openJs(r.bytes);
    const fields = (await js.getFieldObjects()) as Record<string, { value: unknown }[]>;
    expect(fields.nom.find((f) => f.value !== undefined)?.value).toBe("Dupont");
    await js.destroy();
  }, 30_000);
});

describe("savePdf — password-protected documents keep their protection", () => {
  it("AES-256 with an open password: same password, edit visible", async () => {
    const plain = await PDFDocument.load(await makePdf({ pages: 2, text: "Chiffré" }));
    const src = await writeEncrypted(plain, createCrypt({ userPassword: "test", ownerPassword: "owner" }));
    const state = stateFor(2);
    const r = await savePdf({
      source: src,
      state: { ...state, annots: [note(state.pages[0].id, "Note chiffrée é€")] },
      options: { password: "test" },
    });
    expect(r.report.mode).toBe("incremental");
    expect(r.report.encryption).toBe("kept");
    expect(startsWith(r.bytes, src)).toBe(true);
    // The appended note is not readable in the clear.
    expect(Buffer.from(r.bytes.subarray(src.length)).toString("latin1")).not.toContain("Note chiffr");
    const js = await openJs(r.bytes, "test");
    expect(await pageText(js, 1)).toBe("Chiffré 1");
    expect(await annotationTexts(js, 1)).toContain("Text:Note chiffrée é€");
    await js.destroy();
    await expect(openJs(r.bytes, "mauvais")).rejects.toThrow();
    // Opening with the owner password works too, and a second save on top.
    const r2 = await savePdf({
      source: src,
      state: { ...state, annots: [note(state.pages[1].id, "Deux")] },
      options: { password: "owner" },
      disk: r.disk,
    });
    const js2 = await openJs(r2.bytes, "test");
    expect(await annotationTexts(js2, 2)).toContain("Text:Deux");
    await js2.destroy();
  }, 30_000);

  it("owner-only protection (no open password): still opens freely, permissions unchanged", async () => {
    const plain = await PDFDocument.load(await makePdf({ pages: 1 }));
    const src = await writeEncrypted(
      plain,
      createCrypt({ userPassword: "", ownerPassword: "owner", permissions: { ...ALL_PERMISSIONS, print: false } }),
    );
    const state = stateFor(1);
    const r = await savePdf({ source: src, state: { ...state, annots: [note(state.pages[0].id, "OK")] } });
    const js = await openJs(r.bytes);
    expect(await annotationTexts(js, 1)).toContain("Text:OK");
    const perms = await js.getPermissions();
    expect(perms).not.toContain(4); // printing still denied
    await js.destroy();
  }, 30_000);

  for (const scheme of ["rc4", "aes128"] as const) {
    it(`${scheme === "rc4" ? "RC4-128 (R3)" : "AES-128 (R4)"}: new objects encrypted with the file key`, async () => {
      const src = await legacyEncrypted(await makePdf({ pages: 2, text: "Ancien" }), scheme, "u", "o");
      const js0 = await openJs(src, "u");
      expect(await pageText(js0, 2)).toBe("Ancien 2"); // fixture sanity (pdf.js decrypts it)
      await js0.destroy();
      const state = stateFor(2);
      const r = await savePdf({
        source: src,
        state: { ...state, annots: [note(state.pages[1].id, "Legacy note")] },
        options: { password: "u" },
      });
      expect(r.report.mode).toBe("incremental");
      expect(r.report.scheme).toBe(scheme === "rc4" ? "RC4-128" : "AES-128");
      const js = await openJs(r.bytes, "u");
      expect(await annotationTexts(js, 2)).toContain("Text:Legacy note");
      expect(await pageText(js, 1)).toBe("Ancien 1");
      await js.destroy();
    }, 30_000);
  }

  it("a full rewrite (redaction) of a protected file keeps the same passwords", async () => {
    const plain = await PDFDocument.load(await makePdf({ pages: 1, text: "Caché" }));
    const src = await writeEncrypted(plain, createCrypt({ userPassword: "test", ownerPassword: "owner" }));
    const state = stateFor(1);
    const redact = { ...note(state.pages[0].id, ""), kind: "redact", rect: { x: 10, y: 60, w: 200, h: 40 } } as Annot;
    const r = await savePdf({ source: src, state: { ...state, annots: [redact] }, options: { password: "test" } });
    expect(r.report.mode).toBe("full");
    expect(r.report.encryption).toBe("kept");
    const js = await openJs(r.bytes, "test");
    expect(await pageText(js, 1)).not.toContain("Caché");
    await js.destroy();
    await expect(openJs(r.bytes)).rejects.toThrow();
  }, 30_000);

  it("buildPdf (exports) no longer produces an unreadable file from a protected source", async () => {
    const plain = await PDFDocument.load(await makePdf({ pages: 1 }));
    const src = await writeEncrypted(plain, createCrypt({ userPassword: "test" }));
    const { bytes, report } = await buildPdf(src, stateFor(1), { password: "test" });
    expect(report.encryption).toBe("kept");
    const js = await openJs(bytes, "test");
    expect(js.numPages).toBe(1);
    await js.destroy();
    const clear = await buildPdf(src, stateFor(1), { password: "test", encryption: "remove" });
    const js2 = await openJs(clear.bytes);
    expect(await pageText(js2, 1)).toBe("Page 1");
    await js2.destroy();
  }, 30_000);
});

describe("savePdf — building on pdf.js saveDocument() (form values from the annotationStorage)", () => {
  it("applies the Elium model on top of pdf.js's own update, in one update of the original", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([300, 200]);
    createFields(
      { doc, font },
      [{ id: "f1", pageId: "p", name: "ville", kind: "text", rect: { x: 20, y: 20, w: 150, h: 24 } }],
      () => ({ page, height: 200 }),
    );
    const src = await doc.save({ useObjectStreams: false });

    const js = await openJs(src);
    const annots = (await (await js.getPage(1)).getAnnotations()) as { id: string; fieldName?: string }[];
    const widget = annots.find((a) => a.fieldName === "ville")!;
    js.annotationStorage.setValue(widget.id, { value: "Lyon" });
    const base = await js.saveDocument();
    await js.destroy();

    const state = stateFor(1);
    let disk: DiskState | undefined;
    const r = await savePdf({ source: src, base, state: { ...state, annots: [note(state.pages[0].id, "Ajout")] } });
    disk = r.disk;
    expect(r.report.mode).toBe("incremental");
    expect(startsWith(r.bytes, src)).toBe(true);
    expect(revisionCount(r.bytes)).toBe(2); // ONE update on top of the original
    const out = await openJs(r.bytes);
    const fields = (await out.getFieldObjects()) as Record<string, { value: unknown }[]>;
    expect(fields.ville.find((f) => f.value !== undefined)?.value).toBe("Lyon");
    expect(await annotationTexts(out, 1)).toContain("Text:Ajout");
    await out.destroy();
    expect(disk.fingerprints.size).toBeGreaterThan(0);
  }, 30_000);
});
