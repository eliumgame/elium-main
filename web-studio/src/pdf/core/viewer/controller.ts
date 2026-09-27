/**
 * `PageViewController` — owns the pdf.js `PDFPageView`s of the virtualised
 * viewer (one per page *slot* currently mounted, plus the last rendered ones
 * kept warm), their render queue, their LRU buffer, and the glue between them
 * and Elium: link clicks, the text layer handed to the selection code, layer
 * (optional content) visibility and the imported-annotation mask.
 *
 * The React side (`ui/PageStack.tsx`) decides WHICH pages exist in the DOM and
 * WHERE; this class decides what gets rasterised, in which order, and when a
 * canvas is thrown away. It mirrors what pdf.js' own `PDFViewer` does for
 * Firefox, minus the parts Elium replaces (layout, scrolling, navigation):
 *
 *  - a view is created once its page proxy is loaded (and its imported-markup
 *    ids are known, so a masked comment is never painted, not even once);
 *  - zooming calls `PDFPageView.update({ scale })`: the page div resizes at
 *    once through `--scale-factor`, the existing canvas is stretched by CSS,
 *    and a sharp re-render replaces it (immediately, or after `drawingDelay`
 *    ms of quiet during a Ctrl+wheel / pinch gesture);
 *  - past `maxCanvasPixels` pdf.js renders the page at a lower resolution and
 *    adds a detail canvas (tile) over the visible area — `setVisible` feeds it
 *    the visible rectangle of every page on screen.
 */

import { pdfjs } from "../pdfjs";
import type { PDFPageProxy } from "pdfjs-dist";
import type { PdfEngine } from "../engine";
import { pdfjsAssetBase } from "../assets";
import { thumbnailsFor, type ThumbnailService } from "../thumbs";
import { FormSession } from "../forms/session";
import { ImportedAnnotationMask } from "./annotmask";
import { EliumLinkService, type LinkHandlers } from "./links";
import { NO_L10N, PDF_TO_CSS_UNITS, canvasBudget, type ViewerLib } from "./lib";
import { RenderQueue, RenderingState, ViewBuffer, bufferSizeFor, chooseNext, type QueueView } from "./queue";

/** The slice of `PDFPageView` this controller relies on (the .d.ts types it as mostly `any`). */
export interface PageViewLike extends QueueView {
  id: number;
  div: HTMLDivElement;
  scale: number;
  rotation: number;
  pdfPage: PDFPageProxy | null;
  textLayer: { div: HTMLDivElement } | null;
  /** pdf.js: the finished raster when it shows the page as the file does (no postponed zoom, initial layers). */
  readonly thumbnailCanvas: HTMLCanvasElement | null;
  detailView: (QueueView & { update(args: { underlyingViewUpdated?: boolean }): void }) | null;
  setPdfPage(page: PDFPageProxy): void;
  update(args: {
    scale?: number;
    rotation?: number | null;
    optionalContentConfigPromise?: Promise<unknown> | null;
    drawingDelay?: number;
  }): void;
  updateVisibleArea(area: { minX: number; minY: number; maxX: number; maxY: number } | null): void;
  reset(opts?: {
    keepAnnotationLayer?: boolean;
    keepAnnotationEditorLayer?: boolean;
    keepXfaLayer?: boolean;
    keepTextLayer?: boolean;
    keepCanvasWrapper?: boolean;
    preserveDetailViewState?: boolean;
  }): void;
  cancelRendering(): void;
  destroy(): void;
}

/** Placement of one slot's page view. */
export interface SlotSpec {
  /** Total rotation of the page on screen (its own /Rotate + user + view rotation). */
  rotation: number;
}

export interface VisibleSlot {
  key: string;
  /** Visible part of the page view, in its own CSS px, or null when it is fully on screen. */
  visibleArea: { minX: number; minY: number; maxX: number; maxY: number } | null;
}

export interface ControllerOptions {
  engine: PdfEngine;
  lib: ViewerLib;
  links: LinkHandlers;
  /** A page's text layer appeared (or went away: `null`). */
  onTextLayer?: (key: string, layer: HTMLDivElement | null) => void;
  /** A page finished a full (not CSS-only, not detail) render. */
  onPageRendered?: (key: string) => void;
  /** A page's raster was freed (LRU eviction while its slot is still mounted). */
  onPageCleared?: (key: string) => void;
}

interface Entry {
  key: string;
  from: number;
  /** pdf.js page id — unique per view (two slots may show the same source page). */
  id: number;
  view: PageViewLike | null;
  host: HTMLElement | null;
  rotation: number;
  creating: boolean;
  /** Its page could not be loaded: nothing will ever be drawn here. */
  failed: boolean;
  /** Releases the engine-level hold on the page's rendering resources. */
  release: (() => void) | null;
  /** The raster being drawn hides imported markup (so it is not the file's own look). */
  masked: boolean;
}

const RENDER_TEXT_LAYER = 1; // TextLayerMode.ENABLE

/**
 * Stand-in for pdf.js' `TextAccessibilityManager`. The real one sorts every
 * text layer's spans by their on-screen position (`getBoundingClientRect`,
 * n log n times — a forced layout for each page drawn) so as to thread the
 * HTML annotations (comment popups, form widgets) into the reading order for
 * screen readers. Elium hides those (its own layers show comments and fields)
 * and the spans keep their DOM order, so the sort is pure cost.
 */
const NO_TEXT_A11Y = {
  setTextMapping() {},
  enable() {},
  disable() {},
  addPointerInTextLayer() {},
  removePointerInTextLayer() {},
  moveElementInDOM() {
    return null;
  },
};

export class PageViewController {
  private readonly engine: PdfEngine;
  private readonly lib: ViewerLib;
  private readonly opts: ControllerOptions;
  private readonly entries = new Map<string, Entry>();
  private readonly byView = new Map<PageViewLike, Entry>();
  private readonly buffer: ViewBuffer<Entry>;
  private readonly queue: RenderQueue;
  private readonly eventBus: InstanceType<ViewerLib["EventBus"]>;
  private readonly abort = new AbortController();
  private readonly linkService: EliumLinkService;
  private readonly layerProperties: Record<string, unknown>;
  private readonly imageResourcesPath: string;
  private readonly thumbs: ThumbnailService;
  private readonly detachRasters: () => void;
  readonly mask: ImportedAnnotationMask;
  /** The document's AcroForm link (values ⇄ model, scripts). */
  readonly forms: FormSession;
  private readonly detachForms: () => void;

  private scale = 1;
  private optionalContent: Promise<unknown> | null = null;
  private visible: VisibleSlot[] = [];
  private ahead: string[] = [];
  private scaleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private destroyed = false;

  constructor(opts: ControllerOptions) {
    this.opts = opts;
    this.engine = opts.engine;
    this.lib = opts.lib;
    this.mask = ImportedAnnotationMask.for(opts.engine);
    this.forms = FormSession.for(opts.engine);
    this.buffer = new ViewBuffer<Entry>(bufferSizeFor(0), (e) => this.evict(e));
    this.queue = new RenderQueue(
      () => this.pick(),
      (e) => console.warn("[pdf] rendu de page impossible", e),
    );
    this.eventBus = new opts.lib.EventBus();
    this.linkService = new EliumLinkService(opts.links);
    this.linkService.eventBus = this.eventBus;
    // The form layer: pdf.js renders the document's fields as real controls
    // bound to its annotationStorage (`FormSession` keeps that in step with
    // Elium's model); `enableScripting` is settled (`forms.layerReady`)
    // before the first view is created.
    this.layerProperties = {
      annotationEditorUIManager: null,
      annotationStorage: (opts.engine.raw as unknown as { annotationStorage?: unknown }).annotationStorage ?? null,
      downloadManager: null,
      enableScripting: false,
      fieldObjectsPromise: this.forms.fieldObjects,
      findController: null,
      hasJSActionsPromise: this.forms.hasJSActions,
      linkService: this.linkService,
    };
    void this.forms.layerReady.then((enabled) => {
      this.layerProperties.enableScripting = enabled;
    });
    const base = pdfjsAssetBase();
    this.imageResourcesPath = base ? `${base}images/` : "";
    // Thumbnails wait while pages are left to draw here, and are copied from
    // the rasters drawn here rather than drawn a second time.
    this.thumbs = thumbnailsFor(opts.engine);
    this.detachRasters = this.thumbs.attachSource((from, rotation) => this.rasterOf(from, rotation));

    const on = (name: string, fn: (evt: { source: unknown }) => void) =>
      this.eventBus.on(name, fn as never, { signal: this.abort.signal } as never);
    // A view starts drawing → it now holds a canvas: track it in the LRU.
    on("pagerender", ({ source }) => {
      const entry = this.byView.get(source as PageViewLike);
      if (!entry) return;
      this.buffer.push(entry);
      // pdf.js has just read the mask (synchronously, as the render started).
      entry.masked = this.mask.affects(entry.from);
    });
    on("pagerendered", (evt) => {
      const e = evt as { source: unknown; cssTransform?: boolean; isDetailView?: boolean };
      if (e.cssTransform || e.isDetailView) return;
      const entry = this.byView.get(e.source as PageViewLike);
      if (!entry) return;
      // The first raster at a new size is what tells pdf.js whether the page
      // needs a detail (tile) canvas: offer it the visible area again now.
      const visible = this.visible.find((v) => v.key === entry.key);
      if (visible && entry.view) entry.view.updateVisibleArea(visible.visibleArea);
      this.opts.onPageRendered?.(entry.key);
      const raster = entry.masked ? null : entry.view?.thumbnailCanvas;
      if (raster?.width) this.thumbs.offer(entry.from, entry.rotation, raster);
    });
    const offIds = this.mask.onPageIds((from) => {
      if (!this.mask.enabled) return;
      for (const entry of this.entries.values()) if (entry.from === from && entry.view) this.redraw(entry.view);
      this.queue.schedule();
    });
    this.abort.signal.addEventListener("abort", offIds);
    this.detachForms = this.forms.attachViewer({
      eventBus: this.eventBus as never,
      refresh: (pages) => this.refreshForms(pages),
      currentPage: () => opts.links.currentSourcePage(),
    });
    on("textlayerrendered", ({ source }) => {
      const entry = this.byView.get(source as PageViewLike);
      const div = entry?.view?.textLayer?.div;
      if (entry?.host && div) this.opts.onTextLayer?.(entry.key, div);
    });
  }

  // -------------------------------------------------------------------------
  // slots
  // -------------------------------------------------------------------------

  /** A slot for source page `from` was mounted: attach (or create) its view inside `host`. */
  mount(key: string, from: number, host: HTMLElement, spec: SlotSpec): void {
    if (this.destroyed) return;
    let entry = this.entries.get(key);
    if (entry && entry.from !== from) {
      this.drop(entry);
      entry = undefined;
    }
    if (!entry) {
      entry = {
        key,
        from,
        id: this.nextId++,
        view: null,
        host,
        rotation: spec.rotation,
        creating: false,
        failed: false,
        release: null,
        masked: false,
      };
      this.entries.set(key, entry);
    }
    entry.host = host;
    if (entry.view) {
      if (entry.view.div.parentElement !== host) host.append(entry.view.div);
      this.applySpec(entry, spec);
      if (entry.view.renderingState === RenderingState.FINISHED) {
        // A cached raster: shown instantly, no re-render.
        this.opts.onPageRendered?.(key);
        const div = entry.view.textLayer?.div;
        if (div) this.opts.onTextLayer?.(key, div);
      }
      this.queue.schedule();
      return;
    }
    entry.rotation = spec.rotation;
    if (!entry.creating) void this.create(entry);
  }

  /** The slot left the DOM. A finished raster stays cached (LRU); anything in progress is cancelled. */
  unmount(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.host = null;
    this.opts.onTextLayer?.(key, null);
    const view = entry.view;
    if (!view) return;
    view.div.remove();
    if (view.renderingState !== RenderingState.FINISHED) {
      view.reset();
      this.buffer.delete(entry);
    }
    if (!this.buffer.has(entry)) this.drop(entry);
  }

  /** Rotation of a mounted slot changed. */
  setSpec(key: string, spec: SlotSpec): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (!entry.view) {
      entry.rotation = spec.rotation;
      return;
    }
    this.applySpec(entry, spec);
  }

  private applySpec(entry: Entry, spec: SlotSpec): void {
    const view = entry.view!;
    const userRotation = this.userRotation(view, spec.rotation);
    const cssScale = this.scale / PDF_TO_CSS_UNITS;
    entry.rotation = spec.rotation;
    if (view.rotation !== userRotation || Math.abs(view.scale - cssScale) > 1e-9) {
      view.update({ scale: cssScale, rotation: userRotation });
      this.queue.schedule();
    }
  }

  /** pdf.js adds the page's own /Rotate itself; it wants the extra rotation only. */
  private userRotation(view: PageViewLike, total: number): number {
    const own = view.pdfPage?.rotate ?? 0;
    return (((total - own) % 360) + 360) % 360;
  }

  private async create(entry: Entry): Promise<void> {
    entry.creating = true;
    let page: PDFPageProxy;
    try {
      page = await this.engine.page(entry.from);
      // Imported markup is painted by Elium: while the mask is on, know the
      // page's ids before its first frame (one worker round trip). While it is
      // off (nothing imported, or the import still running) the ids are only
      // gathered in the background — `onPageIds` redraws the page should the
      // mask be switched on before they arrive.
      const ids = this.mask.ensure(entry.from);
      if (this.mask.enabled) await ids;
      // Whether the form layer wires the scripts must be known before it is built.
      await this.forms.layerReady;
    } catch {
      entry.creating = false;
      entry.failed = true;
      this.queue.schedule();
      return;
    }
    entry.creating = false;
    if (this.destroyed || this.entries.get(entry.key) !== entry || !entry.host) {
      if (this.entries.get(entry.key) === entry && !entry.host) this.entries.delete(entry.key);
      return;
    }
    const budget = canvasBudget();
    const cssScale = this.scale / PDF_TO_CSS_UNITS;
    const own = page.rotate ?? 0;
    const userRotation = (((entry.rotation - own) % 360) + 360) % 360;
    const view = new this.lib.PDFPageView({
      container: null,
      eventBus: this.eventBus,
      id: entry.id,
      scale: cssScale,
      defaultViewport: page.getViewport({ scale: this.scale, rotation: (own + userRotation) % 360 }),
      optionalContentConfigPromise: this.optionalContent ?? undefined,
      renderingQueue: this.queue,
      textLayerMode: RENDER_TEXT_LAYER,
      // Form fields are live HTML controls (pdf.js' form layer, filled into
      // the annotationStorage); every other appearance is painted on the
      // canvas. The HTML layer also carries the link areas.
      annotationMode: pdfjs.AnnotationMode.ENABLE_FORMS,
      imageResourcesPath: this.imageResourcesPath,
      enableDetailCanvas: true,
      maxCanvasPixels: budget.maxCanvasPixels,
      maxCanvasDim: budget.maxCanvasDim,
      capCanvasAreaFactor: budget.capCanvasAreaFactor,
      enableAutoLinking: true,
      // Native ::selection, styled by Elium — not pdf.js' drawn selection.
      enableSelectionRendering: false,
      layerProperties: this.layerProperties,
      abortSignal: this.abort.signal,
      l10n: NO_L10N,
    } as never) as unknown as PageViewLike;
    view.rotation = userRotation;
    // `draw()` keeps a manager already there (`||=`).
    (view as unknown as { _accessibilityManager: unknown })._accessibilityManager = NO_TEXT_A11Y;
    view.setPdfPage(page);
    view.div.removeAttribute("role");
    view.div.removeAttribute("data-l10n-id");
    entry.view = view;
    entry.release = this.engine.retainPage(entry.from);
    this.byView.set(view, entry);
    entry.host.append(view.div);
    this.queue.schedule();
  }

  /** Forget a view entirely (its canvas and page resources are released). */
  private drop(entry: Entry): void {
    if (entry.view) {
      this.byView.delete(entry.view);
      entry.view.div.remove();
      // Not `view.destroy()`: it would `cleanup()` the shared page proxy even
      // while another slot (a duplicated page) or a thumbnail still uses it.
      entry.view.reset();
      entry.view = null;
      entry.release?.();
      entry.release = null;
      this.engine.releasePageResources(entry.from);
      this.opts.onPageCleared?.(entry.key);
    }
    this.buffer.delete(entry);
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
  }

  /** LRU eviction: free the canvas; a view no longer on screen is dropped. */
  private evict(entry: Entry): void {
    if (!entry.view) return;
    if (!entry.host) {
      this.drop(entry);
      return;
    }
    entry.view.reset();
    this.opts.onTextLayer?.(entry.key, null);
    this.opts.onPageCleared?.(entry.key);
  }

  // -------------------------------------------------------------------------
  // what is on screen
  // -------------------------------------------------------------------------

  /**
   * The slots on screen (most visible first) and, in order, the ones to
   * pre-render next. Called on every scroll frame.
   */
  setVisible(visible: VisibleSlot[], ahead: string[]): void {
    this.visible = visible;
    this.ahead = ahead;
    const keep = new Set<Entry>();
    for (const v of visible) {
      const entry = this.entries.get(v.key);
      if (!entry?.view) continue;
      keep.add(entry);
      entry.view.updateVisibleArea(v.visibleArea);
    }
    this.buffer.resize(bufferSizeFor(visible.length), keep);
    for (const entry of this.buffer) {
      if (!keep.has(entry)) entry.view?.updateVisibleArea(null);
    }
    this.queue.schedule();
  }

  private pick(): QueueView | null {
    const views = (keys: string[]) => {
      const out: QueueView[] = [];
      for (const k of keys) {
        const view = this.entries.get(k)?.view;
        if (view && this.entries.get(k)?.host) out.push(view);
      }
      return out;
    };
    const next = chooseNext(
      views(this.visible.map((v) => v.key)),
      views(this.ahead),
      // During a zoom gesture only the base rasters are refreshed.
      this.scaleTimer !== null,
    );
    // Thumbnails only get the main thread once nothing is left to draw here
    // (pdf.js' single rendering queue: pages first, thumbnails after) — a
    // visible page whose view is still being created (its page loading from
    // the worker, right after a jump) counts as work to come.
    this.thumbs.setMainBusy(next !== null || this.visible.some((v) => this.awaitsView(v.key)));
    return next;
  }

  /** A visible slot that will get a page view but has none yet. */
  private awaitsView(key: string): boolean {
    const entry = this.entries.get(key);
    if (!entry) return true;
    return !entry.view && !entry.failed;
  }

  /** A finished raster of source page `from` at total rotation `rotation`, as the file shows it. */
  private rasterOf(from: number, rotation: number): HTMLCanvasElement | null {
    for (const entry of this.entries.values()) {
      const view = entry.view;
      if (entry.from !== from || entry.rotation !== rotation || entry.masked || !view) continue;
      if (view.renderingState !== RenderingState.FINISHED) continue;
      const raster = view.thumbnailCanvas;
      if (raster?.width) return raster;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // zoom, layers, markup mask
  // -------------------------------------------------------------------------

  get currentScale(): number {
    return this.scale;
  }

  /**
   * New zoom (CSS px per point). Every view resizes immediately (CSS); the
   * sharp re-render happens now, or — with `drawingDelay` — once the gesture
   * has been quiet for that long.
   */
  setScale(scale: number, drawingDelay = -1): void {
    if (Math.abs(scale - this.scale) < 1e-9 && drawingDelay < 0) return;
    this.scale = scale;
    const cssScale = scale / PDF_TO_CSS_UNITS;
    const postpone = drawingDelay >= 0 && drawingDelay < 1000;
    for (const entry of this.entries.values()) {
      entry.view?.update({ scale: cssScale, drawingDelay: postpone ? drawingDelay : -1 });
    }
    if (this.scaleTimer) clearTimeout(this.scaleTimer);
    this.scaleTimer = null;
    if (postpone) {
      this.scaleTimer = setTimeout(() => {
        this.scaleTimer = null;
        for (const entry of this.entries.values()) entry.view?.update({});
        this.queue.schedule();
      }, drawingDelay);
    }
    this.queue.schedule();
  }

  /** Layer visibility changed (pdf.js `OptionalContentConfig`), or `null` for the document default. */
  setOptionalContent(config: unknown): void {
    if (!config && !this.optionalContent) return;
    // Never hand pdf.js a promise of `null`: `PDFPageView.update` reads
    // `.hasInitialVisibility` off whatever it resolves to.
    this.optionalContent = config
      ? Promise.resolve(config)
      : (this.engine.raw.getOptionalContentConfig() as Promise<unknown>);
    for (const entry of this.entries.values()) {
      if (!entry.view) continue;
      entry.view.update({ optionalContentConfigPromise: this.optionalContent });
      this.redraw(entry.view);
    }
    this.queue.schedule();
  }

  /** Imported markup is (or no longer is) painted by Elium instead of pdf.js. */
  setMaskEnabled(on: boolean): void {
    const changed = new Set(this.mask.setEnabled(on));
    if (!changed.size) return;
    for (const entry of this.entries.values()) {
      if (entry.view && changed.has(entry.from)) this.redraw(entry.view);
    }
    this.queue.schedule();
  }

  /** Re-render every view (e.g. after the document's appearance changed). */
  refreshAll(): void {
    for (const entry of this.entries.values()) if (entry.view) this.redraw(entry.view);
    this.queue.schedule();
  }

  /**
   * Redraw a view whose CONTENT changed (layers, masked markup) at the same
   * size. `PDFPageView.update()` alone is not enough: past the canvas budget
   * (a detail/tile canvas on top of a low-resolution base) it only re-applies
   * the CSS transform and refreshes the tile, leaving stale content in the
   * base raster. This is the reset `update()` does in its normal path: the
   * current raster stays on screen until the new one replaces it.
   */
  private redraw(view: PageViewLike): void {
    view.reset({
      keepAnnotationLayer: true,
      keepAnnotationEditorLayer: true,
      keepXfaLayer: true,
      keepTextLayer: true,
      keepCanvasWrapper: true,
      preserveDetailViewState: true,
    });
    view.detailView?.update({ underlyingViewUpdated: true });
  }

  /**
   * Rebuild the form layer of these source pages from the annotationStorage
   * (after the model changed the values: undo, reset, import). The page is
   * re-rendered with a new form layer; views not on screen simply drop their
   * raster and are rebuilt when shown again.
   */
  refreshForms(pages: ReadonlySet<number>): void {
    if (this.destroyed) return;
    for (const entry of this.entries.values()) {
      const view = entry.view;
      if (!view || !pages.has(entry.from)) continue;
      if (!entry.host) {
        this.drop(entry);
        continue;
      }
      view.reset({
        keepAnnotationLayer: false,
        keepAnnotationEditorLayer: true,
        keepXfaLayer: true,
        keepTextLayer: true,
        keepCanvasWrapper: true,
        preserveDetailViewState: true,
      });
      view.detailView?.update({ underlyingViewUpdated: true });
    }
    this.queue.schedule();
  }

  /** The pdf.js page div of a slot (tests / diagnostics). */
  viewOf(key: string): PageViewLike | null {
    return this.entries.get(key)?.view ?? null;
  }

  get cachedCount(): number {
    return this.buffer.length;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.scaleTimer) clearTimeout(this.scaleTimer);
    this.queue.stop();
    this.detachRasters();
    this.detachForms();
    this.thumbs.setMainBusy(false);
    for (const entry of [...this.entries.values()]) this.drop(entry);
    this.buffer.clear();
    this.abort.abort();
    this.mask.destroy();
  }
}
