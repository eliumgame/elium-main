// Must be the very first import — see pdfjs-node-shim.ts for why.
import "./pdfjs-node-shim";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { describe, it, expect } from "vitest";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import { savePdf, readDiskState } from "../src/pdf/ops/save";
import { appendPdfPages } from "../src/pdf/ops/organize";
import { createCrypt, writeEncrypted } from "../src/pdf/ops/security";
import { signPdfBytes, verifyPdfSignatures } from "../src/pdf/ops/pades";
import { generateSelfSignedP12 } from "../src/pdf/ops/self-cert";
import { importPageAnnots, type RawAnnotation } from "../src/pdf/ops/import-annots";
import { writeOcrLayer } from "../src/pdf/ops/ocr";
import { FontBook } from "../src/pdf/ops/fonts";
import { sameValue } from "../src/pdf/model/same";
import * as D from "../src/pdf/model/doc";
import { emptyState, newId, type Annot, type PdfState } from "../src/pdf/model/types";

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(
  createRequire(import.meta.url).resolve("pdfjs-dist/build/pdf.worker.min.mjs"),
).href;

async function makePdf(pages: number, text = "Page"): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const page = doc.addPage([300, 200]);
    page.drawText(`${text} ${i + 1}`, { x: 20, y: 120, size: 14, font });
  }
  return doc.save({ useObjectStreams: false });
}

const stateFor = (n: number): PdfState => ({ ...emptyState(), pages: D.pagesFromSource(n) });

function annot(pageId: string, kind: Annot["kind"], rect = { x: 15, y: 60, w: 120, h: 30 }): Annot {
  const now = new Date().toISOString();
  return {
    id: newId("an"),
    pageId,
    kind,
    rect,
    color: "#000000",
    fill: "#000000",
    opacity: 1,
    strokeWidth: kind === "note" ? 1 : 0,
    author: "Test",
    contents: kind === "note" ? "Vu" : undefined,
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
  const tc = await (await doc.getPage(n)).getTextContent();
  return tc.items.map((i) => ("str" in i ? i.str : "")).join("");
}

const startsWith = (whole: Uint8Array, prefix: Uint8Array) =>
  whole.length >= prefix.length && Buffer.from(whole.subarray(0, prefix.length)).equals(Buffer.from(prefix));

describe("inserting pages from another PDF (SaveInput.transform)", () => {
  it("a signed document: pages appended in an incremental update, the signature stays valid", async () => {
    const p12 = generateSelfSignedP12("Signataire Test", "pw");
    const signed = await signPdfBytes(await makePdf(2, "Signé"), p12, "pw", { reason: "test" });
    const extra = await makePdf(3, "Ajout");

    // The recomposed document (what the session continues on)…
    const derived = await savePdf({
      source: signed,
      state: stateFor(2),
      transform: async (doc) => {
        const r = await appendPdfPages(doc, [{ name: "ajout.pdf", bytes: extra }]);
        expect(r).toEqual({ inserted: 3, failed: [] });
      },
    });
    expect(derived.report.mode).toBe("incremental");
    expect(startsWith(derived.bytes, signed)).toBe(true);
    expect((await verifyPdfSignatures(derived.bytes))[0]?.digestMatches).toBe(true);

    // …then saved into the file still holding the original: one update of it.
    const next = stateFor(5);
    const saved = await savePdf({
      source: derived.bytes,
      disk: await readDiskState(signed),
      state: { ...next, annots: [annot(next.pages[4].id, "note")] },
    });
    expect(saved.report.mode).toBe("incremental");
    expect(saved.report.objectsWritten).toBeGreaterThan(3);
    expect(startsWith(saved.bytes, signed)).toBe(true);
    const sig = await verifyPdfSignatures(saved.bytes);
    expect(sig[0]?.intact).toBe(true);
    // Pages added after an approval signature: the signed revision is intact,
    // the change is reported as not allowed (as Acrobat and pyHanko do).
    expect(sig[0]?.modifications).toBe("disallowed");
    expect(sig[0]?.changes.map((c) => c.label)).toContain("Pages ajoutées ou supprimées");
    const js = await openJs(saved.bytes);
    expect(js.numPages).toBe(5);
    expect(await pageText(js, 1)).toBe("Signé 1");
    expect(await pageText(js, 5)).toBe("Ajout 3");
    await js.destroy();
  }, 30_000);

  it("a protected document keeps its protection; an owner-only protected file is inserted decrypted", async () => {
    const src = await writeEncrypted(
      await PDFDocument.load(await makePdf(2, "Secret")),
      createCrypt({ userPassword: "test", ownerPassword: "owner" }),
    );
    const ownerOnly = await writeEncrypted(
      await PDFDocument.load(await makePdf(1, "Libre")),
      createCrypt({ ownerPassword: "proprio" }),
    );
    const userLocked = await writeEncrypted(
      await PDFDocument.load(await makePdf(1, "Verrou")),
      createCrypt({ userPassword: "clef", ownerPassword: "clef2" }),
    );
    let asked = 0;
    const derived = await savePdf({
      source: src,
      state: stateFor(2),
      options: { password: "test" },
      transform: async (doc) => {
        const r = await appendPdfPages(
          doc,
          [
            { name: "libre.pdf", bytes: ownerOnly },
            { name: "verrou.pdf", bytes: userLocked },
          ],
          async (_name, wrong) => {
            asked++;
            return wrong ? null : "clef";
          },
        );
        expect(r).toEqual({ inserted: 2, failed: [] });
      },
    });
    expect(asked).toBe(1);
    expect(derived.report.encryption).toBe("kept");
    expect(startsWith(derived.bytes, src)).toBe(true);
    await expect(openJs(derived.bytes)).rejects.toThrow();
    const js = await openJs(derived.bytes, "test");
    expect(js.numPages).toBe(4);
    expect(await pageText(js, 3)).toBe("Libre 1");
    expect(await pageText(js, 4)).toBe("Verrou 1");
    await js.destroy();
  }, 30_000);

  it("forced full-rewrite reasons are honoured and reported", async () => {
    const src = await makePdf(2);
    const r = await savePdf({ source: src, state: stateFor(2), forceFullReasons: ["document recomposé"] });
    expect(r.report.mode).toBe("full");
    expect(r.report.fullReasons).toContain("document recomposé");
  });
});

describe("redaction marks saved without being applied", () => {
  it("are written as /Redact annotations, imported back as marks, then applied without leaving the mark", async () => {
    const src = await makePdf(1, "Confidentiel");
    const state = stateFor(1);
    const mark = annot(state.pages[0].id, "redact", { x: 15, y: 60, w: 200, h: 30 });
    const kept = await savePdf({
      source: src,
      state: { ...state, annots: [mark] },
      options: { applyRedactions: false },
    });
    expect(kept.report.mode).toBe("incremental");
    expect(kept.report.lost).toEqual([]);
    const js = await openJs(kept.bytes);
    expect(await pageText(js, 1)).toBe("Confidentiel 1"); // not applied
    const page = await js.getPage(1);
    const raw = (await page.getAnnotations()) as RawAnnotation[];
    expect(raw.map((a) => a.subtype)).toEqual(["Redact"]);
    const imported = importPageAnnots(raw, state.pages[0].id, 200, "Moi").annots;
    expect(imported.map((a) => a.kind)).toEqual(["redact"]);
    expect(imported[0].rect.x).toBeCloseTo(15, 0);
    await js.destroy();

    // Next session: the imported mark, untouched ("pristine"), is applied.
    const applied = await savePdf({
      source: kept.bytes,
      state: { ...state, annots: imported, importedAnnots: true },
      options: { applyRedactions: true, pristineAnnots: new Set(imported) },
    });
    expect(applied.report.mode).toBe("full");
    const js2 = await openJs(applied.bytes);
    expect(await pageText(js2, 1)).not.toContain("Confidentiel");
    const left = (await (await js2.getPage(1)).getAnnotations()) as RawAnnotation[];
    expect(left.filter((a) => a.subtype === "Redact")).toHaveLength(0);
    await js2.destroy();
  }, 30_000);
});

describe("adding a comment leaves the page content alone", () => {
  it("/Contents and /Resources of the page are unchanged (only /Annots is added)", async () => {
    const src = await makePdf(2);
    const before = await PDFDocument.load(src);
    const p0 = before.getPage(0).node;
    const contents0 = String(p0.get(PDFName.of("Contents")));
    const resources0 = String(p0.get(PDFName.of("Resources")));
    const state = stateFor(2);
    const r = await savePdf({ source: src, state: { ...state, annots: [annot(state.pages[0].id, "note")] } });
    expect(r.report.mode).toBe("incremental");
    const after = await PDFDocument.load(r.bytes);
    const p1 = after.getPage(0).node;
    expect(String(p1.get(PDFName.of("Contents")))).toBe(contents0);
    expect(String(p1.get(PDFName.of("Resources")))).toBe(resources0);
    expect(p1.Annots()?.size()).toBe(1);
    // The second page was not touched at all.
    const tail = Buffer.from(r.bytes.subarray(src.length)).toString("latin1");
    expect(tail).not.toContain(`${after.getPage(1).ref.objectNumber} 0 obj`);
  }, 30_000);
});

describe("OCR text layer added to a protected document", () => {
  it("goes into an update of the source, encrypted with its key: searchable text, same pages", async () => {
    const src = await writeEncrypted(
      await PDFDocument.load(await makePdf(2, "Scan")),
      createCrypt({ userPassword: "test", ownerPassword: "owner" }),
    );
    const derived = await savePdf({
      source: src,
      state: stateFor(2),
      options: { password: "test" },
      transform: async (doc) => {
        const book = new FontBook(doc);
        await writeOcrLayer(
          doc,
          doc.getPage(1),
          [{ text: "Reconnu", confidence: 90, rect: { x: 20, y: 150, w: 80, h: 14 } }],
          book,
        );
      },
    });
    expect(derived.report.mode).toBe("incremental");
    expect(derived.report.encryption).toBe("kept");
    expect(startsWith(derived.bytes, src)).toBe(true);
    expect(Buffer.from(derived.bytes.subarray(src.length)).toString("latin1")).not.toContain("Reconnu");
    const js = await openJs(derived.bytes, "test");
    expect(js.numPages).toBe(2);
    expect(await pageText(js, 2)).toContain("Reconnu");
    await js.destroy();
  }, 30_000);
});

describe("sameValue (restored annotations / outline recognised as untouched)", () => {
  it("compares structurally, ignores undefined keys and the named keys", () => {
    expect(sameValue({ a: 1, b: [1, { c: "x" }], d: undefined }, { b: [1, { c: "x" }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameValue([{ id: "1", t: "A" }], [{ id: "2", t: "A" }], new Set(["id"]))).toBe(true);
    expect(sameValue([{ id: "1", t: "A" }], [{ id: "2", t: "A" }])).toBe(false);
    expect(sameValue(null, {})).toBe(false);
  });
});
