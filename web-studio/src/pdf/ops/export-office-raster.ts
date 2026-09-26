/**
 * Browser-side rasterisers for « Exporter un PDF » (export-office.ts): picture
 * crops for Word / RTF, and slide backgrounds for PowerPoint.
 *
 * Canvas only — nothing here runs in Node. Pages are rendered with the app's
 * own `renderToCanvas` at rotation 0 (the space the layout is measured in),
 * once per page, and released as soon as the export moves past them.
 */

import type { PdfEngine } from "../core/engine";
import type { Rect } from "../core/coords";
import { canvasToBlob, renderToCanvas } from "../core/render";
import type { PageText } from "./export";

export interface PageRasteriser {
  /** A region of a page (page space, points) as PNG bytes. */
  crop(page: number, rect: Rect): Promise<Uint8Array | null>;
  /**
   * The whole page as PNG bytes with its text painted out (each line's box
   * filled with the colour around it), so editable text boxes can sit on top
   * without the text showing twice.
   */
  background(page: number): Promise<Uint8Array | null>;
  /** Free the cached canvas. */
  dispose(): void;
}

/**
 * @param scale render scale (1 = 72 dpi). 2 gives crisp pictures at a
 *   reasonable size; the exporters write the PDF's own dimensions whatever the
 *   pixel count.
 */
export function createPageRasteriser(
  engine: PdfEngine,
  layout: readonly PageText[],
  opts: { scale?: number; maxPixels?: number } = {},
): PageRasteriser {
  const scale = opts.scale ?? 2;
  const maxPixels = opts.maxPixels ?? 16_000_000;
  let cached: { page: number; canvas: HTMLCanvasElement; scale: number } | null = null;

  const render = async (index: number) => {
    if (cached?.page === index) return cached;
    cached = null;
    const page = await engine.page(index);
    const vp = page.getViewport({ scale: 1, rotation: 0 });
    // Keep huge pages within the canvas limits of every browser.
    const s = Math.min(scale, Math.sqrt(maxPixels / Math.max(1, vp.width * vp.height)));
    const canvas = await renderToCanvas(page, { scale: s, rotation: 0, background: "#ffffff" });
    cached = { page: index, canvas, scale: s };
    return cached;
  };

  const toPng = async (canvas: HTMLCanvasElement) =>
    new Uint8Array(await (await canvasToBlob(canvas, "image/png")).arrayBuffer());

  return {
    async crop(index, rect) {
      const { canvas, scale: s } = await render(index);
      const x = Math.max(0, Math.floor(rect.x * s));
      const y = Math.max(0, Math.floor(rect.y * s));
      const w = Math.min(canvas.width - x, Math.ceil(rect.w * s));
      const h = Math.min(canvas.height - y, Math.ceil(rect.h * s));
      if (w < 2 || h < 2) return null;
      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      const ctx = out.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(canvas, x, y, w, h, 0, 0, w, h);
      return toPng(out);
    },

    async background(index) {
      const { canvas: src, scale: s } = await render(index);
      const canvas = document.createElement("canvas");
      canvas.width = src.width;
      canvas.height = src.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(src, 0, 0);
      const lines = layout.find((p) => p.page === index)?.lines ?? [];
      for (const l of lines) {
        const pad = Math.max(1, l.fontSize * 0.12);
        const x = Math.max(0, Math.floor((l.rect.x - pad) * s));
        const y = Math.max(0, Math.floor((l.rect.y - pad) * s));
        const w = Math.min(canvas.width - x, Math.ceil((l.rect.w + 2 * pad) * s));
        const h = Math.min(canvas.height - y, Math.ceil((l.rect.h + 2 * pad) * s));
        if (w < 1 || h < 1) continue;
        ctx.fillStyle = surroundingColour(ctx, x, y, w, h);
        ctx.fillRect(x, y, w, h);
      }
      return toPng(canvas);
    },

    dispose() {
      cached = null;
    },
  };
}

/** The median colour of the pixels just around a box: the paper behind the text. */
function surroundingColour(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): string {
  const cw = ctx.canvas.width;
  const ch = ctx.canvas.height;
  const samples: [number, number, number][] = [];
  const take = (sx: number, sy: number, sw: number, sh: number) => {
    const cx = Math.max(0, sx);
    const cy = Math.max(0, sy);
    const ww = Math.min(cw - cx, sw);
    const hh = Math.min(ch - cy, sh);
    if (ww < 1 || hh < 1) return;
    const d = ctx.getImageData(cx, cy, ww, hh).data;
    const step = Math.max(4, Math.floor(d.length / 4 / 64) * 4);
    for (let i = 0; i < d.length; i += step) samples.push([d[i], d[i + 1], d[i + 2]]);
  };
  take(x, y - 2, w, 2);
  take(x, y + h, w, 2);
  take(x - 2, y, 2, h);
  take(x + w, y, 2, h);
  if (!samples.length) return "#ffffff";
  const mid = (k: 0 | 1 | 2) => samples.map((p) => p[k]).sort((a, b) => a - b)[samples.length >> 1];
  return `rgb(${mid(0)}, ${mid(1)}, ${mid(2)})`;
}
