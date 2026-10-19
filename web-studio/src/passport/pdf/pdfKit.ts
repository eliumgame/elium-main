/**
 * Petit moteur de dessin PDF (pdf-lib) pour reproduire À L'IDENTIQUE les documents officiels :
 * polices Carlito (métriques identiques à Calibri), traits, remplissages, texte aligné sur la ligne de
 * base, coches vectorielles et retour à la ligne mesuré sur la police réelle.
 *
 * Coordonnées en points avec l'origine EN HAUT À GAUCHE (comme les mesures relevées sur le rendu Word) ;
 * la conversion vers le repère PDF (origine en bas) est faite ici.
 */
import fontkit from "@pdf-lib/fontkit";
import { woffToSfnt } from "./woff";
import {
  LineCapStyle,
  PDFDocument,
  PDFFont,
  PDFNumber,
  PDFOperator,
  PDFPage,
  StandardFonts,
  degrees,
  rgb,
} from "pdf-lib";

export const A4_PORTRAIT: [number, number] = [595.32, 841.92];
export const A4_LANDSCAPE: [number, number] = [841.92, 595.32];

export interface FontBytes {
  regular: Uint8Array;
  bold: Uint8Array;
}

export interface Fonts {
  /** Calibri (Carlito) ou, à défaut, Helvetica. */
  reg: PDFFont;
  bold: PDFFont;
  /** Arial → Helvetica (métriques identiques). */
  arial: PDFFont;
  arialBold: PDFFont;
  arialBoldItalic: PDFFont;
  /** Times New Roman (annexes en police à empattements). */
  times: PDFFont;
  timesBold: PDFFont;
}

export type FontKey = "reg" | "bold" | "arial" | "arialBold" | "arialBoldItalic" | "times" | "timesBold";

/** Polices Carlito (WOFF, licence OFL) embarquées avec l'application : mêmes métriques que Calibri. */
export async function loadCarlito(): Promise<FontBytes | null> {
  try {
    const [r, b] = await Promise.all([
      import("./fonts/carlito-latin-400-normal.woff?url"),
      import("./fonts/carlito-latin-700-normal.woff?url"),
    ]);
    const get = async (u: string) => woffToSfnt(new Uint8Array(await (await fetch(u)).arrayBuffer()));
    return { regular: await get(r.default), bold: await get(b.default) };
  } catch {
    return null;
  }
}

export async function embedFonts(doc: PDFDocument, bytes: FontBytes | null): Promise<Fonts> {
  const arial = await doc.embedFont(StandardFonts.Helvetica);
  const std = {
    arial,
    arialBold: await doc.embedFont(StandardFonts.HelveticaBold),
    arialBoldItalic: await doc.embedFont(StandardFonts.HelveticaBoldOblique),
    times: await doc.embedFont(StandardFonts.TimesRoman),
    timesBold: await doc.embedFont(StandardFonts.TimesRomanBold),
  };
  if (bytes) {
    try {
      doc.registerFontkit(fontkit);
      return {
        ...std,
        reg: await doc.embedFont(bytes.regular, { subset: true }),
        bold: await doc.embedFont(bytes.bold, { subset: true }),
      };
    } catch {
      /* police illisible : repli sur Helvetica */
    }
  }
  return { ...std, reg: arial, bold: std.arialBold };
}

/** Caractères que WinAnsi (Helvetica) ne sait pas écrire : remplacés plutôt que de faire échouer l'export. */
const FALLBACKS: Record<string, string> = { "’": "'", "‘": "'", "“": '"', "”": '"', "–": "-", "—": "-", "…": "..." };
export function sanitize(text: string, font: PDFFont): string {
  let out = "";
  for (const ch of text.replace(/\t/g, "    ")) {
    try {
      font.widthOfTextAtSize(ch, 10);
      out += ch;
    } catch {
      out += FALLBACKS[ch] ?? "?";
    }
  }
  return out;
}

export const width = (font: PDFFont, size: number, text: string): number =>
  font.widthOfTextAtSize(sanitize(text, font), size);

/** Coupe `text` (avec retours à la ligne explicites) en lignes d'au plus `maxW` points. */
export function wrap(font: PDFFont, size: number, text: string, maxW: number): string[] {
  const lines: string[] = [];
  for (const para of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!para.trim()) {
      lines.push("");
      continue;
    }
    let cur = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const cand = cur ? `${cur} ${word}` : word;
      if (width(font, size, cand) <= maxW) {
        cur = cand;
        continue;
      }
      if (cur) lines.push(cur);
      let rest = word;
      while (width(font, size, rest) > maxW && rest.length > 1) {
        let n = rest.length - 1;
        while (n > 1 && width(font, size, rest.slice(0, n)) > maxW) n--;
        lines.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      cur = rest;
    }
    lines.push(cur);
  }
  return lines;
}

export class Canvas {
  constructor(
    readonly page: PDFPage,
    readonly fonts: Fonts,
  ) {}

  private y(top: number): number {
    return this.page.getHeight() - top;
  }

  fill(x0: number, y0: number, x1: number, y1: number, gray: number): void {
    this.page.drawRectangle({ x: x0, y: this.y(y1), width: x1 - x0, height: y1 - y0, color: rgb(gray, gray, gray) });
  }

  fillColor(x0: number, y0: number, x1: number, y1: number, color: [number, number, number]): void {
    this.page.drawRectangle({ x: x0, y: this.y(y1), width: x1 - x0, height: y1 - y0, color: rgb(...color) });
  }

  /** Rectangle à fond blanc et contour noir. */
  rect(x: number, y: number, w: number, h: number, thickness = 0.5): void {
    this.page.drawRectangle({
      x,
      y: this.y(y + h),
      width: w,
      height: h,
      color: rgb(1, 1, 1),
      borderColor: rgb(0, 0, 0),
      borderWidth: thickness,
    });
  }

  /** Trait horizontal d'épaisseur `t`, centré sur y. */
  h(y: number, x0: number, x1: number, t = 0.5): void {
    this.page.drawRectangle({ x: x0, y: this.y(y) - t / 2, width: x1 - x0, height: t, color: rgb(0, 0, 0) });
  }

  /** Trait vertical d'épaisseur `t`, centré sur x. */
  v(x: number, y0: number, y1: number, t = 0.5): void {
    this.page.drawRectangle({ x: x - t / 2, y: this.y(y1), width: t, height: y1 - y0, color: rgb(0, 0, 0) });
  }

  /** Texte dont la LIGNE DE BASE est à `baseline`, ancré à gauche, au centre ou à droite de `x`. Renvoie sa largeur. */
  text(
    s: string,
    x: number,
    baseline: number,
    o: {
      font?: FontKey;
      size: number;
      align?: "left" | "center" | "right";
      color?: [number, number, number];
      /** Étirement horizontal (0,82 ≈ Arial Narrow). */
      hscale?: number;
    },
  ): number {
    const font = this.fonts[o.font ?? "reg"];
    const t = sanitize(s, font);
    if (!t) return 0;
    const k = o.hscale ?? 1;
    const w = font.widthOfTextAtSize(t, o.size) * k;
    const px = o.align === "center" ? x - w / 2 : o.align === "right" ? x - w : x;
    if (k !== 1) this.page.pushOperators(PDFOperator.of("Tz" as never, [PDFNumber.of(k * 100)]));
    this.page.drawText(t, { x: px, y: this.y(baseline), size: o.size, font, color: rgb(...(o.color ?? [0, 0, 0])) });
    if (k !== 1) this.page.pushOperators(PDFOperator.of("Tz" as never, [PDFNumber.of(100)]));
    return w;
  }

  /** Points de conduite (« ……… ») de x0 à x1, sur la ligne de base. */
  dots(x0: number, x1: number, baseline: number): void {
    this.page.drawLine({
      start: { x: x0, y: this.y(baseline) + 0.6 },
      end: { x: x1, y: this.y(baseline) + 0.6 },
      thickness: 0.75,
      dashArray: [0.05, 2.15],
      lineCap: LineCapStyle.Round,
      color: rgb(0, 0, 0),
    });
  }

  /** Largeur d'un texte avec étirement (même mesure que `text`). */
  measure(s: string, o: { font?: FontKey; size: number; hscale?: number }): number {
    const font = this.fonts[o.font ?? "reg"];
    return font.widthOfTextAtSize(sanitize(s, font), o.size) * (o.hscale ?? 1);
  }

  /** Texte lu de bas en haut (libellés verticaux) : `x` = ligne de base, `yStart` = bas du texte. */
  textUp(s: string, x: number, yStart: number, o: { font?: "reg" | "bold"; size: number }): void {
    const font = this.fonts[o.font ?? "reg"];
    const t = sanitize(s, font);
    this.page.drawText(t, { x, y: this.y(yStart), size: o.size, font, rotate: degrees(90), color: rgb(0, 0, 0) });
  }

  /** Texte lu de haut en bas, centré dans la hauteur [y0, y1] (bande verticale du passeport). */
  textDownCentered(
    s: string,
    xBaseline: number,
    y0: number,
    y1: number,
    o: { font?: "reg" | "bold"; size: number },
  ): void {
    const font = this.fonts[o.font ?? "bold"];
    const t = sanitize(s, font);
    const w = font.widthOfTextAtSize(t, o.size);
    const start = (y0 + y1) / 2 - w / 2;
    // rotation de -90° : le texte descend ; l'origine est le HAUT du texte
    this.page.drawText(t, {
      x: xBaseline,
      y: this.y(start),
      size: o.size,
      font,
      rotate: degrees(-90),
      color: rgb(0, 0, 0),
    });
  }

  /** Case à cocher vectorielle (☐ / ☒), bas de la case sur la ligne de base. */
  checkbox(x: number, baseline: number, checked: boolean, size = 6.6): void {
    const top = baseline - size + 0.4;
    this.page.drawRectangle({
      x,
      y: this.y(top + size),
      width: size,
      height: size,
      borderWidth: 0.6,
      borderColor: rgb(0, 0, 0),
    });
    if (checked) {
      const p = 1.1;
      const a = { x: x + p, y: this.y(top + p) };
      const b = { x: x + size - p, y: this.y(top + size - p) };
      this.page.drawLine({ start: a, end: b, thickness: 0.7, color: rgb(0, 0, 0) });
      this.page.drawLine({
        start: { x: a.x, y: b.y },
        end: { x: b.x, y: a.y },
        thickness: 0.7,
        color: rgb(0, 0, 0),
      });
    }
  }
}

export async function newDoc(fontBytes: FontBytes | null): Promise<{ doc: PDFDocument; fonts: Fonts }> {
  const doc = await PDFDocument.create();
  const fonts = await embedFonts(doc, fontBytes);
  return { doc, fonts };
}
