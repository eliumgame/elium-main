/**
 * Name trees (ISO 32000 §7.9.6): /EmbeddedFiles, /Dests… Read in order,
 * written back as one sorted leaf — the form every viewer reads, where
 * appending to a tree (what pdf-lib's `attach` does) breaks its order, or its
 * shape when the root has /Kids.
 */

import type { PDFDocument, PDFObject } from "pdf-lib";
import { PDFArray, PDFDict, PDFHexString, PDFName, PDFString } from "pdf-lib";

export interface NameEntry {
  /** The key as text. */
  key: string;
  /** The key as written (string object). */
  k: PDFObject;
  /** The value (often a reference). */
  v: PDFObject;
}

const keyText = (k: unknown) => (k instanceof PDFString || k instanceof PDFHexString ? k.decodeText() : "");
const keyBytes = (k: unknown): Uint8Array =>
  k instanceof PDFString || k instanceof PDFHexString ? k.asBytes() : new Uint8Array();

/** Every entry of the tree under `holder[name]`, in the tree's order (leaves left to right). */
export function readNameTree(holder: PDFDict | undefined, name: string): NameEntry[] {
  const out: NameEntry[] = [];
  const walk = (node: unknown, depth: number) => {
    if (!(node instanceof PDFDict) || depth > 32) return;
    const list = node.lookup(PDFName.of("Names"));
    if (list instanceof PDFArray) {
      for (let i = 0; i + 1 < list.size(); i += 2) {
        out.push({ key: keyText(list.lookup(i)), k: list.get(i), v: list.get(i + 1) });
      }
    }
    const kids = node.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i), depth + 1);
  };
  walk(holder?.lookup(PDFName.of(name)), 0);
  return out;
}

/** A key object for `text`: a plain string when ASCII (links and lookups compare bytes). */
export function nameKey(text: string): PDFObject {
  return /^[\x20-\x7e]*$/.test(text) ? PDFString.of(text) : PDFHexString.fromText(text);
}

/**
 * Write `entries` as the tree `holder[name]`: one leaf, sorted by the keys'
 * bytes (ISO 32000's order), no /Limits needed. No entries: the tree goes.
 */
export function writeNameTree(doc: PDFDocument, holder: PDFDict, name: string, entries: readonly NameEntry[]): void {
  if (!entries.length) {
    holder.delete(PDFName.of(name));
    return;
  }
  const sorted = [...entries].sort((a, b) => {
    const x = keyBytes(a.k);
    const y = keyBytes(b.k);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
  holder.set(PDFName.of(name), doc.context.obj({ Names: sorted.flatMap((e) => [e.k, e.v]) } as never));
}

/** `text`, or « text (2) », « text (3) »… — the first not among `taken`. */
export function uniqueKey(text: string, taken: ReadonlySet<string>): string {
  if (!taken.has(text)) return text;
  const dot = text.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [text.slice(0, dot), text.slice(dot)] : [text, ""];
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!taken.has(next)) return next;
  }
}
