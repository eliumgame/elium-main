import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { savePdfAuto, readDiskStateAuto, buildPdfAuto } from "../src/pdf/worker/pdf-save-client";
import { runSaveTask, runReadDiskTask, type SaveRequest } from "../src/pdf/worker/save-task";
import { createCrypt, writeEncrypted } from "../src/pdf/ops/security";
import * as D from "../src/pdf/model/doc";
import { emptyState, newId, type Annot, type PdfState } from "../src/pdf/model/types";

async function makePdf(pages: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([300, 200]).drawText(`Page ${i + 1}`, { x: 20, y: 120, size: 14, font });
  return doc.save({ useObjectStreams: false });
}
const stateFor = (n: number): PdfState => ({ ...emptyState(), pages: D.pagesFromSource(n) });
const note = (pageId: string): Annot =>
  ({
    id: newId("an"),
    pageId,
    kind: "note",
    rect: { x: 15, y: 60, w: 20, h: 20 },
    color: "#000000",
    fill: "#ffff00",
    opacity: 1,
    strokeWidth: 1,
    author: "Test",
    contents: "Vu",
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
    replies: [],
  }) as Annot;

const baseReq = (source: Uint8Array, state: PdfState): SaveRequest => ({
  op: "save",
  retain: true,
  source,
  disk: null,
  state,
  options: {
    interactiveAnnots: true,
    flattenForms: false,
    applyRedactions: true,
    sanitise: false,
    optimise: false,
    author: "T",
    fileName: "t.pdf",
  },
  pristineAnnotIds: null,
  bookmarksPristine: false,
  fonts: [],
  standardFontDataUrl: null,
});

describe("enregistrement hors du fil principal (cœur du Worker)", () => {
  it("produit le même fichier logique que savePdf : pages, annotation, mode", async () => {
    const src = await makePdf(3);
    const st = stateFor(3);
    st.annots = [note(st.pages[0]!.id)];
    const progress: string[] = [];
    const res = await runSaveTask(baseReq(src, st), (_f, label) => progress.push(label));
    const doc = await PDFDocument.load(res.bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(res.report.annotsWritten).toBe(1);
    expect(res.report.mode).toBe("incremental");
    expect(progress.length).toBeGreaterThan(2);
    expect(typeof res.disk.token).toBe("string");
  });

  it("deuxième enregistrement incrémental via le jeton (état gardé), puis sans jeton (relu depuis les octets)", async () => {
    const src = await makePdf(2);
    const st = stateFor(2);
    st.annots = [note(st.pages[0]!.id)];
    const r1 = await runSaveTask(baseReq(src, st), undefined);
    const st2 = { ...st, annots: [...st.annots, note(st.pages[1]!.id)] };
    const withToken = await runSaveTask(
      { ...baseReq(src, st2), disk: { bytes: r1.disk.bytes, floor: r1.disk.floor, token: r1.disk.token } },
      undefined,
    );
    expect(withToken.report.mode).toBe("incremental");
    expect((await PDFDocument.load(withToken.bytes)).getPageCount()).toBe(2);
    const noToken = await runSaveTask(
      { ...baseReq(src, st2), disk: { bytes: r1.disk.bytes, floor: r1.disk.floor, token: null } },
      undefined,
    );
    expect(noToken.report.mode).toBe("incremental");
    expect((await PDFDocument.load(noToken.bytes)).getPageCount()).toBe(2);
  });

  it("fichier chiffré : le mandataire garde un témoin de chiffrement et le mot de passe erroné est typé", async () => {
    const plain = await PDFDocument.load(await makePdf(1));
    const crypt = createCrypt({ userPassword: "secret", ownerPassword: "owner" } as never);
    const enc = await writeEncrypted(plain, crypt);
    const disk = await runReadDiskTask({
      op: "readDisk",
      bytes: enc,
      password: "secret",
      fonts: [],
      standardFontDataUrl: null,
    });
    expect(disk.crypt).toBeTruthy();
    await expect(
      runReadDiskTask({ op: "readDisk", bytes: enc, password: "faux", fonts: [], standardFontDataUrl: null }),
    ).rejects.toMatchObject({ name: "WrongPassword" });
  });
});

describe("savePdfAuto / buildPdfAuto / readDiskStateAuto (repli en ligne sous jsdom)", () => {
  it("enregistre, exporte et relit sans Worker", async () => {
    const src = await makePdf(2);
    const st = stateFor(2);
    st.annots = [note(st.pages[0]!.id)];
    const res = await savePdfAuto({ source: src, state: st });
    expect((await PDFDocument.load(res.bytes)).getPageCount()).toBe(2);
    const built = await buildPdfAuto(src, st, { keepSkipped: true });
    expect(built.report.pages).toBe(2);
    const disk = await readDiskStateAuto(src);
    expect(disk.tail).not.toBeNull();
  });
});
