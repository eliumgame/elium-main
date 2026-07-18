/**
 * PPTX (Office Open XML / PresentationML) export — dependency-free.
 *
 * Builds a valid .pptx ZIP with fflate: content types, a complete slide master,
 * a blank layout, an Office theme, and one slide part per deck slide. Each slide
 * carries a title, the rich body (converted to bullet/plain paragraphs), an
 * optional image and any free-floating shapes. Geometry is mapped from the
 * editor's percentage coordinates to EMU on a 16:9 stage. Opens cleanly in
 * PowerPoint, LibreOffice Impress and Google Slides.
 */
import { zipSync, strToU8 } from "fflate";
import type { Deck, Slide, Shape, SlideElement, SlideTheme, ShapeKind, ChartData } from "./model";
import { bodyHtmlOf } from "./model";

const CX = 12192000; // 13.333in in EMU (16:9 width)
const CY = 6858000; // 7.5in in EMU (16:9 height)
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const CT = "http://schemas.openxmlformats.org/package/2006/content-types";
const C = "http://schemas.openxmlformats.org/drawingml/2006/chart"; // DrawingML charts
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";

function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const hex = (c: string) => c.replace(/^#/, "").slice(0, 6).toUpperCase() || "000000";
const ex = (pct: number, span: number) => Math.round((pct / 100) * span);
/** Solid hex for a PPTX background: a plain #hex, or the first stop of a gradient. */
function bgHex(css: string | undefined): string | null {
  if (!css) return null;
  if (/^#[0-9a-fA-F]{3,6}$/.test(css)) return hex(css);
  const m = /#[0-9a-fA-F]{3,6}/.exec(css);
  return m ? hex(m[0]) : null;
}

/** Theme-derived colours (hex, no #): slide background, title text, body text. */
function themeColors(theme: SlideTheme): { bg: string; title: string; body: string } {
  if (theme === "dark") return { bg: "0D1117", title: "E6EDF3", body: "AEB9C7" };
  if (theme === "brand") return { bg: "1D4ED8", title: "FFFFFF", body: "CFDDFB" };
  return { bg: "FFFFFF", title: "0F172A", body: "334155" };
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; ext: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const mime = m[1];
  const ext = mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : "jpeg";
  return { bytes, ext };
}

function decodeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
}
const stripTags = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();

/**
 * Convert slide body HTML to a flat list of paragraphs (bulleted for lists),
 * keeping each paragraph's *inline* HTML so bold/italic/underline/colour survive
 * as PowerPoint runs. Regex-based and dependency-free, so it behaves identically
 * in the browser and in Node (tests) without a DOM.
 */
function htmlToParagraphs(html: string): { html: string; bullet: boolean }[] {
  if (!html || !html.trim()) return [];
  const lis = [...html.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => m[1]).filter((h) => stripTags(h));
  if (lis.length) return lis.map((h) => ({ html: h, bullet: true }));
  const blocks = html.split(/<\/(?:p|div|h[1-6])>|<br\s*\/?>/i).filter((h) => stripTags(h));
  if (blocks.length) return blocks.map((h) => ({ html: h, bullet: false }));
  return stripTags(html) ? [{ html, bullet: false }] : [];
}

/** An inline text run with its formatting (PowerPoint <a:r>). */
interface Run { text: string; bold?: boolean; italic?: boolean; underline?: boolean; color?: string }
interface Frame { tag: string; bold?: boolean; italic?: boolean; underline?: boolean; color?: string }

/** Normalise an HTML colour (#rgb / #rrggbb / rgb()) to 6-digit hex, no #. */
function colorHex(c: string): string | undefined {
  const s = c.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return m[1].split("").map((x) => x + x).join("").toUpperCase();
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return m[1].toUpperCase();
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (m) return [m[1], m[2], m[3]].map((n) => Math.min(255, parseInt(n, 10)).toString(16).padStart(2, "0")).join("").toUpperCase();
  return undefined;
}

/** Read the formatting an opening inline tag contributes. */
function tagFormat(tag: string): Frame {
  const name = (tag.match(/^[a-zA-Z0-9]+/)?.[0] || "").toLowerCase();
  const f: Frame = { tag: name };
  if (name === "b" || name === "strong") f.bold = true;
  else if (name === "i" || name === "em") f.italic = true;
  else if (name === "u" || name === "ins") f.underline = true;
  const colorAttr = tag.match(/\bcolor\s*=\s*"([^"]+)"/i)?.[1];
  const style = tag.match(/\bstyle\s*=\s*"([^"]*)"/i)?.[1] || "";
  const styleColor = style.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i)?.[1];
  const col = colorAttr || styleColor;
  if (col) { const h = colorHex(col); if (h) f.color = h; }
  if (/font-weight\s*:\s*(?:bold|[6-9]00)/i.test(style)) f.bold = true;
  if (/font-style\s*:\s*italic/i.test(style)) f.italic = true;
  if (/text-decoration[^;]*underline/i.test(style)) f.underline = true;
  return f;
}

/** Parse inline HTML into formatted runs (stack of nested inline tags). */
function inlineToRuns(html: string): Run[] {
  const runs: Run[] = [];
  const stack: Frame[] = [];
  const cur = (): Omit<Frame, "tag"> => ({
    bold: stack.some((f) => f.bold),
    italic: stack.some((f) => f.italic),
    underline: stack.some((f) => f.underline),
    color: [...stack].reverse().find((f) => f.color)?.color,
  });
  let buf = "";
  const flush = () => {
    const text = decodeEntities(buf).replace(/\s+/g, " ");
    buf = "";
    if (!text) return;
    const f = cur();
    runs.push({ text, bold: f.bold || undefined, italic: f.italic || undefined, underline: f.underline || undefined, color: f.color });
  };
  let i = 0;
  const n = html.length;
  while (i < n) {
    if (html[i] === "<") {
      const close = html.indexOf(">", i);
      if (close < 0) { buf += html.slice(i); break; }
      const raw = html.slice(i + 1, close).trim();
      i = close + 1;
      flush();
      if (raw[0] === "/") {
        const name = raw.slice(1).trim().toLowerCase();
        for (let k = stack.length - 1; k >= 0; k--) if (stack[k].tag === name) { stack.splice(k, 1); break; }
      } else if (!raw.endsWith("/")) {
        stack.push(tagFormat(raw)); // self-closing tags (e.g. <br/>) contribute nothing
      }
      continue;
    }
    buf += html[i++];
  }
  flush();
  return runs;
}

function runXml(r: Run, sz: number, defaultColor: string): string {
  const color = r.color || defaultColor;
  const attrs = `lang="fr-FR" sz="${sz}"${r.bold ? ' b="1"' : ""}${r.italic ? ' i="1"' : ""}${r.underline ? ' u="sng"' : ""} dirty="0"`;
  return `<a:r><a:rPr ${attrs}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${xmlEsc(r.text)}</a:t></a:r>`;
}

/** A body paragraph built from inline HTML, preserving per-run formatting. */
function bodyParagraph(html: string, sz: number, color: string, opts: { bullet?: boolean; align?: string } = {}): string {
  const pPr = `<a:pPr${opts.align ? ` algn="${opts.align}"` : ""}${opts.bullet ? ' marL="285750" indent="-285750"' : ""}>${opts.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : "<a:buNone/>"}</a:pPr>`;
  const runs = inlineToRuns(html);
  const body = runs.length
    ? runs.map((r) => runXml(r, sz, color)).join("")
    : `<a:r><a:rPr lang="fr-FR" sz="${sz}" dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t></a:t></a:r>`;
  return `<a:p>${pPr}${body}</a:p>`;
}

const xfrm = (x: number, y: number, w: number, h: number, rotDeg = 0) =>
  `<a:xfrm${rotDeg ? ` rot="${Math.round(rotDeg * 60000)}"` : ""}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;

/** OOXML preset geometry for each editor shape kind. */
function prstOf(kind: ShapeKind): string {
  switch (kind) {
    case "ellipse": return "ellipse";
    case "triangle": return "triangle";
    case "roundRect": return "roundRect";
    case "diamond": return "diamond";
    case "pentagon": return "pentagon";
    case "hexagon": return "hexagon";
    case "star": return "star5";
    case "chevron": return "chevron";
    case "cloud": return "cloud";
    case "heart": return "heart";
    default: return "rect";
  }
}

function paragraph(text: string, sz: number, color: string, opts: { bullet?: boolean; bold?: boolean; align?: string } = {}): string {
  const pPr = `<a:pPr${opts.align ? ` algn="${opts.align}"` : ""}${opts.bullet ? ' marL="285750" indent="-285750"' : ""}>${opts.bullet ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : "<a:buNone/>"}</a:pPr>`;
  const rPr = `<a:rPr lang="fr-FR" sz="${sz}"${opts.bold ? ' b="1"' : ""} dirty="0"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr>`;
  return `<a:p>${pPr}<a:r>${rPr}<a:t>${xmlEsc(text)}</a:t></a:r></a:p>`;
}

function textBox(id: number, name: string, x: number, y: number, w: number, h: number, body: string, anchor = "t"): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

function shapeXml(s: Shape, id: number): string {
  const x = ex(s.x, CX), y = ex(s.y, CY), w = ex(s.w, CX), h = ex(s.h, CY);
  const lnW = Math.max(0, Math.round(s.strokeWidth * 12700)); // px→EMU (1px ≈ 1pt here)
  if (s.kind === "line" || s.kind === "arrow") {
    const tail = s.kind === "arrow" ? '<a:tailEnd type="triangle" w="med" len="med"/>' : "";
    return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Connecteur ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>`
      + `<p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>`
      + `<a:ln w="${lnW}" cap="rnd"><a:solidFill><a:srgbClr val="${hex(s.stroke)}"/></a:solidFill>${tail}</a:ln></p:spPr></p:cxnSp>`;
  }
  const prst = s.kind === "ellipse" ? "ellipse" : s.kind === "triangle" ? "triangle" : "rect";
  const fill = s.fill === "transparent" ? "<a:noFill/>" : `<a:solidFill><a:srgbClr val="${hex(s.fill)}"/></a:solidFill>`;
  const ln = lnW > 0 ? `<a:ln w="${lnW}"><a:solidFill><a:srgbClr val="${hex(s.stroke)}"/></a:solidFill></a:ln>` : "<a:ln><a:noFill/></a:ln>";
  const txt = s.text ? `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="fr-FR" sz="1400" dirty="0"/><a:t>${xmlEsc(s.text)}</a:t></a:r></a:p>` : "<a:p/>";
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Forme ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${fill}${ln}</p:spPr>`
    + `<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/>${txt}</p:txBody></p:sp>`;
}

function picXml(id: number, rId: string, x: number, y: number, w: number, h: number): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Image ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
    + `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr>${xfrm(x, y, w, h)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

/**
 * One free-canvas element → PPTX shape/pic/textbox. Geometry is % → EMU;
 * rotation is carried on <a:xfrm rot>. Font sizes are px at the 720p reference
 * height, i.e. 1px = 0.75pt (slide is 540pt tall) → sz = px·75 (1/100 pt).
 */
function elementXml(el: SlideElement, id: number, colors: { title: string; body: string }, media: { name: string; bytes: Uint8Array }[]): string | null {
  const x = ex(el.x, CX), y = ex(el.y, CY), w = ex(el.w, CX), h = ex(el.h, CY);
  const rot = el.rotation ?? 0;

  if (el.type === "image") {
    if (!el.src) return null;
    const rId = addImage(el.src, media);
    if (!rId) return null;
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Image ${id}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>`
      + `<p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
      + `<p:spPr>${xfrm(x, y, w, h, rot)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  }

  if (el.type === "table" && el.table) {
    const tb = el.table;
    const sz = Math.max(100, Math.round((el.fontSize ?? 18) * 75));
    const color = el.color ? hex(el.color) : colors.body;
    const colW = Math.round(w / Math.max(1, tb.cols));
    const rowH = Math.round(h / Math.max(1, tb.rows));
    const grid = Array.from({ length: tb.cols }, () => `<a:gridCol w="${colW}"/>`).join("");
    const rows = tb.cells.map((row, r) => {
      const cells = row.map((cell) =>
        `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="l"/><a:r><a:rPr lang="fr-FR" sz="${sz}"${r === 0 ? ' b="1"' : ""}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${xmlEsc(cell)}</a:t></a:r></a:p></a:txBody><a:tcPr anchor="ctr"/></a:tc>`,
      ).join("");
      return `<a:tr h="${rowH}">${cells}</a:tr>`;
    }).join("");
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Tableau ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>`
      + `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm>`
      + `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">`
      + `<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl>`
      + `</a:graphicData></a:graphic></p:graphicFrame>`;
  }

  if (el.type === "chart" && el.chart) {
    // Native DrawingML chart: a graphicFrame referencing a c:chart part (built
    // + wired into the slide rels by addChart). Editable in PowerPoint, not a
    // flat picture. graphicFrame has no rotation (charts aren't rotated in PPTX).
    const rId = addChart(el.chart);
    return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Graphique ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>`
      + `<p:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm>`
      + `<a:graphic><a:graphicData uri="${C}">`
      + `<c:chart xmlns:c="${C}" xmlns:r="${R}" r:id="${rId}"/>`
      + `</a:graphicData></a:graphic></p:graphicFrame>`;
  }

  if (el.type === "shape") {
    const kind = el.shape ?? "rect";
    const lnW = Math.max(0, Math.round((el.strokeWidth ?? 2) * 12700));
    const stroke = hex(el.stroke ?? "#2563eb");
    if (kind === "line" || kind === "arrow") {
      const tail = kind === "arrow" ? '<a:tailEnd type="triangle" w="med" len="med"/>' : "";
      return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Connecteur ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>`
        + `<p:spPr>${xfrm(x, y, w, h, rot)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>`
        + `<a:ln w="${lnW}" cap="rnd"><a:solidFill><a:srgbClr val="${stroke}"/></a:solidFill>${tail}</a:ln></p:spPr></p:cxnSp>`;
    }
    const fill = (el.fill ?? "transparent") === "transparent" ? "<a:noFill/>" : `<a:solidFill><a:srgbClr val="${hex(el.fill!)}"/></a:solidFill>`;
    const ln = lnW > 0 ? `<a:ln w="${lnW}"><a:solidFill><a:srgbClr val="${stroke}"/></a:solidFill></a:ln>` : "<a:ln><a:noFill/></a:ln>";
    const adj = kind === "roundRect" ? `<a:avLst><a:gd name="adj" fmla="val ${Math.round(((el.radius ?? 12) / 100) * 100000)}"/></a:avLst>` : "<a:avLst/>";
    const txt = el.text ? `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="fr-FR" sz="1400" dirty="0"/><a:t>${xmlEsc(el.text)}</a:t></a:r></a:p>` : "<a:p/>";
    return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Forme ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>`
      + `<p:spPr>${xfrm(x, y, w, h, rot)}<a:prstGeom prst="${prstOf(kind)}">${adj}</a:prstGeom>${fill}${ln}</p:spPr>`
      + `<p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/>${txt}</p:txBody></p:sp>`;
  }

  // text element
  const sz = Math.max(100, Math.round((el.fontSize ?? 24) * 75));
  const color = el.color ? hex(el.color) : colors.body;
  const algn = el.align === "center" ? "ctr" : el.align === "right" ? "r" : "l";
  const anchor = el.valign === "middle" ? "ctr" : el.valign === "bottom" ? "b" : "t";
  const paras = htmlToParagraphs(el.html ?? "");
  if (!paras.length) return null;
  const body = paras.map((p) => bodyParagraph(p.html, sz, color, { bullet: p.bullet, align: algn })).join("");
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Texte ${id}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr>`
    + `<p:spPr>${xfrm(x, y, w, h, rot)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>`
    + `<p:txBody><a:bodyPr wrap="square" anchor="${anchor}"><a:normAutofit/></a:bodyPr><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

/** Build slideN.xml plus its image media (returned for packaging). */
function slideXml(slide: Slide, colors: { bg: string; title: string; body: string }, media: { name: string; bytes: Uint8Array }[]): string {
  let id = 2; // 1 is the spTree group
  const parts: string[] = [];

  // Free-canvas decks: render the element list verbatim (z-order preserved).
  if (slide.elements) {
    const bg = bgHex(slide.background) ?? colors.bg;
    for (const el of slide.elements) {
      const xml = elementXml(el, id, colors, media);
      if (xml) { parts.push(xml); id++; }
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
      + `<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld>`
      + `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
      + `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`
      + `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`
      + parts.join("")
      + `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  }

  const paras = htmlToParagraphs(bodyHtmlOf(slide));
  const imageRel = slide.image && (slide.layout === "image-full" || slide.layout === "image-right");

  if (slide.layout === "image-full") {
    if (imageRel) {
      const rId = addImage(slide.image!, media);
      if (rId) parts.push(picXml(id++, rId, ex(8, CX), ex(8, CY), ex(84, CX), ex(74, CY)));
    }
    if (slide.title) parts.push(textBox(id++, "Légende", ex(8, CX), ex(84, CY), ex(84, CX), ex(12, CY),
      paragraph(slide.title, 2000, colors.title, { bold: true, align: "ctr" }), "ctr"));
  } else if (slide.layout === "image-right") {
    parts.push(textBox(id++, "Titre", ex(6, CX), ex(8, CY), ex(46, CX), ex(16, CY),
      paragraph(slide.title || " ", 3600, colors.title, { bold: true })));
    if (paras.length) parts.push(textBox(id++, "Contenu", ex(6, CX), ex(28, CY), ex(46, CX), ex(64, CY),
      paras.map((p) => bodyParagraph(p.html, 2000, colors.body, { bullet: p.bullet })).join("")));
    if (imageRel) {
      const rId = addImage(slide.image!, media);
      if (rId) parts.push(picXml(id++, rId, ex(54, CX), ex(20, CY), ex(42, CX), ex(56, CY)));
    } else {
      parts.push(textBox(id++, "Image", ex(54, CX), ex(20, CY), ex(42, CX), ex(56, CY), "<a:p/>"));
    }
  } else {
    const centered = slide.layout === "title";
    parts.push(textBox(id++, "Titre", ex(8, CX), centered ? ex(34, CY) : ex(7, CY), ex(84, CX), ex(20, CY),
      paragraph(slide.title || " ", centered ? 4400 : 4000, colors.title, { bold: true, align: centered ? "ctr" : "l" }),
      centered ? "ctr" : "t"));
    if (paras.length) parts.push(textBox(id++, "Contenu", ex(8, CX), centered ? ex(56, CY) : ex(30, CY), ex(84, CX), centered ? ex(20, CY) : ex(62, CY),
      paras.map((p) => bodyParagraph(p.html, centered ? 2400 : 2000, colors.body, { bullet: p.bullet && !centered, align: centered ? "ctr" : "l" })).join("")));
  }

  for (const s of slide.shapes ?? []) parts.push(shapeXml(s, id++));

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<p:sld xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld>`
    + `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${colors.bg}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>`
    + `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>`
    + `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`
    + parts.join("")
    + `</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

// Image/chart relationships are per-slide (rId local to each slide's .rels), but
// the referenced FILE NAMES must be globally unique across the deck — otherwise
// slide 2's "image1"/"chart1" would collide with slide 1's and pick up the wrong
// bytes. `type` lets deckToPptx emit each relationship with the right rel type.
let _slideRels: { rId: string; target: string; type: string }[] = [];
// Chart parts collected across the whole deck (global names chart1.xml, …).
let _charts: { name: string; xml: string }[] = [];
function addImage(dataUrl: string, media: { name: string; bytes: Uint8Array }[]): string | null {
  const dec = dataUrlToBytes(dataUrl);
  if (!dec) return null;
  const name = `image${media.length + 1}.${dec.ext}`; // global monotonic name
  media.push({ name, bytes: dec.bytes });
  const rId = `rId${_slideRels.length + 2}`; // rId1 is the layout (per-slide)
  _slideRels.push({ rId, target: `../media/${name}`, type: T.image });
  return rId;
}
function addChart(data: ChartData): string {
  const name = `chart${_charts.length + 1}.xml`; // global monotonic name
  _charts.push({ name, xml: chartXml(data) });
  const rId = `rId${_slideRels.length + 2}`; // rId1 is the layout (per-slide)
  _slideRels.push({ rId, target: `../charts/${name}`, type: T.chart });
  return rId;
}

// A self-contained DrawingML chart part with LITERAL data (c:strLit / c:numLit):
// it renders natively in PowerPoint/LibreOffice with no embedded workbook, so
// the part needs no relationships of its own. Categories/values are paired up to
// the shorter of the two lists.
function chartXml(data: ChartData): string {
  const n = Math.min(data.labels?.length ?? 0, data.values?.length ?? 0);
  const cats = (data.labels ?? []).slice(0, n);
  const vals = (data.values ?? []).slice(0, n);
  const AX_CAT = 111111111, AX_VAL = 222222222;
  const strLit = (arr: string[]) =>
    `<c:strLit><c:ptCount val="${arr.length}"/>`
    + arr.map((v, i) => `<c:pt idx="${i}"><c:v>${xmlEsc(v)}</c:v></c:pt>`).join("")
    + `</c:strLit>`;
  const numLit = (arr: number[]) =>
    `<c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${arr.length}"/>`
    + arr.map((v, i) => `<c:pt idx="${i}"><c:v>${Number.isFinite(v) ? v : 0}</c:v></c:pt>`).join("")
    + `</c:numLit>`;
  const catVal = `<c:cat>${strLit(cats)}</c:cat><c:val>${numLit(vals)}</c:val>`;
  const serHead = `<c:idx val="0"/><c:order val="0"/><c:tx><c:v>${xmlEsc(data.title || "Série 1")}</c:v></c:tx>`;
  const axes =
    `<c:catAx><c:axId val="${AX_CAT}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="${AX_VAL}"/></c:catAx>`
    + `<c:valAx><c:axId val="${AX_VAL}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="${AX_CAT}"/></c:valAx>`;

  let plot: string;
  if (data.kind === "pie") {
    plot = `<c:pieChart><c:varyColors val="1"/><c:ser>${serHead}${catVal}</c:ser></c:pieChart>`;
  } else if (data.kind === "line") {
    plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>`
      + `<c:ser>${serHead}<c:marker><c:symbol val="circle"/></c:marker>${catVal}<c:smooth val="0"/></c:ser>`
      + `<c:marker val="1"/><c:axId val="${AX_CAT}"/><c:axId val="${AX_VAL}"/></c:lineChart>${axes}`;
  } else {
    plot = `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>`
      + `<c:ser>${serHead}${catVal}</c:ser>`
      + `<c:axId val="${AX_CAT}"/><c:axId val="${AX_VAL}"/></c:barChart>${axes}`;
  }

  const title = data.title
    ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>${xmlEsc(data.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>`
    : `<c:autoTitleDeleted val="1"/>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}">`
    + `<c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea>`
    + `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

const RELS = (rels: { id: string; type: string; target: string }[]) =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="${REL}">`
  + rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join("")
  + `</Relationships>`;

const T = {
  slide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
  slideMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster",
  slideLayout: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
  theme: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
  image: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
  chart: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart",
};

function themeXml(): string {
  const accents = ["4472C4", "ED7D31", "A5A5A5", "FFC000", "5B9BD5", "70AD47"];
  const clr = `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>`
    + `<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>`
    + accents.map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c}"/></a:accent${i + 1}>`).join("")
    + `<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>`;
  const font = (name: string) => `<a:latin typeface="${name}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const fill = `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`
    + `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:lumMod val="110000"/><a:satMod val="105000"/><a:tint val="67000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="103000"/><a:tint val="73000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="105000"/><a:satMod val="109000"/><a:tint val="81000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>`
    + `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:satMod val="103000"/><a:lumMod val="102000"/><a:tint val="94000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:satMod val="110000"/><a:lumMod val="100000"/><a:shade val="100000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:lumMod val="99000"/><a:satMod val="120000"/><a:shade val="78000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>`;
  const lnStyle = ['<a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>',
    '<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>',
    '<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>'].join("");
  const effect = `<a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle>`;
  const bgFill = `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/><a:satMod val="170000"/></a:schemeClr></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="93000"/><a:satMod val="150000"/><a:shade val="98000"/><a:lumMod val="102000"/></a:schemeClr></a:gs><a:gs pos="50000"><a:schemeClr val="phClr"><a:tint val="98000"/><a:satMod val="130000"/><a:shade val="90000"/><a:lumMod val="103000"/></a:schemeClr></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"><a:shade val="63000"/><a:satMod val="120000"/></a:schemeClr></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<a:theme xmlns:a="${A}" name="Elium"><a:themeElements>`
    + `<a:clrScheme name="Elium">${clr}</a:clrScheme>`
    + `<a:fontScheme name="Elium"><a:majorFont>${font("Calibri Light")}</a:majorFont><a:minorFont>${font("Calibri")}</a:minorFont></a:fontScheme>`
    + `<a:fmtScheme name="Elium"><a:fillStyleLst>${fill}</a:fillStyleLst><a:lnStyleLst>${lnStyle}</a:lnStyleLst><a:effectStyleLst>${effect}</a:effectStyleLst><a:bgFillStyleLst>${bgFill}</a:bgFillStyleLst></a:fmtScheme>`
    + `</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

const MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<p:sldMaster xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>`
  + `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>`
  + `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>`
  + `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>`
  + `<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>`;

const LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
  + `<p:sldLayout xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" type="blank" preserve="1"><p:cSld name="Vierge">`
  + `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>`
  + `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;

/** Serialise a deck to a .pptx byte array. */
export function deckToPptx(deck: Deck): Uint8Array {
  _slideRels = [];
  _charts = [];
  const media: { name: string; bytes: Uint8Array }[] = [];
  const files: Record<string, Uint8Array> = {};
  const n = deck.slides.length;

  // Slides (+ per-slide rels & media & chart parts).
  deck.slides.forEach((slide, i) => {
    _slideRels = [];
    const xml = slideXml(slide, themeColors(deck.theme ?? "light"), media);
    files[`ppt/slides/slide${i + 1}.xml`] = strToU8(xml);
    const rels = [{ id: "rId1", type: T.slideLayout, target: "../slideLayouts/slideLayout1.xml" },
      ..._slideRels.map((r) => ({ id: r.rId, type: r.type, target: r.target }))];
    files[`ppt/slides/_rels/slide${i + 1}.xml.rels`] = strToU8(RELS(rels));
  });

  // Chart parts (literal-data, no own relationships → no .rels file needed).
  for (const c of _charts) files[`ppt/charts/${c.name}`] = strToU8(c.xml);

  // Media (deduped by name across slides).
  const seen = new Set<string>();
  for (const m of media) {
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    files[`ppt/media/${m.name}`] = m.bytes;
  }

  // Presentation part.
  const sldIds = deck.slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("");
  files["ppt/presentation.xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<p:presentation xmlns:a="${A}" xmlns:r="${R}" xmlns:p="${P}" saveSubsetFonts="1">`
    + `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${n + 1}"/></p:sldMasterIdLst>`
    + `<p:sldIdLst>${sldIds}</p:sldIdLst>`
    + `<p:sldSz cx="${CX}" cy="${CY}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
  );
  const presRels = [
    ...deck.slides.map((_, i) => ({ id: `rId${i + 1}`, type: T.slide, target: `slides/slide${i + 1}.xml` })),
    { id: `rId${n + 1}`, type: T.slideMaster, target: "slideMasters/slideMaster1.xml" },
    { id: `rId${n + 2}`, type: T.theme, target: "theme/theme1.xml" },
  ];
  files["ppt/_rels/presentation.xml.rels"] = strToU8(RELS(presRels));

  // Master, layout, theme.
  files["ppt/slideMasters/slideMaster1.xml"] = strToU8(MASTER_XML);
  files["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = strToU8(RELS([
    { id: "rId1", type: T.slideLayout, target: "../slideLayouts/slideLayout1.xml" },
    { id: "rId2", type: T.theme, target: "../theme/theme1.xml" },
  ]));
  files["ppt/slideLayouts/slideLayout1.xml"] = strToU8(LAYOUT_XML);
  files["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = strToU8(RELS([
    { id: "rId1", type: T.slideMaster, target: "../slideMasters/slideMaster1.xml" },
  ]));
  files["ppt/theme/theme1.xml"] = strToU8(themeXml());

  // Package relationships + content types.
  files["_rels/.rels"] = strToU8(RELS([
    { id: "rId1", type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument", target: "ppt/presentation.xml" },
  ]));
  const overrides = [
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>`,
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>`,
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>`,
    ...deck.slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`),
    ..._charts.map((c) => `<Override PartName="/ppt/charts/${c.name}" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`),
  ].join("");
  files["[Content_Types].xml"] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="${CT}">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Default Extension="png" ContentType="image/png"/>`
    + `<Default Extension="jpeg" ContentType="image/jpeg"/>`
    + `<Default Extension="gif" ContentType="image/gif"/>`
    + overrides + `</Types>`,
  );

  return zipSync(files, { level: 6 });
}
