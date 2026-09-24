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
 *
 * Thumbnails never compete with the page view — what pdf.js' own viewer does
 * with its single `PDFRenderingQueue`, where a thumbnail is only drawn once no
 * page is left to draw:
 *  - while the page view has something to draw (a visible page, its detail
 *    tile, the next page) or something is being scrolled, no thumbnail starts,
 *    and one already drawing pauses at its next chunk (`onContinue`);
 *  - the thumbnail of a page the page view has drawn is copied from that
 *    raster (one GPU downscale) instead of being drawn again — pdf.js'
 *    `PDFThumbnailView.setImage`.
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

interface RenderTaskLike {
  cancel: () => void;
  promise: Promise<void>;
  onContinue?: ((cont: () => void) => void) | null;
}

interface Job {
  key: string;
  req: ThumbRequest;
  listeners: Set<Listener>;
  task: RenderTaskLike | null;
  cancelled: boolean;
}

/**
 * Where a thumbnail can be copied from instead of drawn: the finished raster
 * of a page view showing source page `from` at total rotation `rotation`
 * exactly as the file shows it (no Elium mask, no hidden layer), or null.
 */
export type RasterSource = (from: number, rotation: number) => HTMLCanvasElement | null;

/** Cached thumbnails, in device pixels (≈ 60 A4 thumbnails of 264 px wide). */
const DEFAULT_PIXEL_BUDGET = 6_000_000;
/** Renders in flight — thumbnails must never starve the main page rasters. */
const CONCURRENCY = 1;
/** After the last scroll (page view, thumbnail list, organiser), thumbnails wait this long. */
export const SCROLL_QUIET_MS = 150;

export const thumbKey = (r: Pick<ThumbRequest, "from" | "rotation" | "width">, salt = ""): string =>
  `${r.from}:${r.rotation}:${Math.round(r.width)}${salt ? `:${salt}` : ""}`;

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** A raster big enough to be downscaled into this thumbnail (never upscale). */
const bigEnough = (raster: { width: number }, req: ThumbRequest) => raster.width >= req.width * 0.9;

export class ThumbnailService {
  private cache = new Map<string, ImageBitmap>();
  private pixels = 0;
  private pending = new Map<string, Job>();
  private running = new Set<Job>();
  private scratch: HTMLCanvasElement | null = null;
  private destroyed = false;
  /** Bumped when the document's appearance changes (imported markup masked…). */
  private salt = "";
  /** The page view has pages left to draw. */
  private mainBusy = false;
  /** No thumbnail work before this time: a scroll is under way. */
  private quietUntil = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Renders paused at a chunk boundary while held. */
  private parked: (() => void)[] = [];
  /** `whenIdle` callbacks waiting for the hold to lift. */
  private idleWaiters = new Set<() => void>();
  private source: RasterSource | null = null;
  private pumpQueued = false;

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
    let job = this.pending.get(key) ?? [...this.running].find((j) => j.key === key && !j.cancelled);
    if (!job) {
      job = { key, req, listeners: new Set(), task: null, cancelled: false };
      this.pending.set(key, job);
    } else if (req.priority < job.req.priority) {
      job.req = { ...job.req, priority: req.priority };
    }
    job.listeners.add(onReady);
    this.schedulePump();
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

  // -- coordination with the page view ----------------------------------------

  /** The page view has (or no longer has) pages to draw: thumbnails wait for it. */
  setMainBusy(busy: boolean): void {
    if (busy === this.mainBusy) return;
    this.mainBusy = busy;
    if (!busy) this.wake();
  }

  /** Something scrolled: thumbnails wait until it has been quiet for `SCROLL_QUIET_MS`. */
  noteScroll(): void {
    if (this.destroyed) return;
    this.quietUntil = now() + SCROLL_QUIET_MS;
    this.armWake();
  }

  /** Is thumbnail work held back right now? */
  get held(): boolean {
    return this.mainBusy || now() < this.quietUntil;
  }

  /**
   * Run `fn` once the page view is idle and nothing scrolls (what thumbnails
   * wait for), or after `maxWait` ms at the latest — for work that should not
   * compete with the pages being drawn (the pane following the current page).
   * Returns the cancel function.
   */
  whenIdle(fn: () => void, maxWait: number): () => void {
    let done = false;
    const fire = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.idleWaiters.delete(fire);
      fn();
    };
    const timer = setTimeout(fire, maxWait);
    // Decided after the current task's microtasks: the page view learns what it
    // has to draw in one (a jump's target is picked right after the jump), and
    // React may run this from an effect flushed before it.
    queueMicrotask(() => {
      if (done) return;
      if (this.held && !this.destroyed) this.idleWaiters.add(fire);
      else fire();
    });
    return () => {
      done = true;
      clearTimeout(timer);
      this.idleWaiters.delete(fire);
    };
  }

  /** Register the page view's rasters as a source (see `RasterSource`). Returns the detach function. */
  attachSource(source: RasterSource): () => void {
    this.source = source;
    return () => {
      if (this.source === source) this.source = null;
    };
  }

  /**
   * The page view just finished drawing source page `from` at `rotation`:
   * the thumbnails waiting for that page are copied from its raster, now.
   */
  offer(from: number, rotation: number, raster: HTMLCanvasElement): void {
    if (this.destroyed) return;
    const jobs = [...this.pending.values(), ...this.running].filter(
      (j) => !j.cancelled && j.req.from === from && j.req.rotation === rotation && bigEnough(raster, j.req),
    );
    for (const job of jobs) {
      if (this.pending.get(job.key) === job) this.pending.delete(job.key);
      else {
        // Drawing it ourselves is now pointless; its listeners are served here.
        job.cancelled = true;
        job.task?.cancel();
      }
      void this.derive(raster, job.req).then(
        (bmp) => this.deliver(job, bmp),
        () => {},
      );
    }
  }

  private armWake(): void {
    if (this.wakeTimer || this.destroyed) return;
    const wait = Math.max(0, this.quietUntil - now());
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      if (now() < this.quietUntil) this.armWake();
      else this.wake();
    }, wait + 1);
  }

  private wake(): void {
    if (this.destroyed || this.held) return;
    for (const fire of [...this.idleWaiters]) fire();
    const parked = this.parked;
    this.parked = [];
    for (const cont of parked) cont();
    this.pump();
  }

  private clearCache(): void {
    for (const bmp of this.cache.values()) bmp.close();
    this.cache.clear();
    this.pixels = 0;
  }

  /**
   * Requests come from React effects, which may run before the page view has
   * learnt (in a microtask) what it has to draw — right after a jump, say:
   * decide once those have run, and serve a whole batch of requests at once.
   */
  private schedulePump(): void {
    if (this.pumpQueued) return;
    this.pumpQueued = true;
    queueMicrotask(() => {
      this.pumpQueued = false;
      this.pump();
    });
  }

  private pump(): void {
    if (this.destroyed || !this.pending.size) return;
    if (this.held) {
      // `setMainBusy(false)` or the end of the scroll wakes us.
      if (!this.mainBusy) this.armWake();
      return;
    }
    while (this.running.size < CONCURRENCY && this.pending.size) {
      let best: Job | null = null;
      for (const job of this.pending.values()) if (!best || job.req.priority < best.req.priority) best = job;
      if (!best) return;
      this.pending.delete(best.key);
      this.running.add(best);
      void this.run(best);
    }
  }

  private deliver(job: Job, bitmap: ImageBitmap): void {
    if (this.destroyed) {
      bitmap.close();
      return;
    }
    this.store(job.key, bitmap);
    for (const l of job.listeners) l(bitmap);
  }

  private async run(job: Job): Promise<void> {
    let drew = false;
    try {
      // Already drawn by the page view: copy it rather than draw it again.
      const raster = this.source?.(job.req.from, job.req.rotation);
      if (raster && bigEnough(raster, job.req)) {
        const bitmap = await this.derive(raster, job.req);
        if (job.cancelled || this.destroyed) bitmap.close();
        else this.deliver(job, bitmap);
        return;
      }
      const page = await this.engine.page(job.req.from);
      if (job.cancelled || this.destroyed) return;
      drew = true;
      const bitmap = await this.render(page, job);
      if (!bitmap) return;
      if (job.cancelled || this.destroyed) {
        bitmap.close();
        return;
      }
      this.deliver(job, bitmap);
    } catch {
      /* cancelled, or a page that cannot be drawn: it keeps its placeholder */
    } finally {
      this.running.delete(job);
      // The bitmap is all a thumbnail needs: let pdf.js drop the page's
      // operator list and decoded images — unless the page view retains the
      // page (`retainPage`: every page mounted there, pre-rendered ones too).
      if (drew) this.engine.releasePageResources(job.req.from);
      this.pump();
    }
  }

  /** A thumbnail-sized copy of a finished page raster: a GPU downscale, no pdf.js work. */
  private derive(raster: HTMLCanvasElement, req: ThumbRequest): Promise<ImageBitmap> {
    const width = Math.max(1, Math.round(req.width));
    const height = Math.max(1, Math.round((raster.height * width) / Math.max(1, raster.width)));
    // The pixels are snapshotted synchronously: the raster may be reset right after.
    return createImageBitmap(raster, { resizeWidth: width, resizeHeight: height, resizeQuality: "high" });
  }

  private async render(page: PDFPageProxy, job: Job): Promise<ImageBitmap | null> {
    const base = page.getViewport({ scale: 1, rotation: job.req.rotation });
    const scale = Math.max(0.05, job.req.width / Math.max(1, base.width));
    const viewport = page.getViewport({ scale, rotation: job.req.rotation });
    const canvas = (this.scratch ??= document.createElement("canvas"));
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    // NOT `alpha: false`: on an opaque canvas Chromium draws text with LCD
    // (sub-pixel) anti-aliasing, whose colour fringes turn into red/blue
    // specks at thumbnail size. The white fill below keeps it opaque anyway.
    const ctx = canvas.getContext("2d", { willReadFrequently: false });
    if (!ctx) return null;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // A thumbnail shows the file as it is: lift the imported-markup mask the
    // main view applies (pdf.js reads it synchronously when the render starts).
    const start = () => page.render({ canvas, canvasContext: ctx, viewport, intent: "display" });
    const mask = ImportedAnnotationMask.peek(this.engine);
    const task = (mask ? mask.unmasked(start) : start()) as unknown as RenderTaskLike;
    // Cooperative: pdf.js asks before each chunk of drawing (≈ 15 ms); while
    // the page view needs the main thread, or a scroll runs, the rest waits.
    task.onContinue = (cont) => {
      if (this.held && !this.destroyed) this.parked.push(cont);
      else cont();
    };
    job.task = task;
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
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = null;
    for (const job of this.running) {
      job.cancelled = true;
      job.task?.cancel();
    }
    this.parked = [];
    this.idleWaiters.clear();
    this.pending.clear();
    this.source = null;
    this.clearCache();
    if (this.scratch) this.scratch.width = this.scratch.height = 0;
    this.scratch = null;
  }
}

/**
 * Height / width of a page as its thumbnail shows it, and the rotation to bake
 * in (the page's own /Rotate + the user's; an Elium crop is not applied — a
 * thumbnail shows the whole page, as before). Clamped so an absurd page box
 * cannot produce a 10 000 px tall list item.
 */
export function thumbAspect(
  engine: PdfEngine,
  page: { from: number | null; rotate?: number; size?: { w: number; h: number } },
): { aspect: number; rotation: number } {
  const info = page.from != null ? engine.pages[page.from] : undefined;
  const own = info?.rotate ?? 0;
  const rotation = (((own + (page.rotate ?? 0)) % 360) + 360) % 360;
  const w = info?.w ?? page.size?.w ?? 595;
  const h = info?.h ?? page.size?.h ?? 842;
  const aspect = rotation % 180 === 0 ? h / Math.max(1, w) : w / Math.max(1, h);
  return { aspect: Number.isFinite(aspect) && aspect > 0 ? Math.min(8, Math.max(0.125, aspect)) : 1.414, rotation };
}

/** One thumbnail service per open document, shared by the side panel and the organiser. */
const services = new WeakMap<PdfEngine, ThumbnailService>();

export function thumbnailsFor(engine: PdfEngine): ThumbnailService {
  let s = services.get(engine);
  if (!s) {
    s = new ThumbnailService(engine);
    services.set(engine, s);
  }
  return s;
}

/** The document is closing: free its cached thumbnails (and page pictures) now rather than at the next GC. */
export function releaseThumbnails(engine: PdfEngine): void {
  services.get(engine)?.destroy();
  services.delete(engine);
  releasePictures();
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

/**
 * Decoded pictures of inserted pages, most recently used last. A bitmap is at
 * full resolution (a 12 Mpx photo ≈ 48 MB), so the memo is small and every
 * bitmap leaving it is `close()`d rather than left to the GC.
 */
const pictures = new Map<string, Promise<ImageBitmap>>();
const MAX_PICTURES = 12;

const closeLater = (p: Promise<ImageBitmap>) =>
  void p.then(
    (bmp) => bmp.close(),
    () => {},
  );

/** `bitmapFromDataUrl`, memoised (a page picture is drawn by the page, its thumbnail and the organiser). */
export function pictureBitmap(url: string): Promise<ImageBitmap> {
  let p = pictures.get(url);
  if (p) {
    // LRU touch.
    pictures.delete(url);
    pictures.set(url, p);
    return p;
  }
  p = bitmapFromDataUrl(url);
  const mine = p;
  p.catch(() => {
    if (pictures.get(url) === mine) pictures.delete(url);
  });
  pictures.set(url, p);
  while (pictures.size > MAX_PICTURES) {
    const [oldest, old] = pictures.entries().next().value as [string, Promise<ImageBitmap>];
    pictures.delete(oldest);
    // Callers draw a picture as soon as its promise settles, and their
    // reactions were registered before this one: closing now cannot pull a
    // bitmap from under a pending draw (and `drawContained` survives it).
    closeLater(old);
  }
  return p;
}

/** Free every decoded picture (the document closed; a later draw decodes again). */
export function releasePictures(): void {
  for (const p of pictures.values()) closeLater(p);
  pictures.clear();
}

/**
 * Draw `bitmap` into `canvas`, contained (letter-boxed) and centred, at the
 * canvas' own pixel size.
 */
export function drawContained(canvas: HTMLCanvasElement, bitmap: ImageBitmap, background = "#ffffff"): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  // A closed bitmap (evicted from a cache) has no size: keep what is shown.
  if (!bitmap.width || !bitmap.height) return;
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const k = Math.min(canvas.width / bitmap.width, canvas.height / bitmap.height);
  const w = bitmap.width * k;
  const h = bitmap.height * k;
  ctx.imageSmoothingQuality = "high";
  try {
    ctx.drawImage(bitmap, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  } catch {
    /* closed meanwhile: the next request draws a fresh one */
  }
}
