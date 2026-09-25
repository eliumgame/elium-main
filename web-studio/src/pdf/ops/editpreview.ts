/**
 * What an edited page will look like in the saved file — for the on-screen
 * preview of « Modifier le texte ».
 *
 * The preview used to be HTML text painted over a mask: another font, other
 * line breaks than the file would get. Here the page is rebuilt ALONE, in
 * memory, by the very code the save runs (`applyTextEdits` with the same
 * `FontBook`), so what the screen shows is what the file will hold — same
 * face, same wrapping, same substitutions.
 *
 * The source is parsed (and decrypted) once per document and kept; each
 * preview copies one page out of it, which leaves it untouched.
 */

import { PDFDocument } from "pdf-lib";
import type { Rect } from "../core/coords";
import type { ContentEdit, ImageEdit } from "../model/types";
import { pageFrame } from "./annots-pdf";
import { FontBook } from "./fonts";
import { ImageBank } from "./images";
import { openCrypt } from "./security";
import { applyImageEdits, applyTextEdits, pagePlacements } from "./textedit";

const sources = new WeakMap<Uint8Array, Promise<PDFDocument>>();

function sourceDoc(bytes: Uint8Array, password: string | null | undefined): Promise<PDFDocument> {
  let p = sources.get(bytes);
  if (!p) {
    p = (async () => {
      const doc = await PDFDocument.load(bytes, {
        ignoreEncryption: true,
        throwOnInvalidObject: false,
        updateMetadata: false,
      });
      const crypt = openCrypt(doc, password ?? "");
      if (crypt) await crypt.decryptDocument(doc);
      return doc;
    })();
    p.catch(() => sources.delete(bytes));
    sources.set(bytes, p);
  }
  return p;
}

export interface PreviewResult {
  /** A one-page PDF: the source page with its edits applied. */
  bytes: Uint8Array;
  /** Characters no available font could show (they will be missing from the file too). */
  missing: string;
  /** Paragraphs whose original text could not be found on the page. */
  skipped: number;
}

/** The page `pageIndex` of `source` with `edits` applied, as its own PDF. */
export async function rewrittenPage(
  source: Uint8Array,
  password: string | null | undefined,
  pageIndex: number,
  edits: readonly ContentEdit[],
  imageEdits: readonly ImageEdit[] = [],
): Promise<PreviewResult> {
  const src = await sourceDoc(source, password);
  const out = await PDFDocument.create({ updateMetadata: false });
  const [page] = await out.copyPages(src, [pageIndex]);
  out.addPage(page);
  // Same order as the save: text first, then pictures.
  const r = edits.length
    ? await applyTextEdits(out, page, edits, pageFrame(page), new FontBook(out))
    : { missing: [] as string[], skipped: 0 };
  if (imageEdits.length) {
    const bank = new ImageBank(out);
    await applyImageEdits(out, page, imageEdits, async (s) => {
      const img = await bank.get(s);
      return img ? { ref: img.ref } : null;
    });
  }
  const bytes = await out.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { bytes, missing: [...new Set(r.missing.join(""))].join(""), skipped: r.skipped };
}

/** A picture of the page's own content, as « Modifier » lists it. */
export interface PageImage {
  /** Draw-order index among the page's XObject placements (`ImageEdit.occurrence`). */
  occurrence: number;
  /** Bounding box of the whole picture, top-left unrotated page space. */
  rect: Rect;
  /** The part the file's own clip leaves visible (fractions, top-left), when cut. */
  crop?: Rect;
}

/**
 * The images the page `pageIndex` of `source` draws itself (not those inside
 * form XObjects, not inline images), in the space the editor works in.
 * Specks under 2 pt — separators, tracking pixels — are left out.
 */
export async function pageImages(
  source: Uint8Array,
  password: string | null | undefined,
  pageIndex: number,
): Promise<PageImage[]> {
  const src = await sourceDoc(source, password);
  const page = src.getPage(pageIndex);
  const box = page.getCropBox();
  const out: PageImage[] = [];
  for (const p of await pagePlacements(page)) {
    if (!p.isImage) continue;
    const xs = p.corners.map((c) => c.x - box.x);
    const ys = p.corners.map((c) => box.y + box.height - c.y);
    const rect = {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
    if (rect.w < 2 || rect.h < 2) continue;
    // Clipped away entirely: nothing to show nor edit.
    if (p.crop && (p.crop.w * rect.w < 2 || p.crop.h * rect.h < 2)) continue;
    out.push(p.crop ? { occurrence: p.occurrence, rect, crop: p.crop } : { occurrence: p.occurrence, rect });
  }
  return out;
}
