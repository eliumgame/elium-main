/**
 * Bake an edited PDF with pdf-lib: apply the page order (reorder / delete /
 * duplicate / insert-blank) and draw every overlay annotation into a fresh,
 * real .pdf. Coordinates are stored top-left at scale 1, converted here to
 * pdf-lib's bottom-left space (y → pageHeight − y). Targets unrotated pages.
 */
import { PDFDocument, rgb, degrees, type PDFPage, type PDFFont, type PDFImage } from "pdf-lib";
import type { Anno, PageRef, EditedText } from "./model";
import { HIGHLIGHT_COLOR, WHITEOUT_COLOR, newId } from "./model";
import { embedFont } from "./fonts";

/**
 * Turn each *changed* edited line into a white cover over the original + a text
 * annotation with the new text at the same baseline. Reuses the annotation
 * pipeline so editing existing text needs no special bake path.
 */
function editsToAnnos(edits: EditedText[] | undefined): Anno[] {
  const out: Anno[] = [];
  for (const e of edits ?? []) {
    if (e.text === e.original) continue;
    out.push({ id: newId("an"), type: "whiteout", x: e.x, y: e.y, w: e.w, h: e.h + 2, color: "#ffffff", strokeWidth: 0, fontSize: 0 });
    out.push({ id: newId("an"), type: "text", x: e.x, y: e.y, w: e.w, h: e.h, color: e.color ?? "#000000", strokeWidth: 0, fontSize: e.fontSize, text: e.text, fontFamily: e.fontFamily, bold: e.bold, italic: e.italic });
  }
  return out;
}

const A4: [number, number] = [595.28, 841.89];

function col(hex: string) {
  const h = hex.replace("#", "");
  const s = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(s, 16) || 0;
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/** Map common non-WinAnsi punctuation so Helvetica can encode the text. */
function winAnsi(s: string): string {
  return s
    .replace(/[‘’‚]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    // drop anything outside Latin-1 so embedFont(Helvetica) never throws
    .replace(/[^\x00-\xFF]/g, "");
}

async function drawAnno(page: PDFPage, a: Anno, H: number, fontCache: Map<string, PDFFont>, imgCache: Map<string, PDFImage>, doc: PDFDocument) {
  const color = col(a.color);
  if (a.type === "text") {
    const size = a.fontSize || 16;
    const lineH = size * 1.2;
    const { font, unicode } = await embedFont(doc, fontCache, a.fontFamily, a.bold, a.italic);
    // Imported fonts cover full Unicode; standard fonts are WinAnsi-only.
    const lines = (unicode ? (a.text || "") : winAnsi(a.text || "")).split("\n");
    lines.forEach((line, i) => {
      const y = H - a.y - size - i * lineH;
      page.drawText(line, { x: a.x, y, size, font, color });
      if (a.underline && line) {
        let w = 0;
        try { w = font.widthOfTextAtSize(line, size); } catch { w = line.length * size * 0.5; }
        page.drawLine({ start: { x: a.x, y: y - size * 0.12 }, end: { x: a.x + w, y: y - size * 0.12 }, thickness: Math.max(0.5, size / 16), color });
      }
    });
    return;
  }
  if (a.type === "rect") {
    page.drawRectangle({ x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, borderColor: color, borderWidth: a.strokeWidth, opacity: 0 });
    return;
  }
  if (a.type === "ellipse") {
    page.drawEllipse({ x: a.x + a.w / 2, y: H - a.y - a.h / 2, xScale: a.w / 2, yScale: a.h / 2, borderColor: color, borderWidth: a.strokeWidth, opacity: 0 });
    return;
  }
  if (a.type === "line") {
    page.drawLine({ start: { x: a.x, y: H - a.y }, end: { x: a.x + a.w, y: H - a.y - a.h }, thickness: a.strokeWidth, color });
    return;
  }
  if (a.type === "highlight" || a.type === "whiteout") {
    const fill = a.type === "highlight" ? HIGHLIGHT_COLOR : WHITEOUT_COLOR;
    page.drawRectangle({ x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, color: col(fill), opacity: a.type === "highlight" ? 0.4 : 1 });
    return;
  }
  if (a.type === "draw" && a.points && a.points.length > 1) {
    for (let i = 1; i < a.points.length; i++) {
      const p0 = a.points[i - 1], p1 = a.points[i];
      page.drawLine({ start: { x: p0.x, y: H - p0.y }, end: { x: p1.x, y: H - p1.y }, thickness: a.strokeWidth, color });
    }
    return;
  }
  if (a.type === "image" && a.src) {
    let img = imgCache.get(a.src);
    if (!img) {
      const bytes = Uint8Array.from(atob(a.src.split(",")[1] || ""), (c) => c.charCodeAt(0));
      img = a.src.includes("image/png") ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      imgCache.set(a.src, img);
    }
    page.drawImage(img, { x: a.x, y: H - a.y - a.h, width: a.w, height: a.h });
  }
}

export async function buildEditedPdf(
  originalBytes: Uint8Array,
  pages: PageRef[],
  annosByPage: Record<string, Anno[]>,
  textEditsByPage: Record<string, EditedText[]> = {},
): Promise<Uint8Array> {
  const src = await PDFDocument.load(originalBytes);
  const out = await PDFDocument.create();
  const fontCache = new Map<string, PDFFont>();
  const imgCache = new Map<string, PDFImage>();
  const srcSize = src.getPageCount() ? src.getPage(0).getSize() : { width: A4[0], height: A4[1] };

  for (const pr of pages) {
    let page: PDFPage;
    if (pr.from == null) {
      page = out.addPage([srcSize.width, srcSize.height]);
    } else {
      const [copied] = await out.copyPages(src, [pr.from]);
      page = out.addPage(copied);
    }
    const H = page.getHeight();
    // Edited original-text lines first (cover), then user annotations on top.
    const pageAnnos = [...editsToAnnos(textEditsByPage[pr.id]), ...(annosByPage[pr.id] ?? [])];
    for (const a of pageAnnos) {
      try { await drawAnno(page, a, H, fontCache, imgCache, out); } catch { /* skip a bad annotation rather than fail the whole save */ }
    }
    // User rotation rides on top of the page's own /Rotate. /Rotate rotates the
    // whole page (content + the annotations just drawn), so they stay attached.
    if (pr.rotate) page.setRotation(degrees((page.getRotation().angle + pr.rotate) % 360));
  }
  return out.save();
}
