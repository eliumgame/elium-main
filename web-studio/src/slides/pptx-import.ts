/**
 * PPTX (Office Open XML / PresentationML) IMPORT — dependency-free, the inverse
 * of pptx.ts. Reads a .pptx ZIP with fflate, walks the OPC relationships to the
 * slides in order, and turns each spTree child (<p:sp>/<p:pic>/<p:cxnSp>, and
 * <p:grpSp> recursively) into a free-canvas SlideElement. Geometry is EMU→% on
 * the file's own slide size. Uses regex/string scanning (no DOMParser) so it runs
 * identically in the browser and in Node tests, matching the exporter's coverage.
 * Constructs Élium can't represent (tables, charts, media, gradients) degrade
 * gracefully (text is kept; unknown geometry falls back to a rectangle).
 */
import { unzipSync, strFromU8 } from "fflate";
import {
  newSlideId, newElementId,
  type Deck, type Slide, type SlideElement, type ShapeKind, type ElementType,
} from "./model";

const PRST_TO_KIND: Record<string, ShapeKind> = {
  rect: "rect", roundRect: "roundRect", ellipse: "ellipse", triangle: "triangle",
  diamond: "diamond", pentagon: "pentagon", hexagon: "hexagon", star5: "star",
  chevron: "chevron", cloud: "cloud", heart: "heart", line: "line",
};

const attr = (xml: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(xml);
  return m ? m[1] : undefined;
};
const num = (v: string | undefined, dflt = 0): number => { const n = v != null ? Number(v) : NaN; return Number.isFinite(n) ? n : dflt; };
function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
}
function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Ordered top-level {p:sp, p:pic, p:cxnSp, p:grpSp} blocks inside an spTree. */
function childBlocks(xml: string): { tag: string; block: string }[] {
  const TARGETS = new Set(["p:sp", "p:pic", "p:cxnSp", "p:grpSp", "p:graphicFrame"]);
  const out: { tag: string; block: string }[] = [];
  let i = 0; const n = xml.length;
  while (i < n) {
    if (xml[i] !== "<") { i++; continue; }
    const m = /^<(\/?)([a-zA-Z:]+)/.exec(xml.slice(i, i + 48));
    if (!m) { i++; continue; }
    const name = m[2]!;
    if (m[1] !== "/" && TARGETS.has(name)) {
      const openEnd = xml.indexOf(">", i);
      if (openEnd < 0) break;
      if (xml[openEnd - 1] === "/") { out.push({ tag: name, block: xml.slice(i, openEnd + 1) }); i = openEnd + 1; continue; }
      const closeTag = `</${name}>`;
      let depth = 1, j = openEnd + 1;
      while (j < n && depth > 0) {
        const no = xml.indexOf(`<${name}`, j);
        const nc = xml.indexOf(closeTag, j);
        if (nc < 0) { j = n; break; }
        if (no >= 0 && no < nc) {
          const c = xml[no + name.length + 1];
          if (c === " " || c === ">" || c === "/" || c === "\t" || c === "\n" || c === "\r") depth++;
          j = no + name.length + 1;
        } else { depth--; j = nc + closeTag.length; }
      }
      out.push({ tag: name, block: xml.slice(i, j) });
      i = j; continue;
    }
    const gt = xml.indexOf(">", i);
    i = gt < 0 ? n : gt + 1;
  }
  return out;
}

interface Geom { x: number; y: number; w: number; h: number; rot: number }
function firstXfrm(block: string, cx: number, cy: number): Geom {
  const xf = /<[ap]:xfrm\b([^>]*)>([\s\S]*?)<\/[ap]:xfrm>/.exec(block);
  const head = xf?.[1] ?? "";
  const body = xf?.[2] ?? "";
  const off = /<a:off\b([^>]*)\/?>/.exec(body)?.[1] ?? "";
  const ext = /<a:ext\b([^>]*)\/?>/.exec(body)?.[1] ?? "";
  const ex = num(attr(off, "x")), ey = num(attr(off, "y"));
  const ew = num(attr(ext, "cx")), eh = num(attr(ext, "cy"));
  const rot = num(attr(head, "rot"));
  return { x: (ex / cx) * 100, y: (ey / cy) * 100, w: (ew / cx) * 100, h: (eh / cy) * 100, rot: Math.round(rot / 60000) };
}

const colorIn = (xml: string): string | undefined => {
  const v = /<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(xml)?.[1];
  return v ? `#${v.toLowerCase()}` : undefined;
};

/** Rebuild sanitized HTML from a <p:txBody>, preserving b/i/u/colour + bullets. */
function txBodyToHtml(block: string, elColor?: string): string {
  const tb = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(block)?.[1] ?? "";
  const paras = [...tb.matchAll(/<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g)].map((m) => m[1]!);
  const out: string[] = [];
  for (const p of paras) {
    const pPr = /<a:pPr\b([^>]*)>?([\s\S]*?)(?:<\/a:pPr>|\/>)/.exec(p);
    const pPrAll = /<a:pPr[\s\S]*?(?:<\/a:pPr>|\/>)/.exec(p)?.[0] ?? "";
    const bullet = /<a:buChar\b/.test(pPrAll) || (/\bmarL="/.test(pPr?.[1] ?? pPrAll) && !/<a:buNone\/>/.test(pPrAll));
    let inner = "";
    for (const rm of p.matchAll(/<a:r>([\s\S]*?)<\/a:r>/g)) {
      const r = rm[1]!;
      const rPr = /<a:rPr\b([^>]*)>/.exec(r)?.[1] ?? "";
      const text = unescapeXml(/<a:t>([\s\S]*?)<\/a:t>/.exec(r)?.[1] ?? "");
      if (!text) continue;
      let piece = escapeText(text);
      const col = colorIn(r);
      if (col && col !== elColor) piece = `<span style="color:${col}">${piece}</span>`;
      if (/\bu="sng"/.test(rPr)) piece = `<u>${piece}</u>`;
      if (/\bi="1"/.test(rPr)) piece = `<i>${piece}</i>`;
      if (/\bb="1"/.test(rPr)) piece = `<b>${piece}</b>`;
      inner += piece;
    }
    if (bullet) out.push(`<li>${inner}</li>`);
    else out.push(`<p>${inner}</p>`);
  }
  // Coalesce consecutive <li> into a single <ul>.
  let html = ""; let liBuf = "";
  const flush = () => { if (liBuf) { html += `<ul>${liBuf}</ul>`; liBuf = ""; } };
  for (const chunk of out) {
    if (chunk.startsWith("<li>")) liBuf += chunk;
    else { flush(); html += chunk; }
  }
  flush();
  return html;
}
const hasText = (block: string): boolean => /<a:t>[\s\S]*?\S[\s\S]*?<\/a:t>/.test(block);

function el(base: Partial<SlideElement> & Pick<SlideElement, "type">, g: Geom): SlideElement {
  return { id: newElementId(), x: round1(g.x), y: round1(g.y), w: round1(g.w), h: round1(g.h), rotation: g.rot || undefined, ...base } as SlideElement;
}
const round1 = (v: number) => Math.round(v * 10) / 10;

function parsePic(block: string, cx: number, cy: number, rels: Map<string, string>, media: Record<string, Uint8Array>): SlideElement | null {
  const rId = attr(/<a:blip\b[^>]*\/?>/.exec(block)?.[0] ?? "", "r:embed") ?? attr(block, "r:embed");
  const g = firstXfrm(block, cx, cy);
  let src: string | undefined;
  if (rId) {
    const target = rels.get(rId);
    if (target) {
      const path = resolveMedia(target);
      const bytes = media[path];
      if (bytes) src = `data:${mimeOf(path)};base64,${base64(bytes)}`;
    }
  }
  if (!src) return null;
  return el({ type: "image", src }, g);
}

function parseCxn(block: string, cx: number, cy: number): SlideElement {
  const g = firstXfrm(block, cx, cy);
  const ln = /<a:ln\b([^>]*)>([\s\S]*?)<\/a:ln>/.exec(block);
  const strokeW = ln ? Math.round(num(attr(ln[1]!, "w")) / 12700) : 3;
  const stroke = (ln && colorIn(ln[2]!)) || "#0f172a";
  const kind: ShapeKind = /<a:tailEnd\b/.test(block) ? "arrow" : "line";
  return el({ type: "shape", shape: kind, stroke, strokeWidth: strokeW || 3, fill: "transparent" }, g);
}

function parseSp(block: string, cx: number, cy: number): SlideElement | null {
  const g = firstXfrm(block, cx, cy);
  const spPr = /<p:spPr\b[^>]*>([\s\S]*?)<\/p:spPr>/.exec(block)?.[1] ?? "";
  const prst = attr(/<a:prstGeom\b[^>]*>/.exec(spPr)?.[0] ?? "", "prst") ?? "rect";
  const hasFill = /<a:solidFill>/.test(spPr) || /<a:noFill\/>/.test(spPr) || /<a:gradFill/.test(spPr) || /<a:blipFill/.test(spPr);
  const hasLine = /<a:ln\b/.test(spPr);
  const textLike = prst === "rect" && !hasFill && !hasLine && hasText(block);

  if (textLike) {
    const rPr = /<a:rPr\b([^>]*)>/.exec(block)?.[1] ?? "";
    const bodyPr = /<a:bodyPr\b([^>]*)>?/.exec(block)?.[1] ?? "";
    const algn = attr(/<a:pPr\b[^>]*>/.exec(block)?.[0] ?? "", "algn");
    const anchor = attr(bodyPr, "anchor");
    const fontSize = Math.round(num(attr(rPr, "sz"), 24 * 75) / 75) || 24;
    const color = colorIn(/<a:rPr\b[^>]*>([\s\S]*?)<\/a:rPr>/.exec(block)?.[0] ?? block);
    const html = txBodyToHtml(block, color);
    if (!html) return null;
    return el({
      type: "text", html, fontSize,
      ...(color ? { color } : {}),
      align: algn === "ctr" ? "center" : algn === "r" ? "right" : "left",
      valign: anchor === "ctr" ? "middle" : anchor === "b" ? "bottom" : "top",
    }, g);
  }

  // shape
  const kind = PRST_TO_KIND[prst] ?? "rect";
  const fillSolid = /<a:solidFill>([\s\S]*?)<\/a:solidFill>/.exec(spPr);
  const fill = /<a:noFill\/>/.test(spPr) ? "transparent" : (fillSolid && colorIn(fillSolid[1]!)) || "#bfdbfe";
  const ln = /<a:ln\b([^>]*)>([\s\S]*?)<\/a:ln>/.exec(spPr);
  const strokeW = ln ? Math.round(num(attr(ln[1]!, "w")) / 12700) : 2;
  const stroke = (ln && colorIn(ln[2]!)) || "#2563eb";
  const adj = num(attr(/<a:gd\b[^>]*name="adj"[^>]*>/.exec(spPr)?.[0] ?? "", "fmla")?.replace(/^val\s+/, ""));
  const radius = kind === "roundRect" && adj ? Math.round(adj / 1000) : undefined;
  // a shape may carry a centered text label
  const label = [...block.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => unescapeXml(m[1]!)).join(" ").trim();
  const t: ElementType = "shape";
  return el({
    type: t, shape: kind, fill, stroke, strokeWidth: strokeW,
    ...(radius ? { radius } : {}),
    ...(label ? { text: label } : {}),
  }, g);
}

function parseGraphicFrame(block: string, cx: number, cy: number): SlideElement | null {
  if (!/<a:tbl\b/.test(block)) return null; // charts / SmartArt / OLE → skip (degrade)
  const g = firstXfrm(block, cx, cy);
  const trs = [...block.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)].map((m) => m[1]!);
  const cells = trs.map((tr) =>
    [...tr.matchAll(/<a:tc\b[^>]*>([\s\S]*?)<\/a:tc>/g)].map((m) =>
      [...m[1]!.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((x) => unescapeXml(x[1]!)).join("")),
  );
  const rows = cells.length;
  const cols = cells.reduce((m, r) => Math.max(m, r.length), 0);
  if (!rows || !cols) return null;
  const norm = cells.map((r) => { const rr = r.slice(); while (rr.length < cols) rr.push(""); return rr; });
  const sz = Math.round(num(attr(/<a:rPr\b[^>]*>/.exec(block)?.[0] ?? "", "sz"), 18 * 75) / 75) || 18;
  const color = colorIn(block) ?? "#0f172a";
  return el({ type: "table", table: { rows, cols, cells: norm }, fontSize: sz, color }, g);
}

function parseSpTree(spTree: string, cx: number, cy: number, rels: Map<string, string>, media: Record<string, Uint8Array>): SlideElement[] {
  const out: SlideElement[] = [];
  for (const { tag, block } of childBlocks(spTree)) {
    try {
      if (tag === "p:pic") { const e = parsePic(block, cx, cy, rels, media); if (e) out.push(e); }
      else if (tag === "p:cxnSp") out.push(parseCxn(block, cx, cy));
      else if (tag === "p:graphicFrame") { const e = parseGraphicFrame(block, cx, cy); if (e) out.push(e); }
      else if (tag === "p:sp") { const e = parseSp(block, cx, cy); if (e) out.push(e); }
      else if (tag === "p:grpSp") {
        // recurse: strip the group's own nvGrpSpPr/grpSpPr, parse remaining children
        const inner = block.replace(/<p:nvGrpSpPr>[\s\S]*?<\/p:nvGrpSpPr>/, "").replace(/<p:grpSpPr>[\s\S]*?<\/p:grpSpPr>/, "");
        out.push(...parseSpTree(inner, cx, cy, rels, media));
      }
    } catch { /* skip a malformed shape rather than abort the whole slide */ }
  }
  return out;
}

// --- media helpers ---
function resolveMedia(target: string): string {
  // slide rels targets are relative to ppt/slides/ (e.g. ../media/image1.png)
  const t = target.replace(/^(\.\.\/)+/, "");
  return t.startsWith("ppt/") ? t : `ppt/${t}`;
}
function mimeOf(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "application/octet-stream";
}
function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return typeof btoa !== "undefined" ? btoa(bin) : Buffer.from(bytes).toString("base64");
}

function parseRels(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  for (const m of xml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1]!, "Id"); const target = attr(m[1]!, "Target");
    if (id && target) map.set(id, target);
  }
  return map;
}

/** Parse a .pptx byte array into an Élium Deck (free-canvas slides). */
export function importPptx(bytes: Uint8Array): Deck {
  const zip = unzipSync(bytes);
  const text = (path: string): string | undefined => (zip[path] ? strFromU8(zip[path]!) : undefined);

  const pres = text("ppt/presentation.xml") ?? "";
  const sldSz = /<p:sldSz\b([^>]*)\/?>/.exec(pres)?.[1] ?? "";
  const cx = num(attr(sldSz, "cx"), 12192000);
  const cy = num(attr(sldSz, "cy"), 6858000);

  const presRels = parseRels(text("ppt/_rels/presentation.xml.rels"));
  // slide order from <p:sldId r:id="..."> in sldIdLst
  const order = [...pres.matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)].map((m) => m[1]!);
  const slidePaths = order
    .map((rId) => presRels.get(rId))
    .filter((t): t is string => !!t)
    .map((t) => (t.startsWith("ppt/") ? t : `ppt/${t}`));

  const slides: Slide[] = [];
  slidePaths.forEach((path) => {
    const xml = text(path);
    if (!xml) return;
    const relsName = path.replace(/([^/]+)$/, "_rels/$1.rels");
    const rels = parseRels(text(relsName));
    const spTree = /<p:spTree\b[^>]*>([\s\S]*)<\/p:spTree>/.exec(xml)?.[1] ?? "";
    const elements = parseSpTree(spTree, cx, cy, rels, zip);
    const bgColor = colorIn(/<p:bg>[\s\S]*?<\/p:bg>/.exec(xml)?.[0] ?? "");
    slides.push({
      id: newSlideId(), title: "", body: "", bodyHtml: "", layout: "blank",
      elements,
      ...(bgColor ? { background: bgColor } : {}),
    });
  });

  if (!slides.length) slides.push({ id: newSlideId(), title: "", body: "", bodyHtml: "", layout: "blank", elements: [] });
  return { slides, active: 0, theme: "light", transition: "fade" };
}

/** Convenience wrapper for a File from an <input type="file">. */
export async function importPptxFile(file: File): Promise<Deck> {
  return importPptx(new Uint8Array(await file.arrayBuffer()));
}
