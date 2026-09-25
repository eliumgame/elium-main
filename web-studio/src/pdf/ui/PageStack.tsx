import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, ReactNode } from "react";
import type { Quad, Rotation, Size } from "../core/coords";
import { clamp, psToView, rectToView } from "../core/coords";
import type { PdfEngine } from "../core/engine";
import { drawContained, pictureBitmap, thumbnailsFor } from "../core/thumbs";
import { PageViewController, type VisibleSlot } from "../core/viewer/controller";
import { loadViewerLib, type ViewerLib } from "../core/viewer/lib";
import {
  buildRows,
  captureAnchor,
  computeLayout,
  isPagedMode,
  isPlaced,
  rangeInBand,
  resolveAnchor,
  scrollTopForPage,
  visiblePages,
  type Layout,
  type PageBox,
} from "../core/viewer/layout";
import type { Page } from "../model/types";
import { useCurrentPage, type CurrentPage } from "./currentPage";
import { MAX_SCALE, MIN_SCALE, READING_THEMES, type ReadingTheme, type ViewMode } from "./state";

/**
 * The page surface: a virtualised stack of pages built on pdf.js' own page
 * views (the ones Firefox's PDF viewer is made of).
 *
 *  - Layout is pure (`core/viewer/layout.ts`): prefix-sum offsets, binary
 *    search of the visible range. Only the pages in the viewport ± a margin
 *    exist in the DOM, absolutely positioned — the DOM stays O(visible) for a
 *    10-page memo or a 5 000-page manual.
 *  - Each mounted page hosts a `PDFPageView` (canvas + detail tile canvas at
 *    high zoom + text layer + link layer), driven by `PageViewController`: a
 *    prioritised, cooperative render queue and an LRU of rendered pages.
 *  - Zoom is instant: the page boxes and pdf.js' `--scale-factor` change in the
 *    same frame (the existing raster is stretched), a sharp render follows.
 *    Ctrl+wheel zooms about the pointer; a layout change (zoom, page sizes
 *    becoming known, rotation) keeps the point being read where it was.
 *  - Elium's own layers (annotations, content editing, forms) are rendered by
 *    the workspace through `renderOverlay`, inside the page slot, in the page's
 *    view space — exactly where the previous `PageView` put its children.
 */

export interface HitMark {
  /** Quads in SOURCE page space (the file's crop box, unrotated). */
  quads: Quad[];
  active: boolean;
}

export interface OverlayGeometry {
  /** Unrotated page size in points (after an Elium crop). */
  size: Size;
  /** Total rotation on screen. */
  rotation: Rotation;
  /** CSS px per point. */
  scale: number;
}

export interface PageStackHandle {
  /** Bring page `index` (0-based) to the top, `top` points below its top edge. */
  scrollToPage(index: number, opts?: { top?: number; behavior?: ScrollBehavior }): void;
  /** The scroll container. */
  element(): HTMLDivElement | null;
  /** Inclusive range of the pages currently mounted. */
  mountedRange(): { first: number; last: number } | null;
}

export interface PageStackProps {
  engine: PdfEngine;
  pages: Page[];
  /** Unrotated page size in points, after an Elium crop. */
  sizeOf: (page: Page) => Size;
  /** Total rotation on screen (the page's /Rotate + user + view rotation). */
  rotationOf: (page: Page) => Rotation;
  scale: number;
  mode: ViewMode;
  cover: boolean;
  theme: ReadingTheme;
  /** The 1-based page being read (reported back through `onCurrentChange`). */
  currentPage: CurrentPage;
  showTextLayer: boolean;
  /** Tint the form fields (Acrobat's « Surligner les champs »). Default: on. */
  fieldHighlight?: boolean;
  /** Imported markup is drawn by Elium: pdf.js must not paint it. */
  maskImported: boolean;
  /** pdf.js OptionalContentConfig (layers), when some are hidden. */
  optionalContent?: unknown;
  hitsOf?: (page: Page) => HitMark[] | undefined;
  className?: string;
  style?: CSSProperties;
  renderOverlay?: (page: Page, index: number, geom: OverlayGeometry) => ReactNode;
  /** 1-based. */
  onCurrentChange?: (current: number) => void;
  /** Ctrl+wheel zoom settled on a new scale. */
  onScaleChange?: (scale: number) => void;
  /** The box a fit zoom fits into: the viewport, independent of the scrollbars being shown. */
  onViewportResize?: (size: { width: number; height: number }) => void;
  /** A page's text layer (the selection surface) and the slot it lives in (the page's view origin). */
  onTextLayer?: (pageId: string, layer: HTMLElement | null, host: HTMLElement | null) => void;
  /** `page` is a 1-based OUTPUT page. */
  onLinkActivate?: (target: { page?: number; y?: number; url?: string }) => void;
}

/** Extra height mounted above and below the viewport (fraction of its height, min px). */
const OVERSCAN = 0.75;
const OVERSCAN_MIN = 400;
/** Ctrl+wheel: the gesture is considered over after this much quiet. */
const ZOOM_SETTLE_MS = 180;
/** …and the sharp re-render waits this long (pdf.js uses 400 ms for pinch/wheel). */
const ZOOM_DRAWING_DELAY = 400;

interface Anchor {
  vx: number;
  vy: number;
}

interface Placement {
  index: number;
  page: Page;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Offset of the pdf.js page inside the slot (Elium crop), CSS px. */
  offX: number;
  offY: number;
  /** Full (uncropped) page view size, CSS px. */
  fullW: number;
  fullH: number;
  size: Size;
  sourceSize: Size | null;
  rotation: Rotation;
}

const PageStack = forwardRef<PageStackHandle, PageStackProps>(function PageStack(p, ref) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [lib, setLib] = useState<ViewerLib | null>(null);
  const [controller, setController] = useState<PageViewController | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const fitBox = useRef({ width: 0, height: 0 });
  const [range, setRange] = useState<{ first: number; last: number } | null>(null);
  const [gestureScale, setGestureScale] = useState<number | null>(null);
  const scale = gestureScale ?? p.scale;

  // Latest props for the callbacks handed to long-lived objects.
  const live = useRef(p);
  live.current = p;

  // --- pdf.js viewer components + controller ---------------------------------
  useEffect(() => {
    let alive = true;
    void loadViewerLib().then(
      (l) => alive && setLib(l),
      (e) => console.error("[pdf] composants de visionneuse indisponibles", e),
    );
    return () => {
      alive = false;
    };
  }, []);

  const slotEls = useRef(new Map<string, HTMLDivElement>());
  const readyKeys = useRef(new Set<string>());

  useEffect(() => {
    if (!lib) return;
    const engine = p.engine;
    const c = new PageViewController({
      engine,
      lib,
      links: {
        goToSourcePage: (page, y) => {
          const i = live.current.pages.findIndex((q) => q.from === page - 1);
          if (i >= 0) live.current.onLinkActivate?.({ page: i + 1, y });
        },
        resolveDest: (dest) => engine.resolveDest(dest),
        openExternal: (url) => live.current.onLinkActivate?.({ url }),
        currentSourcePage: () => (live.current.pages[live.current.currentPage.get() - 1]?.from ?? 0) + 1,
        sourcePageCount: () => engine.pageCount,
      },
      onTextLayer: (key, layer) =>
        live.current.onTextLayer?.(key, layer, layer ? (slotEls.current.get(key) ?? null) : null),
      // `is-ready` (hides the loading shimmer) is toggled on the slot directly
      // — no React render per finished page — and remembered, so that a later
      // render of the slot keeps it.
      onPageRendered: (key) => {
        readyKeys.current.add(key);
        slotEls.current.get(key)?.classList.add("is-ready");
      },
      onPageCleared: (key) => {
        readyKeys.current.delete(key);
        slotEls.current.get(key)?.classList.remove("is-ready");
      },
    });
    c.setScale(live.current.scale);
    c.setMaskEnabled(live.current.maskImported);
    if (live.current.optionalContent) c.setOptionalContent(live.current.optionalContent);
    setController(c);
    return () => {
      c.destroy();
      setController(null);
    };
  }, [lib, p.engine]);

  useLayoutEffect(() => {
    controller?.setMaskEnabled(p.maskImported);
  }, [controller, p.maskImported]);
  useEffect(() => {
    controller?.setOptionalContent(p.optionalContent ?? null);
  }, [controller, p.optionalContent]);

  // --- viewport size ---------------------------------------------------------
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const measure = () => {
      const next = { width: el.clientWidth, height: el.clientHeight };
      setViewport((v) => (v.width === next.width && v.height === next.height ? v : next));
      // What a fit zoom fits into must NOT depend on whether a scrollbar is
      // showing, or fitting could flip-flop (a wider page brings the
      // horizontal scrollbar, the height shrinks, the zoom drops, the
      // scrollbar goes, the zoom grows…). The vertical gutter is always
      // reserved (`scrollbar-gutter: stable`); the horizontal one is assumed
      // present, with the same thickness.
      const gutter = Math.max(0, el.offsetWidth - el.clientWidth);
      const fit = { width: el.clientWidth, height: Math.max(0, el.offsetHeight - gutter) };
      if (fit.width !== fitBox.current.width || fit.height !== fitBox.current.height) {
        fitBox.current = fit;
        if (fit.width > 0) live.current.onViewportResize?.(fit);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // --- layout ----------------------------------------------------------------
  const { pages, sizeOf, rotationOf, mode, cover } = p;
  const current = useCurrentPage(p.currentPage);
  const boxes = useMemo<PageBox[]>(
    () =>
      pages.map((page) => {
        const s = sizeOf(page);
        return rotationOf(page) % 180 === 0 ? { w: s.w, h: s.h } : { w: s.h, h: s.w };
      }),
    [pages, sizeOf, rotationOf],
  );

  const paged = isPagedMode(mode);
  const pageCount = pages.length;
  const shownRow = useMemo(() => {
    if (!paged) return undefined;
    const rows = buildRows(pageCount, mode, cover);
    const target = clamp(current - 1, 0, Math.max(0, pageCount - 1));
    const r = rows.findIndex(([s, e]) => target >= s && target < e);
    return r < 0 ? 0 : r;
  }, [paged, pageCount, mode, cover, current]);

  const layout = useMemo(
    () =>
      computeLayout(boxes, {
        mode,
        cover,
        scale,
        viewportWidth: viewport.width,
        row: shownRow,
      }),
    [boxes, mode, cover, scale, viewport.width, shownRow],
  );
  const layoutRef = useRef(layout);

  // --- scroll bookkeeping ----------------------------------------------------
  const lastScroll = useRef({ top: 0, left: 0 });
  const scrollDown = useRef(true);
  const zoomAnchor = useRef<Anchor | null>(null);
  const pendingScroll = useRef<{ index: number; top: number } | null>(null);
  /** The page (id) a smooth `scrollToPage` is heading to, until the scroll ends. */
  const smoothTarget = useRef<{ id: string; top: number } | null>(null);
  const prevLayout = useRef<Layout | null>(null);
  const prevPages = useRef<Page[]>(p.pages);
  const gesture = useRef(false);
  const reportedCurrent = useRef(p.currentPage.get());
  const frame = useRef(0);

  const sync = useCallback(() => {
    const el = scrollerRef.current;
    const L = layoutRef.current;
    if (!el || !L.count) {
      setRange(null);
      return;
    }
    const top = el.scrollTop;
    const left = el.scrollLeft;
    const height = el.clientHeight;
    const width = el.clientWidth;
    if (top !== lastScroll.current.top) scrollDown.current = top > lastScroll.current.top;
    lastScroll.current = { top, left };

    const margin = Math.max(OVERSCAN_MIN, height * OVERSCAN);
    const band = rangeInBand(L, top - margin, top + height + margin);
    setRange((prev) => (prev && band && prev.first === band.first && prev.last === band.last ? prev : band));

    const pages = live.current.pages;
    const vis = visiblePages(L, { top, left, width, height });
    if (controller) {
      const slots: VisibleSlot[] = [];
      for (const v of vis) {
        const page = pages[v.index];
        if (!page || page.from == null) continue;
        const off = cropOffset(page, L.scale, live.current, live.current.engine);
        slots.push({
          key: page.id,
          visibleArea: v.visibleArea
            ? {
                minX: v.visibleArea.minX + off.x,
                minY: v.visibleArea.minY + off.y,
                maxX: v.visibleArea.maxX + off.x,
                maxY: v.visibleArea.maxY + off.y,
              }
            : null,
        });
      }
      const ahead: string[] = [];
      if (vis.length) {
        const idx = vis.map((v) => v.index);
        const first = Math.min(...idx);
        const last = Math.max(...idx);
        const extra = L.mode === "facing" || L.mode === "facingContinuous" ? 2 : 1;
        for (let k = 1; k <= extra; k++) {
          const i = scrollDown.current ? last + k : first - k;
          const page = pages[i];
          if (page && page.from != null && isPlaced(L, i)) ahead.push(page.id);
        }
      }
      controller.setVisible(slots, ahead);
    }

    // Current page: the most visible one — but keep the current one while it
    // is still entirely on screen (no flicker between two small pages).
    if (vis.length) {
      const now = live.current.currentPage.get();
      const cur = now - 1;
      const stillFull = vis.some((v) => v.index === cur && v.percent >= 100);
      let best = vis[0];
      for (const v of vis)
        if (v.area > best.area + 0.5 || (Math.abs(v.area - best.area) <= 0.5 && v.index < best.index)) best = v;
      const next = stillFull ? cur : best.index;
      if (next + 1 !== reportedCurrent.current && next + 1 !== now) {
        reportedCurrent.current = next + 1;
        live.current.onCurrentChange?.(next + 1);
      } else if (next + 1 === now) {
        reportedCurrent.current = next + 1;
      }
    }
  }, [controller]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (el && el.scrollTop !== lastScroll.current.top) scrollDown.current = el.scrollTop > lastScroll.current.top;
    // Thumbnails wait for the scroll to settle (the pages it reveals come first).
    thumbnailsFor(live.current.engine).noteScroll();
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      sync();
    });
  }, [sync]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  // A smooth scroll is over (or was interrupted by the user): forget its target.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const end = () => (smoothTarget.current = null);
    el.addEventListener("scrollend", end);
    el.addEventListener("wheel", end, { passive: true });
    el.addEventListener("pointerdown", end);
    return () => {
      el.removeEventListener("scrollend", end);
      el.removeEventListener("wheel", end);
      el.removeEventListener("pointerdown", end);
    };
  }, []);

  // Apply a new layout: zoom the views, keep the reading position, re-derive
  // what is mounted/visible — all before the browser paints.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    layoutRef.current = layout;
    if (controller && Math.abs(controller.currentScale - layout.scale) > 1e-9) {
      controller.setScale(layout.scale, gesture.current ? ZOOM_DRAWING_DELAY : -1);
    }
    const prev = prevLayout.current;
    const before = prevPages.current;
    if (el && prev && prev !== layout) {
      const vp = { width: el.clientWidth, height: el.clientHeight };
      const pending = pendingScroll.current;
      const smooth = smoothTarget.current;
      const smoothIndex = smooth ? p.pages.findIndex((q) => q.id === smooth.id) : -1;
      if (pending && isPlaced(layout, pending.index)) {
        pendingScroll.current = null;
        el.scrollTop = pending.top === -1 ? layout.contentHeight : scrollTopForPage(layout, pending.index, pending.top);
      } else if (smooth && isPlaced(layout, smoothIndex)) {
        // A smooth scroll to a page was under way: anchoring on its
        // mid-flight position would strand the reader half-way. Aim again,
        // in the new layout, at the page it was going to.
        el.scrollTo({ top: scrollTopForPage(layout, smoothIndex, smooth.top), behavior: "smooth" });
      } else if (layout.paged && prev.paged && prev.shownRow !== layout.shownRow) {
        el.scrollTop = 0;
      } else {
        const a = zoomAnchor.current ?? { vx: prev.scale !== layout.scale ? vp.width / 2 : 0, vy: 0 };
        const anchor = captureAnchor(prev, lastScroll.current, a.vx, a.vy);
        // Anchor on the PAGE, not its index: pages may have been reordered.
        const id = before[anchor.index]?.id;
        const now = id ? p.pages.findIndex((q) => q.id === id) : -1;
        const target = { ...anchor, index: now >= 0 ? now : Math.min(anchor.index, layout.count - 1) };
        const pos = resolveAnchor(layout, target, vp);
        if (Math.abs(pos.top - el.scrollTop) > 0.5) el.scrollTop = pos.top;
        if (Math.abs(pos.left - el.scrollLeft) > 0.5) el.scrollLeft = pos.left;
      }
    }
    zoomAnchor.current = null;
    prevLayout.current = layout;
    prevPages.current = p.pages;
    if (el) lastScroll.current = { top: el.scrollTop, left: el.scrollLeft };
    sync();
  }, [layout, controller, sync, p.pages]);

  // --- wheel: Ctrl+wheel zoom about the pointer, paged-mode page turns -------
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastTurn = useRef(0);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
        const before = layoutRef.current.scale;
        const next = clamp(before * Math.exp(-e.deltaY * unit * 0.0016), MIN_SCALE, MAX_SCALE);
        if (Math.abs(next - before) < 0.0005) return;
        const rect = el.getBoundingClientRect();
        zoomAnchor.current = { vx: e.clientX - rect.left, vy: e.clientY - rect.top };
        gesture.current = true;
        setGestureScale(next);
        if (settleTimer.current) clearTimeout(settleTimer.current);
        settleTimer.current = setTimeout(() => {
          settleTimer.current = null;
          gesture.current = false;
          live.current.onScaleChange?.(next);
          setGestureScale(null);
        }, ZOOM_SETTLE_MS);
        return;
      }
      // Single page / two-up: scrolling past the end of the page turns it.
      const L = layoutRef.current;
      if (!L.paged || Math.abs(e.deltaY) < 1) return;
      const atEnd = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      const atStart = el.scrollTop <= 0;
      const now = performance.now();
      if (now - lastTurn.current < 350) {
        if ((e.deltaY > 0 && atEnd) || (e.deltaY < 0 && atStart)) e.preventDefault();
        return;
      }
      const row = L.rows[L.shownRow];
      if (!row) return;
      if (e.deltaY > 0 && atEnd && row.end < L.count) {
        e.preventDefault();
        lastTurn.current = now;
        pendingScroll.current = { index: row.end, top: 0 };
        live.current.onCurrentChange?.(row.end + 1);
      } else if (e.deltaY < 0 && atStart && row.start > 0) {
        e.preventDefault();
        lastTurn.current = now;
        pendingScroll.current = { index: row.start - 1, top: -1 };
        live.current.onCurrentChange?.(row.start);
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (settleTimer.current) clearTimeout(settleTimer.current);
    };
  }, []);

  // --- imperative API --------------------------------------------------------
  useImperativeHandle(
    ref,
    () => ({
      scrollToPage(index, opts) {
        const el = scrollerRef.current;
        const L = layoutRef.current;
        if (!el || !L.count) return;
        const i = clamp(Math.round(index), 0, L.count - 1);
        const topPt = opts?.top ?? 0;
        // Ask the worker for the target page now: the round trip overlaps the
        // render that mounts its slot (its page view waits for it).
        const from = live.current.pages[i]?.from;
        if (from != null) void live.current.engine.page(from).catch(() => {});
        if (!isPlaced(L, i)) {
          // Paged mode: the workspace switches the shown page; scroll once it is laid out.
          pendingScroll.current = { index: i, top: topPt };
          return;
        }
        const top = scrollTopForPage(L, i, topPt);
        const far = Math.abs(top - el.scrollTop) > 2.5 * el.clientHeight;
        const behavior = opts?.behavior ?? (far ? "auto" : "smooth");
        const id = live.current.pages[i]?.id;
        smoothTarget.current =
          behavior === "smooth" && id && Math.abs(top - el.scrollTop) > 0.5 ? { id, top: topPt } : null;
        el.scrollTo({ top, behavior });
        // An instant jump: mount and prioritise the target now rather than on
        // the next scroll frame.
        if (behavior !== "smooth") sync();
      },
      element: () => scrollerRef.current,
      mountedRange: () => range,
    }),
    [range, sync],
  );

  // --- render ----------------------------------------------------------------
  // Elium's layers of a page are rebuilt only when the workspace hands a new
  // `renderOverlay` (its state changed) or the page's geometry changed — not
  // when this stack alone re-renders (scrolling mounts a page, the current page
  // moves): together with the memoised slots, only the slots that changed
  // render again.
  const overlays = useRef(new Map<string, OverlayMemo>());
  const nextOverlays = new Map<string, OverlayMemo>();
  const overlayOf = (page: Page, index: number, geom: OverlayGeometry): ReactNode => {
    const fn = p.renderOverlay;
    if (!fn) return undefined;
    const prev = overlays.current.get(page.id);
    const hit =
      prev &&
      prev.fn === fn &&
      prev.page === page &&
      prev.index === index &&
      prev.size === geom.size &&
      prev.rotation === geom.rotation &&
      prev.scale === geom.scale;
    const memo = hit ? prev : { fn, page, index, ...geom, node: fn(page, index, geom) };
    nextOverlays.set(page.id, memo);
    return memo.node;
  };
  const placements: Placement[] = [];
  if (range) {
    for (let i = range.first; i <= range.last; i++) {
      if (!isPlaced(layout, i)) continue;
      const page = p.pages[i];
      if (!page) continue;
      const rotation = p.rotationOf(page);
      const size = p.sizeOf(page);
      const source = page.from != null ? (p.engine.pages[page.from] ?? null) : null;
      const sourceSize = source ? { w: source.w, h: source.h } : null;
      const off = cropOffset(page, layout.scale, p, p.engine);
      const full = sourceSize ?? size;
      const rotFull = rotation % 180 === 0 ? full : { w: full.h, h: full.w };
      placements.push({
        index: i,
        page,
        x: layout.x[i],
        y: layout.y[i],
        w: layout.w[i],
        h: layout.h[i],
        offX: off.x,
        offY: off.y,
        fullW: rotFull.w * layout.scale,
        fullH: rotFull.h * layout.scale,
        size,
        sourceSize,
        rotation,
      });
    }
  }

  const slots = placements.map((pl) => (
    <PageSlot
      key={pl.page.id}
      controller={controller}
      placement={pl}
      scale={layout.scale}
      active={current === pl.index + 1}
      ready={readyKeys.current.has(pl.page.id)}
      hits={p.hitsOf?.(pl.page)}
      slotEls={slotEls.current}
      overlay={overlayOf(pl.page, pl.index, {
        size: pl.size,
        rotation: pl.rotation,
        scale: layout.scale,
      })}
    />
  ));
  overlays.current = nextOverlays;

  const themeDef = READING_THEMES.find((t) => t.id === p.theme) ?? READING_THEMES[0];
  const stackStyle = {
    width: layout.contentWidth,
    height: layout.contentHeight,
    "--scale-factor": String(layout.scale),
    "--pdfx-page-filter": themeDef.filter,
    "--pdfx-page-bg": themeDef.canvas,
  } as CSSProperties;

  return (
    <div
      ref={scrollerRef}
      className={`pdfx-canvas ${p.className ?? ""}`}
      style={p.style}
      onScroll={onScroll}
      role="main"
      aria-label="Pages du document"
      tabIndex={0}
    >
      <div
        className={`pdfx-stack ${p.showTextLayer ? "" : "no-text"} ${p.fieldHighlight === false ? "no-field-highlight" : ""}`}
        style={stackStyle}
      >
        {slots}
      </div>
    </div>
  );
});

interface OverlayMemo extends OverlayGeometry {
  fn: NonNullable<PageStackProps["renderOverlay"]>;
  page: Page;
  index: number;
  node: ReactNode;
}

export default PageStack;

/** Offset (CSS px) of the visible crop inside the full page view, for an Elium crop. */
function cropOffset(
  page: Page,
  scale: number,
  p: Pick<PageStackProps, "rotationOf">,
  engine: PdfEngine,
): { x: number; y: number } {
  const crop = page.crop;
  if (!crop || page.from == null) return { x: 0, y: 0 };
  const src = engine.pages[page.from];
  if (!src) return { x: 0, y: 0 };
  const full = { w: src.w, h: src.h };
  const rect = {
    x: crop.left,
    y: crop.top,
    w: Math.max(1, full.w - crop.left - crop.right),
    h: Math.max(1, full.h - crop.top - crop.bottom),
  };
  const v = rectToView(rect, full, p.rotationOf(page));
  return { x: v.x * scale, y: v.y * scale };
}

// ---------------------------------------------------------------------------

interface PageSlotProps {
  controller: PageViewController | null;
  placement: Placement;
  scale: number;
  active: boolean;
  /** Its page view has finished a raster (see `readyKeys`). */
  ready: boolean;
  hits?: HitMark[];
  slotEls: Map<string, HTMLDivElement>;
  overlay?: ReactNode;
}

/** Same placement, field by field (a placement object is rebuilt on every render of the stack). */
function samePlacement(a: Placement, b: Placement): boolean {
  return (
    a.index === b.index &&
    a.page === b.page &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.offX === b.offX &&
    a.offY === b.offY &&
    a.fullW === b.fullW &&
    a.fullH === b.fullH &&
    a.size === b.size &&
    a.rotation === b.rotation &&
    a.sourceSize?.w === b.sourceSize?.w &&
    a.sourceSize?.h === b.sourceSize?.h
  );
}

const PageSlot = memo(
  PageSlotView,
  (a, b) =>
    a.controller === b.controller &&
    a.scale === b.scale &&
    a.active === b.active &&
    a.ready === b.ready &&
    a.hits === b.hits &&
    a.slotEls === b.slotEls &&
    a.overlay === b.overlay &&
    samePlacement(a.placement, b.placement),
);

function PageSlotView({ controller, placement: pl, scale, active, ready, hits, slotEls, overlay }: PageSlotProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const { page } = pl;
  const key = page.id;
  const from = page.from;

  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el) return;
    slotEls.set(key, el);
    return () => {
      if (slotEls.get(key) === el) slotEls.delete(key);
    };
  }, [key, slotEls]);

  // Attach this slot's pdf.js page view (created on first mount, reused from
  // the LRU when scrolling back).
  const rotationRef = useRef(pl.rotation);
  rotationRef.current = pl.rotation;
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!controller || from == null || !host) return;
    controller.mount(key, from, host, { rotation: rotationRef.current });
    return () => controller.unmount(key);
  }, [controller, key, from]);
  useLayoutEffect(() => {
    if (controller && from != null) controller.setSpec(key, { rotation: pl.rotation });
  }, [controller, key, from, pl.rotation]);

  const inserted = from == null;
  const src = pl.sourceSize ?? pl.size;
  return (
    <div
      ref={slotRef}
      className={`pdfx-page pdfx-slot ${active ? "is-active" : ""} ${inserted || ready ? "is-ready" : ""}`}
      data-page={pl.index + 1}
      style={{ left: pl.x, top: pl.y, width: pl.w, height: pl.h }}
    >
      <div className="pdfx-slot__clip">
        <div
          ref={hostRef}
          className="pdfx-slot__pdf"
          style={{ left: -pl.offX, top: -pl.offY, width: pl.fullW, height: pl.fullH }}
        />
        {inserted && page.image && <InsertedPicture url={page.image} width={pl.w} height={pl.h} />}
        {!!hits?.length && (
          <svg
            className="pdfx-hits"
            width={pl.fullW}
            height={pl.fullH}
            style={{ left: -pl.offX, top: -pl.offY }}
            aria-hidden
          >
            {hits.map((hit, i) =>
              hit.quads.map((q, k) => (
                <polygon
                  key={`${i}-${k}`}
                  className={hit.active ? "pdfx-hit is-active" : "pdfx-hit"}
                  points={q
                    .map((pt) => {
                      const v = psToView(pt, src, pl.rotation);
                      return `${(v.x * scale).toFixed(1)},${(v.y * scale).toFixed(1)}`;
                    })
                    .join(" ")}
                />
              )),
            )}
          </svg>
        )}
      </div>
      {overlay}
      <span className="pdfx-page__label">{page.label || String(pl.index + 1)}</span>
    </div>
  );
}

/** The picture of an image page inserted this session, drawn without any URL fetch. */
function InsertedPicture({ url, width, height }: { url: string; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(width * dpr));
  const h = Math.max(1, Math.round(height * dpr));
  useEffect(() => {
    let alive = true;
    void pictureBitmap(url).then(
      (bmp) => {
        const c = ref.current;
        if (alive && c) drawContained(c, bmp);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [url, w, h]);
  return <canvas ref={ref} className="pdfx-page__image" width={w} height={h} />;
}
