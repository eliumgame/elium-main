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
import type { ContentEdit } from "../model/types";
import { pageFrame } from "./annots-pdf";
import { FontBook } from "./fonts";
import { openCrypt } from "./security";
import { applyTextEdits } from "./textedit";

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
): Promise<PreviewResult> {
  const src = await sourceDoc(source, password);
  const out = await PDFDocument.create({ updateMetadata: false });
  const [page] = await out.copyPages(src, [pageIndex]);
  out.addPage(page);
  const r = await applyTextEdits(out, page, edits, pageFrame(page), new FontBook(out));
  const bytes = await out.save({ useObjectStreams: false, updateFieldAppearances: false });
  return { bytes, missing: [...new Set(r.missing.join(""))].join(""), skipped: r.skipped };
}
