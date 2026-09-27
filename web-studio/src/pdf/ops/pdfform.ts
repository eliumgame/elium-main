/**
 * The AcroForm of a pdf-lib document WITHOUT pdf-lib's side effect:
 * `PDFDocument.getForm()` deletes the document's XFA every time it is called
 * (« pdf-lib does not support reading or writing XFA »), which silently
 * destroyed dynamic XFA forms — and hybrid ones without a word — on any save
 * touching a field. What happens to XFA is decided in `xfa.ts` only.
 */

import type { PDFDocument, PDFForm } from "pdf-lib";

export function formOf(doc: PDFDocument): PDFForm {
  const cache = (doc as unknown as { formCache?: { access(): PDFForm } }).formCache;
  return cache ? cache.access() : doc.getForm();
}
