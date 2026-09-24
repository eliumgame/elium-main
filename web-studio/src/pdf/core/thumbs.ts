/**
 * Page thumbnails for the side panel and the page organiser.
 *
 * The old code rendered every thumbnail to a canvas, turned it into a PNG
 * `data:` URL and showed it in an `<img>` — which the desktop app's CSP
 * (`img-src 'self'`) silently blocks, so the panels stayed blank; and a
 * 1000-page document meant 1000 PNG encodes and 1000 base64 strings in the
 * heap. Here a thumbnail is rendered by pdf.js at low resolution into one
 * reusable scratch canvas, kept as an `ImageBitmap` in a small LRU cache (by
 * pixel budget), and drawn straight into the visible `<canvas>` — no URL of
 * any kind, so no CSP involvement at all.
 *
 * Requests are prioritised (lower first — the caller passes the distance to
 * what is on screen) and cancellable: scrolling a long list only ever renders
 * what is (still) in view.
 */

import type { PDFPageProxy } from "pdfjs-dist";
import type { PdfEngine } from "./engine";
import { ImportedAnnotationMask } from "./viewer/annotmask";

export interface ThumbRequest {
  /** Source page (0-based). */
  from: number;
  /** Total rotation to bake in (the page's /Rotate + the user's). */
  rotation: number;
  /** Target width in device pixels. */
  width: number;
  /** Lower renders first. */
  priority: number;
}

type Listener = (bitmap: ImageBitmap) => void;

interface Job {
  key: string;
  req: ThumbRequest;
  listeners: Set<Listener>;
  task: { cancel: () => void; promise: Promise<void> } | null;
  cancelled: boolean;
}

/** Cached thumbnails, in device pixels (≈ 60 A4 thumbnails of 264 px wide). */
const DEFAULT_PIXEL_BUDGET = 6_000_000;
/** Renders in flight — thumbnails must never starve the main page rasters. */
const CONCURRENCY = 1;

export const thumbKey = (r: Pick<ThumbRequest, "from" | "rotation" | "width">, salt = ""): string =>
  `${r.from}:${r.rotation}:${Math.round(r.width)}${salt ? `:${salt}` : ""}`;

export class ThumbnailService {
  private cache = new Map<string, ImageBitmap>();
  private pixels = 0;
  private pending = new Map<string, Job>();
  private running = new Set<Job>();
  private scratch: HTMLCanvasElement | null = null;
  private destroyed = false;
  /** Bumped when the document's appearance changes (imported markup masked…). */
  private salt = "";

  constructor(
    private readonly engine: PdfEngine,
    private readonly pixelBudget = DEFAULT_PIXEL_BUDGET,
  ) {}

  /** The cached bitmap, if any (drawn synchronously on mount → no flash when scrolling back). */
  peek(req: Pick<ThumbRequest, "from" | "rotation" | "width">): ImageBitmap | null {
    const key = thumbKey(req, this.salt);
    const hit = this.cache.get(key);
    if (!hit) return null;
    // LRU touch.
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit;
  }

  /**
   * Ask for a thumbnail; `onReady` is called once with the bitmap (do not
   * close it: the cache owns it). Returns the cancel function.
   */
  request(req: ThumbRequest, onReady: Listener): () => void {
    if (this.destroyed) return () => {};
    const key = thumbKey(req, this.salt);
    const hit = this.cache.get(key);
    if (hit) {
      onReady(hit);
      return () => {};
    }
    let job = this.pending.get(key) ?? [...this.running].find((j) => j.key === key);
    if (!job) {
      job = { key, req, listeners: new Set(), task: null, cancelled: false };
      this.pending.set(key, job);
    } else if (req.priority < job.req.priority) {
      job.req = { ...job.req, priority: req.priority };
    }
    job.listeners.add(onReady);
    this.pump();
    const j = job;
    return () => {
      j.listeners.delete(onReady);
      if (j.listeners.size) return;
      if (this.pending.get(j.key) === j) this.pending.delete(j.key);
      else if (this.running.has(j)) {
        j.cancelled = true;
        j.task?.cancel();
      }
    };
  }

  /** Forget every cached thumbnail (the document's appearance changed). */
  invalidate(): void {
    this.salt = String(Number(this.salt || "0") + 1);
    this.clearCache();
  }

  private clearCache(): void {
    for (const bmp of this.cache.values()) bmp.close();
    this.cache.clear();
    this.pixels = 0;
  }

  private pump(): void {
    while (!this.destroyed && this.running.size < CONCURRENCY && this.pending.size) {
      let best: Job | null = null;
      for (const job of this.pending.values()) if (!best || job.req.priority < best.req.priority) best = job;
      if (!best) return;
      this.pending.delete(best.key);
      this.running.add(best);
      void this.run(best);
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      const page = await this.engine.page(job.req.from);
      if (job.cancelled || this.destroyed) return;
      const bitmap = await this.render(page, job);
      if (!bitmap) return;
      if (job.cancelled || this.destroyed) {
        bitmap.close();
        return;
      }
      this.store(job.key, bitmap);
      for (const l of job.listeners) l(bitmap);
    } catch (e) {
      if ((e as { name?: string } | null)?.name !== "RenderingCancelledException") {
        /* a page that cannot be drawn simply keeps its placeholder */
      }
    } finally {
      this.running.delete(job);
      this.pump();
    }
  }

  private async render(page: PDFPageProxy, job: Job): Promise<ImageBitmap | null> {
    const base = page.getViewport({ scale: 1, rotation: job.req.rotation });
    const scale = Math.max(0.05, job.req.width / Math.max(1, base.width));
    const viewport = page.getViewport({ scale, rotation: job.req.rotation });
    const canvas = (this.scratch ??= document.createElement("canvas"));
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // A thumbnail shows the file as it is: lift the imported-markup mask the
    // main view applies (pdf.js reads it synchronously when the render starts).
    const start = () => page.render({ canvas, canvasContext: ctx, viewport, intent: "display" });
    const mask = ImportedAnnotationMask.peek(this.engine);
    const task = mask ? mask.unmasked(start) : start();
    job.task = task as unknown as Job["task"];
    await task.promise;
    job.task = null;
    return createImageBitmap(canvas);
  }

  private store(key: string, bitmap: ImageBitmap): void {
    const old = this.cache.get(key);
    if (old) {
      this.pixels -= old.width * old.height;
      old.close();
      this.cache.delete(key);
    }
    this.cache.set(key, bitmap);
    this.pixels += bitmap.width * bitmap.height;
    while (this.pixels > this.pixelBudget && this.cache.size > 1) {
      const [firstKey, first] = this.cache.entries().next().value as [string, ImageBitmap];
      this.cache.delete(firstKey);
      this.pixels -= first.width * first.height;
      first.close();
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const job of this.running) {
      job.cancelled = true;
      job.task?.cancel();
    }
    this.pending.clear();
    this.clearCache();
    if (this.scratch) this.scratch.width = this.scratch.height = 0;
    this.scratch = null;
  }
}

// ---------------------------------------------------------------------------
// Pictures of inserted pages
// ---------------------------------------------------------------------------

/**
 * Decode a `data:` URL (an image page inserted this session) to a bitmap
 * WITHOUT fetching it: `fetch(dataUrl)` needs `connect-src data:`, an `<img>`
 * needs `img-src data:`, and older desktop builds allow neither.
 */
export async function bitmapFromDataUrl(url: string): Promise<ImageBitmap> {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) throw new Error("not a data: URL");
  const header = url.slice(5, comma);
  const type = header.split(";")[0] || "application/octet-stream";
  const payload = url.slice(comma + 1);
  let bytes: Uint8Array;
  if (/;base64/i.test(header)) {
    const bin = atob(payload);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(payload));
  }
  return createImageBitmap(new Blob([bytes as BlobPart], { type }));
}

const pictures = new Map<string, Promise<ImageBitmap>>();

/** `bitmapFromDataUrl`, memoised (a page picture is drawn by the page, its thumbnail and the organiser). */
export function pictureBitmap(url: string): Promise<ImageBitmap> {
  let p = pictures.get(url);
  if (!p) {
    p = bitmapFromDataUrl(url);
    p.catch(() => pictures.delete(url));
    pictures.set(url, p);
    // Pictures are few (pages inserted by hand); keep the memo bounded anyway.
    if (pictures.size > 64) pictures.delete(pictures.keys().next().value as string);
  }
  return p;
}

/**
 * Draw `bitmap` into `canvas`, contained (letter-boxed) and centred, at the
 * canvas' own pixel size.
 */
export function drawContained(canvas: HTMLCanvasElement, bitmap: ImageBitmap, background = "#ffffff"): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const k = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
  const w = bitmap.width * k;
  const h = bitmap.height * k;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
}
