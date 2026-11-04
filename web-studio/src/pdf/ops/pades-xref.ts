/** Validate post-signature xref routing independently of pdf-lib's sequential object scan. */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFParser, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { readXrefTail } from "./incremental";
import { unPng } from "./redact";

type Entry = { type: number; offset: number; generation: number };
type Section = { entries: Map<number, Entry>; prev?: number; hybrid?: number };
type Snapshot = { entries: Map<number, Entry>; sections: Set<number>; tail: number };
const MAX_ENTRIES = 1_000_000;
const MAX_SECTIONS = 1024;

function integer(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("entier xref invalide");
  return value;
}

// PDFParser exposes the same object parser used by PDFDocument, but here we
// seek to the offsets specified by xref instead of scanning all definitions.
class SectionParser extends PDFParser {
  appendedObjects(start: number): { objects: Map<number, Entry>; xrefs: Set<number> } {
    const objects = new Map<number, Entry>();
    const xrefs = new Set<number>();
    this.bytes.moveTo(start);
    while (!this.bytes.done()) {
      this.skipWhitespaceAndComments();
      if (this.bytes.done()) break;
      const at = this.bytes.offset();
      const token = this.token();
      if (token === "xref") {
        this.section(at);
        continue;
      }
      if (token === "startxref") {
        this.number();
        continue;
      }
      if (!/^\d+$/.test(token)) throw new Error("contenu inattendu entre révisions");
      const id = integer(Number(token));
      const generation = this.number();
      if (id >= MAX_ENTRIES || generation > 65535 || this.token() !== "obj")
        throw new Error("en-tête d'objet invalide");
      const obj = this.parseObject();
      if (obj instanceof PDFRawStream) {
        if (obj.dict.get(PDFName.of("Type")) === PDFName.of("ObjStm"))
          throw new Error("nouveaux objets comprimés non vérifiables");
        if (this.dictNumber(obj.dict, "Length") !== obj.getContents().length)
          throw new Error("longueur de flux non vérifiable");
      }
      if (this.token() !== "endobj") throw new Error("fin d'objet ambiguë");
      if (obj instanceof PDFRawStream && obj.dict.get(PDFName.of("Type")) === PDFName.of("XRef")) xrefs.add(id);
      objects.set(id, { type: 1, offset: at, generation });
    }
    return { objects, xrefs };
  }

  token(): string {
    this.skipWhitespaceAndComments();
    let out = "";
    while (!this.bytes.done() && ![0, 9, 10, 12, 13, 32, 60, 62, 91, 93, 47, 37].includes(this.bytes.peek())) {
      out += String.fromCharCode(this.bytes.next());
      if (out.length > 32) throw new Error("jeton xref trop long");
    }
    if (!out) throw new Error("jeton xref absent");
    return out;
  }

  number(): number {
    const token = this.token();
    if (!/^\d+$/.test(token)) throw new Error("entier xref attendu");
    return integer(Number(token));
  }

  section(at: number): Section {
    this.bytes.moveTo(at);
    const first = this.token();
    const entries = new Map<number, Entry>();
    let dict: PDFDict;
    const put = (id: number, entry: Entry) => {
      if (id >= MAX_ENTRIES || entries.has(id)) throw new Error("sous-sections xref incohérentes");
      entries.set(id, entry);
    };
    if (first === "xref") {
      for (;;) {
        const token = this.token();
        if (token === "trailer") break;
        if (!/^\d+$/.test(token)) throw new Error("sous-section xref invalide");
        const start = integer(Number(token));
        const count = this.number();
        if (start + count > MAX_ENTRIES) throw new Error("table xref trop grande");
        for (let i = 0; i < count; i++) {
          const offset = this.number();
          const generation = this.number();
          const state = this.token();
          if (generation > 65535 || !["n", "f"].includes(state)) throw new Error("entrée xref invalide");
          put(start + i, { type: state === "n" ? 1 : 0, offset, generation });
        }
      }
      const trailer = this.parseObject();
      if (!(trailer instanceof PDFDict)) throw new Error("trailer absent");
      dict = trailer;
    } else {
      if (!/^\d+$/.test(first)) throw new Error("section xref absente");
      this.number();
      if (this.token() !== "obj") throw new Error("flux xref absent");
      const stream = this.parseObject();
      if (!(stream instanceof PDFRawStream) || stream.dict.get(PDFName.of("Type")) !== PDFName.of("XRef"))
        throw new Error("flux xref invalide");
      dict = stream.dict;
      const widths = dict.get(PDFName.of("W"));
      const size = this.dictNumber(dict, "Size");
      const length = this.dictNumber(dict, "Length");
      if (
        !(widths instanceof PDFArray) ||
        widths.size() !== 3 ||
        size === undefined ||
        size > MAX_ENTRIES ||
        length !== stream.getContents().length
      )
        throw new Error("dimensions xref invalides");
      const w = widths.asArray().map((v) => (v instanceof PDFNumber ? integer(v.asNumber()) : NaN));
      if (w.some((v) => !Number.isFinite(v) || v > 6) || w.every((v) => v === 0))
        throw new Error("largeurs xref invalides");
      const index = dict.get(PDFName.of("Index"));
      const ranges =
        index === undefined
          ? [0, size]
          : index instanceof PDFArray
            ? index.asArray().map((v) => (v instanceof PDFNumber ? integer(v.asNumber()) : NaN))
            : [];
      if (!ranges.length || ranges.length % 2 || ranges.some((v) => !Number.isFinite(v)))
        throw new Error("index xref invalide");
      let count = 0;
      for (let i = 0; i < ranges.length; i += 2) {
        if (ranges[i]! + ranges[i + 1]! > MAX_ENTRIES) throw new Error("index xref trop grand");
        count += ranges[i + 1]!;
      }
      if (count > MAX_ENTRIES) throw new Error("flux xref trop grand");
      const rowBytes = w[0]! + w[1]! + w[2]!;
      let params = dict.get(PDFName.of("DecodeParms"));
      if (params instanceof PDFArray) {
        if (params.size() !== 1) throw new Error("prédicteurs xref multiples");
        params = params.get(0);
      }
      const predictor = params instanceof PDFDict ? (this.dictNumber(params, "Predictor") ?? 1) : 1;
      if (predictor !== 1 && (predictor < 10 || predictor > 15)) throw new Error("prédicteur xref non pris en charge");
      if (
        predictor !== 1 &&
        (!(params instanceof PDFDict) ||
          (this.dictNumber(params, "Columns") ?? 1) !== rowBytes ||
          (this.dictNumber(params, "Colors") ?? 1) !== 1 ||
          (this.dictNumber(params, "BitsPerComponent") ?? 8) !== 8)
      )
        throw new Error("dimensions du prédicteur xref invalides");
      const expected = count * (rowBytes + (predictor === 1 ? 0 : 1));
      let data: Uint8Array = new Uint8Array(decodePDFRawStream(stream).getBytes(expected + 1));
      if (data.length !== expected) throw new Error("longueur xref incohérente");
      if (predictor !== 1) {
        for (let row = 0; row < count; row++)
          if (data[row * (rowBytes + 1)]! > 4) throw new Error("filtre PNG xref invalide");
        data = unPng(data, rowBytes, 1, count);
      }
      let pos = 0;
      const read = (width: number) => {
        let value = 0;
        for (let i = 0; i < width; i++) value = value * 256 + data[pos++]!;
        return integer(value);
      };
      for (let r = 0; r < ranges.length; r += 2)
        for (let i = 0; i < ranges[r + 1]!; i++) {
          const type = w[0] ? read(w[0]) : 1;
          const offset = read(w[1]!);
          const generation = read(w[2]!);
          if (type > 2) throw new Error("type xref inconnu");
          put(ranges[r]! + i, { type, offset, generation });
        }
    }
    return { entries, prev: this.dictNumber(dict, "Prev"), hybrid: this.dictNumber(dict, "XRefStm") };
  }

  dictNumber(dict: PDFDict, key: string): number | undefined {
    const value = dict.get(PDFName.of(key));
    if (value === undefined) return undefined;
    if (!(value instanceof PDFNumber)) throw new Error("référence xref non directe");
    return integer(value.asNumber());
  }
}

function snapshot(bytes: Uint8Array): Snapshot {
  const tail = readXrefTail(bytes);
  if (!tail) throw new Error("fin xref illisible");
  const parser = new SectionParser(bytes);
  const sections = new Set<number>();
  const entries = new Map<number, Entry>();
  let at: number | undefined = tail.startxref;
  while (at !== undefined) {
    if (at <= 0 || at >= bytes.length || sections.has(at) || sections.size >= MAX_SECTIONS)
      throw new Error("chaîne xref incohérente");
    sections.add(at);
    const section = parser.section(at);
    if (section.hybrid !== undefined) {
      if (section.hybrid >= at || sections.has(section.hybrid)) throw new Error("xref hybride incohérente");
      sections.add(section.hybrid);
      const hybrid = parser.section(section.hybrid);
      if (hybrid.hybrid !== undefined) throw new Error("xref hybride imbriquée");
      for (const [id, entry] of hybrid.entries) section.entries.set(id, entry);
    }
    for (const [id, entry] of section.entries) if (!entries.has(id)) entries.set(id, entry);
    if (section.prev !== undefined && section.prev >= at) throw new Error("chaîne xref non décroissante");
    at = section.prev;
  }
  return { entries, sections, tail: tail.startxref };
}

const same = (a: Entry | undefined, b: Entry) =>
  !!a && a.type === b.type && a.offset === b.offset && a.generation === b.generation;

/** A changed xref must point to a newly written object, never reveal an older hidden definition. */
export function xrefRevisionProblem(bytes: Uint8Array, signedEnd: number): string | undefined {
  try {
    const before = snapshot(bytes.subarray(0, signedEnd));
    const after = snapshot(bytes);
    const appended = new SectionParser(bytes).appendedObjects(signedEnd);
    if (after.tail < signedEnd || !after.sections.has(before.tail))
      return "Chaîne des révisions xref remplacée après la signature";
    for (const [id, entry] of appended.objects) {
      if (appended.xrefs.has(id)) {
        if (before.entries.has(id) || !after.sections.has(entry.offset))
          return "Un objet signé a été reclassé en flux xref";
        if (!after.entries.has(id)) continue;
      }
      if (!same(after.entries.get(id), entry)) return "Divergence entre les objets ajoutés et les références xref";
    }
    for (const [id, entry] of after.entries) {
      if (id === 0 || same(before.entries.get(id), entry)) continue;
      // Compressed-object rebinding and freeing signed objects cannot be
      // reconciled safely with pdf-lib's scan. Fail closed for these updates.
      if (entry.type !== 1 || entry.offset < signedEnd || entry.offset >= bytes.length)
        return "Référence xref réaffectée après la signature";
      const head = String.fromCharCode(...bytes.subarray(entry.offset, entry.offset + 80));
      const match = /^(\d+)\s+(\d+)\s+obj\b/.exec(head);
      if (!match || Number(match[1]) !== id || Number(match[2]) !== entry.generation)
        return "Position d'objet xref incohérente après la signature";
    }
  } catch {
    return "Les références xref des révisions ne peuvent pas être vérifiées";
  }
  return undefined;
}
