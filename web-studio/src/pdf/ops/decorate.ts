/**
 * Page decoration applied at export time: watermarks, backgrounds,
 * headers/footers and Bates numbering — Acrobat's "Edit → Page marks" family.
 *
 * All of it is painted into the page content (that is what these are: content,
 * not markup), and all of it honours a page range so a cover page can be left
 * clean. Marks are laid out as the page is SEEN: on a page turned by /Rotate,
 * a header still runs along the top edge the reader sees, upright.
 *
 * Each mark is a marked-content sequence `/Artifact <</Type /Pagination
 * /Subtype …>>` (screen readers and text extraction skip it, as PDF/UA asks)
 * carrying `/EliumMark`, so a later session can remove it again
 * (`stripPageMarks`), along with the page marks Acrobat adds.
 */

import type { PDFDocument, PDFPage } from "pdf-lib";
import { PDFArray, PDFDict, PDFName, PDFStream } from "pdf-lib";
import { parseContentStream } from "../core/contentstream";
import type { Bates, HeaderFooter, Watermark } from "../model/types";
import type { PageFrame } from "./annots-pdf";
import { readPageContentBytes, writePageContent, xobjectDict } from "./content";
import type { FontBook } from "./fonts";
import { sanitiseForFont } from "./fonts";
import type { ImageBank } from "./images";
import { PageResources, Painter, hexToRgb, measure } from "./painter";
import { parsePageRange } from "./organize";

export interface DecorateContext {
  doc: PDFDocument;
  fonts: FontBook;
  images: ImageBank;
  /** Values available to header/footer tokens. */
  tokens: { title: string; author: string; filename: string; total: number };
}

/** The part of the document state the marks come from. */
export interface PageMarks {
  watermark: Watermark;
  header: HeaderFooter;
  footer: HeaderFooter;
  bates: Bates;
}

/** Substitute `{page}`, `{date}` and friends in a header/footer field. */
export function expandTokens(
  template: string,
  ctx: { page: number; total: number; title: string; author: string; filename: string; bates?: string; date?: Date },
): string {
  const d = ctx.date ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return template
    .replace(/\{page\}/gi, String(ctx.page))
    .replace(/\{pages\}/gi, String(ctx.total))
    .replace(/\{date\}/gi, `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`)
    .replace(/\{time\}/gi, `${pad(d.getHours())}:${pad(d.getMinutes())}`)
    .replace(/\{title\}/gi, ctx.title)
    .replace(/\{author\}/gi, ctx.author)
    .replace(/\{filename\}/gi, ctx.filename)
    .replace(/\{bates\}/gi, ctx.bates ?? "");
}

/** Format one Bates number. */
export function batesLabel(bates: Bates, sequence: number): string {
  return `${bates.prefix}${String(bates.start + sequence).padStart(Math.max(1, bates.digits), "0")}${bates.suffix}`;
}

/** Which pages (0-based) get which mark — worked out once per save. */
export interface MarksPlan {
  total: number;
  watermark: ReadonlySet<number>;
  header: ReadonlySet<number>;
  footer: ReadonlySet<number>;
  /** Bates number of each numbered page: the sequence runs over the range only. */
  bates: ReadonlyMap<number, string>;
}

export function planMarks(marks: PageMarks, total: number): MarksPlan {
  const pick = (enabled: boolean, spec: string | undefined): Set<number> =>
    enabled ? new Set(parsePageRange(spec ?? "", total)) : new Set();
  const numbered = [...pick(marks.bates.enabled, marks.bates.pages)].sort((a, b) => a - b);
  return {
    total,
    watermark: pick(marks.watermark.enabled, marks.watermark.pages),
    header: pick(marks.header.enabled, marks.header.pages),
    footer: pick(marks.footer.enabled, marks.footer.pages),
    bates: new Map(numbered.map((index, seq) => [index, batesLabel(marks.bates, seq)])),
  };
}

// ---------------------------------------------------------------------------
// The page as seen
// ---------------------------------------------------------------------------

/**
 * The crop box as the reader sees it: `w × h` with its origin at the bottom
 * left of the displayed page, and `cm`, the matrix from that space to the
 * page's own (the /Rotate turn plus the crop-box origin).
 */
export function seenSpace(page: PDFPage, frame: PageFrame): { w: number; h: number; cm: number[] } {
  const rot = (((page.getRotation().angle % 360) + 360) % 360) as number;
  const { x, y, width, height } = frame.box;
  const swap = rot % 180 !== 0;
  const w = swap ? height : width;
  const h = swap ? width : height;
  const t = (rot * Math.PI) / 180;
  const c = Math.round(Math.cos(t));
  const s = Math.round(Math.sin(t));
  // Where [0, w] × [0, h] lands under the turn; shifted onto the crop box.
  const xs = [0, w * c, -h * s, w * c - h * s];
  const ys = [0, w * s, h * c, w * s + h * c];
  return { w, h, cm: [c, s, -s, c, x - Math.min(...xs), y - Math.min(...ys)] };
}

type Subtype = "Watermark" | "Background" | "Header" | "Footer";

/** One mark as its own content stream: tagged, in the seen space, self-contained. */
function markStream(ctx: DecorateContext, subtype: Subtype, cm: number[], body: string) {
  const type = subtype === "Background" ? "/Type /Background" : `/Type /Pagination /Subtype /${subtype}`;
  const text =
    `/Artifact <<${type} /EliumMark /${subtype}>> BDC\nq\n` +
    `${cm.map((v) => +v.toFixed(4)).join(" ")} cm\n${body}\nQ\nEMC\n`;
  return ctx.doc.context.register(ctx.doc.context.flateStream(text));
}

/**
 * What the page draws is closed in `q … Q` first, so a mark drawn after it
 * starts from the default state (a page ending inside a `cm` or a clip would
 * otherwise move or hide it). Cheap: two tiny streams around the original ones.
 */
function isolate(ctx: DecorateContext, page: PDFPage): void {
  const open = ctx.doc.context.register(ctx.doc.context.stream("q\n"));
  const close = ctx.doc.context.register(ctx.doc.context.stream("\nQ\n"));
  page.node.addContentStream(close);
  const contents = page.node.Contents();
  if (contents instanceof PDFArray) contents.insert(0, open);
}

/** Put a content stream *before* the page's own content (backgrounds). */
function prepend(page: PDFPage, ref: ReturnType<PDFDocument["context"]["register"]>): void {
  page.node.addContentStream(ref);
  const contents = page.node.Contents();
  if (contents instanceof PDFArray && contents.size() > 1) {
    contents.remove(contents.size() - 1);
    contents.insert(0, ref);
  }
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

function anchorFor(position: Watermark["position"], w: number, h: number, cw: number, ch: number, margin: number) {
  const cx = (w - cw) / 2;
  const cy = (h - ch) / 2;
  switch (position) {
    case "top":
      return { x: cx, y: h - ch - margin };
    case "bottom":
      return { x: cx, y: margin };
    case "topLeft":
      return { x: margin, y: h - ch - margin };
    case "topRight":
      return { x: w - cw - margin, y: h - ch - margin };
    case "bottomLeft":
      return { x: margin, y: margin };
    case "bottomRight":
      return { x: w - cw - margin, y: margin };
    default:
      return { x: cx, y: cy };
  }
}

async function paintWatermark(p: Painter, wm: Watermark, ctx: DecorateContext, W: number, H: number) {
  const margin = 28;
  let drew = false;
  p.save();
  if (wm.mode === "color") {
    p.alpha({ fillAlpha: wm.opacity, blend: "Normal" });
    p.fillColor(hexToRgb(wm.color)).rect(0, 0, W, H).fill();
    drew = true;
  } else if (wm.mode === "image" && wm.src) {
    p.alpha({ fillAlpha: wm.opacity, strokeAlpha: wm.opacity, blend: "Multiply" });
    const img = await ctx.images.get(wm.src);
    if (img) {
      const base = Math.min((W * 0.6) / img.width, (H * 0.6) / img.height);
      const scale = base * (wm.scale || 1);
      const iw = img.width * scale;
      const ih = img.height * scale;
      const at = anchorFor(wm.position, W, H, iw, ih, margin);
      if (wm.angle) p.rotateAbout(wm.angle, { x: at.x + iw / 2, y: at.y + ih / 2 });
      p.image(img, at.x, at.y, iw, ih);
      drew = true;
    }
  } else if (wm.text) {
    p.alpha({ fillAlpha: wm.opacity, strokeAlpha: wm.opacity, blend: "Multiply" });
    const { font, unicode } = await ctx.fonts.forText(wm.fontFamily, true, false, wm.text);
    const text = sanitiseForFont(wm.text, unicode);
    let size = (wm.fontSize || 56) * (wm.scale || 1);
    // Shrink so a long watermark still fits across the diagonal.
    const diagonal = Math.hypot(W, H) * 0.9;
    while (size > 6 && measure(font, text, size) > diagonal) size -= 1;
    const tw = measure(font, text, size);
    const at = anchorFor(wm.position, W, H, tw, size, margin);
    p.fillColor(hexToRgb(wm.color));
    if (wm.angle) p.rotateAbout(wm.angle, { x: at.x + tw / 2, y: at.y + size / 2 });
    p.text(font, size, { x: at.x, y: at.y }, text);
    drew = true;
  }
  p.restore();
  return drew;
}

async function paintBand(
  p: Painter,
  band: HeaderFooter,
  isHeader: boolean,
  ctx: DecorateContext,
  W: number,
  H: number,
  values: Parameters<typeof expandTokens>[1],
): Promise<boolean> {
  const cells: [string, "left" | "center" | "right"][] = [
    [expandTokens(band.left, values), "left"],
    [expandTokens(band.center, values), "center"],
    [expandTokens(band.right, values), "right"],
  ];
  if (cells.every(([t]) => !t.trim())) return false;
  const { font, unicode } = await ctx.fonts.forText(band.fontFamily, false, false, cells.map(([t]) => t).join(""));
  const size = band.fontSize || 9;
  const y = isHeader ? H - band.marginPt : band.marginPt - size * 0.2;
  p.save().fillColor(hexToRgb(band.color));
  for (const [raw, align] of cells) {
    const text = sanitiseForFont(raw, unicode);
    if (!text.trim()) continue;
    const w = measure(font, text, size);
    const x = align === "center" ? (W - w) / 2 : align === "right" ? W - band.marginPt - w : band.marginPt;
    p.text(font, size, { x, y }, text);
  }
  p.restore();
  return true;
}

const usesBates = (band: HeaderFooter) => [band.left, band.center, band.right].some((t) => /\{bates\}/i.test(t));

/**
 * Paint every mark `plan` gives page `index` (0-based among the written
 * pages). Returns whether anything was drawn.
 */
export async function decoratePage(
  page: PDFPage,
  frame: PageFrame,
  index: number,
  marks: PageMarks,
  plan: MarksPlan,
  ctx: DecorateContext,
): Promise<boolean> {
  const bates = plan.bates.get(index);
  const header = plan.header.has(index);
  const footer = plan.footer.has(index);
  const watermark = plan.watermark.has(index);
  if (!bates && !header && !footer && !watermark) return false;

  const { w: W, h: H, cm } = seenSpace(page, frame);
  const res = new PageResources(page);
  const behind: ReturnType<typeof markStream>[] = [];
  const front: ReturnType<typeof markStream>[] = [];

  if (watermark) {
    const p = new Painter(res);
    if (await paintWatermark(p, marks.watermark, ctx, W, H)) {
      const back = marks.watermark.mode === "color" || marks.watermark.behind;
      const ref = markStream(ctx, marks.watermark.mode === "color" ? "Background" : "Watermark", cm, p.toString());
      (back ? behind : front).push(ref);
    }
  }
  const values = (band: HeaderFooter) => ({
    page: index + (Number.isFinite(band.startPage) ? band.startPage! : 1),
    total: plan.total,
    title: ctx.tokens.title,
    author: ctx.tokens.author,
    filename: ctx.tokens.filename,
    bates,
  });
  let batesPlaced = false;
  for (const [on, band, isHeader] of [
    [header, marks.header, true],
    [footer, marks.footer, false],
  ] as const) {
    if (!on) continue;
    const p = new Painter(res);
    if (await paintBand(p, band, isHeader, ctx, W, H, values(band))) {
      front.push(markStream(ctx, isHeader ? "Header" : "Footer", cm, p.toString()));
      if (usesBates(band)) batesPlaced = true;
    }
  }
  // Numbering asked for but placed by neither band: its own stamp, bottom right.
  if (bates && !batesPlaced) {
    const { font, unicode } = await ctx.fonts.forText(undefined, true, false, bates);
    const p = new Painter(res);
    const size = 9;
    const text = sanitiseForFont(bates, unicode);
    p.save().fillColor({ r: 0.15, g: 0.18, b: 0.24 });
    p.text(font, size, { x: W - 24 - measure(font, text, size), y: 18 }, text);
    p.restore();
    front.push(markStream(ctx, "Footer", cm, p.toString()));
  }

  if (!behind.length && !front.length) return false;
  if (front.length) {
    isolate(ctx, page);
    for (const ref of front) page.node.addContentStream(ref);
  }
  for (const ref of behind.reverse()) prepend(page, ref);
  return true;
}

// ---------------------------------------------------------------------------
// Removing marks
// ---------------------------------------------------------------------------

const MARK_KINDS = new Set(["Watermark", "Background", "Header", "Footer"]);

/** Acrobat's page-mark XObject: `/PieceInfo /ADBE_CompoundType /Private /Watermark` (or Header…). */
function isAcrobatMark(page: PDFPage, name: string): boolean {
  const dict = xobjectDict(page, name);
  const info = dict?.lookup(PDFName.of("PieceInfo"));
  const compound = info instanceof PDFDict ? info.lookup(PDFName.of("ADBE_CompoundType")) : undefined;
  const priv = compound instanceof PDFDict ? compound.lookup(PDFName.of("Private")) : undefined;
  return priv instanceof PDFName && MARK_KINDS.has(priv.asString().replace(/^\//, ""));
}

/**
 * Remove the page marks already painted into `page`: Elium's (`/EliumMark`)
 * and Acrobat's (the marked-content sequence around one of its compound
 * XObjects). Other artifacts — a word processor's running headers — are the
 * document's own text and stay. Returns how many marks went.
 */
export function stripPageMarks(doc: PDFDocument, page: PDFPage): number {
  const bytes = readPageContentBytes(page);
  // Cheap test before a full parse: no mark can be there.
  const text = new TextDecoder("latin1").decode(bytes);
  if (!/EliumMark|\bDo\b/.test(text)) return 0;
  const ops = parseContentStream(bytes);

  const drop = new Set<number>();
  const open: { at: number; elium: boolean; artifact: boolean }[] = [];
  let removed = 0;
  for (let i = 0; i < ops.length; i++) {
    const { op, args } = ops[i];
    if (op === "BDC" || op === "BMC") {
      const props = op === "BDC" ? args[1] : undefined;
      const tag = args[0];
      open.push({
        at: i,
        elium: props?.t === "dict" && props.v.has("EliumMark"),
        artifact: tag?.t === "name" && tag.v === "Artifact",
      });
    } else if (op === "EMC") {
      const seq = open.pop();
      if (!seq) continue;
      // Acrobat's: an /Artifact sequence around one of its mark XObjects (an
      // outer /Span or /P holding one stays: only the inner one goes).
      let acrobat = false;
      if (!seq.elium && seq.artifact) {
        for (let j = seq.at + 1; j < i && !acrobat; j++) {
          if (drop.has(j)) continue;
          const a = ops[j].args[0];
          acrobat = ops[j].op === "Do" && a?.t === "name" && isAcrobatMark(page, a.v);
        }
      }
      if (seq.elium || acrobat) {
        for (let j = seq.at; j <= i; j++) drop.add(j);
        removed++;
      }
    }
  }
  // An Acrobat mark drawn without its marked-content wrapper.
  for (let i = 0; i < ops.length; i++) {
    const a = ops[i].args[0];
    if (!drop.has(i) && ops[i].op === "Do" && a?.t === "name" && isAcrobatMark(page, a.v)) {
      drop.add(i);
      removed++;
    }
  }
  if (!removed) return 0;
  writePageContent(
    doc,
    page,
    ops.filter((_, i) => !drop.has(i)),
  );
  // Acrobat's mark objects, no longer drawn by the page.
  const xo = page.node.Resources()?.lookup(PDFName.of("XObject"));
  if (xo instanceof PDFDict) {
    for (const key of xo.keys()) if (isAcrobatMark(page, key.asString().replace(/^\//, ""))) xo.delete(key);
  }
  // Acrobat's record that the page carries marks, now stale.
  const info = page.node.lookup(PDFName.of("PieceInfo"));
  if (info instanceof PDFDict) {
    info.delete(PDFName.of("ADBE_CompoundType"));
    if (!info.keys().length) page.node.delete(PDFName.of("PieceInfo"));
  }
  return removed;
}

/** True when some page of `doc` carries marks `stripPageMarks` would remove. */
export function hasPageMarks(doc: PDFDocument): boolean {
  for (const page of doc.getPages()) {
    const text = new TextDecoder("latin1").decode(readPageContentBytes(page));
    if (text.includes("EliumMark")) return true;
    const xo = page.node.Resources()?.lookup(PDFName.of("XObject"));
    if (!(xo instanceof PDFDict)) continue;
    for (const key of xo.keys()) {
      if (xo.lookup(key) instanceof PDFStream && isAcrobatMark(page, key.asString().replace(/^\//, ""))) return true;
    }
  }
  return false;
}
