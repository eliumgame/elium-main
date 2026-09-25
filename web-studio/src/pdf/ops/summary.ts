/**
 * « Résumer les commentaires », as Acrobat's « Document et commentaires avec
 * lignes de connexion sur des pages séparées »: every page that carries
 * comments, reduced on the left with a numbered marker at each comment, and
 * on the right the list — type, author, date, status, text, replies —, a thin
 * line joining each marker to its entry. A list too long for one sheet goes
 * on (text only) on the next.
 *
 * `rendered` is the document as it will print (comments flattened into the
 * pages, `buildPdf(…, { interactiveAnnots: false })`), so the reduced page
 * shows the markup the list talks about.
 */

import type { PDFFont, PDFPage } from "pdf-lib";
import { commentable, exportablePages } from "../model/doc";
import type { Annot, PdfState, ReviewStatus } from "../model/types";
import { FontBook, sanitiseForFont } from "./fonts";
import { measure, wrapText } from "./painter";

export interface SummaryOptions {
  title: string;
  /** « Type » labels, by kind (the pane's). */
  kindLabel: Record<string, string>;
}

const SHEET = { w: 842, h: 595 };
const MARGIN = 24;
const PAGE_BOX = { x: MARGIN, y: MARGIN + 18, w: 430, h: SHEET.h - 2 * MARGIN - 36 };
const LIST = { x: 480, w: SHEET.w - 480 - MARGIN, top: SHEET.h - MARGIN - 30, bottom: MARGIN + 14 };

const STATUS: Record<ReviewStatus, string> = {
  none: "",
  accepted: "Accepté",
  rejected: "Rejeté",
  cancelled: "Annulé",
  completed: "Terminé",
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.toLocaleDateString("fr-FR")} ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
}

export async function buildCommentSummary(
  rendered: Uint8Array,
  state: PdfState,
  opts: SummaryOptions,
): Promise<Uint8Array> {
  const lib = await import("pdf-lib");
  const { PDFDocument, rgb } = lib;
  const src = await PDFDocument.load(rendered, { ignoreEncryption: true, updateMetadata: false });
  const out = await PDFDocument.create();
  out.setTitle(`${opts.title} — synthèse des commentaires`);
  out.setProducer("Elium");
  const fonts = new FontBook(out);
  const face = async (text: string, bold = false): Promise<{ font: PDFFont; text: string }> => {
    const f = await fonts.forText("Helvetica", bold, false, text);
    return { font: f.font, text: sanitiseForFont(text, f.unicode) };
  };
  const color = (hex: string) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    const n = m ? parseInt(m[1], 16) : 0x1d4ed8;
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  };

  const pages = exportablePages(state);
  const listed = commentable(state.annots);
  const replacing = new Set(state.annots.filter((a) => a.group).map((a) => a.group!));
  let sheets = 0;

  const header = async (sheet: PDFPage, label: string) => {
    const h = await face(`${opts.title} — ${label}`, true);
    sheet.drawText(h.text, { x: MARGIN, y: SHEET.h - MARGIN - 8, size: 11, font: h.font, color: rgb(0.2, 0.2, 0.25) });
    sheets++;
    const foot = await face(`Synthèse des commentaires — ${sheets}`);
    sheet.drawText(foot.text, {
      x: SHEET.w - MARGIN - measure(foot.font, foot.text, 8),
      y: MARGIN - 8,
      size: 8,
      font: foot.font,
      color: rgb(0.45, 0.45, 0.5),
    });
  };

  for (const [index, model] of pages.entries()) {
    const mine = listed.filter((a) => a.pageId === model.id).sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
    if (!mine.length || index >= src.getPageCount()) continue;

    const page = src.getPage(index);
    const crop = page.getCropBox();
    const embedded = await out.embedPage(page, {
      left: crop.x,
      bottom: crop.y,
      right: crop.x + crop.width,
      top: crop.y + crop.height,
    });
    const scale = Math.min(PAGE_BOX.w / crop.width, PAGE_BOX.h / crop.height);
    const w = crop.width * scale;
    const h = crop.height * scale;
    const ox = PAGE_BOX.x + (PAGE_BOX.w - w) / 2;
    const oy = PAGE_BOX.y + (PAGE_BOX.h - h) / 2;

    let sheet = out.addPage([SHEET.w, SHEET.h]);
    const pageSheet = sheet;
    await header(sheet, `page ${index + 1}`);
    sheet.drawPage(embedded, { x: ox, y: oy, width: w, height: h });
    sheet.drawRectangle({ x: ox, y: oy, width: w, height: h, borderColor: rgb(0.7, 0.7, 0.75), borderWidth: 0.6 });

    let y = LIST.top;
    let first = true;
    for (const [n, a] of mine.entries()) {
      const num = String(n + 1);
      const entry = await entryLines(a, replacing.has(a.id));
      const need = 16 + entry.length * 11 + 6;
      if (!first && y - need < LIST.bottom) {
        sheet = out.addPage([SHEET.w, SHEET.h]);
        await header(sheet, `page ${index + 1} (suite)`);
        y = LIST.top;
      }
      first = false;

      // The marker on the reduced page, and its connector (on the page's own sheet).
      const mx = ox + (a.rect.x + Math.min(a.rect.w, 12) / 2) * scale;
      const my = oy + h - (a.rect.y + Math.min(a.rect.h, 12) / 2) * scale;
      if (sheet === pageSheet) {
        sheet.drawLine({
          start: { x: mx, y: my },
          end: { x: LIST.x - 6, y: y - 5 },
          thickness: 0.4,
          color: color(a.color),
          opacity: 0.7,
        });
        sheet.drawCircle({ x: mx, y: my, size: 6, color: rgb(1, 1, 1), borderColor: color(a.color), borderWidth: 1 });
        const small = await face(num, true);
        sheet.drawText(small.text, {
          x: mx - measure(small.font, small.text, 6.5) / 2,
          y: my - 2.3,
          size: 6.5,
          font: small.font,
          color: rgb(0.1, 0.1, 0.1),
        });
      }

      // The entry: number, type, author and date; status; text; replies.
      sheet.drawCircle({ x: LIST.x + 5, y: y - 4, size: 6, color: color(a.color) });
      const nb = await face(num, true);
      sheet.drawText(nb.text, {
        x: LIST.x + 5 - measure(nb.font, nb.text, 6.5) / 2,
        y: y - 6.3,
        size: 6.5,
        font: nb.font,
        color: rgb(1, 1, 1),
      });
      const title = await face(entry.title, true);
      sheet.drawText(title.text, { x: LIST.x + 16, y: y - 8, size: 9, font: title.font, color: rgb(0.1, 0.1, 0.15) });
      y -= 16;
      for (const line of entry) {
        const f = await face(line.text, line.bold);
        for (const part of wrapText(f.font, f.text, line.size, LIST.w - 16 - line.indent)) {
          if (y - 11 < LIST.bottom) {
            sheet = out.addPage([SHEET.w, SHEET.h]);
            await header(sheet, `page ${index + 1} (suite)`);
            y = LIST.top;
          }
          sheet.drawText(part, {
            x: LIST.x + 16 + line.indent,
            y: y - 8,
            size: line.size,
            font: f.font,
            color: line.muted ? rgb(0.4, 0.4, 0.45) : rgb(0.12, 0.12, 0.15),
          });
          y -= 11;
        }
      }
      y -= 6;
    }
  }

  if (!sheets) {
    const sheet = out.addPage([SHEET.w, SHEET.h]);
    await header(sheet, "aucun commentaire");
    const t = await face("Ce document ne contient aucun commentaire.");
    sheet.drawText(t.text, { x: MARGIN, y: SHEET.h / 2, size: 12, font: t.font });
  }
  return out.save();

  async function entryLines(a: Annot, isReplace: boolean) {
    const kind = isReplace ? "Remplacement de texte" : (opts.kindLabel[a.kind] ?? a.kind);
    const lines: { text: string; size: number; bold?: boolean; indent: number; muted?: boolean }[] = [];
    const status = STATUS[a.status ?? "none"];
    const meta = [a.author, when(a.createdAt), status, a.checked ? "coché" : ""].filter(Boolean).join(" · ");
    lines.push({ text: meta, size: 7.5, indent: 0, muted: true });
    const body = a.contents || a.text || "";
    if (a.kind === "caret" && body)
      lines.push({ text: isReplace ? `Remplacer par : « ${body} »` : `Insérer : « ${body} »`, size: 8.5, indent: 0 });
    else if (a.kind === "attachment" && a.file) lines.push({ text: `Fichier : ${a.file.name}`, size: 8.5, indent: 0 });
    else if (body) lines.push({ text: body, size: 8.5, indent: 0 });
    for (const r of a.replies ?? []) {
      if (!r.text) continue;
      lines.push({ text: `${r.author} — ${when(r.createdAt)}`, size: 7, indent: 10, muted: true });
      lines.push({ text: r.text, size: 8, indent: 10 });
    }
    return Object.assign(lines, { title: kind });
  }
}
