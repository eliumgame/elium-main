/**
 * Form data exchange, as Acrobat does it (« Exporter / Importer les données ») :
 *
 *  - FDF (ISO 32000 §12.7.8) — written as Acrobat writes it: one tree of
 *    /Kids per name part (« client.nom » → /T (client) /Kids [ /T (nom) ]),
 *    text as PDF strings (UTF-16BE with BOM when needed), box states and
 *    radio buttons as NAMES (/V /Oui), multi-select lists as arrays. Read with
 *    a small object parser: indirect objects and references, literal strings
 *    with every escape (octal, \n…), hex strings, UTF-16, #xx in names,
 *    hierarchies, /V inherited as Acrobat writes it.
 *  - XFDF (the XML form: `<fields><field name><value>`), nested fields too.
 *  - Tab-delimited text (Acrobat's « .txt » : a header row of field names,
 *    then values; the first data row is imported).
 *
 * Import maps each value onto the document's field by its fully qualified
 * name and type (`core/forms/values.ts`); names the document does not have are
 * reported, not silently counted as imported.
 */

import type { FormValue } from "../model/types";
import { coerceValue, type FormField } from "../core/forms/values";

/** A value as a data file holds it, before it is matched to a field. */
export type RawDataValue =
  { kind: "text"; text: string } | { kind: "name"; text: string } | { kind: "list"; items: string[] };

export interface DataEntry {
  name: string;
  type: FormField["type"];
  value: FormValue;
}

// ---------------------------------------------------------------------------
// PDF strings and names
// ---------------------------------------------------------------------------

/** PDFDocEncoding bytes 0x18–0x1F and 0x80–0x9F that differ from Latin-1. */
const PDFDOC_HIGH: Record<number, string> = {
  0x18: "˘", 0x19: "ˇ", 0x1a: "ˆ", 0x1b: "˙", 0x1c: "˝", 0x1d: "˛", 0x1e: "˚", 0x1f: "˜",
  0x80: "•", 0x81: "†", 0x82: "‡", 0x83: "…", 0x84: "—", 0x85: "–", 0x86: "ƒ", 0x87: "⁄",
  0x88: "‹", 0x89: "›", 0x8a: "−", 0x8b: "‰", 0x8c: "„", 0x8d: "“", 0x8e: "”", 0x8f: "‘",
  0x90: "’", 0x91: "‚", 0x92: "™", 0x93: "ﬁ", 0x94: "ﬂ", 0x95: "Ł", 0x96: "Œ", 0x97: "Š",
  0x98: "Ÿ", 0x99: "Ž", 0x9a: "ı", 0x9b: "ł", 0x9c: "œ", 0x9d: "š", 0x9e: "ž", 0xa0: "€",
}; // prettier-ignore

/** Bytes of a PDF string → text (UTF-16BE / UTF-8 with BOM, else PDFDocEncoding). */
export function decodePdfString(bytes: number[]): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = "";
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return s;
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes.slice(3)));
  }
  return bytes.map((b) => PDFDOC_HIGH[b] ?? String.fromCharCode(b)).join("");
}

/** Text → a PDF string token: literal when plain ASCII, else UTF-16BE hex with BOM. */
export function encodePdfString(text: string): string {
  if (/^[\x20-\x7e\t\r\n]*$/.test(text)) {
    return `(${text
      .replace(/[\\()]/g, "\\$&")
      .replace(/\r/g, "\\r")
      .replace(/\n/g, "\\n")})`;
  }
  let hex = "FEFF";
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${hex}>`;
}

/** Text → a PDF name token (UTF-8, #xx for delimiters, whitespace and non-ASCII). */
export function encodePdfName(text: string): string {
  let out = "/";
  for (const b of new TextEncoder().encode(text)) {
    const c = String.fromCharCode(b);
    out += b < 0x21 || b > 0x7e || "#()<>[]{}/%".includes(c) ? `#${b.toString(16).padStart(2, "0").toUpperCase()}` : c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// A minimal PDF object parser (enough for FDF)
// ---------------------------------------------------------------------------

type Obj =
  | { t: "str"; bytes: number[] }
  | { t: "name"; v: string }
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "null" }
  | { t: "ref"; n: number; g: number }
  | { t: "arr"; v: Obj[] }
  | { t: "dict"; v: Map<string, Obj> };

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
/** One char per byte (TextDecoder's « latin1 » is windows-1252: fine for tokens, which are ASCII). */
const LATIN1 = new TextDecoder("latin1");
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

class Lexer {
  pos = 0;
  constructor(readonly b: Uint8Array) {}

  skip(): void {
    const b = this.b;
    while (this.pos < b.length) {
      const c = b[this.pos];
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++;
      } else break;
    }
  }

  /** A regular token (keyword or number) at the current position. */
  word(): string {
    const start = this.pos;
    while (this.pos < this.b.length && !WS.has(this.b[this.pos]) && !DELIM.has(this.b[this.pos])) this.pos++;
    // (No spread of the bytes: a huge token would overflow the call stack.)
    return LATIN1.decode(this.b.subarray(start, this.pos));
  }

  literal(): number[] {
    const b = this.b;
    const out: number[] = [];
    let depth = 1;
    this.pos++; // (
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 0x5c) {
        const e = b[this.pos++];
        const map: Record<number, number> = {
          0x6e: 10,
          0x72: 13,
          0x74: 9,
          0x62: 8,
          0x66: 12,
          0x28: 0x28,
          0x29: 0x29,
          0x5c: 0x5c,
        };
        if (e in map) out.push(map[e]);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let k = 0; k < 2 && b[this.pos] >= 0x30 && b[this.pos] <= 0x37; k++) v = v * 8 + (b[this.pos++] - 0x30);
          out.push(v & 0xff);
        } else if (e === 0x0d) {
          if (b[this.pos] === 0x0a) this.pos++; // line continuation
        } else if (e !== 0x0a) out.push(e);
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) break;
        out.push(c);
      } else if (c === 0x0d) {
        // An end of line in a string is a single LF (§7.3.4.2).
        if (b[this.pos] === 0x0a) this.pos++;
        out.push(0x0a);
      } else out.push(c);
    }
    return out;
  }

  hex(): number[] {
    const b = this.b;
    this.pos++; // <
    let digits = "";
    while (this.pos < b.length && b[this.pos] !== 0x3e) {
      const c = String.fromCharCode(b[this.pos++]);
      if (/[0-9a-fA-F]/.test(c)) digits += c;
    }
    this.pos++; // >
    if (digits.length % 2) digits += "0";
    const out: number[] = [];
    for (let i = 0; i < digits.length; i += 2) out.push(parseInt(digits.slice(i, i + 2), 16));
    return out;
  }

  name(): string {
    this.pos++; // /
    const raw = this.word();
    const bytes: number[] = [];
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === "#" && /^[0-9a-fA-F]{2}$/.test(raw.slice(i + 1, i + 3))) {
        bytes.push(parseInt(raw.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(raw.charCodeAt(i));
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
    } catch {
      let out = "";
      for (const b of bytes) out += String.fromCharCode(b);
      return out;
    }
  }

  /** The next object; `n g R` references are recognised. */
  obj(depth = 0): Obj | null {
    if (depth > 64) throw new Error("FDF : imbrication trop profonde");
    this.skip();
    const b = this.b;
    if (this.pos >= b.length) return null;
    const c = b[this.pos];
    if (c === 0x28) return { t: "str", bytes: this.literal() };
    if (c === 0x3c && b[this.pos + 1] === 0x3c) {
      this.pos += 2;
      const v = new Map<string, Obj>();
      for (;;) {
        this.skip();
        if (b[this.pos] === 0x3e && b[this.pos + 1] === 0x3e) {
          this.pos += 2;
          return { t: "dict", v };
        }
        if (b[this.pos] !== 0x2f) throw new Error("FDF : clé de dictionnaire attendue");
        const key = this.name();
        const val = this.obj(depth + 1);
        if (!val) throw new Error("FDF : dictionnaire tronqué");
        v.set(key, val);
      }
    }
    if (c === 0x3c) return { t: "str", bytes: this.hex() };
    if (c === 0x2f) return { t: "name", v: this.name() };
    if (c === 0x5b) {
      this.pos++;
      const v: Obj[] = [];
      for (;;) {
        this.skip();
        if (b[this.pos] === 0x5d) {
          this.pos++;
          return { t: "arr", v };
        }
        const item = this.obj(depth + 1);
        if (!item) throw new Error("FDF : tableau tronqué");
        v.push(item);
      }
    }
    const word = this.word();
    if (!word) {
      this.pos++;
      return this.obj(depth);
    }
    if (word === "true" || word === "false") return { t: "bool", v: word === "true" };
    if (word === "null") return { t: "null" };
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      // « n g R » ?
      const save = this.pos;
      this.skip();
      const g = this.word();
      this.skip();
      if (/^\d+$/.test(word) && /^\d+$/.test(g) && this.b[this.pos] === 0x52 /* R */) {
        this.pos++;
        return { t: "ref", n: Number(word), g: Number(g) };
      }
      this.pos = save;
      return { t: "num", v: Number(word) };
    }
    return { t: "name", v: word }; // stray keyword: tolerated
  }
}

/** Every `n g obj … endobj` and the trailer of an FDF file. */
function parseObjects(bytes: Uint8Array): { objects: Map<number, Obj>; trailer: Map<string, Obj> | null } {
  const text = LATIN1.decode(bytes.subarray(0, Math.min(bytes.length, 8)));
  if (!text.startsWith("%FDF")) throw new Error("Ce fichier n'est pas un FDF.");
  const objects = new Map<number, Obj>();
  const lex = new Lexer(bytes);
  let trailer: Map<string, Obj> | null = null;
  const latin = LATIN1.decode(bytes);
  // Bounded numbers at a token boundary: no quadratic backtracking on long digit runs.
  const re = /(?<![0-9])(\d{1,10})\s+(\d{1,5})\s+obj\b|trailer\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin))) {
    lex.pos = m.index + m[0].length;
    try {
      const o = lex.obj();
      if (!o) continue;
      if (m[1] !== undefined) objects.set(Number(m[1]), o);
      else if (o.t === "dict") trailer = o.v;
      re.lastIndex = Math.max(re.lastIndex, lex.pos);
      // A stream's data is not objects: skip to its end.
      lex.skip();
      if (latin.startsWith("stream", lex.pos)) {
        const end = latin.indexOf("endstream", lex.pos);
        re.lastIndex = end < 0 ? latin.length : end + 9;
      }
    } catch {
      /* a damaged object: skip it, keep reading */
    }
  }
  return { objects, trailer };
}

// ---------------------------------------------------------------------------
// FDF
// ---------------------------------------------------------------------------

/** FDF → the values it holds, by fully qualified field name. */
export function parseFdf(bytes: Uint8Array): Map<string, RawDataValue> {
  const { objects, trailer } = parseObjects(bytes);
  const resolve = (o: Obj | undefined, seen = 0): Obj | undefined =>
    o?.t === "ref" && seen < 32 ? resolve(objects.get(o.n), seen + 1) : o;
  const dict = (o: Obj | undefined) => {
    const r = resolve(o);
    return r?.t === "dict" ? r.v : undefined;
  };
  let root = dict(trailer?.get("Root"));
  // Some writers omit the trailer: take the object holding /FDF.
  if (!root) for (const o of objects.values()) if (o.t === "dict" && o.v.has("FDF")) root = o.v;
  const fdf = dict(root?.get("FDF"));
  const fields = resolve(fdf?.get("Fields"));
  const out = new Map<string, RawDataValue>();
  const value = (o: Obj | undefined): RawDataValue | null => {
    const v = resolve(o);
    if (!v) return null;
    if (v.t === "str") return { kind: "text", text: decodePdfString(v.bytes) };
    if (v.t === "name") return { kind: "name", text: v.v };
    if (v.t === "num") return { kind: "text", text: String(v.v) };
    if (v.t === "arr") {
      const items = v.v
        .map((x) => resolve(x))
        .map((x) => (x?.t === "str" ? decodePdfString(x.bytes) : x?.t === "name" ? x.v : null))
        .filter((x): x is string => x !== null);
      return { kind: "list", items };
    }
    return null;
  };
  // Each field dict once (shared or cyclic /Kids would be exponential), and a cap on the total.
  const seen = new Set<Map<string, Obj>>();
  const MAX_NODES = 100_000;
  const walk = (list: Obj | undefined, prefix: string, depth: number) => {
    const arr = resolve(list);
    if (arr?.t !== "arr" || depth > 32) return;
    for (const item of arr.v) {
      const f = dict(item);
      if (!f || seen.has(f) || seen.size >= MAX_NODES) continue;
      seen.add(f);
      const t = resolve(f.get("T"));
      const part = t?.t === "str" ? decodePdfString(t.bytes) : "";
      const name = part ? (prefix ? `${prefix}.${part}` : part) : prefix;
      if (f.has("V") && name) {
        const v = value(f.get("V"));
        if (v) out.set(name, v);
      }
      if (f.has("Kids")) walk(f.get("Kids"), name, depth + 1);
    }
  };
  walk(fields, "", 0);
  return out;
}

interface Node {
  kids: Map<string, Node>;
  value?: DataEntry;
}

/** The entries as a tree of name parts (« a.b.c »). */
function tree(entries: readonly DataEntry[]): Node {
  const root: Node = { kids: new Map() };
  for (const e of entries) {
    let node = root;
    for (const part of e.name.split(".")) {
      let next = node.kids.get(part);
      if (!next) node.kids.set(part, (next = { kids: new Map() }));
      node = next;
    }
    node.value = e;
  }
  return root;
}

function fdfValue(e: DataEntry): string {
  const v = e.value;
  if (e.type === "checkbox" || e.type === "radiobutton") {
    const s = v === true ? "Yes" : v === false || v === "" ? "Off" : Array.isArray(v) ? (v[0] ?? "Off") : v;
    return encodePdfName(s);
  }
  if (Array.isArray(v)) return `[${v.map(encodePdfString).join(" ")}]`;
  return encodePdfString(typeof v === "boolean" ? (v ? "Oui" : "") : v);
}

/** The values as an FDF file Acrobat imports (the /F entry names the PDF). */
export function toFdf(entries: readonly DataEntry[], pdfFileName: string): Uint8Array {
  const write = (node: Node): string =>
    [...node.kids]
      .map(([part, n]) => {
        const kids = n.kids.size ? ` /Kids [ ${write(n)} ]` : "";
        const v = n.value ? ` /V ${fdfValue(n.value)}` : "";
        return `<< /T ${encodePdfString(part)}${v}${kids} >>`;
      })
      .join("\n");
  const body = [
    "%FDF-1.2",
    "%âãÏÓ",
    "1 0 obj",
    `<< /FDF << /Fields [\n${write(tree(entries))}\n] /F ${encodePdfString(pdfFileName)} >> /Type /Catalog >>`,
    "endobj",
    "trailer",
    "<< /Root 1 0 R >>",
    "%%EOF",
    "",
  ].join("\n");
  const out = new Uint8Array(body.length);
  for (let i = 0; i < body.length; i++) out[i] = body.charCodeAt(i) & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// XFDF (form data)
// ---------------------------------------------------------------------------

const xmlEsc = (s: string) =>
  s
    // Characters XML 1.0 cannot carry at all (Acrobat rejects them too).
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\r/g, "&#13;");

/** The values as XFDF `<fields>` (Acrobat's XML form data). */
export function toXfdfFields(entries: readonly DataEntry[], pdfFileName: string): string {
  const write = (node: Node, indent: string): string =>
    [...node.kids]
      .map(([part, n]) => {
        let inner = "";
        if (n.value) {
          const v = n.value.value;
          const list = Array.isArray(v) ? v : [v === true ? "Yes" : v === false ? "Off" : v];
          inner += list.map((x) => `${indent}  <value>${xmlEsc(x)}</value>\n`).join("");
        }
        if (n.kids.size) inner += write(n, `${indent}  `);
        return `${indent}<field name="${xmlEsc(part)}">\n${inner}${indent}</field>\n`;
      })
      .join("");
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n` +
    `  <fields>\n${write(tree(entries), "    ")}  </fields>\n` +
    `  <f href="${xmlEsc(pdfFileName)}"/>\n` +
    `</xfdf>\n`
  );
}

/** XFDF `<fields>` → the values it holds (empty when the file has only comments). */
export function parseXfdfFields(xml: string): Map<string, RawDataValue> {
  const out = new Map<string, RawDataValue>();
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("XFDF illisible.");
  const fields = [...doc.getElementsByTagName("*")].find((e) => e.localName === "fields");
  if (!fields) return out;
  const walk = (el: Element, prefix: string, depth: number) => {
    if (depth > 32) return;
    for (const child of [...el.children]) {
      if (child.localName !== "field") continue;
      const part = child.getAttribute("name") ?? "";
      const name = part ? (prefix ? `${prefix}.${part}` : part) : prefix;
      const values = [...child.children].filter((c) => c.localName === "value" || c.localName === "value-richtext");
      if (values.length && name) {
        const items = values.map((v) => v.textContent ?? "");
        out.set(name, items.length > 1 ? { kind: "list", items } : { kind: "text", text: items[0] });
      }
      walk(child, name, depth + 1);
    }
  };
  walk(fields, "", 0);
  return out;
}

// ---------------------------------------------------------------------------
// Tab-delimited text (Acrobat « .txt »)
// ---------------------------------------------------------------------------

const tabCell = (s: string) => (/[\t\r\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

function cellText(v: FormValue): string {
  if (Array.isArray(v)) return v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "Off";
  return v;
}

/**
 * Header row of field names, one row of values (what Acrobat's « Exporter →
 * Texte » writes). A multi-select list's items go one per line inside the
 * cell: a comma may be part of an item (« Paris, France »).
 */
export function toTabText(entries: readonly DataEntry[]): string {
  const cell = (v: FormValue) => (Array.isArray(v) ? v.join("\n") : cellText(v));
  return `${entries.map((e) => tabCell(e.name)).join("\t")}\r\n${entries.map((e) => tabCell(cell(e.value))).join("\t")}\r\n`;
}

function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === "") quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ""));
}

/** Tab-delimited text → the first data row, by header name. */
export function parseTabText(text: string): Map<string, RawDataValue> {
  const out = new Map<string, RawDataValue>();
  const rows = parseDelimited(text.replace(/^﻿/, ""), "\t");
  if (rows.length < 2) return out;
  const [head, first] = rows;
  head.forEach((name, i) => {
    if (name) out.set(name, { kind: "text", text: first[i] ?? "" });
  });
  return out;
}

/** CSV for spreadsheets (« Champ;Valeur », one field per row — Excel in French opens it as is). */
export function toCsv(entries: readonly DataEntry[]): string {
  const esc = (s: string) => (/[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = [["Champ", "Valeur"], ...entries.map((e) => [e.name, cellText(e.value)])];
  return `﻿${rows.map((r) => r.map(esc).join(";")).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Matching imported values to the document's fields
// ---------------------------------------------------------------------------

export interface ImportResult {
  values: Record<string, FormValue>;
  /** Names in the file that the document has no field for. */
  unknown: string[];
  /** Fields whose value in the file does not fit them (a box state it does not have…). */
  rejected: string[];
}

function onStates(field: FormField): string[] {
  return field.widgets.map((w) => w.exportValue).filter((x): x is string => !!x);
}

/** Give each imported value the shape of its field (see `core/forms/values.ts`). */
export function matchImported(
  fields: ReadonlyMap<string, FormField>,
  raw: ReadonlyMap<string, RawDataValue>,
): ImportResult {
  const res: ImportResult = { values: {}, unknown: [], rejected: [] };
  for (const [name, rv] of raw) {
    const field = fields.get(name);
    if (!field || field.type === "button" || field.type === "signature") {
      res.unknown.push(name);
      continue;
    }
    const text = rv.kind === "list" ? (rv.items[0] ?? "") : rv.text;
    switch (field.type) {
      case "checkbox":
      case "radiobutton": {
        const states = onStates(field);
        let v = text;
        if (v === "" || v === "Off") v = "Off";
        else if (!states.includes(v)) {
          // An /Opt export value, or « Yes » for a single box with another on-state.
          const opt = field.options.findIndex((o) => o.value === v || o.label === v);
          if (opt >= 0 && states[opt]) v = states[opt];
          else if (field.type === "checkbox" && states.length === 1 && /^(yes|oui|on|true|1)$/i.test(v)) v = states[0];
          else {
            res.rejected.push(name);
            continue;
          }
        }
        res.values[name] = v;
        break;
      }
      case "listbox":
        if (field.multiSelect) {
          // One item per line (tab text); a single known item is kept whole even with a comma.
          const items =
            rv.kind === "list"
              ? rv.items
              : !text
                ? []
                : text.includes("\n")
                  ? text.split(/\r?\n/)
                  : field.options.some((o) => o.value === text)
                    ? [text]
                    : text.split(/\s*,\s*/);
          res.values[name] = items.filter((x) => x !== "");
          break;
        }
        res.values[name] = coerceValue(field, text);
        break;
      default:
        res.values[name] = coerceValue(field, text);
    }
  }
  return res;
}

/** Every fillable field with its current value, in document order — what an export writes. */
export function exportEntries(fields: ReadonlyMap<string, FormField>, values: Record<string, FormValue>): DataEntry[] {
  const out: DataEntry[] = [];
  for (const f of fields.values()) {
    if (f.type === "button" || f.type === "signature") continue;
    out.push({ name: f.name, type: f.type, value: f.name in values ? values[f.name] : f.fileValue });
  }
  return out;
}
