/**
 * Comments as FDF — Acrobat's « Exporter les commentaires » in its native
 * format, and « Importer les commentaires » from one.
 *
 * Both directions go through the code a PDF goes through, so an FDF carries
 * exactly what a saved file would:
 * - export: the annotations are written by `writeAnnots` (appearances, /RD,
 *   replies, states…) onto blank pages the size of the document's, then the
 *   annotation objects are serialised as an FDF (`/FDF /Annots`, `/Page`
 *   instead of `/P`);
 * - import: the FDF's annotations are copied onto blank pages the size of the
 *   document's and that little PDF is read like any opened file (pdf.js +
 *   `resolveAnnotExtras` + `importPageAnnots`).
 */

import type { PDFDict as PDFDictT, PDFRef as PDFRefT } from "pdf-lib";
import type { Annot, MeasureScale, Page } from "../model/types";
import { newId } from "../model/types";
import type { RawAnnotation } from "./import-annots";

/** A page's geometry: unrotated size, crop-box origin, /Rotate. */
export interface FdfPageBox {
  w: number;
  h: number;
  ox?: number;
  oy?: number;
  rotate?: number;
}

async function blankLike(boxes: readonly FdfPageBox[]) {
  const { PDFDocument, degrees } = await import("pdf-lib");
  const doc = await PDFDocument.create({ updateMetadata: false });
  for (const b of boxes) {
    const page = doc.addPage([b.w, b.h]);
    const ox = b.ox ?? 0;
    const oy = b.oy ?? 0;
    if (ox || oy) page.setMediaBox(ox, oy, b.w, b.h);
    if (b.rotate) page.setRotation(degrees(b.rotate));
  }
  return doc;
}

/** The annotations as an FDF file referring to `sourceName`. */
export async function toFdfComments(
  annots: readonly Annot[],
  pages: readonly Page[],
  boxes: ReadonlyMap<string, FdfPageBox>,
  sourceName: string,
  opts: { author: string; measureScale: MeasureScale },
): Promise<Uint8Array> {
  const lib = await import("pdf-lib");
  const { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFString, PDFWriter } = lib;
  const { pageFrame, writeAnnots } = await import("./annots-pdf");
  const { FontBook } = await import("./fonts");
  const { ImageBank } = await import("./images");

  const geo = pages.map((p) => boxes.get(p.id) ?? { w: 595, h: 842 });
  const doc = await blankLike(geo);
  const fonts = new FontBook(doc);
  const images = new ImageBank(doc);
  const pageRefs = doc.getPages().map((p) => p.ref);
  for (const [index, model] of pages.entries()) {
    const mine = annots.filter((a) => a.pageId === model.id);
    if (!mine.length) continue;
    const page = doc.getPage(index);
    await writeAnnots(
      page,
      mine,
      { doc, frame: pageFrame(page), fonts, images, measureScale: opts.measureScale, rotation: geo[index].rotate },
      { defaultAuthor: opts.author, pageRefs },
    );
  }
  await doc.flush();

  // Every annotation object, with its page as a number (FDF has no page tree).
  const list: PDFRefT[] = [];
  doc.getPages().forEach((page, index) => {
    const arr = page.node.Annots();
    if (!(arr instanceof PDFArray)) return;
    for (let i = 0; i < arr.size(); i++) {
      const ref = arr.get(i);
      const dict = arr.lookup(i);
      if (!(ref instanceof PDFRef) || !(dict instanceof PDFDict)) continue;
      dict.delete(PDFName.of("P"));
      dict.set(PDFName.of("Page"), PDFNumber.of(index));
      list.push(ref);
    }
  });
  // The pages themselves are not part of an FDF.
  const pageTree = doc.catalog.get(PDFName.of("Pages"));
  for (const ref of pageRefs) doc.context.delete(ref);
  if (pageTree instanceof PDFRef) doc.context.delete(pageTree);
  const catalogRef = doc.context.trailerInfo.Root;
  if (catalogRef instanceof PDFRef) doc.context.delete(catalogRef);

  const fdf = doc.context.obj({ FDF: { F: PDFString.of(sourceName), Annots: list } } as never);
  doc.context.trailerInfo.Root = doc.context.register(fdf);
  delete doc.context.trailerInfo.Info;
  const bytes = await PDFWriter.forContext(doc.context, 50).serializeToBuffer();
  // Same length: « %PDF-1.7 » → « %FDF-1.2 ».
  const head = new TextEncoder().encode("%FDF-1.2");
  bytes.set(head, 0);
  return bytes;
}

/**
 * The FDF's annotations as Elium comments on `pages`. `readAnnotations` reads
 * a PDF's annotations per 0-based page the way the viewer does (pdf.js'
 * `getAnnotations`), so the import is the one of an opened file.
 *
 * Imported comments get fresh ids (never a « 12R » that would be taken for an
 * object of the open file); the FDF's /NM is kept to recognise them again.
 */
export async function fromFdfComments(
  bytes: Uint8Array,
  pages: readonly Page[],
  boxes: ReadonlyMap<string, FdfPageBox>,
  author: string,
  readAnnotations: (pdf: Uint8Array) => Promise<RawAnnotation[][]>,
): Promise<Annot[]> {
  const lib = await import("pdf-lib");
  const { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFObjectCopier, PDFRef } = lib;
  const { importPageAnnots, resolveAnnotExtras, withExtras } = await import("./import-annots");

  // pdf-lib reads an FDF as the PDF syntax it is; only the header differs.
  const asPdf = bytes.slice();
  const text = new TextDecoder("latin1").decode(asPdf.subarray(0, 1024));
  const at = text.indexOf("%FDF-");
  if (at < 0) return [];
  asPdf.set(new TextEncoder().encode("%PDF-"), at);
  const src = await PDFDocument.load(asPdf, {
    ignoreEncryption: true,
    throwOnInvalidObject: false,
    updateMetadata: false,
  });
  const root = src.context.lookup(src.context.trailerInfo.Root);
  const fdf = root instanceof PDFDict ? root.lookup(PDFName.of("FDF")) : undefined;
  const list = fdf instanceof PDFDict ? fdf.lookup(PDFName.of("Annots")) : undefined;
  if (!(list instanceof PDFArray) || !list.size()) return [];

  const geo = pages.map((p) => boxes.get(p.id) ?? { w: 595, h: 842 });
  const doc = await blankLike(geo);
  const copier = PDFObjectCopier.for(src.context, doc.context);
  for (let i = 0; i < list.size(); i++) {
    const dict = list.lookup(i);
    if (!(dict instanceof PDFDict)) continue;
    const pageNo = dict.lookup(PDFName.of("Page"));
    const index = pageNo instanceof PDFNumber ? pageNo.asNumber() : 0;
    if (index < 0 || index >= geo.length) continue;
    // Through the ref: the copier maps each FDF object once, so the /IRT and
    // /Parent links between annotations land on the same copies.
    const ref = list.get(i);
    const target = ref instanceof PDFRef ? (copier.copy(ref) as PDFRefT) : doc.context.register(copier.copy(dict));
    const copy = doc.context.lookup(target, PDFDict) as PDFDictT;
    copy.delete(PDFName.of("Page"));
    const page = doc.getPage(index);
    copy.set(PDFName.of("P"), page.ref);
    page.node.addAnnot(target);
  }
  const pdf = await doc.save({ useObjectStreams: false, updateFieldAppearances: false });

  const raws = await readAnnotations(pdf);
  const extras = await resolveAnnotExtras(pdf);
  const out: Annot[] = [];
  for (const [index, model] of pages.entries()) {
    const raw = raws[index];
    if (!raw?.length) continue;
    const b = geo[index];
    const { annots } = importPageAnnots(withExtras(raw, extras.get(index)), model.id, b.h, author, {
      x: b.ox ?? 0,
      y: b.oy ?? 0,
    });
    out.push(...annots);
  }
  return out.map((a) => ({
    ...a,
    id: newId("an"),
    replies: (a.replies ?? []).map((r) => ({ ...r, id: newId("rp") })),
  }));
}
