/**
 * Identity rules for annotations that travel between files (PDF, XFDF, FDF).
 *
 * An annotation imported from the open file has pdf.js' id (« 12R ») as its
 * model id: it names an object of THAT file (the save relies on it to keep or
 * re-link the original). Such an id must never leave the file — as an /NM or
 * an XFDF name it would, in another document, match an unrelated « 12R ».
 */

import { newId } from "../model/types";

/** pdf.js' id for an annotation object of the open file (« 12R », « 12R3 »). */
export function isPdfjsId(id: string | null | undefined): boolean {
  return !!id && /^\d+R\d*$/.test(id);
}

/** A fresh unique name for /NM or an XFDF `name`. */
export function newAnnotName(): string {
  const uuid = (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.();
  return uuid ?? newId("nm");
}

/** The name an annotation travels under (its /NM; never a pdf.js id). */
export function travelName(a: { id: string; pdf?: { nm?: string } }): string {
  return a.pdf?.nm ?? (isPdfjsId(a.id) ? `elium-${a.id}-${newId("x")}` : a.id);
}

/** A MIME type as `type/subtype`, or the generic binary one. */
export function safeMime(m: string | null | undefined): string {
  const v = (m ?? "").trim().toLowerCase();
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(v) ? v : "application/octet-stream";
}

/**
 * Rich text (/RC) as XML that can sit inside an XFDF element: the prolog
 * dropped, and only if what remains is well-formed (null otherwise).
 */
export function embeddableRichText(rc: string): string | null {
  const body = rc.replace(/^﻿?\s*<\?xml[^?]*\?>\s*/i, "").trim();
  if (!body.startsWith("<") || typeof DOMParser === "undefined") return null;
  const doc = new DOMParser().parseFromString(body, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) return null;
  return new XMLSerializer().serializeToString(doc.documentElement);
}
