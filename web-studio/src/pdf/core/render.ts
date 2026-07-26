/**
 * Page raster scheduler.
 *
 * A PDF viewer that renders every visible page at once stutters badly on long
 * documents: pdf.js work happens on the main thread once the worker hands back
 * the operator list. So renders are queued, capped to a few in flight, ordered
 * by how close the page is to the viewport, and cancelled the moment they go
 * stale (a new zoom level, a rotation, or the page scrolling far away).
 */

import type { PDFPageProxy } from "pdfjs-dist";
import { clamp } from "./coords";

/** Hard cap on canvas pixels — browsers refuse to allocate beyond ~16k² anyway. */
const MAX_CANVAS_PIXELS = 18_000_000;
/** Renders allowed in flight at once. */
const MAX_CONCURRENT = 3;

export interface RenderRequest {
  /** Stable key for the page slot; a second request with the same key supersedes the first. */
  key: string;
  page: PDFPageProxy;
  canvas: HTMLCanvasElement;
  /** CSS pixels per PDF point. */
  scale: number;
  /** Total rotation to bake into the raster (page /Rotate + user rotation). */
  rotation: number;
  /** Device pixel ratio to render at (capped internally). */
  dpr: number;
  /** Lower sorts first. */
  priority: number;
  /** Optional-content (layer) configuration from the engine. */
  optionalContentConfig?: unknown;
  /** Render annotations that live in the file itself (links, widgets, stamps). */
  annotationMode?: number;
  onDone?: () => void;
  onError?: (e: unknown) => void;
}

interface Job extends RenderRequest {
  cancelled: boolean;
  task: { cancel: () => void; promise: Promise<void> } | null;
}

/**
 * The effective device pixel ratio: the display's, clamped so a very large page
 * at a very high zoom cannot blow the canvas budget.
 */
export function effectiveDpr(widthPt: number, heightPt: number, scale: number, dpr: number): number {
  const capped = clamp(dpr, 1, 3);
  const px = widthPt * heightPt * scale * scale;
  if (px <= 0) return capped;
  const maxDpr = Math.sqrt(MAX_CANVAS_PIXELS / px);
  return clamp(Math.min(capped, maxDpr), 0.5, 3);
}

export class RenderScheduler {
  private queue: Job[] = [];
  private running = new Set<Job>();
  private byKey = new Map<string, Job>();

  /** Queue (or re-queue) a page render. Supersedes any pending job for the key. */
  submit(req: RenderRequest): void {
    this.cancel(req.key);
    const job: Job = { ...req, cancelled: false, task: null };
    this.byKey.set(req.key, job);
    this.queue.push(job);
    this.pump();
  }

  /** Drop a page's pending or in-flight render (it scrolled away, or unmounted). */
  cancel(key: string): void {
    const existing = this.byKey.get(key);
    if (!existing) return;
    existing.cancelled = true;
    existing.task?.cancel();
    this.byKey.delete(key);
    this.queue = this.queue.filter((j) => j !== existing);
    this.running.delete(existing);
  }

  /** Re-prioritise everything still waiting (called while scrolling). */
  reprioritise(score: (key: string) => number): void {
    for (const job of this.queue) job.priority = score(job.key);
  }

  cancelAll(): void {
    for (const key of [...this.byKey.keys()]) this.cancel(key);
  }

  private pump(): void {
    while (this.running.size < MAX_CONCURRENT && this.queue.length) {
      this.queue.sort((a, b) => a.priority - b.priority);
      const job = this.queue.shift()!;
      if (job.cancelled) continue;
      this.running.add(job);
      void this.run(job);
    }
  }

  private async run(job: Job): Promise<void> {
    try {
      const ctx = job.canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("2d context unavailable");

      const viewport = job.page.getViewport({ scale: job.scale * job.dpr, rotation: job.rotation });
      const cssW = Math.floor(viewport.width / job.dpr);
      const cssH = Math.floor(viewport.height / job.dpr);
      job.canvas.width = Math.floor(viewport.width);
      job.canvas.height = Math.floor(viewport.height);
      job.canvas.style.width = `${cssW}px`;
      job.canvas.style.height = `${cssH}px`;

      // Paint white first: PDF pages are opaque, and an un-cleared canvas shows
      // the previous zoom level's pixels while the new render lands.
      ctx.save();
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, job.canvas.width, job.canvas.height);
      ctx.restore();

      if (job.cancelled) return;
      const task = job.page.render({
        canvas: job.canvas,
        canvasContext: ctx,
        viewport,
        optionalContentConfigPromise: job.optionalContentConfig
          ? Promise.resolve(job.optionalContentConfig as never)
          : undefined,
        annotationMode: job.annotationMode as never,
      });
      job.task = task as unknown as Job["task"];
      await task.promise;
      if (!job.cancelled) job.onDone?.();
    } catch (e) {
      const name = (e as { name?: string } | undefined)?.name;
      if (!job.cancelled && name !== "RenderingCancelledException") job.onError?.(e);
    } finally {
      this.running.delete(job);
      if (this.byKey.get(job.key) === job) this.byKey.delete(job.key);
      this.pump();
    }
  }
}

/**
 * Render one page to a detached canvas — used for thumbnails, the page
 * organiser, snapshot export and image export. Bypasses the scheduler because
 * these are one-shot and already throttled by an IntersectionObserver.
 */
export async function renderToCanvas(
  page: PDFPageProxy,
  opts: { scale?: number; maxWidth?: number; maxHeight?: number; rotation?: number; background?: string },
): Promise<HTMLCanvasElement> {
  const base = page.getViewport({ scale: 1, rotation: opts.rotation ?? page.rotate });
  let scale = opts.scale ?? 1;
  if (opts.maxWidth) scale = Math.min(scale, opts.maxWidth / base.width);
  if (opts.maxHeight) scale = Math.min(scale, opts.maxHeight / base.height);
  const viewport = page.getViewport({ scale, rotation: opts.rotation ?? page.rotate });
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("2d context unavailable");
  ctx.fillStyle = opts.background ?? "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  return canvas;
}

/** Canvas → blob, promisified. */
export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob failed"))), type, quality);
  });
}
