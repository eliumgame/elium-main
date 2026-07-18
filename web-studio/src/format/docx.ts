/**
 * DOCX (Office Open XML / WordprocessingML) import & export — dependency-free.
 *
 * The writer builds a valid .docx ZIP with fflate; the reader parses
 * `word/document.xml` with a small built-in XML parser so it works identically
 * in the browser and in Node (tests). Scope: paragraphs, headings, alignment,
 * indentation, bold/italic/underline/strike, hyperlinks, bullet/ordered lists,
 * blockquotes, code blocks, tables, images/figures (embedded media) and page
 * breaks. Comment annotations are dropped on export (the annotated text stays),
 * matching the HTML/Markdown exporters.
 */

import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import type { EliumFile, ProseMirrorNode } from "./types";

// =========================================================================
// XML helpers
// =========================================================================

function xmlEsc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlDecode(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&");
}

interface XmlEl {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
type XmlNode = XmlEl | { text: string };

function isEl(n: XmlNode): n is XmlEl {
  return (n as XmlEl).name !== undefined;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out[m[1]] = xmlDecode(m[2]);
  return out;
}

/** Minimal, tolerant XML parser sufficient for WordprocessingML. */
function parseXml(xml: string): XmlEl {
  xml = xml.replace(/<\?xml[^>]*\?>/g, "").replace(/<!--[\s\S]*?-->/g, "");
  const root: XmlEl = { name: "#root", attrs: {}, children: [] };
  const stack: XmlEl[] = [root];
  const tagRe = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(xml))) {
    const between = xml.slice(last, m.index);
    if (between) {
      const txt = xmlDecode(between);
      stack[stack.length - 1].children.push({ text: txt });
    }
    last = tagRe.lastIndex;
    const [, closing, name, attrStr, selfClose] = m;
    if (closing) {
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].name === name) {
          stack.length = k;
          break;
        }
      }
    } else {
      const el: XmlEl = { name, attrs: parseAttrs(attrStr), children: [] };
      stack[stack.length - 1].children.push(el);
      if (!selfClose) stack.push(el);
    }
  }
  return root;
}

function children(el: XmlEl, name: string): XmlEl[] {
  return el.children.filter((c): c is XmlEl => isEl(c) && c.name === name);
}
function firstChild(el: XmlEl, name: string): XmlEl | undefined {
  return children(el, name)[0];
}
function descendants(el: XmlEl, name: string): XmlEl[] {
  const out: XmlEl[] = [];
  const walk = (n: XmlEl) => {
    for (const c of n.children) {
      if (isEl(c)) {
        if (c.name === name) out.push(c);
        walk(c);
      }
    }
  };
  walk(el);
  return out;
}
function firstDescendant(el: XmlEl, name: string): XmlEl | undefined {
  return descendants(el, name)[0];
}

// =========================================================================
// base64 + image dimensions
// =========================================================================

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  return Buffer.from(bytes).toString("base64");
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

const MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

/** Probe intrinsic pixel size from PNG/JPEG/GIF bytes (fallback 480×320). */
function imageSize(bytes: Uint8Array): { w: number; h: number } {
  const fallback = { w: 480, h: 320 };
  try {
    // PNG: 8-byte signature, IHDR width/height at offset 16 (big-endian).
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset);
      return { w: dv.getUint32(16), h: dv.getUint32(20) };
    }
    // GIF: logical screen descriptor (little-endian) at offset 6.
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return { w: bytes[6] | (bytes[7] << 8), h: bytes[8] | (bytes[9] << 8) };
    }
    // JPEG: scan for a SOF marker.
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i < bytes.length - 8) {
        if (bytes[i] !== 0xff) { i++; continue; }
        const marker = bytes[i + 1];
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          const h = (bytes[i + 5] << 8) | bytes[i + 6];
          const w = (bytes[i + 7] << 8) | bytes[i + 8];
          return { w, h };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

// =========================================================================
// Constants
// =========================================================================

const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';

const EMU_PER_PX = 9525;
const MAX_CONTENT_EMU = 6 * 914400; // ~6 inch content width

// =========================================================================
// Writer
// =========================================================================

interface WriteCtx {
  rels: string[]; // relationship XML fragments
  media: Record<string, Uint8Array>; // word/media/<file> -> bytes
  relCount: number;
  drawingId: number;
  changeId: number; // unique w:id per tracked-change (w:ins/w:del) element
  footnotes?: { id: string; text: string }[]; // collected for numbering + a notes section
}

function addRel(ctx: WriteCtx, type: string, target: string, mode?: string): string {
  const id = `rId${ctx.relCount++}`;
  const ext = mode ? ` TargetMode="${mode}"` : "";
  ctx.rels.push(`<Relationship Id="${id}" Type="${type}" Target="${xmlEsc(target)}"${ext}/>`);
  return id;
}

const hex6 = (v: unknown): string | null => {
  const c = String(v ?? "").replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : null;
};

function runProps(marks: { type: string; attrs?: Record<string, unknown> }[]): string {
  const p: string[] = [];
  const has = (t: string) => marks.some((m) => m.type === t);
  const mark = (t: string) => marks.find((m) => m.type === t);
  if (has("bold")) p.push("<w:b/>");
  if (has("italic")) p.push("<w:i/>");
  if (has("underline") || has("link")) p.push('<w:u w:val="single"/>');
  if (has("strike")) p.push("<w:strike/>");
  if (has("code")) p.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
  // textStyle → real colour / font / size (px → half-points = px * 1.5)
  const ts = mark("textStyle");
  const tsColor = ts ? hex6(ts.attrs?.color) : null;
  if (ts) {
    const fam = String(ts.attrs?.fontFamily ?? "").split(",")[0].replace(/['"]/g, "").trim();
    if (fam) p.push(`<w:rFonts w:ascii="${xmlEsc(fam)}" w:hAnsi="${xmlEsc(fam)}"/>`);
    const px = parseFloat(String(ts.attrs?.fontSize ?? ""));
    if (px) p.push(`<w:sz w:val="${Math.round(px * 1.5)}"/>`);
  }
  // highlight → preset name if no colour, else real fill via shading
  const hl = mark("highlight");
  if (hl) {
    const c = hex6(hl.attrs?.color);
    p.push(c ? `<w:shd w:val="clear" w:color="auto" w:fill="${c}"/>` : '<w:highlight w:val="yellow"/>');
  }
  // colour: textStyle wins; otherwise links are blue
  if (tsColor) p.push(`<w:color w:val="${tsColor}"/>`);
  else if (has("link")) p.push('<w:color w:val="1d4ed8"/>');
  return p.length ? `<w:rPr>${p.join("")}</w:rPr>` : "";
}

/** `w:id`/`w:author`/`w:date` attributes for a w:ins/w:del element. */
function trackAttrs(ctx: WriteCtx, m: { attrs?: Record<string, unknown> }): string {
  const author = String(m.attrs?.author || "Elium");
  const ts = String(m.attrs?.ts || "");
  return `w:id="${++ctx.changeId}" w:author="${xmlEsc(author)}"${ts ? ` w:date="${xmlEsc(ts)}"` : ""}`;
}

function runXml(
  text: string,
  marks: { type: string; attrs?: Record<string, unknown> }[],
  ctx: WriteCtx,
): string {
  if (!text) return "";
  const del = marks.find((m) => m.type === "deletion");
  const ins = marks.find((m) => m.type === "insertion");
  // insertion/deletion are w:ins/w:del WRAPPERS, not run properties.
  const body = marks.filter((m) => m.type !== "insertion" && m.type !== "deletion");
  if (del) {
    // Deleted text uses <w:delText> (not <w:t>) so plain readers that ignore
    // track-changes don't resurrect the removed text.
    const run = `<w:r>${runProps(body)}<w:delText xml:space="preserve">${xmlEsc(text)}</w:delText></w:r>`;
    return `<w:del ${trackAttrs(ctx, del)}>${run}</w:del>`;
  }
  const run = `<w:r>${runProps(body)}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>`;
  return ins ? `<w:ins ${trackAttrs(ctx, ins)}>${run}</w:ins>` : run;
}

function inlineRuns(node: ProseMirrorNode, ctx: WriteCtx): string {
  return (node.content ?? [])
    .map((c) => {
      if (c.type === "hardBreak") return "<w:r><w:br/></w:r>";
      if (c.type === "footnote") {
        const n = (ctx.footnotes ?? []).findIndex((f) => f.id === String(c.attrs?.id)) + 1;
        return `<w:r><w:rPr><w:vertAlign w:val="superscript"/><w:color w:val="1d4ed8"/></w:rPr><w:t xml:space="preserve">[${n || "?"}]</w:t></w:r>`;
      }
      if (c.type === "text") {
        const marks = c.marks ?? [];
        const link = marks.find((m) => m.type === "link");
        if (link) {
          const href = String(link.attrs?.href ?? "#");
          const rId = addRel(
            ctx,
            "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
            href,
            "External",
          );
          return `<w:hyperlink r:id="${rId}">${runXml(c.text ?? "", marks, ctx)}</w:hyperlink>`;
        }
        return runXml(c.text ?? "", marks, ctx);
      }
      return "";
    })
    .join("");
}

function paraProps(opts: { style?: string; align?: string; indent?: number; numId?: number; ilvl?: number; shade?: boolean }): string {
  const p: string[] = [];
  if (opts.style) p.push(`<w:pStyle w:val="${opts.style}"/>`);
  if (opts.numId != null) p.push(`<w:numPr><w:ilvl w:val="${opts.ilvl ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>`);
  if (opts.shade) p.push('<w:shd w:val="clear" w:color="auto" w:fill="0f172a"/>');
  if (opts.indent) p.push(`<w:ind w:left="${opts.indent * 480}"/>`);
  if (opts.align && opts.align !== "left") {
    const jc = opts.align === "justify" ? "both" : opts.align;
    p.push(`<w:jc w:val="${jc}"/>`);
  }
  return p.length ? `<w:pPr>${p.join("")}</w:pPr>` : "";
}

function drawingXml(ctx: WriteCtx, src: string, alt: string): string {
  const m = /^data:([^;]+);base64,(.*)$/.exec(src.trim());
  if (!m) return ""; // only embedded (data URL) images are supported
  const mime = m[1].toLowerCase();
  const ext = MIME_EXT[mime] ?? "png";
  const bytes = base64ToBytes(m[2]);
  const idx = Object.keys(ctx.media).length + 1;
  const filename = `image${idx}.${ext}`;
  ctx.media[filename] = bytes;
  const rId = addRel(
    ctx,
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
    `media/${filename}`,
  );
  const { w, h } = imageSize(bytes);
  let cx = w * EMU_PER_PX;
  let cy = h * EMU_PER_PX;
  if (cx > MAX_CONTENT_EMU) {
    cy = Math.round((cy * MAX_CONTENT_EMU) / cx);
    cx = MAX_CONTENT_EMU;
  }
  const did = ctx.drawingId++;
  return (
    `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    `<wp:docPr id="${did}" name="image${did}" descr="${xmlEsc(alt)}"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<pic:pic><pic:nvPicPr><pic:cNvPr id="${did}" name="image${did}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
    `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
  );
}

function blockXml(node: ProseMirrorNode, ctx: WriteCtx, headings: { level: number; text: string }[], list?: { numId: number; ilvl: number }): string {
  switch (node.type) {
    case "paragraph":
      return `<w:p>${paraProps({ align: String(node.attrs?.textAlign ?? ""), indent: Number(node.attrs?.indent) || 0, ...(list ?? {}) })}${inlineRuns(node, ctx)}</w:p>`;
    case "heading": {
      const level = Math.min(4, Number(node.attrs?.level ?? 1));
      return `<w:p>${paraProps({ style: `Heading${level}`, align: String(node.attrs?.textAlign ?? "") })}${inlineRuns(node, ctx)}</w:p>`;
    }
    case "tableOfContents": {
      const items = headings
        .map((h) => `<w:p>${paraProps({ indent: h.level - 1 })}<w:r><w:t xml:space="preserve">${xmlEsc(h.text)}</w:t></w:r></w:p>`)
        .join("");
      return `<w:p>${paraProps({ style: "Heading1" })}<w:r><w:t>Table des matières</w:t></w:r></w:p>${items}`;
    }
    case "bulletList":
    case "orderedList": {
      const numId = node.type === "bulletList" ? 1 : 2;
      return (node.content ?? [])
        .map((li) =>
          (li.content ?? [])
            .map((child) =>
              child.type === "paragraph"
                ? blockXml(child, ctx, headings, { numId, ilvl: 0 })
                : blockXml(child, ctx, headings),
            )
            .join(""),
        )
        .join("");
    }
    case "taskList":
      return (node.content ?? [])
        .map((li) => {
          const box = li.attrs?.checked ? "☒ " : "☐ ";
          const inner = (li.content ?? []).map((c) => inlineRuns(c, ctx)).join("");
          return `<w:p>${paraProps({ indent: 1 })}<w:r><w:t xml:space="preserve">${box}</w:t></w:r>${inner}</w:p>`;
        })
        .join("");
    case "blockquote":
      return (node.content ?? [])
        .map((c) => `<w:p>${paraProps({ indent: 1 })}${inlineRuns(c, ctx)}</w:p>`)
        .join("");
    case "codeBlock": {
      const raw = (node.content ?? []).map((c) => c.text ?? "").join("");
      return raw
        .split("\n")
        .map((line) => `<w:p>${paraProps({ shade: true })}<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:color w:val="e2e8f0"/></w:rPr><w:t xml:space="preserve">${xmlEsc(line)}</w:t></w:r></w:p>`)
        .join("");
    }
    case "horizontalRule":
      return '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr></w:pPr></w:p>';
    case "pageBreak":
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
    case "image":
      return `<w:p>${drawingXml(ctx, String(node.attrs?.src ?? ""), String(node.attrs?.alt ?? ""))}</w:p>`;
    case "figure": {
      const align = String(node.attrs?.align ?? "center");
      const img = drawingXml(ctx, String(node.attrs?.src ?? ""), String(node.attrs?.alt ?? ""));
      const caption = (node.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : "")).join("");
      const imgP = `<w:p>${paraProps({ align })}${img}</w:p>`;
      const capP = caption
        ? `<w:p>${paraProps({ align })}<w:r><w:rPr><w:i/><w:color w:val="64748b"/></w:rPr><w:t xml:space="preserve">${xmlEsc(caption)}</w:t></w:r></w:p>`
        : "";
      return imgP + capP;
    }
    case "table":
      return tableXml(node, ctx, headings);
    default:
      return (node.content ?? []).map((c) => blockXml(c, ctx, headings, list)).join("");
  }
}

function tableXml(table: ProseMirrorNode, ctx: WriteCtx, headings: { level: number; text: string }[]): string {
  const rows = table.content ?? [];
  const cols = Math.max(1, ...rows.map((r) => (r.content ?? []).length));
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => '<w:gridCol w:w="2400"/>').join("")}</w:tblGrid>`;
  const body = rows
    .map((row) => {
      const cells = (row.content ?? [])
        .map((cell) => {
          const inner = (cell.content ?? []).map((c) => blockXml(c, ctx, headings)).join("") || "<w:p/>";
          const span = Number(cell.attrs?.colspan ?? 1);
          const tcPr = `<w:tcPr><w:tcW w:w="2400" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ""}</w:tcPr>`;
          return `<w:tc>${tcPr}${inner}</w:tc>`;
        })
        .join("");
      return `<w:tr>${cells}</w:tr>`;
    })
    .join("");
  const tblPr =
    '<w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>' +
    '<w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="cbd5e1"/>' +
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="cbd5e1"/>' +
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="cbd5e1"/>' +
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="cbd5e1"/>' +
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="cbd5e1"/>' +
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="cbd5e1"/></w:tblBorders></w:tblPr>';
  return `<w:tbl>${tblPr}${grid}${body}</w:tbl>`;
}

function collectHeadings(doc: ProseMirrorNode): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  const walk = (n: ProseMirrorNode) => {
    if (n.type === "heading") {
      const level = Number(n.attrs?.level ?? 1);
      if (level <= 3) out.push({ level, text: (n.content ?? []).map((c) => c.text ?? "").join("").trim() || "Sans titre" });
    }
    (n.content ?? []).forEach(walk);
  };
  walk(doc);
  return out;
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading4"><w:name w:val="heading 4"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="3"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`;

const NUMBERING_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

/** Serialize an Elium file to a .docx byte array. */
export function docToDocx(file: EliumFile): Uint8Array {
  const ctx: WriteCtx = { rels: [], media: {}, relCount: 100, drawingId: 1, changeId: 0 };
  const doc = file.document.doc;
  const headings = collectHeadings(doc);

  // Collect footnotes so refs can be numbered and listed in a Notes section.
  const footnotes: { id: string; text: string }[] = [];
  const walkFn = (n: ProseMirrorNode) => {
    if (n.type === "footnote") footnotes.push({ id: String(n.attrs?.id ?? footnotes.length + 1), text: String(n.attrs?.text ?? "") });
    (n.content ?? []).forEach(walkFn);
  };
  walkFn(doc);
  ctx.footnotes = footnotes;

  const title = file.manifest.title?.trim();
  const titleP = title
    ? `<w:p>${paraProps({ style: "Heading1" })}<w:r><w:t xml:space="preserve">${xmlEsc(title)}</w:t></w:r></w:p>`
    : "";
  const bodyInner = (doc.content ?? []).map((n) => blockXml(n, ctx, headings)).join("");
  const notesXml = footnotes.length
    ? `<w:p>${paraProps({ style: "Heading2" })}<w:r><w:t xml:space="preserve">Notes</w:t></w:r></w:p>`
      + footnotes.map((f, i) =>
          `<w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t xml:space="preserve">[${i + 1}] </w:t></w:r><w:r><w:t xml:space="preserve">${xmlEsc(f.text)}</w:t></w:r></w:p>`,
        ).join("")
    : "";

  // Page setup (format/orientation/margins) from the document's PageSettings.
  const page = file.document.page;
  const letter = page?.format === "Letter";
  let pw = letter ? 12240 : 11906, ph = letter ? 15840 : 16838;
  const landscape = page?.orientation === "landscape";
  if (landscape) { const t = pw; pw = ph; ph = t; }
  const tw = (mm: number) => Math.round(mm * 56.6929); // mm → twips
  const mg = page?.margins ?? { top: 25, right: 20, bottom: 25, left: 20 };
  const sectPr = `<w:sectPr><w:pgSz w:w="${pw}" w:h="${ph}"${landscape ? ' w:orient="landscape"' : ""}/>`
    + `<w:pgMar w:top="${tw(mg.top)}" w:right="${tw(mg.right)}" w:bottom="${tw(mg.bottom)}" w:left="${tw(mg.left)}" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>${titleP}${bodyInner}${notesXml}${sectPr}</w:body></w:document>`;

  const baseRels =
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>';
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${baseRels}${ctx.rels.join("")}</Relationships>`;

  const mediaDefaults = Object.keys(ctx.media)
    .map((f) => f.split(".").pop() ?? "png")
    .filter((ext, i, a) => a.indexOf(ext) === i)
    .map((ext) => `<Default Extension="${ext}" ContentType="${EXT_MIME[ext] ?? "image/png"}"/>`)
    .join("");
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>${mediaDefaults}
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

  const coreXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:title>${xmlEsc(title ?? "Document")}</dc:title><dc:creator>Elium</dc:creator></cp:coreProperties>`;

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(contentTypes),
    "_rels/.rels": strToU8(rootRels),
    "docProps/core.xml": strToU8(coreXml),
    "word/document.xml": strToU8(documentXml),
    "word/styles.xml": strToU8(STYLES_XML),
    "word/numbering.xml": strToU8(NUMBERING_XML),
    "word/_rels/document.xml.rels": strToU8(documentRels),
  };
  for (const [name, bytes] of Object.entries(ctx.media)) files[`word/media/${name}`] = bytes;

  return zipSync(files, { level: 6 });
}

// =========================================================================
// Reader
// =========================================================================

const te = (n: XmlEl): string =>
  n.children.map((c) => (isEl(c) ? te(c) : c.text)).join("");

/** Concatenate w:t text of a run-bearing element, honoring w:tab/w:br. */
function runText(el: XmlEl): string {
  let out = "";
  const walk = (n: XmlEl) => {
    for (const c of n.children) {
      if (!isEl(c)) continue;
      if (c.name === "w:t") out += te(c);
      // Word writes tracked-change deletions with <w:delText> instead of
      // <w:t> precisely so plain readers won't resurrect the deleted text —
      // but Elium preserves it (see inlineFromParagraph's w:del handling).
      else if (c.name === "w:delText") out += te(c);
      else if (c.name === "w:tab") out += "\t";
      else if (c.name === "w:br" || c.name === "w:cr") out += "\n";
      else walk(c);
    }
  };
  walk(el);
  return out;
}

interface NumFmtMap {
  [numId: string]: "bullet" | "ordered";
}

function parseNumbering(zip: Record<string, Uint8Array>): NumFmtMap {
  const out: NumFmtMap = {};
  const raw = zip["word/numbering.xml"];
  if (!raw) return out;
  const root = parseXml(strFromU8(raw));
  const abstractFmt: Record<string, string> = {};
  for (const an of descendants(root, "w:abstractNum")) {
    const id = an.attrs["w:abstractNumId"];
    const lvl = firstDescendant(an, "w:lvl");
    const fmt = lvl ? firstChild(lvl, "w:numFmt")?.attrs["w:val"] : undefined;
    if (id) abstractFmt[id] = fmt ?? "bullet";
  }
  for (const num of descendants(root, "w:num")) {
    const numId = num.attrs["w:numId"];
    const aId = firstChild(num, "w:abstractNumId")?.attrs["w:val"];
    const fmt = aId != null ? abstractFmt[aId] : "bullet";
    if (numId) out[numId] = fmt === "bullet" ? "bullet" : "ordered";
  }
  return out;
}

function relTargets(zip: Record<string, Uint8Array>): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = zip["word/_rels/document.xml.rels"];
  if (!raw) return out;
  for (const r of descendants(parseXml(strFromU8(raw)), "Relationship")) {
    if (r.attrs.Id) out[r.attrs.Id] = r.attrs.Target;
  }
  return out;
}

const MARK_ELS: Record<string, { type: string }> = {
  "w:b": { type: "bold" },
  "w:i": { type: "italic" },
  "w:u": { type: "underline" },
  "w:strike": { type: "strike" },
};

function runMarks(r: XmlEl): { type: string; attrs?: Record<string, unknown> }[] {
  const rpr = firstChild(r, "w:rPr");
  if (!rpr) return [];
  const marks: { type: string; attrs?: Record<string, unknown> }[] = [];
  for (const c of rpr.children) {
    if (isEl(c) && MARK_ELS[c.name]) {
      // <w:b w:val="false"/> disables the mark.
      if (c.attrs["w:val"] === "false" || c.attrs["w:val"] === "0") continue;
      marks.push(MARK_ELS[c.name]);
    }
  }
  // textStyle: colour / font family / font size, mirroring the writer's
  // runProps (w:color, w:rFonts, w:sz) so a document written by Elium and
  // re-imported keeps its character formatting instead of silently losing it.
  const tsAttrs: Record<string, unknown> = {};
  const color = firstChild(rpr, "w:color")?.attrs["w:val"];
  if (color && /^[0-9a-fA-F]{6}$/.test(color)) tsAttrs.color = `#${color.toLowerCase()}`;
  const rFonts = firstChild(rpr, "w:rFonts");
  const fam = rFonts?.attrs["w:ascii"] || rFonts?.attrs["w:hAnsi"];
  if (fam) tsAttrs.fontFamily = fam;
  // w:sz is in half-points; the writer converts px → half-points as px * 1.5
  // (runProps: `Math.round(px * 1.5)`), so the inverse here is halfPoints / 1.5.
  const szVal = Number(firstChild(rpr, "w:sz")?.attrs["w:val"]);
  if (Number.isFinite(szVal) && szVal > 0) tsAttrs.fontSize = `${Math.round(szVal / 1.5)}px`;
  if (Object.keys(tsAttrs).length) marks.push({ type: "textStyle", attrs: tsAttrs });
  return marks;
}

function inlineFromParagraph(
  p: XmlEl,
  rels: Record<string, string>,
  zip: Record<string, Uint8Array>,
): { nodes: ProseMirrorNode[]; pageBreak: boolean; figure?: ProseMirrorNode } {
  const nodes: ProseMirrorNode[] = [];
  let pageBreak = false;
  let figure: ProseMirrorNode | undefined;

  const pushText = (text: string, marks: { type: string; attrs?: Record<string, unknown> }[]) => {
    if (!text) return;
    nodes.push(marks.length ? { type: "text", text, marks } : { type: "text", text });
  };

  const handleRun = (r: XmlEl, extra: { type: string; attrs?: Record<string, unknown> }[] = []) => {
    // page break?
    for (const br of descendants(r, "w:br")) {
      if (br.attrs["w:type"] === "page") pageBreak = true;
    }
    // embedded image?
    const blip = firstDescendant(r, "a:blip");
    if (blip && !figure) {
      const embed = blip.attrs["r:embed"] || blip.attrs["r:link"];
      const target = embed ? rels[embed] : undefined;
      if (target) {
        const path = target.startsWith("media/") ? `word/${target}` : `word/${target.replace(/^\/?word\//, "")}`;
        const bytes = zip[path] ?? zip[`word/${target}`];
        if (bytes) {
          const ext = (target.split(".").pop() ?? "png").toLowerCase();
          const mime = EXT_MIME[ext] ?? "image/png";
          figure = {
            type: "figure",
            attrs: { src: `data:${mime};base64,${bytesToBase64(bytes)}`, alt: "", align: "center", width: "" },
            content: [],
          };
        }
      }
    }
    const text = runText(r);
    if (text) pushText(text, [...runMarks(r), ...extra]);
  };

  for (const c of p.children) {
    if (!isEl(c)) continue;
    if (c.name === "w:r") handleRun(c);
    else if (c.name === "w:hyperlink") {
      const rId = c.attrs["r:id"];
      const href = rId ? rels[rId] : undefined;
      const linkMark = href ? [{ type: "link", attrs: { href } }] : [];
      for (const r of children(c, "w:r")) handleRun(r, linkMark);
    } else if (c.name === "w:ins" || c.name === "w:del") {
      // Real Word documents with track-changes on wrap inserted/deleted runs
      // one level deeper, inside <w:ins>/<w:del> rather than as direct <w:r>
      // children of the paragraph — without this branch that text was never
      // read at all (silent data loss on import). Map to Elium's own
      // insertion/deletion marks (TrackChanges.ts) using the w:author/w:date
      // straight off the element, so track-changes state round-trips too.
      const trackMark = [
        {
          type: c.name === "w:ins" ? "insertion" : "deletion",
          attrs: { author: c.attrs["w:author"] ?? "", ts: c.attrs["w:date"] ?? "" },
        },
      ];
      for (const r of children(c, "w:r")) handleRun(r, trackMark);
      // A tracked change can itself wrap a hyperlink (nested one level further).
      for (const hl of children(c, "w:hyperlink")) {
        const rId = hl.attrs["r:id"];
        const href = rId ? rels[rId] : undefined;
        const linkMark = href ? [{ type: "link", attrs: { href } }] : [];
        for (const r of children(hl, "w:r")) handleRun(r, [...trackMark, ...linkMark]);
      }
    }
  }
  return { nodes, pageBreak, figure };
}

function alignFrom(p: XmlEl): string | undefined {
  const jc = firstDescendant(p, "w:jc")?.attrs["w:val"];
  if (!jc) return undefined;
  return jc === "both" ? "justify" : jc;
}

function paragraphNode(
  p: XmlEl,
  rels: Record<string, string>,
  zip: Record<string, Uint8Array>,
): ProseMirrorNode[] {
  const ppr = firstChild(p, "w:pPr");
  const style = ppr ? firstChild(ppr, "w:pStyle")?.attrs["w:val"] ?? "" : "";
  const { nodes, pageBreak, figure } = inlineFromParagraph(p, rels, zip);
  const out: ProseMirrorNode[] = [];

  if (figure) {
    figure.content = nodes.length ? nodes : [];
    out.push(figure);
    if (pageBreak) out.push({ type: "pageBreak" });
    return out;
  }

  const headingMatch = /^Heading(\d)$/i.exec(style) || /^Titre(\d)$/i.exec(style);
  const align = alignFrom(p);
  const attrs: Record<string, unknown> = {};
  if (align) attrs.textAlign = align;

  if (headingMatch) {
    out.push({ type: "heading", attrs: { level: Math.min(4, Number(headingMatch[1])), ...attrs }, content: nodes });
  } else {
    const ind = firstDescendant(p, "w:ind")?.attrs["w:left"];
    if (ind) {
      const lvl = Math.round(Number(ind) / 480);
      if (lvl > 0) attrs.indent = Math.min(8, lvl);
    }
    out.push(Object.keys(attrs).length || nodes.length ? { type: "paragraph", attrs, content: nodes } : { type: "paragraph" });
  }
  if (pageBreak) out.push({ type: "pageBreak" });
  return out;
}

function tableNode(tbl: XmlEl, rels: Record<string, string>, zip: Record<string, Uint8Array>): ProseMirrorNode {
  const rows = children(tbl, "w:tr").map((tr, rowIdx) => ({
    type: "tableRow",
    content: children(tr, "w:tc").map((tc) => {
      const span = Number(firstDescendant(tc, "w:gridSpan")?.attrs["w:val"] ?? 1);
      const cellBlocks = children(tc, "w:p").flatMap((p) => paragraphNode(p, rels, zip));
      return {
        type: rowIdx === 0 ? "tableHeader" : "tableCell",
        attrs: span > 1 ? { colspan: span } : {},
        content: cellBlocks.length ? cellBlocks : [{ type: "paragraph" }],
      } as ProseMirrorNode;
    }),
  }));
  return { type: "table", content: rows };
}

/** Parse a .docx byte array into a title + ProseMirror document node. */
export function docxToDoc(bytes: Uint8Array): { title: string; doc: ProseMirrorNode } {
  const zip = unzipSync(bytes);
  const docRaw = zip["word/document.xml"];
  if (!docRaw) throw new Error("Fichier .docx invalide : word/document.xml introuvable.");

  const rels = relTargets(zip);
  const numFmt = parseNumbering(zip);
  const root = parseXml(strFromU8(docRaw));
  const body = firstDescendant(root, "w:body");
  const content: ProseMirrorNode[] = [];

  const flushList = (items: ProseMirrorNode[], kind: "bullet" | "ordered") => {
    if (!items.length) return;
    content.push({ type: kind === "bullet" ? "bulletList" : "orderedList", content: items });
  };

  let listItems: ProseMirrorNode[] = [];
  let listKind: "bullet" | "ordered" | null = null;

  if (body) {
    for (const c of body.children) {
      if (!isEl(c)) continue;
      if (c.name === "w:p") {
        const numId = firstDescendant(c, "w:numId")?.attrs["w:val"];
        if (numId) {
          const kind = numFmt[numId] ?? "bullet";
          const para = paragraphNode(c, rels, zip).find((n) => n.type === "paragraph" || n.type === "heading") ?? { type: "paragraph" };
          if (listKind && listKind !== kind) {
            flushList(listItems, listKind);
            listItems = [];
          }
          listKind = kind;
          listItems.push({ type: "listItem", content: [para] });
          continue;
        }
        if (listKind) {
          flushList(listItems, listKind);
          listItems = [];
          listKind = null;
        }
        content.push(...paragraphNode(c, rels, zip));
      } else if (c.name === "w:tbl") {
        if (listKind) {
          flushList(listItems, listKind);
          listItems = [];
          listKind = null;
        }
        content.push(tableNode(c, rels, zip));
      }
    }
    if (listKind) flushList(listItems, listKind);
  }

  // Title: prefer docProps/core.xml dc:title.
  let title = "";
  const core = zip["docProps/core.xml"];
  if (core) {
    title = (firstDescendant(parseXml(strFromU8(core)), "dc:title") && te(firstDescendant(parseXml(strFromU8(core)), "dc:title")!)) || "";
  }

  return { title, doc: { type: "doc", content: content.length ? content : [{ type: "paragraph" }] } };
}
