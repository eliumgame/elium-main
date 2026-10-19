/**
 * Annexes d'une fiche dans le dossier PDF : une page de garde par annexe (« Annexe n — nom — SPx »), puis son contenu
 * quand il s'intègre — pages d'un PDF recopiées telles quelles, image mise à l'échelle sur une page A4, fichier texte
 * en pages de texte. Tout autre type (Word, Excel, vidéo…) reçoit une page de garde qui le signale : il reste
 * disponible tel quel dans l'application et dans le Drive.
 */
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { Annexe, Situation } from "../types";
import { spLabel } from "../model";
import { A4_PORTRAIT, Canvas, wrap, type Fonts } from "./pdfKit";

const MARGIN = 56;

function frSize(n: number): string {
  return n >= 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(n / 1024))} Ko`;
}

function cover(doc: PDFDocument, fonts: Fonts, s: Situation, a: Annexe, n: number, note: string): void {
  const c = new Canvas(doc.addPage(A4_PORTRAIT), fonts);
  const mid = A4_PORTRAIT[0] / 2;
  c.text(`Annexe ${n}`, mid, 250, { font: "timesBold", size: 26, align: "center" });
  c.text(`Fiche ${spLabel(s.id)}${s.intitule.trim() ? ` — ${s.intitule.trim()}` : ""}`, mid, 282, {
    font: "times",
    size: 12,
    align: "center",
  });
  let y = 318;
  for (const t of wrap(fonts.timesBold, 15, a.name, A4_PORTRAIT[0] - 2 * MARGIN)) {
    c.text(t, mid, y, { font: "timesBold", size: 15, align: "center" });
    y += 20;
  }
  if (a.note.trim()) {
    y += 6;
    for (const t of wrap(fonts.times, 11.5, a.note.trim(), A4_PORTRAIT[0] - 2 * MARGIN)) {
      c.text(t, mid, y, { font: "times", size: 11.5, align: "center" });
      y += 15;
    }
  }
  if (note) {
    y += 18;
    for (const t of wrap(fonts.times, 10.5, note, A4_PORTRAIT[0] - 2 * MARGIN - 40)) {
      c.text(t, mid, y, { font: "times", size: 10.5, align: "center", color: [0.35, 0.35, 0.35] });
      y += 14;
    }
  }
}

function caption(c: Canvas, s: Situation, a: Annexe, n: number): void {
  c.text(`Annexe ${n} — ${a.name} (${spLabel(s.id)})`, MARGIN, 36, {
    font: "arial",
    size: 8.5,
    color: [0.35, 0.35, 0.35],
  });
}

async function appendPdf(doc: PDFDocument, fonts: Fonts, s: Situation, n: number, bytes: Uint8Array): Promise<boolean> {
  try {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const pages = await doc.copyPages(src, src.getPageIndices());
    for (const p of pages) {
      doc.addPage(p);
      const c = new Canvas(p, fonts);
      // légende discrète en haut de chaque page recopiée (hors cadre si la page est déjà pleine)
      c.text(`Annexe ${n} — ${spLabel(s.id)}`, p.getWidth() - 14, 10, {
        font: "arial",
        size: 6.5,
        align: "right",
        color: [0.4, 0.4, 0.4],
      });
    }
    return true;
  } catch {
    return false;
  }
}

async function appendImage(
  doc: PDFDocument,
  fonts: Fonts,
  s: Situation,
  a: Annexe,
  n: number,
  bytes: Uint8Array,
): Promise<boolean> {
  try {
    const isPng = a.mime === "image/png" || /\.png$/i.test(a.name);
    const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    const page = doc.addPage(A4_PORTRAIT);
    const c = new Canvas(page, fonts);
    caption(c, s, a, n);
    const maxW = A4_PORTRAIT[0] - 2 * MARGIN;
    const maxH = A4_PORTRAIT[1] - 2 * MARGIN - 20;
    const k = Math.min(maxW / img.width, maxH / img.height, 1.5);
    const w = img.width * k;
    const h = img.height * k;
    page.drawImage(img, { x: (A4_PORTRAIT[0] - w) / 2, y: A4_PORTRAIT[1] - MARGIN - 20 - h, width: w, height: h });
    return true;
  } catch {
    return false; // WebP, GIF ou image illisible
  }
}

async function appendText(
  doc: PDFDocument,
  fonts: Fonts,
  s: Situation,
  a: Annexe,
  n: number,
  bytes: Uint8Array,
): Promise<boolean> {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).slice(0, 60_000);
    const mono = await doc.embedFont(StandardFonts.Courier);
    const size = 8.5;
    const pitch = 11;
    const maxW = A4_PORTRAIT[0] - 2 * MARGIN;
    const lines: string[] = [];
    for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
      let cur = raw.replace(/\t/g, "    ");
      do {
        let take = cur.length;
        while (take > 1 && mono.widthOfTextAtSize(cur.slice(0, take).replace(/[^\x20-\xff]/g, "?"), size) > maxW)
          take--;
        lines.push(cur.slice(0, take));
        cur = cur.slice(take);
      } while (cur.length);
    }
    let page = doc.addPage(A4_PORTRAIT);
    let y = 56;
    let c = new Canvas(page, fonts);
    caption(c, s, a, n);
    for (const l of lines) {
      if (y > A4_PORTRAIT[1] - 56) {
        page = doc.addPage(A4_PORTRAIT);
        c = new Canvas(page, fonts);
        caption(c, s, a, n);
        y = 56;
      }
      page.drawText(l.replace(/[^\x20-\xff]/g, "?"), {
        x: MARGIN,
        y: A4_PORTRAIT[1] - y,
        size,
        font: mono,
        color: rgb(0, 0, 0),
      });
      y += pitch;
    }
    return true;
  } catch {
    return false;
  }
}

/** Au-delà, l'assemblage dans le navigateur devient trop lourd : l'annexe est signalée mais pas recopiée. */
const MAX_INLINE_BYTES = 12 * 1024 * 1024;

export async function appendAnnexes(
  doc: PDFDocument,
  fonts: Fonts,
  s: Situation,
  bytesOf: (id: string) => Uint8Array | undefined,
): Promise<void> {
  let n = 0;
  for (const a of s.annexes) {
    n++;
    // Laisse respirer l'interface entre deux annexes (l'assemblage d'un gros PDF bloque le fil principal).
    await new Promise((r) => setTimeout(r, 0));
    const bytes = bytesOf(a.id);
    if (!bytes) {
      cover(
        doc,
        fonts,
        s,
        a,
        n,
        "Fichier introuvable sur cet appareil, ou trop volumineux (plus de 12 Mo) : il n'a pas été intégré au PDF.",
      );
      continue;
    }
    if (bytes.length > MAX_INLINE_BYTES) {
      cover(
        doc,
        fonts,
        s,
        a,
        n,
        `Fichier trop volumineux (${frSize(bytes.length)}) pour être intégré au dossier PDF : joignez-le séparément.`,
      );
      continue;
    }
    const isPdf = a.mime === "application/pdf" || /\.pdf$/i.test(a.name);
    const isImg = /^image\/(png|jpe?g)$/.test(a.mime) || /\.(png|jpe?g)$/i.test(a.name);
    const isTxt = /^text\//.test(a.mime) || /\.(txt|csv|md)$/i.test(a.name);
    cover(
      doc,
      fonts,
      s,
      a,
      n,
      isPdf || isImg || isTxt
        ? ""
        : `Fichier joint (${frSize(a.size)}) non intégrable dans un PDF : il reste disponible tel quel dans l'application.`,
    );
    const ok = isPdf
      ? await appendPdf(doc, fonts, s, n, bytes)
      : isImg
        ? await appendImage(doc, fonts, s, a, n, bytes)
        : isTxt
          ? await appendText(doc, fonts, s, a, n, bytes)
          : true;
    if (!ok)
      cover(doc, fonts, s, a, n, "Ce fichier n'a pas pu être lu pour être intégré (format non reconnu ou protégé).");
  }
}
