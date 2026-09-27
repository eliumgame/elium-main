/**
 * XFA in a file Elium writes form values into.
 *
 * A « hybrid » form carries both an XFA form (/AcroForm /XFA) and the
 * equivalent AcroForm fields. Acrobat shows the XFA data when both exist: a
 * value written into the AcroForm alone would appear in Acrobat with its OLD
 * content. The accepted practice (Acrobat's own « enregistrer en statique »,
 * and what every AcroForm filler does) is to drop the XFA packets once the
 * AcroForm is the one being filled: the pages are the same, drawn from the
 * AcroForm's widgets. A purely dynamic XFA form (no AcroForm field) cannot be
 * filled that way and is left untouched.
 */

import { PDFArray, PDFDict, PDFName } from "pdf-lib";
import type { PDFDocument } from "pdf-lib";

export type XfaKind = "none" | "hybrid" | "dynamic";

/** Does the document carry XFA, and can its AcroForm stand in for it? */
export function xfaKind(doc: PDFDocument): XfaKind {
  const acro = doc.catalog.lookup(PDFName.of("AcroForm"));
  if (!(acro instanceof PDFDict) || !acro.has(PDFName.of("XFA"))) return "none";
  const fields = acro.lookup(PDFName.of("Fields"));
  return fields instanceof PDFArray && fields.size() > 0 ? "hybrid" : "dynamic";
}

/**
 * Drop the XFA of a hybrid form (see the file header). Returns true when it
 * was removed. A dynamic XFA form is never touched.
 */
export function dropHybridXfa(doc: PDFDocument): boolean {
  if (xfaKind(doc) !== "hybrid") return false;
  const acro = doc.catalog.lookup(PDFName.of("AcroForm")) as PDFDict;
  acro.delete(PDFName.of("XFA"));
  // « NeedsRendering » asks for the (now absent) XFA to be laid out.
  doc.catalog.delete(PDFName.of("NeedsRendering"));
  return true;
}
