/**
 * PDF/A-2b and PDF/A-3b (ISO 19005-2/-3, conformance « b »): what Acrobat's
 * « Enregistrer au format PDF/A » does to a document, and a quick check of the
 * requirements a document already meets.
 *
 * Conversion, in place on a decrypted working copy:
 *  - output intent sRGB (a profile made here, see `srgbProfile`); pages and
 *    forms using DeviceCMYK get a DefaultCMYK ICC colour space (the CMYK
 *    profile pdf.js ships), which PDF/A accepts in place of device colours;
 *  - every font embedded: a standard font referenced by name (Helvetica,
 *    Times, Courier, Arial…) becomes the matching Liberation TrueType, with
 *    widths read from that font so the file stays consistent;
 *  - no encryption, no JavaScript nor forbidden actions (launch, sound,
 *    movie, reset form…), no additional-actions (/AA), no XFA;
 *  - annotations printable and visible, appearance /N only; annotation types
 *    PDF/A forbids removed; embedded files removed in PDF/A-2 (allowed in -3);
 *  - no transfer functions, alternates, interpolation, OPI;
 *  - XMP metadata declaring the part and conformance, in sync with /Info; a
 *    trailer /ID.
 * What cannot be fixed is reported (a symbolic font such as ZapfDingbats with
 * no substitute, a CID font not embedded…). Validation proper (veraPDF) is out
 * of reach in a browser; `checkPdfA` covers the usual failures.
 */
import fontkit from "@pdf-lib/fontkit";
import { unzlibSync as unzlib, zlibSync } from "fflate";
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from "pdf-lib";
import type { PDFDocument, PDFFont, PDFObject } from "pdf-lib";
import { parseToUnicode } from "../core/fontmetrics";
import {
  MACROMAN_ENCODING,
  STANDARD_ENCODING,
  WINANSI_ENCODING,
  aglNameFor,
  glyphNameToUnicode,
  isAglName,
} from "./glyphnames";
import { liberationBytes, type FontStyle, type UnicodeFamily } from "./unicodefonts";

export interface PdfAOptions {
  part: 2 | 3;
  /** A CMYK ICC profile for DefaultCMYK (pdf.js' CGATS001Compat); without it DeviceCMYK stays reported. */
  cmykProfile?: Uint8Array | null;
  producer?: string;
}

export interface PdfAReport {
  /** What was changed, in French. */
  fixed: string[];
  /** What could not be made conforming. */
  remaining: string[];
}

const N = (s: string) => PDFName.of(s);
const nameOf = (o: PDFObject | undefined) => (o instanceof PDFName ? o.decodeText() : undefined);

// ---------------------------------------------------------------------------
// sRGB profile
// ---------------------------------------------------------------------------

/** A small ICC v2 display profile for sRGB (D50-adapted primaries, gamma 2.2). */
export function srgbProfile(): Uint8Array {
  const s15 = (v: number) => Math.round(v * 65536);
  const enc = new TextEncoder();
  const tag = (sig: string, data: Uint8Array) => ({ sig, data });
  const xyz = (x: number, y: number, z: number) => {
    const d = new Uint8Array(20);
    const v = new DataView(d.buffer);
    d.set(enc.encode("XYZ "), 0);
    v.setInt32(8, s15(x));
    v.setInt32(12, s15(y));
    v.setInt32(16, s15(z));
    return d;
  };
  const curv = () => {
    const d = new Uint8Array(14);
    const v = new DataView(d.buffer);
    d.set(enc.encode("curv"), 0);
    v.setUint32(8, 1);
    v.setUint16(12, 0x0233); // gamma 2.2 (u8Fixed8)
    return d;
  };
  const desc = (text: string) => {
    const ascii = enc.encode(`${text}\0`);
    const d = new Uint8Array(12 + ascii.length + 4 + 4 + 2 + 1 + 67);
    const v = new DataView(d.buffer);
    d.set(enc.encode("desc"), 0);
    v.setUint32(8, ascii.length);
    d.set(ascii, 12);
    return d;
  };
  const text = (t: string) => {
    const ascii = enc.encode(`${t}\0`);
    const d = new Uint8Array(8 + ascii.length);
    d.set(enc.encode("text"), 0);
    d.set(ascii, 8);
    return d;
  };
  const tags = [
    tag("desc", desc("sRGB IEC61966-2.1 (Elium)")),
    tag("cprt", text("No copyright, use freely")),
    tag("wtpt", xyz(0.9642, 1.0, 0.8249)),
    tag("rXYZ", xyz(0.4361, 0.2225, 0.0139)),
    tag("gXYZ", xyz(0.3851, 0.7169, 0.0971)),
    tag("bXYZ", xyz(0.1431, 0.0606, 0.7141)),
    tag("rTRC", curv()),
    tag("gTRC", curv()),
    tag("bTRC", curv()),
  ];
  const pad4 = (n: number) => (n + 3) & ~3;
  let offset = 128 + 4 + tags.length * 12;
  const placed = tags.map((t) => {
    const at = offset;
    offset = pad4(offset + t.data.length);
    return { ...t, at };
  });
  const out = new Uint8Array(offset);
  const v = new DataView(out.buffer);
  v.setUint32(0, offset);
  v.setUint32(8, 0x02100000); // version 2.1
  out.set(enc.encode("mntrRGB XYZ "), 12);
  v.setUint16(24, 2026);
  v.setUint16(26, 1);
  v.setUint16(28, 1);
  out.set(enc.encode("acsp"), 36);
  v.setInt32(68, s15(0.9642));
  v.setInt32(72, s15(1.0));
  v.setInt32(76, s15(0.8249));
  v.setUint32(128, tags.length);
  placed.forEach((t, i) => {
    out.set(enc.encode(t.sig), 132 + i * 12);
    v.setUint32(136 + i * 12, t.at);
    v.setUint32(140 + i * 12, t.data.length);
    out.set(t.data, t.at);
  });
  return out;
}

// ---------------------------------------------------------------------------
// Walking the object graph
// ---------------------------------------------------------------------------

const streamDict = (o: PDFObject | undefined): PDFDict | null =>
  o instanceof PDFDict ? o : o instanceof PDFStream ? (o as unknown as { dict: PDFDict }).dict : null;

/**
 * Every dictionary of the document, indirect or direct (inline font and
 * graphics-state dictionaries in /Resources, annotation dictionaries inside
 * arrays…), each visited once. References are not followed: their targets are
 * visited as indirect objects.
 */
function forEachDict(doc: PDFDocument, visit: (d: PDFDict, isStream: boolean) => void): void {
  const seen = new Set<object>();
  const rec = (o: PDFObject | undefined, isStream = false) => {
    if (o instanceof PDFStream) return rec((o as unknown as { dict: PDFDict }).dict, true);
    if (o instanceof PDFArray) {
      if (seen.has(o)) return;
      seen.add(o);
      for (const v of o.asArray()) rec(v);
      return;
    }
    if (!(o instanceof PDFDict) || seen.has(o)) return;
    seen.add(o);
    visit(o, isStream);
    for (const [, v] of o.entries()) rec(v);
  };
  for (const [, obj] of [...doc.context.enumerateIndirectObjects()]) rec(obj);
}

interface Collected {
  fonts: Set<PDFDict>;
  gstates: Set<PDFDict>;
}

/** Font and graphics-state dictionaries: named as such, or found in a /Resources (or AcroForm /DR). */
function collectResources(d: PDFDict, out: Collected): void {
  const type = nameOf(d.lookup(N("Type")));
  if (type === "Font") out.fonts.add(d);
  if (type === "ExtGState") out.gstates.add(d);
  for (const key of ["Resources", "DR"]) {
    const res = d.lookup(N(key));
    if (!(res instanceof PDFDict)) continue;
    for (const [cat, set] of [
      ["Font", out.fonts],
      ["ExtGState", out.gstates],
    ] as const) {
      const sub = res.lookup(N(cat));
      if (!(sub instanceof PDFDict)) continue;
      for (const k of sub.keys()) {
        const v = sub.lookup(k);
        if (v instanceof PDFDict) set.add(v);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

type Face = {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  numGlyphs: number;
  bbox: { minX: number; minY: number; maxX: number; maxY: number };
  glyphForCodePoint(cp: number): { id: number; advanceWidth: number };
  getGlyph(id: number): { advanceWidth: number };
};

/** The Liberation face standing in for a font known by name, or null (symbolic, unknown). */
function substituteFor(baseFont: string): { family: UnicodeFamily; style: FontStyle } | null {
  const n = baseFont.replace(/^[A-Z]{6}\+/, "").toLowerCase();
  if (/symbol|dingbat|wingding|webding/.test(n)) return null;
  const bold = /bold|black|heavy|semibold|demi/.test(n);
  const italic = /italic|oblique/.test(n);
  const style: FontStyle = bold && italic ? "bi" : bold ? "b" : italic ? "i" : "r";
  if (/courier|mono|consol|fixed/.test(n)) return { family: "mono", style };
  if (/times|serif|georgia|garamond|cambria|book|mincho|song|ming/.test(n)) return { family: "serif", style };
  return { family: "sans", style };
}

function isEmbedded(font: PDFDict): boolean {
  const fd = font.lookup(N("FontDescriptor"));
  return fd instanceof PDFDict && ["FontFile", "FontFile2", "FontFile3"].some((k) => fd.has(N(k)));
}

/** The CIDFont under a Type0 font. */
function descendantOf(font: PDFDict): PDFDict | undefined {
  const desc = font.lookup(N("DescendantFonts"));
  const cid = desc instanceof PDFArray ? desc.lookup(0) : undefined;
  return cid instanceof PDFDict ? cid : undefined;
}

/** A font that must be embedded and is not, described for the report (undefined: fine). */
function missingFont(font: PDFDict): string | undefined {
  const st = nameOf(font.lookup(N("Subtype")));
  if (st === "Type3" || st === "CIDFontType0" || st === "CIDFontType2") return undefined;
  const base = nameOf(font.lookup(N("BaseFont"))) ?? "?";
  if (st === "Type0") {
    const cid = descendantOf(font);
    return cid && !isEmbedded(cid) ? `CID ${base}` : undefined;
  }
  return isEmbedded(font) ? undefined : base;
}

interface Substitute {
  base: string;
  sub: { family: UnicodeFamily; style: FontStyle };
  face: Face;
  k: number;
  file: PDFRef;
}

/** The Liberation stand-in for `base`, its font file registered once per face. */
async function loadSubstitute(doc: PDFDocument, base: string, cache: Map<string, PDFRef>): Promise<Substitute | null> {
  const sub = substituteFor(base);
  if (!sub) return null;
  const bytes = await liberationBytes(sub.style, sub.family);
  if (!bytes) return null;
  const face = fontkit.create(bytes) as unknown as Face;
  const key = `${sub.family}-${sub.style}`;
  let file = cache.get(key);
  if (!file) {
    const packed = zlibSync(bytes);
    file = doc.context.register(
      PDFRawStream.of(
        doc.context.obj({ Filter: "FlateDecode", Length: packed.length, Length1: bytes.length }) as PDFDict,
        packed,
      ),
    );
    cache.set(key, file);
  }
  return { base, sub, face, k: 1000 / face.unitsPerEm, file };
}

function descriptorFor(doc: PDFDocument, s: Substitute, symbolic: boolean): PDFRef {
  const { face, k, sub } = s;
  const flags =
    (symbolic ? 4 : 32) |
    (sub.family === "serif" ? 2 : 0) |
    (sub.family === "mono" ? 1 : 0) |
    (/i/.test(sub.style) ? 64 : 0);
  return doc.context.register(
    doc.context.obj({
      Type: "FontDescriptor",
      FontName: N(s.base.replace(/[^\x21-\x7e]/g, "").replace(/[()<>[\]{}/%#]/g, "") || "Font"),
      Flags: flags,
      FontBBox: [face.bbox.minX * k, face.bbox.minY * k, face.bbox.maxX * k, face.bbox.maxY * k].map(Math.round),
      ItalicAngle: face.italicAngle,
      Ascent: Math.round(face.ascent * k),
      Descent: Math.round(face.descent * k),
      CapHeight: Math.round((face.capHeight || face.ascent * 0.7) * k),
      StemV: 80,
      FontFile2: s.file,
    }),
  );
}

const BASE_ENCODINGS: Record<string, string[]> = {
  StandardEncoding: STANDARD_ENCODING,
  WinAnsiEncoding: WINANSI_ENCODING,
  MacRomanEncoding: MACROMAN_ENCODING,
};

/** Codes 0-255 to glyph names, as a simple font's /Encoding (and built-in encoding) define them. */
function simpleFontGlyphNames(font: PDFDict): string[] {
  const enc = font.lookup(N("Encoding"));
  // A Type 1 font's built-in encoding is StandardEncoding (the Latin standard fonts); a TrueType has none: WinAnsi.
  const builtIn = nameOf(font.lookup(N("Subtype"))) === "TrueType" ? WINANSI_ENCODING : STANDARD_ENCODING;
  const baseName = enc instanceof PDFDict ? nameOf(enc.lookup(N("BaseEncoding"))) : nameOf(enc);
  const names = [...(BASE_ENCODINGS[baseName ?? ""] ?? builtIn)];
  if (enc instanceof PDFDict) {
    const diff = enc.lookup(N("Differences"));
    if (diff instanceof PDFArray) {
      let code = 0;
      for (let i = 0; i < diff.size(); i++) {
        const v = diff.lookup(i);
        if (v instanceof PDFNumber) code = v.asNumber();
        else if (v instanceof PDFName) {
          if (code >= 0 && code < 256) names[code] = v.decodeText();
          code++;
        }
      }
    }
  }
  return names;
}

/** Give a simple font referenced by name its Liberation stand-in, embedded, as a TrueType. */
async function embedSimpleFont(
  doc: PDFDocument,
  font: PDFDict,
  cache: Map<string, PDFRef>,
): Promise<{ dropped: number } | null> {
  const base = nameOf(font.lookup(N("BaseFont"))) ?? "Helvetica";
  const s = await loadSubstitute(doc, base, cache);
  if (!s) return null;
  const { face, k } = s;
  // Differences may only use Adobe Glyph List names: uni0141 becomes Lslash; a name with no
  // known character is dropped (the code falls back to its WinAnsi glyph).
  let dropped = 0;
  const names = simpleFontGlyphNames(font).map((n) => {
    if (!n || isAglName(n)) return n;
    const cp = glyphNameToUnicode(n);
    const agl = cp !== undefined ? aglNameFor(cp) : undefined;
    if (!agl) dropped++;
    return agl ?? "";
  });
  // A non-symbolic TrueType must be encoded WinAnsi or MacRoman, possibly with /Differences: the
  // same glyphs, re-expressed on a WinAnsi base (validators read MacRoman codes of a TrueType
  // through its Windows cmap, so MacRoman itself is spelt out as differences too).
  let encoding: PDFObject;
  if (names.every((n, c) => !n || n === WINANSI_ENCODING[c])) encoding = N("WinAnsiEncoding");
  else {
    const diffs: (number | PDFName)[] = [];
    let next = -1;
    names.forEach((n, c) => {
      if (!n || n === WINANSI_ENCODING[c]) return;
      if (c !== next) diffs.push(c);
      diffs.push(N(n));
      next = c + 1;
    });
    // Indirect: validators (veraPDF) cache a TrueType program per font file and encoding object,
    // and direct encodings of fonts sharing the Liberation file would collide.
    encoding = doc.context.register(
      doc.context.obj({ Type: "Encoding", BaseEncoding: "WinAnsiEncoding", Differences: diffs }),
    );
  }
  // Widths as the embedded program has them: code → glyph name → Unicode → glyph (.notdef when absent).
  const notdef = Math.round(face.getGlyph(0).advanceWidth * k);
  let first = 32;
  names.forEach((n, c) => {
    if (n && c < first) first = c;
  });
  const last = 255;
  const widths: number[] = [];
  for (let c = first; c <= last; c++) {
    const n = names[c] || WINANSI_ENCODING[c];
    const cp = n ? glyphNameToUnicode(n) : undefined;
    const g = cp !== undefined ? face.glyphForCodePoint(cp) : null;
    widths.push(g && g.id !== 0 ? Math.round(g.advanceWidth * k) : notdef);
  }
  font.set(N("Subtype"), N("TrueType"));
  font.set(N("FirstChar"), PDFNumber.of(first));
  font.set(N("LastChar"), PDFNumber.of(last));
  font.set(N("Widths"), doc.context.obj(widths));
  font.set(N("FontDescriptor"), descriptorFor(doc, s, false));
  font.set(N("Encoding"), encoding);
  return { dropped };
}

/**
 * Give a Type0 font whose CIDFont is not embedded a Liberation CIDFontType2.
 * Possible when the codes are CIDs (Identity-H/V) and a ToUnicode CMap says
 * which character each stands for: the CIDToGIDMap then points every CID at
 * the substitute's glyph for that character, and /W carries its widths.
 * Returns why it cannot be done, or how many characters the substitute lacks.
 */
async function embedCidFont(
  doc: PDFDocument,
  font: PDFDict,
  cid: PDFDict,
  cache: Map<string, PDFRef>,
): Promise<{ problem: string } | { missing: number }> {
  const base = nameOf(cid.lookup(N("BaseFont"))) ?? nameOf(font.lookup(N("BaseFont"))) ?? "?";
  const enc = nameOf(font.lookup(N("Encoding")));
  if (enc !== "Identity-H" && enc !== "Identity-V")
    return { problem: `police CID non incorporée (encodage ${enc ?? "incorporé"} non pris en charge) : ${base}` };
  const tu = font.lookup(N("ToUnicode"));
  let map: Map<number, string> | undefined;
  if (tu instanceof PDFRawStream) {
    try {
      map = parseToUnicode(tu.dict.has(N("Filter")) ? decodePDFRawStream(tu).decode() : tu.contents).map;
    } catch {
      map = undefined;
    }
  }
  if (!map || map.size === 0)
    return { problem: `police CID non incorporée (caractères inconnus, pas de table ToUnicode) : ${base}` };
  const s = await loadSubstitute(doc, base, cache);
  if (!s) return { problem: `police CID non incorporée sans substitut : ${base}` };
  const { face, k } = s;
  const glyphs = new Map<number, { gid: number; w: number }>();
  let missing = 0;
  let maxCid = 0;
  for (const [code, text] of map) {
    if (code < 0 || code > 0xffff) continue;
    const cp = text.codePointAt(0);
    const g = cp !== undefined ? face.glyphForCodePoint(cp) : null;
    if (!g || g.id === 0) {
      missing++;
      continue;
    }
    glyphs.set(code, { gid: g.id, w: Math.round(g.advanceWidth * k) });
    maxCid = Math.max(maxCid, code);
  }
  const gidMap = new Uint8Array((maxCid + 1) * 2);
  for (const [c, { gid }] of glyphs) {
    gidMap[c * 2] = gid >> 8;
    gidMap[c * 2 + 1] = gid & 0xff;
  }
  const w: (number | number[])[] = [];
  let run: number[] | null = null;
  let prev = -2;
  for (const c of [...glyphs.keys()].sort((a, b) => a - b)) {
    if (c !== prev + 1 || !run) {
      run = [];
      w.push(c, run);
    }
    run.push(glyphs.get(c)!.w);
    prev = c;
  }
  const packed = zlibSync(gidMap);
  const ctx = doc.context;
  cid.set(N("Subtype"), N("CIDFontType2"));
  if (!(cid.lookup(N("CIDSystemInfo")) instanceof PDFDict))
    cid.set(
      N("CIDSystemInfo"),
      ctx.obj({ Registry: PDFString.of("Adobe"), Ordering: PDFString.of("Identity"), Supplement: 0 }),
    );
  cid.set(N("FontDescriptor"), descriptorFor(doc, s, true));
  cid.set(N("DW"), PDFNumber.of(Math.round(face.getGlyph(0).advanceWidth * k)));
  cid.set(N("W"), ctx.obj(w));
  cid.set(
    N("CIDToGIDMap"),
    ctx.register(PDFRawStream.of(ctx.obj({ Filter: "FlateDecode", Length: packed.length }) as PDFDict, packed)),
  );
  return { missing };
}

// ---------------------------------------------------------------------------
// Annotation appearances
// ---------------------------------------------------------------------------

const num = (o: PDFObject | undefined) => (o instanceof PDFNumber ? o.asNumber() : 0);
const nums = (o: PDFObject | undefined): number[] =>
  o instanceof PDFArray ? o.asArray().map((_, i) => num(o.lookup(i))) : [];
const f2 = (v: number) => (Math.round(v * 100) / 100).toString();

/** The annotation's colour as a fill or stroke operator (RGB, grey or CMYK by component count). */
function colourOp(an: PDFDict, key: string, stroke: boolean, fallback: number[]): string {
  let c = nums(an.lookup(N(key)));
  if (![1, 3, 4].includes(c.length)) c = fallback;
  const op = c.length === 1 ? "g" : c.length === 3 ? "rg" : "k";
  return `${c.map(f2).join(" ")} ${stroke ? op.toUpperCase() : op}`;
}

/**
 * A plain appearance for a comment with none (PDF/A wants one for every
 * visible annotation): the note icon, the shape's outline, the ink strokes,
 * the markup bars; nothing drawn (but valid) for the other kinds.
 */
function fallbackAppearance(an: PDFDict, st: string, rect: number[]): string {
  const [x1, y1, x2, y2] = [
    Math.min(rect[0]!, rect[2]!),
    Math.min(rect[1]!, rect[3]!),
    Math.max(rect[0]!, rect[2]!),
    Math.max(rect[1]!, rect[3]!),
  ];
  const w = x2 - x1;
  const h = y2 - y1;
  const bs = an.lookup(N("BS"));
  const lw = bs instanceof PDFDict && bs.has(N("W")) ? num(bs.lookup(N("W"))) : 1;
  const stroke = colourOp(an, "C", true, [0]);
  switch (st) {
    case "Text": {
      const m = Math.min(w, h);
      const lines = [0.7, 0.5, 0.3]
        .map((t) => `${f2(x1 + m * 0.2)} ${f2(y1 + m * t)} m ${f2(x1 + m * 0.8)} ${f2(y1 + m * t)} l`)
        .join(" ");
      return `q ${colourOp(an, "C", false, [1, 0.85, 0.2])} 0 G 0.5 w ${f2(x1 + 0.5)} ${f2(y1 + 0.5)} ${f2(m - 1)} ${f2(m - 1)} re B ${lines} S Q`;
    }
    case "Square":
    case "Circle": {
      if (lw <= 0) return "";
      const i = lw / 2;
      const [a, b, c, d] = [x1 + i, y1 + i, w - lw, h - lw];
      const fill = an.has(N("IC")) ? `${colourOp(an, "IC", false, [1])} ` : "";
      const paint = fill ? "B" : "S";
      if (st === "Square") return `q ${fill}${stroke} ${f2(lw)} w ${f2(a)} ${f2(b)} ${f2(c)} ${f2(d)} re ${paint} Q`;
      const [cx, cy, rx, ry] = [a + c / 2, b + d / 2, c / 2, d / 2];
      const kx = rx * 0.5523;
      const ky = ry * 0.5523;
      return (
        `q ${fill}${stroke} ${f2(lw)} w ${f2(cx + rx)} ${f2(cy)} m ` +
        `${f2(cx + rx)} ${f2(cy + ky)} ${f2(cx + kx)} ${f2(cy + ry)} ${f2(cx)} ${f2(cy + ry)} c ` +
        `${f2(cx - kx)} ${f2(cy + ry)} ${f2(cx - rx)} ${f2(cy + ky)} ${f2(cx - rx)} ${f2(cy)} c ` +
        `${f2(cx - rx)} ${f2(cy - ky)} ${f2(cx - kx)} ${f2(cy - ry)} ${f2(cx)} ${f2(cy - ry)} c ` +
        `${f2(cx + kx)} ${f2(cy - ry)} ${f2(cx + rx)} ${f2(cy - ky)} ${f2(cx + rx)} ${f2(cy)} c ${paint} Q`
      );
    }
    case "Line": {
      const l = nums(an.lookup(N("L")));
      if (l.length < 4) return "";
      return `q ${stroke} ${f2(lw)} w ${f2(l[0]!)} ${f2(l[1]!)} m ${f2(l[2]!)} ${f2(l[3]!)} l S Q`;
    }
    case "Ink": {
      const list = an.lookup(N("InkList"));
      if (!(list instanceof PDFArray)) return "";
      let path = "";
      for (let i = 0; i < list.size(); i++) {
        const p = nums(list.lookup(i));
        for (let j = 0; j + 1 < p.length; j += 2) path += `${f2(p[j]!)} ${f2(p[j + 1]!)} ${j ? "l" : "m"} `;
      }
      return path ? `q ${stroke} ${f2(lw)} w 1 J 1 j ${path}S Q` : "";
    }
    case "Highlight":
    case "Underline":
    case "StrikeOut":
    case "Squiggly": {
      const q = nums(an.lookup(N("QuadPoints")));
      let out = "";
      for (let i = 0; i + 7 < q.length; i += 8) {
        const xs = [q[i]!, q[i + 2]!, q[i + 4]!, q[i + 6]!];
        const ys = [q[i + 1]!, q[i + 3]!, q[i + 5]!, q[i + 7]!];
        const [qx1, qx2, qy1, qy2] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        if (st === "Highlight") out += `${f2(qx1)} ${f2(qy1)} ${f2(qx2 - qx1)} ${f2(qy2 - qy1)} re f `;
        else {
          const y = st === "StrikeOut" ? (qy1 + qy2) / 2 : qy1 + (qy2 - qy1) * 0.08;
          out += `${f2(qx1)} ${f2(y)} m ${f2(qx2)} ${f2(y)} l S `;
        }
      }
      if (!out) return "";
      return st === "Highlight"
        ? `q ${colourOp(an, "C", false, [1, 1, 0])} ${out}Q`
        : `q ${stroke} ${f2(Math.max(0.5, (y2 - y1) / 20))} w ${out}Q`;
    }
    default:
      return "";
  }
}

/** A form XObject over the annotation's rectangle (page coordinates, so the identity maps it). */
function appearanceStream(doc: PDFDocument, rect: number[], content: string): PDFRef {
  const bbox = [
    Math.min(rect[0]!, rect[2]!),
    Math.min(rect[1]!, rect[3]!),
    Math.max(rect[0]!, rect[2]!),
    Math.max(rect[1]!, rect[3]!),
  ];
  return doc.context.register(
    doc.context.flateStream(content, { Type: "XObject", Subtype: "Form", BBox: bbox, Resources: {} }),
  );
}

/** Fields whose widgets lack a normal appearance get pdf-lib's; returns how many were done. */
function updateFieldAppearances(doc: PDFDocument): number {
  let form: ReturnType<typeof doc.getForm>;
  let fields: ReturnType<typeof form.getFields> = [];
  try {
    form = doc.getForm();
    fields = form.getFields();
  } catch {
    return 0;
  }
  let done = 0;
  let font: PDFFont | undefined;
  for (const field of fields) {
    try {
      if (!field.needsAppearancesUpdate()) continue;
      const f = field as unknown as { defaultUpdateAppearances(font?: PDFFont): void };
      font ??= form.getDefaultFont();
      f.defaultUpdateAppearances(font);
      done++;
    } catch {
      // Left to the generic fallback below.
    }
  }
  return done;
}

// ---------------------------------------------------------------------------
// Embedded files (PDF/A-3)
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  xml: "text/xml",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  tif: "image/tiff",
  tiff: "image/tiff",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  rtf: "application/rtf",
};

function textOf(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined;
}

/** Values of a name tree (the leaves' objects, direct ones registered so they can be shared). */
function nameTreeValues(doc: PDFDocument, node: PDFDict, depth = 0): PDFRef[] {
  const out: PDFRef[] = [];
  if (depth > 32) return out;
  const names = node.lookup(N("Names"));
  if (names instanceof PDFArray) {
    for (let i = 1; i < names.size(); i += 2) {
      let v = names.get(i);
      if (v instanceof PDFDict) {
        const ref = doc.context.register(v);
        names.set(i, ref);
        v = ref;
      }
      if (v instanceof PDFRef) out.push(v);
    }
  }
  const kids = node.lookup(N("Kids"));
  if (kids instanceof PDFArray)
    for (let i = 0; i < kids.size(); i++) {
      const kid = kids.lookup(i);
      if (kid instanceof PDFDict) out.push(...nameTreeValues(doc, kid, depth + 1));
    }
  return out;
}

/** An embedded file that is a PDF declaring PDF/A-1 or -2 in its (uncompressed) XMP. */
function declaresPdfA12(stream: PDFObject | undefined): boolean {
  const bytes = streamBytes(stream);
  if (!bytes) return false;
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
  if (!head.startsWith("%PDF")) return false;
  return /pdfaid:part(?:>\s*|\s*=\s*["'])[12]\b/.test(new TextDecoder("latin1").decode(bytes));
}

/**
 * PDF/A-2 6.8: an embedded file must itself be PDF/A-1 or -2. The others are
 * dropped: /EF removed from their file specifications, the EmbeddedFiles name
 * tree removed when nothing is left in it. Returns how many were dropped.
 */
function dropEmbeddedFiles(doc: PDFDocument): number {
  let dropped = 0;
  forEachDict(doc, (d) => {
    const ef = d.lookup(N("EF"));
    if (!(ef instanceof PDFDict)) return;
    if (ef.keys().every((k) => declaresPdfA12(ef.lookup(k)))) return;
    d.delete(N("EF"));
    d.delete(N("RF"));
    dropped++;
  });
  const cat = doc.catalog;
  const names = cat.lookup(N("Names"));
  const tree = names instanceof PDFDict ? names.lookup(N("EmbeddedFiles")) : undefined;
  if (names instanceof PDFDict && tree instanceof PDFDict) {
    const kept = nameTreeValues(doc, tree).some((ref) => {
      const fs = doc.context.lookup(ref);
      return fs instanceof PDFDict && fs.has(N("EF"));
    });
    if (!kept) names.delete(N("EmbeddedFiles"));
  }
  return dropped;
}

/**
 * PDF/A-3 6.8: every embedded file is associated with the document (catalog
 * /AF), its file specification says how (/AFRelationship) and carries /F and
 * /UF, and the embedded stream declares its MIME type (/Subtype).
 */
function associateEmbeddedFiles(doc: PDFDocument): number {
  const ctx = doc.context;
  const cat = doc.catalog;
  const specs: PDFRef[] = [];
  const names = cat.lookup(N("Names"));
  const tree = names instanceof PDFDict ? names.lookup(N("EmbeddedFiles")) : undefined;
  if (tree instanceof PDFDict) specs.push(...nameTreeValues(doc, tree));
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(N("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const an = annots.lookup(i);
      if (!(an instanceof PDFDict) || nameOf(an.lookup(N("Subtype"))) !== "FileAttachment") continue;
      let fs = an.get(N("FS"));
      if (fs instanceof PDFDict) {
        fs = ctx.register(fs);
        an.set(N("FS"), fs);
      }
      if (fs instanceof PDFRef) specs.push(fs);
    }
  }
  let af = cat.lookup(N("AF"));
  if (!(af instanceof PDFArray)) {
    af = ctx.obj([]);
    cat.set(N("AF"), af);
  }
  const afArray = af as PDFArray;
  const inAf = new Set(afArray.asArray().map((o) => o.toString()));
  let changed = 0;
  for (const ref of specs) {
    const fs = ctx.lookup(ref);
    if (!(fs instanceof PDFDict)) continue;
    const ef = fs.lookup(N("EF"));
    if (!(ef instanceof PDFDict)) continue;
    const fname = textOf(fs.lookup(N("UF"))) ?? textOf(fs.lookup(N("F"))) ?? "fichier";
    if (!fs.has(N("Type"))) fs.set(N("Type"), N("Filespec"));
    if (!fs.has(N("F"))) fs.set(N("F"), PDFString.of(fname.replace(/[^\x20-\x7e]/g, "_")));
    if (!fs.has(N("UF"))) fs.set(N("UF"), PDFHexString.fromText(fname));
    if (!(fs.lookup(N("AFRelationship")) instanceof PDFName)) {
      fs.set(N("AFRelationship"), N("Unspecified"));
      changed++;
    }
    for (const key of ef.keys()) {
      const stream = streamDict(ef.lookup(key));
      if (!stream) continue;
      if (!(stream.lookup(N("Subtype")) instanceof PDFName)) {
        const ext = /\.([A-Za-z0-9]+)$/.exec(fname)?.[1]?.toLowerCase() ?? "";
        stream.set(N("Subtype"), N(MIME[ext] ?? "application/octet-stream"));
        changed++;
      }
      if (!stream.has(N("Type"))) stream.set(N("Type"), N("EmbeddedFile"));
    }
    if (!inAf.has(ref.toString())) {
      afArray.push(ref);
      inAf.add(ref.toString());
      changed++;
    }
  }
  if (afArray.size() === 0) cat.delete(N("AF"));
  return changed;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

const FORBIDDEN_ACTIONS = new Set([
  "Launch",
  "Sound",
  "Movie",
  "ResetForm",
  "ImportData",
  "JavaScript",
  "Hide",
  "SetOCGState",
  "Rendition",
  "Trans",
  "GoTo3DView",
]);
const FORBIDDEN_ANNOTS = new Set(["Sound", "Movie", "Screen", "3D", "RichMedia"]);

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}
function xmpDate(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function infoText(info: PDFDict | undefined, key: string): string | undefined {
  return textOf(info?.lookup(N(key)));
}

/** Convert `doc` (decrypted, in memory) to PDF/A-2b or -3b, in place. */
export async function convertToPdfA(doc: PDFDocument, opts: PdfAOptions): Promise<PdfAReport> {
  // Fonts and pages pdf-lib creates lazily must exist before they are looked at.
  await doc.flush();
  const ctx = doc.context;
  const fixed = new Set<string>();
  const remaining = new Set<string>();
  const cat = doc.catalog;

  // Encryption and document-level actions.
  if (ctx.trailerInfo.Encrypt) {
    ctx.trailerInfo.Encrypt = undefined;
    fixed.add("protection par mot de passe retirée (interdite en PDF/A)");
  }
  for (const key of ["AA", "NeedsRendering"]) if (cat.has(N(key))) cat.delete(N(key));
  const open = cat.lookup(N("OpenAction"));
  if (open instanceof PDFDict && FORBIDDEN_ACTIONS.has(nameOf(open.lookup(N("S"))) ?? "")) {
    cat.delete(N("OpenAction"));
    fixed.add("action à l'ouverture supprimée");
  }
  const names = cat.lookup(N("Names"));
  if (names instanceof PDFDict) {
    if (names.has(N("JavaScript"))) {
      names.delete(N("JavaScript"));
      fixed.add("JavaScript du document supprimé");
    }
  }
  if (opts.part === 2 && dropEmbeddedFiles(doc))
    fixed.add("fichiers joints supprimés (en PDF/A-2, seuls des fichiers PDF/A peuvent être joints)");
  if (opts.part === 2 && cat.has(N("AF"))) cat.delete(N("AF"));
  // A signature cannot survive the conversion (the file changes): its fields become empty.
  let signaturesRemoved = 0;
  for (const [, obj] of [...ctx.enumerateIndirectObjects()]) {
    if (!(obj instanceof PDFDict)) continue;
    const v = obj.lookup(N("V"));
    if (v instanceof PDFDict && v.has(N("ByteRange"))) {
      obj.delete(N("V"));
      signaturesRemoved++;
    }
  }
  if (cat.has(N("Perms"))) cat.delete(N("Perms"));
  if (signaturesRemoved)
    fixed.add(`${signaturesRemoved} signature(s) électronique(s) retirée(s) : la conversion modifie le document`);
  const acro = cat.lookup(N("AcroForm"));
  if (acro instanceof PDFDict) {
    if (signaturesRemoved) acro.delete(N("SigFlags"));
    if (acro.has(N("XFA"))) {
      acro.delete(N("XFA"));
      fixed.add("partie XFA du formulaire supprimée");
    }
  }

  // Optional content: no /AS in any configuration, and each one named (6.9), uniquely.
  const oc = cat.lookup(N("OCProperties"));
  if (oc instanceof PDFDict) {
    const configs: (PDFObject | undefined)[] = [oc.lookup(N("D"))];
    const more = oc.lookup(N("Configs"));
    if (more instanceof PDFArray) for (let i = 0; i < more.size(); i++) configs.push(more.lookup(i));
    const used = new Set<string>();
    configs.forEach((c, i) => {
      if (!(c instanceof PDFDict)) return;
      c.delete(N("AS"));
      let name = textOf(c.lookup(N("Name")));
      if (name === undefined || name === "" || used.has(name)) {
        const stem = i === 0 ? "Par défaut" : `Configuration ${i}`;
        name = stem;
        for (let n = 2; used.has(name); n++) name = `${stem} (${n})`;
        c.set(N("Name"), PDFHexString.fromText(name));
        fixed.add("configurations de calques nommées");
      }
      used.add(name);
    });
  }

  // Embedded files: associated and described in PDF/A-3.
  if (opts.part === 3 && associateEmbeddedFiles(doc))
    fixed.add("fichiers joints associés au document (/AF, type MIME, relation)");

  // Annotations: forbidden kinds out, printable, a normal appearance and nothing else.
  if (acro instanceof PDFDict) {
    if (updateFieldAppearances(doc)) fixed.add("apparences des champs de formulaire générées");
    acro.delete(N("NeedAppearances"));
  }
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(N("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const an = annots.lookup(i);
      if (!(an instanceof PDFDict)) continue;
      const st = nameOf(an.lookup(N("Subtype"))) ?? "";
      const fs = an.lookup(N("FS"));
      const noFile = !(fs instanceof PDFDict) || !(fs.lookup(N("EF")) instanceof PDFDict);
      if (FORBIDDEN_ANNOTS.has(st) || (st === "FileAttachment" && opts.part === 2 && noFile)) {
        annots.remove(i);
        fixed.add("annotations multimédia ou pièces jointes supprimées");
        continue;
      }
      const f = an.lookup(N("F"));
      const flags = f instanceof PDFNumber ? f.asNumber() : 0;
      const next = (flags | 4) & ~(1 | 2 | 32 | 256);
      if (next !== flags) {
        an.set(N("F"), PDFNumber.of(next));
        fixed.add("annotations rendues imprimables");
      }
      if (st === "Popup" || st === "Link") continue;
      const ap = an.lookup(N("AP"));
      const rect = nums(an.lookup(N("Rect")));
      const sized = rect.length === 4 && rect[2] !== rect[0] && rect[3] !== rect[1];
      const isButton = st === "Widget" && fieldType(an) === "Btn";
      const normal = ap instanceof PDFDict ? ap.lookup(N("N")) : undefined;
      const fine = isButton ? normal instanceof PDFDict : normal instanceof PDFStream;
      if (ap instanceof PDFDict && fine) {
        for (const k of ["D", "R"]) ap.delete(N(k));
        continue;
      }
      if (!sized) continue;
      // No usable appearance: a plain one, so the annotation is kept (and valid).
      const stream = appearanceStream(doc, rect, st === "Widget" ? "" : fallbackAppearance(an, st, rect));
      if (isButton) {
        const state = nameOf(an.lookup(N("AS")));
        const states: Record<string, PDFRef> = { Off: stream };
        if (state && state !== "Off") states[state] = appearanceStream(doc, rect, "");
        an.set(N("AP"), ctx.obj({ N: states }));
      } else an.set(N("AP"), ctx.obj({ N: stream }));
      fixed.add(
        st === "Widget" ? "apparences des champs de formulaire générées" : "apparences des commentaires générées",
      );
    }
  }
  // The form's default font (appearances just made) must exist before fonts are looked at.
  await doc.flush();

  // Objects, direct ones included.
  const found: Collected = { fonts: new Set(), gstates: new Set() };
  forEachDict(doc, (d, isStream) => {
    collectResources(d, found);
    // Additional actions are forbidden on pages, annotations and fields.
    if (d.has(N("AA"))) {
      d.delete(N("AA"));
      fixed.add("actions automatiques (/AA) supprimées");
    }
    const a = d.lookup(N("A"));
    if (a instanceof PDFDict && FORBIDDEN_ACTIONS.has(nameOf(a.lookup(N("S"))) ?? "")) {
      d.delete(N("A"));
      fixed.add("actions interdites (JavaScript, lancement, son…) supprimées");
    }
    if (!isStream) return;
    const subtype = nameOf(d.lookup(N("Subtype")));
    if (subtype === "Image") for (const k of ["Alternates", "OPI", "Interpolate"]) d.delete(N(k));
    if (subtype === "Form") for (const k of ["OPI", "Ref", "Subtype2", "PS"]) d.delete(N(k));
  });
  for (const gs of found.gstates) {
    for (const k of ["TR", "TR2", "HTP"]) {
      const v = gs.lookup(N(k));
      if (v !== undefined && !(k === "TR2" && nameOf(v) === "Default")) {
        gs.delete(N(k));
        fixed.add("fonctions de transfert supprimées");
      }
    }
  }
  const fontCache = new Map<string, PDFRef>();
  for (const font of found.fonts) {
    const st = nameOf(font.lookup(N("Subtype")));
    if (st === "Type3" || st === "CIDFontType0" || st === "CIDFontType2") continue;
    const base = nameOf(font.lookup(N("BaseFont"))) ?? "?";
    if (st === "Type0") {
      const cid = descendantOf(font);
      if (!cid || isEmbedded(cid)) continue;
      const r = await embedCidFont(doc, font, cid, fontCache);
      if ("problem" in r) remaining.add(r.problem);
      else {
        fixed.add("polices incorporées (substituts Liberation)");
        if (r.missing) remaining.add(`caractères sans glyphe dans la police de substitution (non conforme) : ${base}`);
      }
      continue;
    }
    if (isEmbedded(font)) continue;
    const r = await embedSimpleFont(doc, font, fontCache);
    if (!r) remaining.add(`police non incorporée sans substitut : ${base}`);
    else {
      fixed.add("polices incorporées (substituts Liberation)");
      if (r.dropped) fixed.add(`glyphes aux noms non standard remplacés : ${base}`);
    }
  }

  // Colours: an sRGB output intent; DeviceCMYK given an ICC colour space.
  const srgb = srgbProfile();
  const iccRef = ctx.register(ctx.stream(zlibSync(srgb), { N: 3, Filter: "FlateDecode", Length: 0 } as never));
  (ctx.lookup(iccRef) as PDFRawStream).dict.set(
    N("Length"),
    PDFNumber.of((ctx.lookup(iccRef) as PDFRawStream).contents.length),
  );
  cat.set(
    N("OutputIntents"),
    ctx.obj([
      {
        Type: "OutputIntent",
        S: "GTS_PDFA1",
        OutputConditionIdentifier: PDFString.of("sRGB IEC61966-2.1"),
        Info: PDFString.of("sRGB IEC61966-2.1"),
        RegistryName: PDFString.of("http://www.color.org"),
        DestOutputProfile: iccRef,
      },
    ]),
  );
  fixed.add("mode colorimétrique sRGB déclaré (profil ICC incorporé)");
  if (opts.cmykProfile && usesDeviceCmyk(doc)) {
    const packed = zlibSync(opts.cmykProfile);
    const cmykRef = ctx.register(
      PDFRawStream.of(ctx.obj({ N: 4, Filter: "FlateDecode", Length: packed.length }) as PDFDict, packed),
    );
    const cs = ctx.obj([N("ICCBased"), cmykRef]);
    const withDefault = (res: PDFDict) => {
      let spaces = res.lookup(N("ColorSpace"));
      if (!(spaces instanceof PDFDict)) {
        spaces = ctx.obj({});
        res.set(N("ColorSpace"), spaces);
      }
      if (!(spaces as PDFDict).has(N("DefaultCMYK"))) (spaces as PDFDict).set(N("DefaultCMYK"), cs);
    };
    for (const page of doc.getPages()) {
      let res = page.node.Resources();
      if (!res) {
        res = ctx.obj({}) as PDFDict;
        page.node.set(N("Resources"), res);
      }
      withDefault(res);
    }
    for (const [, obj] of ctx.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFStream)) continue;
      const d = (obj as unknown as { dict: PDFDict }).dict;
      if (nameOf(d.lookup(N("Subtype"))) !== "Form") continue;
      let res = d.lookup(N("Resources"));
      if (!(res instanceof PDFDict)) {
        res = ctx.obj({});
        d.set(N("Resources"), res);
      }
      withDefault(res as PDFDict);
    }
    fixed.add("couleurs CMJN rattachées à un profil ICC");
  } else if (usesDeviceCmyk(doc)) remaining.add("couleurs CMJN sans profil ICC");

  // Metadata: /Info and XMP in sync, the PDF/A identification.
  const now = new Date();
  let info = ctx.trailerInfo.Info instanceof PDFRef ? ctx.lookup(ctx.trailerInfo.Info) : undefined;
  if (!(info instanceof PDFDict)) {
    info = ctx.obj({}) as PDFDict;
    ctx.trailerInfo.Info = ctx.register(info as PDFDict);
  }
  const infoDict = info as PDFDict;
  const producer = opts.producer ?? "Elium";
  infoDict.set(N("Producer"), PDFString.of(producer));
  infoDict.set(N("ModDate"), PDFString.of(pdfDate(now)));
  if (!infoDict.has(N("CreationDate"))) infoDict.set(N("CreationDate"), PDFString.of(pdfDate(now)));
  const created = parseDate(infoText(infoDict, "CreationDate")) ?? now;
  infoDict.set(N("CreationDate"), PDFString.of(pdfDate(created)));
  const title = infoText(infoDict, "Title");
  const author = infoText(infoDict, "Author");
  const subject = infoText(infoDict, "Subject");
  const keywords = infoText(infoDict, "Keywords");
  const creator = infoText(infoDict, "Creator");
  for (const k of ["Trapped"]) infoDict.delete(N(k));
  const xmp =
    `<?xpacket begin="\u{FEFF}" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n` +
    `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">\n` +
    `<pdfaid:part>${opts.part}</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>\n` +
    (title ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(title)}</rdf:li></rdf:Alt></dc:title>\n` : "") +
    (author ? `<dc:creator><rdf:Seq><rdf:li>${xmlEsc(author)}</rdf:li></rdf:Seq></dc:creator>\n` : "") +
    (subject
      ? `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(subject)}</rdf:li></rdf:Alt></dc:description>\n`
      : "") +
    (keywords ? `<pdf:Keywords>${xmlEsc(keywords)}</pdf:Keywords>\n` : "") +
    (creator ? `<xmp:CreatorTool>${xmlEsc(creator)}</xmp:CreatorTool>\n` : "") +
    `<pdf:Producer>${xmlEsc(producer)}</pdf:Producer>\n` +
    `<xmp:CreateDate>${xmpDate(created)}</xmp:CreateDate><xmp:ModifyDate>${xmpDate(now)}</xmp:ModifyDate><xmp:MetadataDate>${xmpDate(now)}</xmp:MetadataDate>\n` +
    `</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>`;
  const xmpBytes = new TextEncoder().encode(xmp);
  cat.set(N("Metadata"), ctx.register(ctx.stream(xmpBytes, { Type: "Metadata", Subtype: "XML" })));
  fixed.add("métadonnées XMP PDF/A écrites");

  // Trailer /ID.
  if (!ctx.trailerInfo.ID) {
    const id = new Uint8Array(16);
    globalThis.crypto.getRandomValues(id);
    const hex = Array.from(id, (b) => b.toString(16).padStart(2, "0")).join("");
    ctx.trailerInfo.ID = ctx.obj([PDFHexString.of(hex), PDFHexString.of(hex)]);
  }
  return { fixed: [...fixed], remaining: [...remaining] };
}

function parseDate(s: string | undefined): Date | undefined {
  const m = s && /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(s);
  return m
    ? new Date(Date.UTC(+m[1]!, +(m[2] ?? 1) - 1, +(m[3] ?? 1), +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)))
    : undefined;
}

/** Does anything draw in DeviceCMYK (content operators k/K, images, colour space names)? */
function usesDeviceCmyk(doc: PDFDocument): boolean {
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict || obj instanceof PDFArray) {
      if (obj.toString().includes("/DeviceCMYK")) return true;
    } else if (obj instanceof PDFStream) {
      const d = (obj as unknown as { dict: PDFDict }).dict;
      if (d.toString().includes("/DeviceCMYK")) return true;
      if (nameOf(d.lookup(N("Subtype"))) === "Image") continue;
      let data: Uint8Array;
      if (!(obj instanceof PDFRawStream)) {
        const plain = (obj as unknown as { getUnencodedContents?: () => Uint8Array }).getUnencodedContents?.();
        if (!plain) continue;
        const text = new TextDecoder("latin1").decode(plain.subarray(0, 2_000_000));
        if (/(?:^|\s)(?:[\d.]+\s+){4}[kK](?=\s|$)/.test(text) || /\/DeviceCMYK/.test(text)) return true;
        continue;
      }
      data = obj.contents;
      if (nameOf(d.lookup(N("Filter"))) === "FlateDecode") {
        try {
          data = unzlib(data);
        } catch {
          continue;
        }
      } else if (d.has(N("Filter"))) continue;
      const text = new TextDecoder("latin1").decode(data.subarray(0, 2_000_000));
      if (/(?:^|\s)(?:[\d.]+\s+){4}[kK](?=\s|$)/.test(text) || /\/DeviceCMYK/.test(text)) return true;
    }
  }
  return false;
}

/** A widget's field type, inherited from its parent fields. */
function fieldType(d: PDFDict): string | undefined {
  let node: PDFDict | undefined = d;
  for (let depth = 0; node && depth < 32; depth++) {
    const ft = nameOf(node.lookup(N("FT")));
    if (ft) return ft;
    const parent: PDFObject | undefined = node.lookup(N("Parent"));
    node = parent instanceof PDFDict ? parent : undefined;
  }
  return undefined;
}

/** A stream's decoded bytes (undefined when its filters are beyond pdf-lib). */
function streamBytes(s: PDFObject | undefined): Uint8Array | undefined {
  try {
    if (s instanceof PDFRawStream) return s.dict.has(N("Filter")) ? decodePDFRawStream(s).decode() : s.contents;
    if (s instanceof PDFStream) return (s as unknown as { getUnencodedContents(): Uint8Array }).getUnencodedContents();
  } catch {
    // unreadable
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/** The usual PDF/A failures a document shows (empty: nothing found — not a validation). */
export function checkPdfA(doc: PDFDocument): string[] {
  const problems = new Set<string>();
  const ctx = doc.context;
  const cat = doc.catalog;
  if (ctx.trailerInfo.Encrypt) problems.add("Le document est protégé par mot de passe.");
  if (!(cat.lookup(N("OutputIntents")) instanceof PDFArray))
    problems.add("Aucun mode colorimétrique (OutputIntent) déclaré.");
  const meta = streamBytes(cat.lookup(N("Metadata")));
  const pdfaid = !!meta && /pdfaid:part/.test(new TextDecoder().decode(meta));
  if (!pdfaid) problems.add("Les métadonnées ne déclarent pas la conformité PDF/A.");
  const names = cat.lookup(N("Names"));
  if (names instanceof PDFDict && names.has(N("JavaScript"))) problems.add("Le document contient du JavaScript.");
  const found: Collected = { fonts: new Set(), gstates: new Set() };
  forEachDict(doc, (d) => {
    collectResources(d, found);
    if (d.has(N("AA"))) problems.add("Actions automatiques (/AA) présentes.");
    const a = d.lookup(N("A"));
    if (a instanceof PDFDict && FORBIDDEN_ACTIONS.has(nameOf(a.lookup(N("S"))) ?? ""))
      problems.add(`Action interdite : ${nameOf(a.lookup(N("S")))}.`);
  });
  for (const font of found.fonts) {
    const missing = missingFont(font);
    if (missing) problems.add(`Police non incorporée : ${missing}.`);
  }
  for (const gs of found.gstates)
    if (gs.has(N("TR")) || gs.has(N("HTP")) || (gs.has(N("TR2")) && nameOf(gs.lookup(N("TR2"))) !== "Default"))
      problems.add("Fonctions de transfert présentes.");
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(N("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const an = annots.lookup(i);
      if (!(an instanceof PDFDict)) continue;
      const f = an.lookup(N("F"));
      if (!(f instanceof PDFNumber) || !(f.asNumber() & 4)) problems.add("Annotations non imprimables.");
      const st = nameOf(an.lookup(N("Subtype")));
      const rect = nums(an.lookup(N("Rect")));
      const sized = rect.length === 4 && rect[2] !== rect[0] && rect[3] !== rect[1];
      if (st !== "Popup" && st !== "Link" && sized && !(an.lookup(N("AP")) instanceof PDFDict))
        problems.add("Annotations sans apparence.");
    }
  }
  return [...problems];
}
