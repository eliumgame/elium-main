/**
 * Render scheduling for the virtualised viewer — a port of pdf.js'
 * `PDFRenderingQueue` + `PDFPageViewBuffer` (web/pdf_rendering_queue.js,
 * web/pdf_viewer.js), which the viewer bundle does not export.
 *
 * One page raster at a time, highest priority first:
 *   1. the visible pages, most visible first;
 *   2. then their "detail" views (the sharp tile pdf.js paints over the visible
 *      part of a page too large to rasterise whole at the current zoom);
 *   3. then the next page(s) in the scroll direction, so scrolling on finds
 *      them ready.
 * Rendering is cooperative: pdf.js calls the view's `onContinue` hook between
 * chunks of drawing operations, and `BasePDFPageView` pauses its render there
 * when `isHighestPriority(view)` turns false — i.e. when the user scrolled
 * something more important into view. The paused render resumes later instead
 * of restarting.
 *
 * Nothing here touches the DOM or pdf.js directly, so the policy is tested
 * with plain objects.
 */

/** pdf.js `RenderingStates`. */
export const RenderingState = {
  INITIAL: 0,
  RUNNING: 1,
  PAUSED: 2,
  FINISHED: 3,
} as const;

/** What the queue needs from a pdf.js page view (`PDFPageView` / `PDFPageDetailView`). */
export interface QueueView {
  renderingId: string;
  renderingState: number;
  resume: (() => void) | null;
  draw(): Promise<unknown>;
  detailView?: QueueView | null;
}

const isFinished = (v: QueueView) => v.renderingState === RenderingState.FINISHED;

/**
 * The next view to draw: `visible` is most-visible-first, `ahead` the
 * pre-render candidates in the order they should be tried. Mirrors
 * `PDFRenderingQueue.getHighestPriority`.
 */
export function chooseNext(
  visible: readonly QueueView[],
  ahead: readonly QueueView[],
  ignoreDetailViews = false,
): QueueView | null {
  for (const v of visible) if (!isFinished(v)) return v;
  if (!ignoreDetailViews) {
    for (const v of visible) {
      const d = v.detailView;
      if (d && !isFinished(d)) return d;
    }
  }
  for (const v of ahead) if (!isFinished(v)) return v;
  return null;
}

const isCancelled = (e: unknown) => (e as { name?: string } | null)?.name === "RenderingCancelledException";

export class RenderQueue {
  private highest: string | null = null;
  private scheduled = false;
  private stopped = false;

  /**
   * @param pick     returns the view that should render now (see `chooseNext`), or null when idle.
   * @param onError  a render failed for another reason than being cancelled.
   */
  constructor(
    private readonly pick: () => QueueView | null,
    private readonly onError: (e: unknown) => void = () => {},
  ) {
    // `PDFPageView` checks `renderingQueue.hasViewer()` to know it is driven by
    // a viewer (and must not set `--scale-factor` on its container itself).
    // pdf.js defines it as an own, non-enumerable property; so do we.
    Object.defineProperty(this, "hasViewer", { value: () => true });
  }

  /** Asked by the page view between chunks of drawing: keep going, or pause? */
  isHighestPriority(view: { renderingId: string }): boolean {
    return this.highest === view.renderingId;
  }

  /** Coalesce several triggers (scroll, zoom, a page finishing) into one pick. */
  schedule(): void {
    if (this.scheduled || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.renderHighestPriority();
    });
  }

  renderHighestPriority(): void {
    if (this.stopped) return;
    const view = this.pick();
    if (view) this.renderView(view);
    else this.highest = null;
  }

  /** Returns false when the view had nothing to do. */
  renderView(view: QueueView): boolean {
    switch (view.renderingState) {
      case RenderingState.FINISHED:
        return false;
      case RenderingState.PAUSED:
        this.highest = view.renderingId;
        view.resume?.();
        break;
      case RenderingState.RUNNING:
        this.highest = view.renderingId;
        break;
      case RenderingState.INITIAL:
        this.highest = view.renderingId;
        view
          .draw()
          .finally(() => this.schedule())
          .catch((e) => {
            if (!isCancelled(e)) this.onError(e);
          });
        break;
    }
    return true;
  }

  stop(): void {
    this.stopped = true;
    this.highest = null;
  }
}

/**
 * The rendered pages kept in memory — a port of `PDFPageViewBuffer`. A view is
 * pushed when it starts drawing; past `size`, the least recently used one is
 * evicted (its canvas freed). `resize(n, keep)` first refreshes the views in
 * `keep` (the visible ones), so they are never the ones evicted.
 */
export class ViewBuffer<T> {
  private buf = new Set<T>();

  constructor(
    private size: number,
    private readonly onEvict: (item: T) => void,
  ) {}

  get length(): number {
    return this.buf.size;
  }

  push(item: T): void {
    this.buf.delete(item);
    this.buf.add(item);
    this.trim();
  }

  resize(size: number, keep?: ReadonlySet<T>): void {
    this.size = size;
    if (keep?.size) {
      for (const item of [...this.buf]) {
        if (keep.has(item)) {
          this.buf.delete(item);
          this.buf.add(item);
        }
      }
    }
    this.trim();
  }

  has(item: T): boolean {
    return this.buf.has(item);
  }

  delete(item: T): boolean {
    return this.buf.delete(item);
  }

  clear(): void {
    this.buf.clear();
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.buf.values();
  }

  private trim(): void {
    while (this.buf.size > this.size) {
      const first = this.buf.values().next().value as T;
      this.buf.delete(first);
      this.onEvict(first);
    }
  }
}

/** pdf.js keeps at least 10 rendered pages, more when many are on screen at once. */
export const bufferSizeFor = (visibleCount: number): number => Math.max(10, 2 * visibleCount + 1);
