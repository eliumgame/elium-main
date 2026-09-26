/**
 * OCR — making a scanned PDF searchable.
 *
 * Each page is rasterised, recognised with Tesseract, and the recognised words
 * are written back as an **invisible text layer** (text render mode 3) placed
 * exactly over the glyphs in the picture. The page looks identical; selecting,
 * searching and copying suddenly work.
 *
 * Tesseract is imported lazily so a user who never runs OCR never downloads it.
 * Its worker, WebAssembly core and language models are served by the app
 * itself: OCR runs offline, in the desktop app as in the Drive, and the
 * document never leaves the machine.
 */

import type { PDFDocument, PDFPage } from "pdf-lib";
import type { PdfEngine } from "../core/engine";
import { renderToCanvas } from "../core/render";
import type { Rect, Rotation } from "../core/coords";
import { round, viewToPs } from "../core/coords";
import { PageResources, Painter, encodeFontText } from "./painter";
import type { FontBook } from "./fonts";
import { sanitiseForFont } from "./fonts";

export type OcrLanguage = "fra" | "eng" | "deu" | "spa" | "ita" | "por" | "nld";

export const OCR_LANGUAGES: { code: OcrLanguage; label: string }[] = [
  { code: "fra", label: "Français" },
  { code: "eng", label: "Anglais" },
  { code: "deu", label: "Allemand" },
  { code: "spa", label: "Espagnol" },
  { code: "ita", label: "Italien" },
  { code: "por", label: "Portugais" },
  { code: "nld", label: "Néerlandais" },
];

export interface OcrWord {
  text: string;
  confidence: number;
  /** Box in the page's displayed orientation (top-left origin, points). */
  rect: Rect;
  /** Recognised with low confidence: listed for review (Acrobat's « texte suspect »). */
  suspect?: boolean;
}

/** One recognised line: its words and baseline, in the displayed orientation (points). */
export interface OcrLine {
  words: OcrWord[];
  /** Baseline from its left to its right end (y down). */
  baseline: { x0: number; y0: number; x1: number; y1: number };
  /** Line height (ascender to descender). */
  height: number;
}

export interface OcrPageResult {
  page: number;
  lines: OcrLine[];
  /** Every word, in reading order (the lines' words). */
  words: OcrWord[];
  text: string;
  /** Mean confidence, 0..100. */
  confidence: number;
  /** The page's /Rotate when it was recognised, and its unrotated size (crop box). */
  rotation: Rotation;
  size: { w: number; h: number };
}

/** Words recognised below this confidence are kept but flagged as suspect. */
export const SUSPECT_BELOW = 60;
/** Largest raster handed to Tesseract (pixels): big drawings are recognised at a lower resolution. */
const MAX_PIXELS = 40_000_000;

export interface OcrOptions {
  languages: OcrLanguage[];
  /** Rasterisation resolution; 300 dpi is Tesseract's sweet spot. */
  dpi: number;
  /** 0-based page indices; omitted = every page. */
  pages?: number[];
  /** Skip pages that already contain a decent amount of real text. */
  skipPagesWithText: boolean;
  onProgress?: (info: { page: number; total: number; stage: string; ratio: number }) => void;
  signal?: AbortSignal;
}

export const DEFAULT_OCR: OcrOptions = {
  languages: ["fra", "eng"],
  dpi: 300,
  skipPagesWithText: true,
};

const base = () => (import.meta.env.BASE_URL ?? "/").replace(/\/?$/, "/");

/**
 * Tesseract's runtime and models, all served by the app itself
 * (`scripts/tesseract-assets-plugin.ts`, `public/tessdata/`): OCR works
 * offline and under the desktop CSP, which forbids any CDN.
 */
export const tesseractPaths = () => ({
  workerPath: `${base()}tesseract/worker.min.js`,
  corePath: `${base()}tesseract/`,
  langPath: `${base()}tessdata`,
});

/** The languages whose model is missing from the app (checked before recognising). */
export async function missingModels(languages: readonly OcrLanguage[]): Promise<OcrLanguage[]> {
  const { langPath } = tesseractPaths();
  const missing: OcrLanguage[] = [];
  for (const l of languages) {
    try {
      const res = await fetch(`${langPath}/${l}.traineddata.gz`, { method: "HEAD" });
      if (!res.ok) missing.push(l);
    } catch {
      missing.push(l);
    }
  }
  return missing;
}

/** True when the app ships its language models (fully offline OCR). */
export async function hasLocalModels(): Promise<boolean> {
  return (await missingModels(["eng"])).length === 0;
}

interface TesseractWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

interface TesseractLine {
  words?: TesseractWord[];
  bbox: { x0: number; y0: number; x1: number; y1: number };
  baseline?: { x0: number; y0: number; x1: number; y1: number; has_baseline?: boolean };
}

export class OcrCancelled extends Error {
  constructor() {
    super("Reconnaissance interrompue.");
    this.name = "OcrCancelled";
  }
}

/**
 * Recognise the given pages. Returns per-page lines and words positioned in
 * the page's displayed orientation (points), ready to be written as an
 * invisible text layer. Throws `OcrCancelled` when interrupted: a cancelled
 * run produces nothing.
 */
export async function recognise(engine: PdfEngine, options: Partial<OcrOptions> = {}): Promise<OcrPageResult[]> {
  const opts: OcrOptions = { ...DEFAULT_OCR, ...options };
  const indices = opts.pages?.length ? opts.pages : engine.pages.map((p) => p.index);
  if (!indices.length) return [];
  const languages: OcrLanguage[] = opts.languages.length ? opts.languages : ["eng"];
  const missing = await missingModels(languages);
  if (missing.length) {
    const names = missing.map((m) => OCR_LANGUAGES.find((l) => l.code === m)?.label ?? m).join(", ");
    throw new Error(`Modèle de langue absent de l'application : ${names}.`);
  }

  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker(languages.join("+"), 1, {
    ...tesseractPaths(),
    logger: (m: { status?: string; progress?: number }) => {
      opts.onProgress?.({ page: 0, total: indices.length, stage: m.status ?? "", ratio: m.progress ?? 0 });
    },
  });
  // Interrupting stops the recognition in progress, not only the next page.
  const stop = () => void worker.terminate().catch(() => {});
  opts.signal?.addEventListener("abort", stop);

  const out: OcrPageResult[] = [];
  try {
    for (let i = 0; i < indices.length; i++) {
      if (opts.signal?.aborted) throw new OcrCancelled();
      const index = indices[i];
      if (index < 0 || index >= engine.pageCount) continue;
      // Real geometry (the engine may still hold an estimate for this page).
      const info = await engine.pageInfo(index);
      const empty = (): OcrPageResult => ({
        page: index,
        lines: [],
        words: [],
        text: "",
        confidence: 100,
        rotation: info.rotate,
        size: { w: info.w, h: info.h },
      });

      if (opts.skipPagesWithText) {
        const tc = await engine.text(index);
        const chars = tc.items.reduce((n, it) => n + (it.str?.length ?? 0), 0);
        if (chars > 120) {
          out.push(empty());
          opts.onProgress?.({ page: i + 1, total: indices.length, stage: "texte déjà présent", ratio: 1 });
          continue;
        }
      }

      opts.onProgress?.({ page: i + 1, total: indices.length, stage: "rendu", ratio: 0 });
      const proxy = await engine.page(index);
      // Rendered as displayed (its /Rotate applied): Tesseract reads upright text.
      const scale = Math.min(opts.dpi / 72, Math.sqrt(MAX_PIXELS / Math.max(1, info.w * info.h)));
      const canvas = await renderToCanvas(proxy, { scale, rotation: info.rotate });

      opts.onProgress?.({ page: i + 1, total: indices.length, stage: "reconnaissance", ratio: 0.3 });
      let data: { text?: string; confidence?: number; blocks?: unknown[] };
      try {
        data = (await worker.recognize(canvas, {}, { blocks: true, text: true })).data as unknown as typeof data;
      } catch (e) {
        if (opts.signal?.aborted) throw new OcrCancelled();
        throw e;
      }
      const lines = collectLines(data)
        .map((l) => toLine(l, scale))
        .filter((l): l is OcrLine => !!l);
      const r = empty();
      r.lines = lines;
      r.words = lines.flatMap((l) => l.words);
      r.text = data.text ?? "";
      r.confidence = data.confidence ?? 0;
      out.push(r);
      opts.onProgress?.({ page: i + 1, total: indices.length, stage: "terminé", ratio: 1 });
    }
    if (opts.signal?.aborted) throw new OcrCancelled();
  } finally {
    opts.signal?.removeEventListener("abort", stop);
    await worker.terminate().catch(() => {});
  }
  return out;
}

/** Tesseract 6 nests lines under blocks → paragraphs. */
function collectLines(data: { blocks?: unknown[] }): TesseractLine[] {
  const out: TesseractLine[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.lines)) out.push(...(n.lines as TesseractLine[]));
    for (const key of ["blocks", "paragraphs"]) {
      if (Array.isArray(n[key])) for (const child of n[key] as unknown[]) walk(child);
    }
  };
  for (const block of data.blocks ?? []) walk(block);
  return out;
}

function toLine(l: TesseractLine, scale: number): OcrLine | null {
  const words = (l.words ?? [])
    .filter((w) => w.text.trim())
    .map((w) => ({
      text: w.text.trim(),
      confidence: w.confidence,
      suspect: w.confidence < SUSPECT_BELOW,
      rect: {
        x: w.bbox.x0 / scale,
        y: w.bbox.y0 / scale,
        w: (w.bbox.x1 - w.bbox.x0) / scale,
        h: (w.bbox.y1 - w.bbox.y0) / scale,
      },
    }))
    .filter((w) => w.rect.w > 0.3 && w.rect.h > 0.3)
    .sort((a, b) => a.rect.x - b.rect.x);
  if (!words.length) return null;
  const height = (l.bbox.y1 - l.bbox.y0) / scale;
  const b = l.baseline;
  const baseline =
    b && b.has_baseline !== false && b.x1 > b.x0
      ? { x0: b.x0 / scale, y0: b.y0 / scale, x1: b.x1 / scale, y1: b.y1 / scale }
      : // No baseline: a fifth of the line above its bottom (descenders).
        {
          x0: l.bbox.x0 / scale,
          y0: (l.bbox.y1 - (l.bbox.y1 - l.bbox.y0) * 0.2) / scale,
          x1: l.bbox.x1 / scale,
          y1: (l.bbox.y1 - (l.bbox.y1 - l.bbox.y0) * 0.2) / scale,
        };
  return { words, baseline, height };
}

/**
 * Write an invisible text layer for one page (text render mode 3): one text
 * line per recognised line, on its baseline and at its slope, its words
 * separated by spaces and stretched to cover the words in the picture — so
 * selection, search and copy follow the lines as they are read.
 */
export async function writeOcrLayer(
  doc: PDFDocument,
  page: PDFPage,
  result: Pick<OcrPageResult, "lines" | "rotation" | "size">,
  fonts: FontBook,
): Promise<number> {
  const lines = result.lines.filter((l) => l.words.length);
  if (!lines.length) return 0;
  // Invisible text, but it is what search and copy read: every recognised
  // character must be encodable (Polish, Greek, Cyrillic… OCR languages).
  const all = lines.flatMap((l) => l.words.map((w) => w.text)).join(" ");
  const { font, unicode } = await fonts.forText("Helvetica", false, false, all);
  const box = page.getCropBox();
  const res = new PageResources(page);
  const painter = new Painter(res);
  const name = res.fontName(font);
  const size = { w: result.size.w, h: result.size.h };
  // Displayed orientation (y down) → PDF user space (y up).
  const toPdf = (x: number, y: number) => {
    const p = viewToPs({ x, y }, size, result.rotation);
    return { x: box.x + p.x, y: box.y + box.height - p.y };
  };
  const width = (t: string, s: number) => {
    try {
      return font.widthOfTextAtSize(t, s);
    } catch {
      return t.length * s * 0.5;
    }
  };

  painter.save().raw("BT").raw("3 Tr");
  let written = 0;
  for (const line of lines) {
    const { x0, y0, x1, y1 } = line.baseline;
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    const yAt = (x: number) => y0 + ((x - x0) / (x1 - x0 || 1)) * (y1 - y0);
    const o = toPdf(x0, y0);
    const e = toPdf(x0 + ux, y0 + uy);
    const dx = e.x - o.x;
    const dy = e.y - o.y;
    const fontSize = Math.max(2, line.height * 0.95);
    painter.raw(`/${name} ${round(fontSize, 2)} Tf`);
    line.words.forEach((w, i) => {
      const next = line.words[i + 1];
      const text = sanitiseForFont(w.text, unicode).trim();
      if (!text) return;
      const shown = next ? `${text} ` : text;
      const span = next ? next.rect.x - w.rect.x : w.rect.w;
      const natural = width(shown, fontSize);
      if (natural <= 0 || span <= 0) return;
      const hScale = Math.max(10, Math.min(400, (span / ux / natural) * 100));
      const at = toPdf(w.rect.x, yAt(w.rect.x));
      painter
        .raw(`${round(hScale, 1)} Tz`)
        .raw(`${round(dx, 5)} ${round(dy, 5)} ${round(-dy, 5)} ${round(dx, 5)} ${round(at.x, 2)} ${round(at.y, 2)} Tm`)
        .raw(`${encodeFontText(font, shown)} Tj`);
      written++;
    });
  }
  painter.raw("100 Tz").raw("ET").restore();

  if (!written) return 0;
  page.node.addContentStream(doc.context.register(doc.context.stream(`q\n${painter.toString()}\nQ\n`)));
  return written;
}

/** Plain text of an OCR run, for "copy the recognised text". */
export function ocrToText(results: readonly OcrPageResult[]): string {
  return results
    .map((r) => r.text.trim())
    .filter(Boolean)
    .join("\n\f\n");
}
