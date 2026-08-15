/**
 * OCR — making a scanned PDF searchable.
 *
 * Each page is rasterised, recognised with Tesseract, and the recognised words
 * are written back as an **invisible text layer** (text render mode 3) placed
 * exactly over the glyphs in the picture. The page looks identical; selecting,
 * searching and copying suddenly work.
 *
 * Tesseract is imported lazily so a user who never runs OCR never downloads it.
 * Language models are looked for in the app's own `tessdata/` directory first,
 * so a packaged desktop build stays fully offline; only if they are absent does
 * it fall back to the public CDN — and even then the *document never leaves the
 * machine*, only the model files come in.
 */

import type { PDFDocument, PDFPage } from "pdf-lib";
import type { PdfEngine } from "../core/engine";
import { renderToCanvas } from "../core/render";
import type { Rect } from "../core/coords";
import { round } from "../core/coords";
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
  /** Page-space box (top-left origin, points). */
  rect: Rect;
}

export interface OcrPageResult {
  page: number;
  words: OcrWord[];
  text: string;
  /** Mean confidence, 0..100. */
  confidence: number;
}

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

/** Where to look for `*.traineddata.gz`, preferring a locally bundled copy. */
async function resolveLangPath(): Promise<string | undefined> {
  const base = `${import.meta.env.BASE_URL ?? "/"}tessdata`.replace(/\/+/g, "/");
  try {
    const probe = await fetch(`${base}/eng.traineddata.gz`, { method: "HEAD" });
    if (probe.ok) return base;
  } catch {
    /* not bundled */
  }
  return undefined; // tesseract.js falls back to its CDN default
}

/** True when the app ships its own language models (fully offline OCR). */
export async function hasLocalModels(): Promise<boolean> {
  return (await resolveLangPath()) !== undefined;
}

interface TesseractWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/**
 * Recognise the given pages. Returns per-page words positioned in page space
 * (points), ready to be written as an invisible text layer.
 */
export async function recognise(engine: PdfEngine, options: Partial<OcrOptions> = {}): Promise<OcrPageResult[]> {
  const opts: OcrOptions = { ...DEFAULT_OCR, ...options };
  const indices = opts.pages?.length ? opts.pages : engine.pages.map((p) => p.index);
  if (!indices.length) return [];

  const { createWorker } = await import("tesseract.js");
  const langPath = await resolveLangPath();
  const langs = opts.languages.length ? opts.languages.join("+") : "eng";

  const worker = await createWorker(langs, 1, {
    ...(langPath ? { langPath } : {}),
    logger: (m: { status?: string; progress?: number }) => {
      opts.onProgress?.({ page: 0, total: indices.length, stage: m.status ?? "", ratio: m.progress ?? 0 });
    },
  });

  const out: OcrPageResult[] = [];
  try {
    for (let i = 0; i < indices.length; i++) {
      if (opts.signal?.aborted) break;
      const index = indices[i];
      const info = engine.pages[index];
      if (!info) continue;

      if (opts.skipPagesWithText) {
        const tc = await engine.text(index);
        const chars = tc.items.reduce((n, it) => n + (it.str?.length ?? 0), 0);
        if (chars > 120) {
          out.push({ page: index, words: [], text: "", confidence: 100 });
          opts.onProgress?.({ page: i + 1, total: indices.length, stage: "texte déjà présent", ratio: 1 });
          continue;
        }
      }

      opts.onProgress?.({ page: i + 1, total: indices.length, stage: "rendu", ratio: 0 });
      const proxy = await engine.page(index);
      const scale = opts.dpi / 72;
      const canvas = await renderToCanvas(proxy, { scale, rotation: 0 });

      opts.onProgress?.({ page: i + 1, total: indices.length, stage: "reconnaissance", ratio: 0.3 });
      const { data } = await worker.recognize(canvas, {}, { blocks: true, text: true });
      const words = collectWords(data as unknown as { blocks?: unknown[]; words?: TesseractWord[] });

      out.push({
        page: index,
        text: (data as { text?: string }).text ?? "",
        confidence: (data as { confidence?: number }).confidence ?? 0,
        words: words
          .filter((w) => w.text.trim() && w.confidence > 35)
          .map((w) => ({
            text: w.text,
            confidence: w.confidence,
            rect: {
              x: w.bbox.x0 / scale,
              y: w.bbox.y0 / scale,
              w: (w.bbox.x1 - w.bbox.x0) / scale,
              h: (w.bbox.y1 - w.bbox.y0) / scale,
            },
          }))
          // Guard against words the recogniser placed outside the page.
          .filter((w) => w.rect.w > 0.5 && w.rect.h > 0.5 && w.rect.x < info.w && w.rect.y < info.h),
      });
      opts.onProgress?.({ page: i + 1, total: indices.length, stage: "terminé", ratio: 1 });
    }
  } finally {
    await worker.terminate().catch(() => {});
  }
  return out;
}

/** Tesseract 6 nests words under blocks → paragraphs → lines. */
function collectWords(data: { blocks?: unknown[]; words?: TesseractWord[] }): TesseractWord[] {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out: TesseractWord[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (Array.isArray(n.words)) out.push(...(n.words as TesseractWord[]));
    for (const key of ["blocks", "paragraphs", "lines"]) {
      if (Array.isArray(n[key])) for (const child of n[key] as unknown[]) walk(child);
    }
  };
  for (const block of data.blocks ?? []) walk(block);
  return out;
}

/**
 * Write an invisible text layer for one page. Each word is drawn in render
 * mode 3 (neither filled nor stroked) with the horizontal scale tuned so the
 * selection box matches the word's real width on the picture.
 */
export async function writeOcrLayer(
  doc: PDFDocument,
  page: PDFPage,
  words: readonly OcrWord[],
  fonts: FontBook,
): Promise<number> {
  if (!words.length) return 0;
  const { font } = await fonts.standard();
  const box = page.getCropBox();
  const res = new PageResources(page);
  const painter = new Painter(res);
  const name = res.fontName(font);

  painter.save().raw("BT").raw("3 Tr");
  let written = 0;
  for (const w of words) {
    const text = sanitiseForFont(w.text, false).trim();
    if (!text) continue;
    const size = Math.max(2, w.rect.h * 0.92);
    let natural = 0;
    try {
      natural = font.widthOfTextAtSize(text, size);
    } catch {
      natural = text.length * size * 0.5;
    }
    if (natural <= 0) continue;
    // Stretch horizontally so the invisible word covers the visible one.
    const hScale = Math.max(10, Math.min(400, (w.rect.w / natural) * 100));
    const x = box.x + w.rect.x;
    const y = box.y + box.height - w.rect.y - w.rect.h + w.rect.h * 0.16;
    painter
      .raw(`/${name} ${round(size, 2)} Tf`)
      .raw(`${round(hScale, 1)} Tz`)
      .raw(`1 0 0 1 ${round(x, 2)} ${round(y, 2)} Tm`)
      .raw(`${encodeFontText(font, text)} Tj`);
    written++;
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
