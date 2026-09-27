/**
 * « Rapport PDF » of a comparison, as Acrobat's « Comparer des fichiers »
 * report: a cover sheet (the two files, the date, the totals), then one sheet
 * per changed page — the original and the revised page side by side with the
 * changes highlighted and numbered, and the numbered list of changes beside
 * them (going on, text only, on further sheets when long).
 *
 * The page pictures come from an injected function (the browser draws them
 * through pdf.js — `canvasPictures`); without one, each page is an outlined
 * frame of its size, the highlights still in place.
 */

import type { PDFFont, PDFPage, RGB } from "pdf-lib";
import type { Rect, Size } from "../core/coords";
import type { PdfEngine } from "../core/engine";
import { DIFF_LABEL, describeItem, pageTitle, type DetailedPage, type DetailedReport, type DiffItem } from "./compare";
import { FontBook, sanitiseForFont } from "./fonts";
import { measure, wrapText } from "./painter";

/** PNG (or JPEG) bytes of page `pageIndex` (0-based) of one side, unrotated; null = no picture. */
export type PagePicture = (side: "left" | "right", pageIndex: number) => Promise<Uint8Array | null>;

export interface CompareReportOptions {
  leftName: string;
  rightName: string;
  /** Date shown on the cover (default: now). */
  date?: Date;
  picture?: PagePicture;
  onProgress?: (done: number, total: number) => void;
}

const SHEET = { w: 842, h: 595 };
const MARGIN = 24;
const BOX_TOP = SHEET.h - MARGIN - 34;
const BOX_BOTTOM = MARGIN + 16;
const BOXES = {
  left: { x: MARGIN, w: 262 },
  right: { x: MARGIN + 274, w: 262 },
};
const LIST = { x: 584, w: SHEET.w - 584 - MARGIN, top: SHEET.h - MARGIN - 30, bottom: MARGIN + 14 };
const A4: Size = { w: 595, h: 842 };

/** Highlight colours: removed (left), added (right), formatting, pictures, whole pages. */
const TONE = {
  removed: [0.86, 0.15, 0.15],
  added: [0.08, 0.6, 0.25],
  format: [0.15, 0.39, 0.92],
  image: [0.92, 0.45, 0.05],
  page: [0.45, 0.35, 0.8],
} as const;

/** Colour of an item's boxes on one side. */
export function toneOf(it: DiffItem, side: "left" | "right"): keyof typeof TONE {
  if (it.category === "format") return "format";
  if (it.category === "image") return "image";
  if (it.category === "page") return it.kind === "added" ? "added" : it.kind === "removed" ? "removed" : "page";
  return side === "left" ? "removed" : "added";
}

function when(d: Date): string {
  return `${d.toLocaleDateString("fr-FR")} ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;

/** Pages that go into the report: every page with something to say. */
export function reportedPages(report: DetailedReport): DetailedPage[] {
  return report.pages.filter((p) => p.status !== "unchanged" || p.moved || p.items.length);
}

export async function buildCompareReport(report: DetailedReport, opts: CompareReportOptions): Promise<Uint8Array> {
  const { PDFDocument, rgb } = await import("pdf-lib");
  const out = await PDFDocument.create();
  out.setTitle(`Comparaison — ${opts.leftName} / ${opts.rightName}`);
  out.setProducer("Elium");
  const fonts = new FontBook(out);
  const face = async (text: string, bold = false): Promise<{ font: PDFFont; text: string }> => {
    const f = await fonts.forText("Helvetica", bold, false, text);
    return { font: f.font, text: sanitiseForFont(text, f.unicode) };
  };
  const tone = (k: keyof typeof TONE): RGB => rgb(...(TONE[k] as unknown as [number, number, number]));
  const muted = rgb(0.4, 0.4, 0.45);
  const ink = rgb(0.12, 0.12, 0.15);
  let sheets = 0;

  const text = async (sheet: PDFPage, s: string, x: number, y: number, size: number, bold = false, color = ink) => {
    const f = await face(s, bold);
    sheet.drawText(f.text, { x, y, size, font: f.font, color });
  };
  const footer = async (sheet: PDFPage) => {
    sheets++;
    const foot = await face(`Rapport de comparaison — ${sheets}`);
    sheet.drawText(foot.text, {
      x: SHEET.w - MARGIN - measure(foot.font, foot.text, 8),
      y: MARGIN - 8,
      size: 8,
      font: foot.font,
      color: rgb(0.45, 0.45, 0.5),
    });
  };

  // -- Cover --------------------------------------------------------------
  const cover = out.addPage([SHEET.w, SHEET.h]);
  let y = SHEET.h - 80;
  await text(cover, "Rapport de comparaison", 60, y, 24, true);
  y -= 40;
  await text(cover, "Document d'origine", 60, y, 9, false, muted);
  await text(cover, opts.leftName, 200, y, 11, true);
  y -= 20;
  await text(cover, "Document révisé", 60, y, 9, false, muted);
  await text(cover, opts.rightName, 200, y, 11, true);
  y -= 20;
  await text(cover, "Date", 60, y, 9, false, muted);
  await text(cover, when(opts.date ?? new Date()), 200, y, 11);
  y -= 44;
  const totals: [string, number, keyof typeof TONE][] = [
    ["Pages modifiées", report.pagesModified, "page"],
    ["Pages ajoutées", report.pagesAdded, "added"],
    ["Pages supprimées", report.pagesRemoved, "removed"],
    ["Pages déplacées", report.pagesMoved, "page"],
    ["Mots ajoutés", report.wordsAdded, "added"],
    ["Mots supprimés", report.wordsRemoved, "removed"],
    ["Changements de mise en forme", report.formatChanges, "format"],
    ["Images / dessins modifiés", report.imageChanges, "image"],
  ];
  const colW = 176;
  for (const [k, [label, n, t]] of totals.entries()) {
    const x = 60 + (k % 4) * colW;
    const yy = y - Math.floor(k / 4) * 62;
    cover.drawRectangle({ x, y: yy - 42, width: colW - 12, height: 52, color: rgb(0.96, 0.96, 0.97) });
    cover.drawRectangle({ x, y: yy - 42, width: 3, height: 52, color: tone(t) });
    await text(cover, String(n), x + 14, yy - 14, 20, true);
    await text(cover, label, x + 14, yy - 32, 8.5, false, muted);
  }
  y -= 140;
  const changed = reportedPages(report);
  const lines: string[] = [];
  lines.push(`Similarité du texte : ${Math.round(report.similarity * 100)} %.`);
  if (!report.visual && report.pagesWithoutText)
    lines.push(`${report.pagesWithoutText} page(s) sans texte n'ont pas pu être comparées.`);
  else if (report.visual) lines.push("Les images et dessins ont été comparés visuellement (100 dpi).");
  lines.push(
    changed.length
      ? `${changed.length} page(s) présentent des différences : détail sur les pages suivantes.`
      : "Aucune différence trouvée entre les deux documents.",
  );
  for (const l of lines) {
    await text(cover, l, 60, y, 10);
    y -= 16;
  }
  const legend: [string, keyof typeof TONE][] = [
    ["Supprimé (original)", "removed"],
    ["Ajouté (révisé)", "added"],
    ["Mise en forme", "format"],
    ["Image / dessin", "image"],
  ];
  y -= 10;
  let lx = 60;
  for (const [label, t] of legend) {
    cover.drawRectangle({
      x: lx,
      y: y - 2,
      width: 10,
      height: 10,
      color: tone(t),
      opacity: 0.35,
      borderColor: tone(t),
    });
    await text(cover, label, lx + 15, y, 9);
    lx += 150;
  }
  await footer(cover);

  // -- One sheet per changed page -------------------------------------------
  for (const [n, pg] of changed.entries()) {
    const sheet = out.addPage([SHEET.w, SHEET.h]);
    await text(sheet, pageTitle(pg), MARGIN, SHEET.h - MARGIN - 8, 12, true);
    await footer(sheet);
    const numbered = pg.items.map((it, k) => ({ it, num: k + 1 }));

    for (const side of ["left", "right"] as const) {
      const box = BOXES[side];
      const index = side === "left" ? pg.leftPage : pg.rightPage;
      await text(
        sheet,
        side === "left" ? `Original${index ? ` — page ${index}` : ""}` : `Révisé${index ? ` — page ${index}` : ""}`,
        box.x,
        BOX_TOP + 8,
        8.5,
        true,
        muted,
      );
      if (index === null) {
        await text(sheet, "(pas de page correspondante)", box.x + 10, BOX_TOP - 20, 9, false, muted);
        continue;
      }
      const size = (side === "left" ? pg.leftSize : pg.rightSize) ?? A4;
      const s = Math.min(box.w / size.w, (BOX_TOP - BOX_BOTTOM) / size.h);
      const w = size.w * s;
      const h = size.h * s;
      const ox = box.x + (box.w - w) / 2;
      const oy = BOX_TOP - h;
      const bytes = await opts.picture?.(side, index - 1).catch(() => null);
      if (bytes && (isPng(bytes) || isJpeg(bytes))) {
        const img = isPng(bytes) ? await out.embedPng(bytes) : await out.embedJpg(bytes);
        sheet.drawImage(img, { x: ox, y: oy, width: w, height: h });
      } else {
        sheet.drawRectangle({ x: ox, y: oy, width: w, height: h, color: rgb(0.985, 0.985, 0.99) });
      }
      const wholePage = pg.status === "added" || pg.status === "removed";
      sheet.drawRectangle({
        x: ox,
        y: oy,
        width: w,
        height: h,
        borderColor: wholePage ? tone(pg.status === "added" ? "added" : "removed") : rgb(0.7, 0.7, 0.75),
        borderWidth: wholePage ? 2 : 0.6,
      });
      const toSheet = (r: Rect) => ({
        x: ox + r.x * s,
        y: oy + (size.h - r.y - r.h) * s,
        width: r.w * s,
        height: r.h * s,
      });
      for (const { it, num } of numbered) {
        const rects = side === "left" ? it.leftRects : it.rightRects;
        if (!rects.length) continue;
        const c = tone(toneOf(it, side));
        for (const r of rects) {
          const q = toSheet(r);
          sheet.drawRectangle({
            ...q,
            width: Math.max(q.width, 1.5),
            height: Math.max(q.height, 1.5),
            color: c,
            opacity: 0.25,
            borderColor: c,
            borderWidth: 0.5,
          });
        }
        const first = toSheet(rects[0]);
        const label = await face(String(num), true);
        const lw = measure(label.font, label.text, 5.5) + 3;
        const bx = Math.max(ox, first.x - lw - 1);
        const by = first.y + first.height - 6;
        sheet.drawRectangle({ x: bx, y: by, width: lw, height: 6.5, color: c });
        sheet.drawText(label.text, { x: bx + 1.5, y: by + 1.3, size: 5.5, font: label.font, color: rgb(1, 1, 1) });
      }
    }

    // The list of changes, beside the pages then on further sheets.
    let at = LIST.top;
    let page = sheet;
    let cont = 0;
    const room = async (need: number) => {
      if (at - need >= LIST.bottom) return;
      page = out.addPage([SHEET.w, SHEET.h]);
      cont++;
      await text(page, `${pageTitle(pg)} (suite)`, MARGIN, SHEET.h - MARGIN - 8, 12, true);
      await footer(page);
      at = LIST.top;
    };
    // Continuation sheets have the whole width.
    const listX = () => (cont ? MARGIN : LIST.x);
    const listW = () => (cont ? SHEET.w - 2 * MARGIN : LIST.w);
    await text(page, `Modifications (${pg.items.length})`, LIST.x, at, 10, true);
    at -= 16;
    for (const { it, num } of numbered) {
      await room(24);
      const c = tone(toneOf(it, it.category === "text" && it.kind === "delete" ? "left" : "right"));
      page.drawRectangle({ x: listX(), y: at - 2, width: 12, height: 9, color: c });
      const nb = await face(String(num), true);
      page.drawText(nb.text, {
        x: listX() + 6 - measure(nb.font, nb.text, 6.5) / 2,
        y: at,
        size: 6.5,
        font: nb.font,
        color: rgb(1, 1, 1),
      });
      await text(page, DIFF_LABEL[it.kind], listX() + 16, at, 8.5, true);
      at -= 12;
      const body = await face(describeItem(it));
      for (const part of wrapText(body.font, body.text, 8, listW() - 16).slice(0, 12)) {
        await room(11);
        page.drawText(part, { x: listX() + 16, y: at, size: 8, font: body.font, color: ink });
        at -= 10.5;
      }
      at -= 5;
    }
    opts.onProgress?.(n + 1, changed.length);
  }
  return out.save();
}

/**
 * The browser pictures for the report: each page drawn by pdf.js into a
 * detached canvas (unrotated, as the highlights are in page space), as PNG.
 */
export function canvasPictures(left: PdfEngine, right: PdfEngine, dpi = 110): PagePicture {
  return async (side, pageIndex) => {
    const { renderToCanvas, canvasToBlob } = await import("../core/render");
    const engine = side === "left" ? left : right;
    const canvas = await renderToCanvas(await engine.page(pageIndex), {
      scale: dpi / 72,
      rotation: 0,
      background: "#ffffff",
    });
    try {
      return new Uint8Array(await (await canvasToBlob(canvas, "image/png")).arrayBuffer());
    } finally {
      canvas.width = canvas.height = 0;
      engine.releasePageResources(pageIndex);
    }
  };
}
