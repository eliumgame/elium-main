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
import { zlibSync } from "fflate";
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
} from "pdf-lib";
import type { PDFDocument, PDFObject } from "pdf-lib";
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
// Fonts
// ---------------------------------------------------------------------------

const WINANSI_HIGH: Record<number, number> = {
  0x80: 0x20ac,
  0x82: 0x201a,
  0x83: 0x0192,
  0x84: 0x201e,
  0x85: 0x2026,
  0x86: 0x2020,
  0x87: 0x2021,
  0x88: 0x02c6,
  0x89: 0x2030,
  0x8a: 0x0160,
  0x8b: 0x2039,
  0x8c: 0x0152,
  0x8e: 0x017d,
  0x91: 0x2018,
  0x92: 0x2019,
  0x93: 0x201c,
  0x94: 0x201d,
  0x95: 0x2022,
  0x96: 0x2013,
  0x97: 0x2014,
  0x98: 0x02dc,
  0x99: 0x2122,
  0x9a: 0x0161,
  0x9b: 0x203a,
  0x9c: 0x0153,
  0x9e: 0x017e,
  0x9f: 0x0178,
};
const winAnsi = (code: number) => (code >= 0x80 && code <= 0x9f ? WINANSI_HIGH[code] : code);

/** The Liberation face standing in for a font known by name, or null (symbolic, unknown). */
function substituteFor(baseFont: string): { family: UnicodeFamily; style: FontStyle } | null {
  const n = baseFont.replace(/^[A-Z]{6}\+/, "").toLowerCase();
  if (/symbol|dingbat|wingding|webding/.test(n)) return null;
  const bold = /bold|black|heavy|semibold|demi/.test(n);
  const italic = /italic|oblique/.test(n);
  const style: FontStyle = bold && italic ? "bi" : bold ? "b" : italic ? "i" : "r";
  if (/courier|mono|consol|fixed/.test(n)) return { family: "mono", style };
  if (/times|serif|georgia|garamond|cambria|book/.test(n)) return { family: "serif", style };
  return { family: "sans", style };
}

function isEmbedded(font: PDFDict): boolean {
  const fd = font.lookup(N("FontDescriptor"));
  return fd instanceof PDFDict && ["FontFile", "FontFile2", "FontFile3"].some((k) => fd.has(N(k)));
}

/** Give a simple font referenced by name its Liberation stand-in, embedded. */
async function embedSimpleFont(doc: PDFDocument, font: PDFDict, cache: Map<string, PDFRef>): Promise<boolean> {
  const base = nameOf(font.lookup(N("BaseFont"))) ?? "Helvetica";
  const sub = substituteFor(base);
  if (!sub) return false;
  const bytes = await liberationBytes(sub.style, sub.family);
  if (!bytes) return false;
  const face = fontkit.create(bytes) as unknown as {
    unitsPerEm: number;
    ascent: number;
    descent: number;
    capHeight: number;
    italicAngle: number;
    bbox: { minX: number; minY: number; maxX: number; maxY: number };
    glyphForCodePoint(cp: number): { advanceWidth: number };
  };
  const k = 1000 / face.unitsPerEm;
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
  // Codes as the font's encoding maps them (WinAnsi unless /Differences say otherwise).
  const enc = font.lookup(N("Encoding"));
  const differences = new Map<number, string>();
  if (enc instanceof PDFDict) {
    const diff = enc.lookup(N("Differences"));
    if (diff instanceof PDFArray) {
      let code = 0;
      for (let i = 0; i < diff.size(); i++) {
        const v = diff.lookup(i);
        if (v instanceof PDFNumber) code = v.asNumber();
        else if (v instanceof PDFName) differences.set(code++, v.decodeText());
      }
    }
  }
  const first = 32;
  const last = 255;
  const widths: number[] = [];
  for (let c = first; c <= last; c++) {
    const cp = differences.has(c) ? glyphNameToCodePoint(differences.get(c)!) : winAnsi(c);
    const g = cp ? face.glyphForCodePoint(cp) : null;
    widths.push(Math.round((g?.advanceWidth ?? 0) * k));
  }
  const flags =
    32 | (sub.family === "serif" ? 2 : 0) | (sub.family === "mono" ? 1 : 0) | (/i/.test(sub.style) ? 64 : 0);
  const descriptor = doc.context.obj({
    Type: "FontDescriptor",
    FontName: N(base.replace(/[^\x21-\x7e]/g, "")),
    Flags: flags,
    FontBBox: [face.bbox.minX * k, face.bbox.minY * k, face.bbox.maxX * k, face.bbox.maxY * k].map(Math.round),
    ItalicAngle: face.italicAngle,
    Ascent: Math.round(face.ascent * k),
    Descent: Math.round(face.descent * k),
    CapHeight: Math.round((face.capHeight || face.ascent * 0.7) * k),
    StemV: 80,
    FontFile2: file,
  });
  font.set(N("Subtype"), N("TrueType"));
  font.set(N("FirstChar"), PDFNumber.of(first));
  font.set(N("LastChar"), PDFNumber.of(last));
  font.set(N("Widths"), doc.context.obj(widths));
  font.set(N("FontDescriptor"), doc.context.register(descriptor));
  if (!(enc instanceof PDFDict) && nameOf(enc) !== "WinAnsiEncoding" && nameOf(enc) !== "MacRomanEncoding")
    font.set(N("Encoding"), N("WinAnsiEncoding"));
  if (enc instanceof PDFDict) {
    // A TrueType's /Differences must stay within glyph names the font has: based on WinAnsi.
    enc.set(N("BaseEncoding"), N("WinAnsiEncoding"));
  }
  return true;
}

const GLYPHS: Record<string, number> = {
  space: 32,
  bullet: 0x2022,
  endash: 0x2013,
  emdash: 0x2014,
  quoteright: 0x2019,
  quoteleft: 0x2018,
  quotedblleft: 0x201c,
  quotedblright: 0x201d,
  ellipsis: 0x2026,
  Euro: 0x20ac,
  trademark: 0x2122,
};
function glyphNameToCodePoint(name: string): number | undefined {
  if (GLYPHS[name]) return GLYPHS[name];
  const uni = /^uni([0-9A-F]{4})$/.exec(name);
  if (uni) return parseInt(uni[1]!, 16);
  if (name.length === 1) return name.charCodeAt(0);
  return undefined;
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
  const v = info?.lookup(N(key));
  return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
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
    if (opts.part === 2 && names.has(N("EmbeddedFiles"))) {
      names.delete(N("EmbeddedFiles"));
      fixed.add("fichiers joints supprimés (autorisés seulement en PDF/A-3)");
    }
  }
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
    acro.delete(N("NeedAppearances"));
  }
  const oc = cat.lookup(N("OCProperties"));
  if (oc instanceof PDFDict) {
    const configs: (PDFObject | undefined)[] = [oc.lookup(N("D"))];
    const more = oc.lookup(N("Configs"));
    if (more instanceof PDFArray) for (let i = 0; i < more.size(); i++) configs.push(more.lookup(i));
    for (const c of configs) if (c instanceof PDFDict) c.delete(N("AS"));
  }

  // Objects.
  const fontCache = new Map<string, PDFRef>();
  const pageRefs = new Set(doc.getPages().map((p) => p.ref.toString()));
  for (const [ref, obj] of [...ctx.enumerateIndirectObjects()]) {
    const d =
      obj instanceof PDFDict ? obj : obj instanceof PDFStream ? (obj as unknown as { dict: PDFDict }).dict : null;
    if (!d) continue;
    const type = nameOf(d.lookup(N("Type")));
    const subtype = nameOf(d.lookup(N("Subtype")));
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
    if (type === "ExtGState") {
      for (const k of ["TR", "TR2", "HTP"]) {
        const v = d.lookup(N(k));
        if (v !== undefined && nameOf(v) !== "Default") {
          d.delete(N(k));
          fixed.add("fonctions de transfert supprimées");
        }
      }
    }
    if (subtype === "Image") {
      for (const k of ["Alternates", "OPI"]) d.delete(N(k));
      if (d.has(N("Interpolate"))) d.set(N("Interpolate"), N("false") as never);
      if (d.has(N("Interpolate"))) d.delete(N("Interpolate"));
    }
    if (subtype === "Form") for (const k of ["OPI", "Ref", "Subtype2", "PS"]) d.delete(N(k));
    if (type === "Font" || (subtype && ["Type1", "TrueType", "MMType1"].includes(subtype) && d.has(N("BaseFont")))) {
      if (subtype === "Type3" || subtype === "Type0") continue;
      if (!isEmbedded(d)) {
        const base = nameOf(d.lookup(N("BaseFont"))) ?? "?";
        if (await embedSimpleFont(doc, d, fontCache)) fixed.add("polices incorporées (substituts Liberation)");
        else remaining.add(`police non incorporée sans substitut : ${base}`);
      }
    }
    if (type === "Font" && subtype === "Type0") {
      const desc = d.lookup(N("DescendantFonts"));
      const cid = desc instanceof PDFArray ? desc.lookup(0) : undefined;
      if (cid instanceof PDFDict && !isEmbedded(cid))
        remaining.add(`police CID non incorporée : ${nameOf(d.lookup(N("BaseFont"))) ?? "?"}`);
    }
    void ref;
    void pageRefs;
  }

  // Annotations.
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(N("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const an = annots.lookup(i);
      if (!(an instanceof PDFDict)) continue;
      const st = nameOf(an.lookup(N("Subtype"))) ?? "";
      if (FORBIDDEN_ANNOTS.has(st) || (st === "FileAttachment" && opts.part === 2)) {
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
      const ap = an.lookup(N("AP"));
      if (ap instanceof PDFDict) {
        for (const k of ["D", "R"]) ap.delete(N(k));
      } else if (st !== "Popup" && st !== "Link") {
        const r = an.lookup(N("Rect"));
        const nums =
          r instanceof PDFArray
            ? [0, 1, 2, 3].map((j) => (r.lookup(j) as PDFNumber | undefined)?.asNumber?.() ?? 0)
            : [0, 0, 0, 0];
        if (Math.abs(nums[2]! - nums[0]!) > 0 && Math.abs(nums[3]! - nums[1]!) > 0) {
          annots.remove(i);
          fixed.add("annotations sans apparence supprimées");
        }
      }
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

import { unzlibSync as unzlib } from "fflate";

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
  const meta = cat.lookup(N("Metadata"));
  let pdfaid = false;
  if (meta instanceof PDFRawStream && !meta.dict.has(N("Filter"))) {
    pdfaid = /pdfaid:part/.test(new TextDecoder().decode(meta.contents));
  }
  if (!pdfaid) problems.add("Les métadonnées ne déclarent pas la conformité PDF/A.");
  const names = cat.lookup(N("Names"));
  if (names instanceof PDFDict && names.has(N("JavaScript"))) problems.add("Le document contient du JavaScript.");
  for (const [, obj] of ctx.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const st = nameOf(obj.lookup(N("Subtype")));
    if (nameOf(obj.lookup(N("Type"))) === "Font" && st !== "Type3" && st !== "Type0" && !isEmbedded(obj))
      problems.add(`Police non incorporée : ${nameOf(obj.lookup(N("BaseFont"))) ?? "?"}.`);
    if (obj.has(N("AA"))) problems.add("Actions automatiques (/AA) présentes.");
    const a = obj.lookup(N("A"));
    if (a instanceof PDFDict && FORBIDDEN_ACTIONS.has(nameOf(a.lookup(N("S"))) ?? ""))
      problems.add(`Action interdite : ${nameOf(a.lookup(N("S")))}.`);
  }
  for (const page of doc.getPages()) {
    const annots = page.node.lookup(N("Annots"));
    if (!(annots instanceof PDFArray)) continue;
    for (let i = 0; i < annots.size(); i++) {
      const an = annots.lookup(i);
      if (!(an instanceof PDFDict)) continue;
      const f = an.lookup(N("F"));
      if (!(f instanceof PDFNumber) || !(f.asNumber() & 4)) problems.add("Annotations non imprimables.");
    }
  }
  return [...problems];
}
