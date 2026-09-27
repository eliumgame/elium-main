/**
 * Standalone HTML → PDF pages, in the browser (« Créer un PDF depuis un fichier »).
 *
 * 1. The HTML is laid out in a hidden, sandboxed, same-origin frame at the
 *    width of the page's content box. Its style sheet is adopted through the
 *    CSSOM and inline styles are set through `style.cssText`: the desktop
 *    CSP (no 'unsafe-inline' for styles) would refuse <style> elements and
 *    style attributes, but not these. Fonts carried as data: URLs are loaded
 *    from their bytes with the FontFace API (font-src has no data:).
 * 2. What must not be cut is measured — text lines (one rectangle per word),
 *    pictures, table rows, blocks kept together, headings with what follows —
 *    with the page breaks asked for, and `planPageSlices` cuts the content.
 * 3. Each page is drawn: the blocks it shows are serialised (XHTML) with the
 *    style sheet into an SVG <foreignObject>, which is drawn on a canvas at the
 *    chosen resolution. An SVG image is its own document: nothing outside it
 *    is fetched and no script runs, and a data: URL (img-src allows data:)
 *    leaves the canvas readable, where a blob: one would taint it.
 * 4. The words measured on each page, and its links, go with its picture to
 *    `assemblePdf`, which writes them as an invisible text layer and Link
 *    annotations.
 */

import { customFontFilename, customFontNames, getCustomFont } from "../../ui/fonts";
import { fontFaceCss, fontExtension } from "../../format/embedded-fonts";
import {
  contentBoxPx,
  FIT_WIDTH_CLASS,
  FIXED_PAGE_CLASS,
  planPageSlices,
  PX_PER_PT,
  renameStyleAttributes,
  STYLE_ATTR,
  type HtmlSource,
  type LinkBox,
  type RenderedPage,
  type VBox,
  type WordBox,
} from "../ops/create-from-file";

export interface RenderOptions {
  /** Resolution of the page pictures; 150 dpi by default. */
  dpi?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Largest page picture (pixels): big pages are drawn at a lower resolution. */
const MAX_PIXELS = 24_000_000;
/** Width of the frame laying out fixed-size pages (wider than any slide). */
const FIXED_FRAME_WIDTH = 4096;

const XHTML = "http://www.w3.org/1999/xhtml";

export class RenderCancelled extends Error {
  constructor() {
    super("Création interrompue.");
    this.name = "AbortError";
  }
}

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

interface FontBytes {
  family: string;
  weight?: string;
  style?: string;
  bytes: Uint8Array;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** `@font-face` rules with a base64 data: source, taken out of a style sheet (their bytes). */
export function extractDataFonts(css: string): { css: string; fonts: FontBytes[] } {
  const fonts: FontBytes[] = [];
  const rest = css.replace(/@font-face\s*\{([^}]*)\}/gi, (rule, body: string) => {
    const src = /url\(\s*["']?data:[^;,]*;base64,([A-Za-z0-9+/=\s]+)["']?\s*\)/i.exec(body);
    const family = /font-family\s*:\s*["']?([^;"']+)["']?/i.exec(body)?.[1]?.trim();
    if (!src || !family) return rule;
    try {
      fonts.push({
        family,
        weight: /font-weight\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim(),
        style: /font-style\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim(),
        bytes: base64ToBytes(src[1]),
      });
      return "";
    } catch {
      return rule;
    }
  });
  return { css: rest, fonts };
}

/** Fonts the user imported into the app that the source names (they render in the editors too). */
function customFontsUsed(src: HtmlSource): { fonts: FontBytes[]; css: string } {
  const fonts: FontBytes[] = [];
  const faces: { family: string; ext: string; base64: string }[] = [];
  for (const family of customFontNames()) {
    if (!src.css.includes(family) && !src.body.includes(family)) continue;
    const bytes = getCustomFont(family);
    if (!bytes) continue;
    fonts.push({ family, bytes });
    faces.push({ family, ext: fontExtension(customFontFilename(family)) ?? "ttf", base64: bytesToBase64(bytes) });
  }
  return { fonts, css: faces.length ? fontFaceCss(faces) : "" };
}

// ---------------------------------------------------------------------------
// Layout frame
// ---------------------------------------------------------------------------

interface Layout {
  frame: HTMLIFrameElement;
  doc: Document;
  win: Window;
  /** CSS for the page pictures (the source's, fonts included). */
  renderCss: string;
  dispose: () => void;
}

const nextFrame = () => new Promise<void>((res) => requestAnimationFrame(() => res()));

/** Inline styles set through the CSSOM (allowed by the CSP) rather than as attributes (refused). */
function moveInlineStyles(root: Element): [HTMLElement | SVGElement, string][] {
  const out: [HTMLElement | SVGElement, string][] = [];
  const all = [root, ...root.querySelectorAll(`[${STYLE_ATTR}]`)];
  for (const el of all) {
    const v = el.getAttribute(STYLE_ATTR);
    if (v == null) continue;
    el.removeAttribute(STYLE_ATTR);
    if (v.trim()) out.push([el as HTMLElement, v]);
  }
  return out;
}

/** What remains dangerous after the source's own sanitising: never shown, never run. */
function scrub(root: Element): void {
  root.querySelectorAll("script,iframe,frame,object,embed,link,meta,base").forEach((el) => el.remove());
  for (const el of root.querySelectorAll("*")) {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  }
}

async function mountLayout(src: HtmlSource, widthPx: number, heightPx: number): Promise<Layout> {
  const frame = document.createElement("iframe");
  // Same origin (the parent measures and serialises it), no script.
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("title", "Mise en page");
  frame.tabIndex = -1;
  const fs = frame.style;
  fs.position = "fixed";
  fs.left = "-100000px";
  fs.top = "0";
  fs.width = `${Math.ceil(widthPx)}px`;
  fs.height = `${Math.ceil(heightPx)}px`;
  fs.border = "0";
  fs.opacity = "0";
  fs.pointerEvents = "none";
  document.body.appendChild(frame);
  const dispose = () => frame.remove();
  try {
    const win = frame.contentWindow!;
    // A frame's initial document is in quirks mode (no doctype): margins in
    // table cells and at the top of <body> would not be laid out as in the
    // pictures, which are drawn in standards mode (XHTML). Rewritten with a
    // doctype (markup only: nothing the CSP refuses).
    const initial = frame.contentDocument!;
    initial.open();
    initial.write("<!doctype html><html><head></head><body></body></html>");
    initial.close();
    const doc = frame.contentDocument!;
    if (doc.compatMode !== "CSS1Compat") throw new Error("Mise en page impossible (mode de compatibilité).");
    doc.documentElement.setAttribute("lang", src.lang || "fr");

    const custom = customFontsUsed(src);
    const data = extractDataFonts(src.css);
    // The frame's own sheet: the source's, without scroll bars (they would narrow the page).
    const sheet = new (win as unknown as typeof globalThis).CSSStyleSheet();
    sheet.replaceSync(`${data.css}\nhtml{overflow:hidden!important}`);
    doc.adoptedStyleSheets = [sheet];
    // Fonts from their bytes: font-src forbids data: URLs, not buffers.
    const FontFaceCtor = (win as unknown as typeof globalThis).FontFace;
    for (const f of [...data.fonts, ...custom.fonts]) {
      try {
        const face = new FontFaceCtor(f.family, f.bytes as unknown as ArrayBuffer, {
          ...(f.weight ? { weight: f.weight } : {}),
          ...(f.style ? { style: f.style } : {}),
        });
        doc.fonts.add(await face.load());
      } catch {
        /* an unreadable face falls back to the next family */
      }
    }

    // Parsed inert, cleaned, then moved in with its inline styles set through the CSSOM.
    const parsed = new DOMParser().parseFromString(
      `<!doctype html><html><head></head><body>${renameStyleAttributes(src.body)}</body></html>`,
      "text/html",
    );
    scrub(parsed.body);
    const styles = moveInlineStyles(parsed.body);
    if (src.bodyClass) doc.body.className = src.bodyClass;
    for (const node of [...parsed.body.childNodes]) doc.body.appendChild(doc.adoptNode(node));
    for (const [el, css] of styles) if (el !== (parsed.body as Element)) el.style.cssText = css;
    const bodyStyle = styles.find(([el]) => el === (parsed.body as Element));
    if (bodyStyle) doc.body.style.cssText = bodyStyle[1];
    wrapLooseInline(doc);

    await Promise.all([...doc.images].map((img) => img.decode().catch(() => {})));
    await doc.fonts.ready;
    await nextFrame();
    return { frame, doc, win, renderCss: `${src.css}\n${custom.css}`, dispose };
  } catch (e) {
    dispose();
    throw e;
  }
}

/** Text and inline elements directly in <body> wrapped in blocks, so the page's blocks can be kept or left out. */
function wrapLooseInline(doc: Document): void {
  const body = doc.body;
  const win = doc.defaultView!;
  let run: Node[] = [];
  const flush = () => {
    if (run.some((n) => n.nodeType === 1 || (n.textContent ?? "").trim())) {
      const div = doc.createElement("div");
      run[0].parentNode!.insertBefore(div, run[0]);
      for (const n of run) div.appendChild(n);
    }
    run = [];
  };
  for (const node of [...body.childNodes]) {
    const inline =
      node.nodeType === 3 ||
      (node.nodeType === 1 && win.getComputedStyle(node as Element).display.startsWith("inline"));
    if (inline) run.push(node);
    else {
      flush();
      if (node.nodeType === 8) node.remove();
    }
  }
  flush();
}

// ---------------------------------------------------------------------------
// Measuring
// ---------------------------------------------------------------------------

interface MeasuredWord {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
}

interface Measured {
  /** Per top-level block of <body>: its extent (with everything it draws) and border box. */
  blocks: { el: Element; top: number; bottom: number; boxTop: number; boxBottom: number }[];
  boxes: VBox[];
  forced: number[];
  words: MeasuredWord[];
  links: { rect: { left: number; top: number; width: number; height: number }; href: string }[];
  images: VBox[];
  end: number;
  origin: { x: number; y: number };
}

const FORCED = new Set(["page", "left", "right", "recto", "verso", "always"]);
const ATOMIC = new Set(["img", "svg", "canvas", "video", "tr", "hr", "picture", "math"]);
const SKIP_TEXT = new Set(["style", "script", "title", "desc", "noscript", "template", "option"]);

function measure(layout: Layout, pageHeightPx: number): Measured {
  const { doc, win } = layout;
  const body = doc.body;
  const bodyRect = body.getBoundingClientRect();
  const ox = bodyRect.left;
  const oy = bodyRect.top;
  const blocks: Measured["blocks"] = [];
  const boxes: VBox[] = [];
  const forced: number[] = [];
  const words: MeasuredWord[] = [];
  const links: Measured["links"] = [];
  const images: VBox[] = [];
  let end = 0;
  const styleOf = new Map<Element, CSSStyleDeclaration>();
  const cs = (el: Element) => {
    let s = styleOf.get(el);
    if (!s) {
      s = win.getComputedStyle(el);
      styleOf.set(el, s);
    }
    return s;
  };
  const range = doc.createRange();

  for (const block of [...body.children]) {
    const firstWord = words.length;
    const r0 = block.getBoundingClientRect();
    let top = r0.top - oy;
    let bottom = r0.bottom - oy;
    const walker = doc.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node: Node | null = block; node; node = walker.nextNode()) {
      if (node.nodeType === 1) {
        const el = node as Element;
        const s = cs(el);
        if (s.display === "none") continue;
        const r = el.getBoundingClientRect();
        if (r.width || r.height) {
          top = Math.min(top, r.top - oy);
          bottom = Math.max(bottom, r.bottom - oy);
        }
        const t = r.top - oy;
        const b = r.bottom - oy;
        if (FORCED.has(s.breakBefore)) forced.push(t);
        if (FORCED.has(s.breakAfter)) forced.push(b);
        const name = el.localName;
        const atomic =
          (ATOMIC.has(name) && !(name === "svg" && el.parentElement?.closest("svg"))) ||
          s.breakInside === "avoid" ||
          s.breakInside === "avoid-page";
        if (atomic && b - t > 0 && b - t <= pageHeightPx) boxes.push({ top: t, bottom: b });
        if (name === "img" || (name === "image" && el.namespaceURI?.endsWith("svg")))
          images.push({ top: t, bottom: b });
        // A heading stays with the start of what follows it.
        const keepNext = /^h[1-6]$/.test(name) || s.breakAfter === "avoid" || s.breakAfter === "avoid-page";
        if (keepNext && el.nextElementSibling) {
          const n = el.nextElementSibling.getBoundingClientRect();
          const nb = Math.min(n.bottom - oy, n.top - oy + 40);
          if (nb > t && nb - t <= pageHeightPx) boxes.push({ top: t, bottom: nb });
        }
        if (name === "a" && el.getAttribute("href")) {
          for (const lr of el.getClientRects())
            if (lr.width && lr.height)
              links.push({
                rect: { left: lr.left - ox, top: lr.top - oy, width: lr.width, height: lr.height },
                href: el.getAttribute("href")!,
              });
        }
        continue;
      }
      // Text: one rectangle per word.
      const parent = node.parentElement;
      if (!parent || SKIP_TEXT.has(parent.localName)) continue;
      const ps = cs(parent);
      if (ps.visibility !== "visible" || ps.display === "none") continue;
      const zoom = (parent as Element & { currentCSSZoom?: number }).currentCSSZoom ?? 1;
      const fontSize = (parseFloat(ps.fontSize) || 12) * zoom;
      const text = node.nodeValue ?? "";
      for (const m of text.matchAll(/\S+/gu)) {
        const at = m.index ?? 0;
        range.setStart(node, at);
        range.setEnd(node, at + m[0].length);
        const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
        if (!rects.length) continue;
        if (rects.length === 1) {
          const r = rects[0];
          words.push({ text: m[0], left: r.left - ox, top: r.top - oy, width: r.width, height: r.height, fontSize });
        } else {
          // A word broken over lines (long URL, no spaces): its pieces, character by character.
          let piece: MeasuredWord | null = null;
          for (let i = 0; i < m[0].length; i++) {
            range.setStart(node, at + i);
            range.setEnd(node, at + i + 1);
            const r = [...range.getClientRects()].find((x) => x.width > 0 && x.height > 0);
            if (!r) continue;
            const t = r.top - oy;
            if (piece && Math.abs(piece.top - t) < 1 && r.left - ox >= piece.left + piece.width - 1) {
              piece.text += m[0][i];
              piece.width = r.right - ox - piece.left;
            } else {
              if (piece) words.push(piece);
              piece = { text: m[0][i], left: r.left - ox, top: t, width: r.width, height: r.height, fontSize };
            }
          }
          if (piece) words.push(piece);
        }
      }
    }
    for (let i = firstWord; i < words.length; i++) {
      top = Math.min(top, words[i].top);
      bottom = Math.max(bottom, words[i].top + words[i].height);
    }
    blocks.push({ el: block, top, bottom, boxTop: r0.top - oy, boxBottom: r0.bottom - oy });
    end = Math.max(end, bottom);
  }
  range.detach();
  for (const w of words) boxes.push({ top: w.top, bottom: w.top + w.height });
  return { blocks, boxes, forced, words, links, images, end, origin: { x: ox, y: oy } };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** One page's picture: the blocks it shows, in an SVG <foreignObject>. */
function pageSvg(
  layout: Layout,
  m: Measured,
  slice: { x: number; top: number; bottom: number; width: number },
  view: { width: number; height: number; x: number; y: number },
  pixels: { width: number; height: number },
): string {
  const shown = m.blocks.map((b, i) => ({ ...b, i })).filter((b) => b.bottom > slice.top && b.top < slice.bottom);
  // Built as text from the laid-out nodes, without copying them into another
  // document: a copy's style attributes would be parsed again (and refused by
  // the CSP). Inside the SVG picture, a document of its own, they apply.
  const xml = new XMLSerializer();
  const css =
    `${layout.renderCss}\n` +
    `html{margin:0!important;padding:0!important;overflow:hidden!important;background:transparent!important}` +
    `body{position:relative!important;top:${-slice.top}px!important;left:${-slice.x}px!important;` +
    `width:${slice.width}px!important;margin:0!important}`;
  const src = layout.doc.body;
  const lang = layout.doc.documentElement.getAttribute("lang") ?? "fr";
  const bodyAttrs =
    (src.className ? ` class="${xmlEsc(src.className)}"` : "") +
    (src.style.cssText ? ` style="${xmlEsc(src.style.cssText)}"` : "");
  let content = "";
  if (shown.length) {
    const first = shown[0].i;
    if (first > 0) {
      // What comes before stands in as one block ending where the previous one
      // did, with the margin that separated them (which then collapses the same).
      const prev = m.blocks[first - 1];
      const gap = m.blocks[first].boxTop - prev.boxBottom;
      const height = Math.max(0, gap >= 0 ? prev.boxBottom : m.blocks[first].boxTop);
      content += `<div style="display:block;height:${height}px;margin:0 0 ${Math.max(0, gap)}px 0;padding:0;border:0"></div>`;
    }
    const last = shown[shown.length - 1].i;
    for (let i = first; i <= last; i++) content += xml.serializeToString(m.blocks[i].el);
  }
  const page =
    `<html xmlns="${XHTML}" lang="${xmlEsc(lang)}"><head><style>${xmlEsc(css)}</style></head>` +
    `<body${bodyAttrs}>${content}</body></html>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pixels.width}" height="${pixels.height}" ` +
    `viewBox="0 0 ${view.width} ${view.height}">` +
    `<foreignObject x="${view.x}" y="${view.y}" width="${slice.width}" height="${slice.bottom - slice.top}">` +
    // Characters XML does not allow would make the whole picture unreadable.
    page.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "") +
    `</foreignObject></svg>`
  );
}

const xmlEsc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

async function rasterise(svg: string, width: number, height: number, jpeg: boolean): Promise<RenderedPage["image"]> {
  const img = new Image();
  img.decoding = "sync";
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try {
    await img.decode();
  } catch {
    throw new Error("La page n'a pas pu être dessinée (contenu illisible par le navigateur).");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Dessin impossible : pas de contexte 2D.");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  let blob: Blob | null;
  try {
    blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, jpeg ? "image/jpeg" : "image/png", 0.92));
  } catch {
    // Browsers that treat any SVG <foreignObject> as foreign content (Safari).
    throw new Error("Ce navigateur ne permet pas de dessiner les pages : utilisez Chrome, Edge ou Firefox.");
  }
  if (!blob) throw new Error("La page n'a pas pu être enregistrée en image.");
  canvas.width = canvas.height = 0;
  return { bytes: new Uint8Array(await blob.arrayBuffer()), type: jpeg ? "jpeg" : "png" };
}

interface PagePlan {
  /** Layout area shown (CSS px, from the body's origin). */
  slice: { x: number; top: number; bottom: number; width: number };
  /** Page size (points), and the area's offset on it (CSS px of the page). */
  width: number;
  height: number;
  offset: { x: number; y: number };
  /** Points per layout pixel. */
  k: number;
}

function wordsOn(m: Measured, p: PagePlan): WordBox[] {
  const out: WordBox[] = [];
  for (const w of m.words) {
    const cy = w.top + w.height / 2;
    if (cy < p.slice.top || cy >= p.slice.bottom) continue;
    const cx = w.left + w.width / 2;
    if (cx < p.slice.x || cx > p.slice.x + p.slice.width) continue;
    out.push({
      text: w.text,
      x: (w.left - p.slice.x + p.offset.x) * p.k,
      y: (w.top - p.slice.top + p.offset.y) * p.k,
      w: w.width * p.k,
      h: w.height * p.k,
      fontSize: w.fontSize * p.k,
    });
  }
  return out;
}

function linksOn(layout: Layout, m: Measured, plans: PagePlan[], index: number): LinkBox[] {
  const p = plans[index];
  const out: LinkBox[] = [];
  const pageOf = (y: number) => {
    const i = plans.findIndex((q) => y >= q.slice.top && y < q.slice.bottom);
    return i < 0 ? (y < plans[0].slice.top ? 0 : plans.length - 1) : i;
  };
  for (const l of m.links) {
    const cy = l.rect.top + l.rect.height / 2;
    if (pageOf(cy) !== index) continue;
    const box = {
      x: (l.rect.left - p.slice.x + p.offset.x) * p.k,
      y: (l.rect.top - p.slice.top + p.offset.y) * p.k,
      w: l.rect.width * p.k,
      h: l.rect.height * p.k,
    };
    const href = l.href.trim();
    if (/^(https?:|mailto:|tel:)/i.test(href)) {
      out.push({ ...box, uri: href });
    } else if (href.startsWith("#") && href.length > 1) {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {
        /* keep it as written */
      }
      const target = layout.doc.getElementById(id) ?? layout.doc.getElementsByName(id)[0];
      if (!target) continue;
      const ty = target.getBoundingClientRect().top - m.origin.y;
      const tp = pageOf(ty);
      const q = plans[tp];
      out.push({ ...box, dest: { page: tp, y: Math.max(0, (ty - q.slice.top + q.offset.y) * q.k) } });
    }
  }
  return out;
}

/**
 * Lay out an HTML source, split it into pages and draw each one. Returns the
 * pages with their words and links, ready for `assemblePdf`.
 */
export async function renderHtmlSource(src: HtmlSource, opts: RenderOptions = {}): Promise<RenderedPage[]> {
  const dpi = Math.max(72, Math.min(300, opts.dpi ?? 150));
  const content = contentBoxPx(src.page);
  const fixed = src.layout === "fixed";
  const layout = await mountLayout(src, fixed ? FIXED_FRAME_WIDTH : content.width, content.height);
  try {
    if (opts.signal?.aborted) throw new RenderCancelled();
    const doc = layout.doc;
    // Wide tables (sheets) scaled down to the page width.
    if (!fixed) {
      for (const el of doc.querySelectorAll<HTMLElement>(`.${FIT_WIDTH_CLASS}`)) {
        const w = el.scrollWidth;
        if (w > content.width + 1) el.style.zoom = String(Math.max(0.2, content.width / w));
      }
    }
    const m = measure(layout, content.height);
    const plans: PagePlan[] = [];
    if (fixed) {
      for (const el of doc.querySelectorAll<HTMLElement>(`.${FIXED_PAGE_CLASS}`)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;
        const k = src.page.width / r.width;
        plans.push({
          slice: { x: r.left - m.origin.x, top: r.top - m.origin.y, bottom: r.bottom - m.origin.y, width: r.width },
          width: src.page.width,
          height: r.height * k,
          offset: { x: 0, y: 0 },
          k,
        });
      }
    } else {
      const slices = planPageSlices({ end: m.end, pageHeight: content.height, boxes: m.boxes, forced: m.forced });
      const k = 1 / PX_PER_PT;
      for (const s of slices)
        plans.push({
          slice: { x: 0, top: s.top, bottom: s.bottom, width: content.width },
          width: src.page.width,
          height: src.page.height,
          offset: { x: src.page.margin.left * PX_PER_PT, y: src.page.margin.top * PX_PER_PT },
          k,
        });
    }
    const pages: RenderedPage[] = [];
    for (let i = 0; i < plans.length; i++) {
      if (opts.signal?.aborted) throw new RenderCancelled();
      opts.onProgress?.(i, plans.length);
      const p = plans[i];
      const scale = Math.min(dpi / 72, Math.sqrt(MAX_PIXELS / Math.max(1, p.width * p.height)));
      const pixels = {
        width: Math.max(1, Math.round(p.width * scale)),
        height: Math.max(1, Math.round(p.height * scale)),
      };
      const view = { width: p.width / p.k, height: p.height / p.k, x: p.offset.x, y: p.offset.y };
      const svg = pageSvg(layout, m, p.slice, view, pixels);
      const photo = m.images.some((b) => b.bottom > p.slice.top && b.top < p.slice.bottom);
      const image = await rasterise(svg, pixels.width, pixels.height, photo);
      pages.push({
        width: p.width,
        height: p.height,
        image,
        words: wordsOn(m, p),
        links: linksOn(layout, m, plans, i),
      });
    }
    opts.onProgress?.(plans.length, plans.length);
    return pages;
  } finally {
    layout.dispose();
  }
}
