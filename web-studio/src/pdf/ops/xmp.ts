/**
 * Keeping the XMP metadata packet in step with the Info dictionary.
 *
 * Acrobat (and pdf.js for the title) read a document's properties from its
 * XMP packet first: changing the Info dictionary alone would leave Acrobat
 * showing the OLD title/author, and a PDF/A file whose Info and XMP disagree is
 * no longer conformant. Only properties the packet already carries are
 * updated (element or attribute form); nothing is invented, and a packet we
 * cannot read is left alone.
 */

import { PDFName, PDFRawStream, PDFRef, PDFStream, decodePDFRawStream } from "pdf-lib";
import type { PDFDocument } from "pdf-lib";

export interface XmpChanges {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  producer?: string;
  /** Modification date (xmp:ModifyDate / xmp:MetadataDate). */
  modified?: Date;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** ISO 8601 with the local offset, as XMP dates are written. */
export function xmpDate(d: Date): string {
  const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

/** Replace a simple property, in element (`<p:x>v</p:x>`) or attribute (`p:x="v"`) form. */
function setSimple(xml: string, qname: string, value: string): string {
  const q = qname.replace(":", "\\:");
  const element = new RegExp(`(<${q}(?:\\s[^>]*)?>)([\\s\\S]*?)(</${q}>)`, "g");
  let out = xml.replace(element, (_m, open: string, _v: string, close: string) => `${open}${esc(value)}${close}`);
  const attribute = new RegExp(`(\\s${q}\\s*=\\s*)(["'])([\\s\\S]*?)\\2`, "g");
  out = out.replace(attribute, (_m, pre: string, quote: string) => `${pre}${quote}${esc(value)}${quote}`);
  return out;
}

/** Replace the items of a language alternative / ordered array property (dc:title, dc:creator…). */
function setList(xml: string, qname: string, value: string): string {
  const q = qname.replace(":", "\\:");
  const block = new RegExp(`(<${q}(?:\\s[^>]*)?>)([\\s\\S]*?)(</${q}>)`, "g");
  return xml.replace(block, (_m, open: string, inner: string, close: string) => {
    let first = true;
    // Keep the container (rdf:Alt / rdf:Seq / rdf:Bag) and the first item's attributes (xml:lang).
    const items = inner.replace(
      /<rdf:li(\s[^>]*)?>([\s\S]*?)<\/rdf:li>|<rdf:li(\s[^>]*)?\/>/g,
      (_i, a1?: string, _v?: string, a2?: string) => {
        if (!first) return "";
        first = false;
        return `<rdf:li${a1 ?? a2 ?? ""}>${esc(value)}</rdf:li>`;
      },
    );
    return `${open}${items}${close}`;
  });
}

/** The updated packet, or null when nothing changed. Pure. */
export function updateXmp(xml: string, c: XmpChanges): string | null {
  let out = xml;
  if (c.title !== undefined) out = setList(out, "dc:title", c.title);
  if (c.author !== undefined) out = setList(out, "dc:creator", c.author);
  if (c.subject !== undefined) out = setList(out, "dc:description", c.subject);
  if (c.keywords !== undefined) out = setSimple(out, "pdf:Keywords", c.keywords);
  if (c.producer !== undefined) out = setSimple(out, "pdf:Producer", c.producer);
  if (c.modified) {
    const when = xmpDate(c.modified);
    out = setSimple(out, "xmp:ModifyDate", when);
    out = setSimple(out, "xmp:MetadataDate", when);
  }
  return out === xml ? null : out;
}

/** Apply `updateXmp` to the document's catalog /Metadata stream, in place (same object number). */
export function syncXmp(doc: PDFDocument, c: XmpChanges): boolean {
  const ref = doc.catalog.get(PDFName.of("Metadata"));
  if (!(ref instanceof PDFRef)) return false;
  const stream = doc.context.lookup(ref);
  if (!(stream instanceof PDFStream)) return false;
  let raw: Uint8Array;
  try {
    const filtered = (stream as unknown as { dict: import("pdf-lib").PDFDict }).dict.has(PDFName.of("Filter"));
    raw =
      stream instanceof PDFRawStream
        ? filtered
          ? decodePDFRawStream(stream).decode()
          : stream.contents
        : (stream as unknown as { getUnencodedContents(): Uint8Array }).getUnencodedContents();
  } catch {
    return false;
  }
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(raw);
  if (!xml.includes("xmpmeta") && !xml.includes("rdf:RDF")) return false;
  const next = updateXmp(xml, c);
  if (next === null) return false;
  const bytes = new TextEncoder().encode(next);
  // Written uncompressed, as XMP is meant to be (tools scan for the packet).
  doc.context.assign(ref, doc.context.stream(bytes, { Type: "Metadata", Subtype: "XML" }));
  return true;
}
