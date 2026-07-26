import { useEffect, useRef, useState } from "react";
import { TextLayer } from "pdfjs-dist";
import type { PDFPageProxy } from "pdfjs-dist";
import type { Quad, Rotation, Size } from "../core/coords";
import { psToView } from "../core/coords";
import type { PdfEngine } from "../core/engine";
import type { RenderScheduler } from "../core/render";
import { effectiveDpr } from "../core/render";
import type { ReadingTheme } from "./state";
import { READING_THEMES } from "./state";

/**
 * One rendered page: raster, selectable text, the file's own links, search
 * highlights, and whatever editing layers the workspace stacks on top.
 *
 * Rendering is deferred until the page is near the viewport and routed through
 * the shared scheduler, so scrolling a 500-page document stays smooth.
 */

export interface PageViewProps {
  engine: PdfEngine;
  scheduler: RenderScheduler;
  /** Index in the *output* page order (0-based), used for numbering. */
  index: number;
  /** Source page index, or null for a page inserted this session. */
  from: number | null;
  /** Unrotated page size in points. */
  size: Size;
  /** Total rotation = page /Rotate + user rotation + view rotation. */
  rotation: Rotation;
  scale: number;
  theme: ReadingTheme;
  label: string;
  active: boolean;
  /** Highlight quads for search hits on this page (page space). */
  hits?: { quads: Quad[]; active: boolean }[];
  /** Optional-content configuration, when layers are toggled off. */
  optionalContent?: unknown;
  /** Background picture for an inserted page. */
  image?: string;
  showTextLayer: boolean;
  /**
   * pdf.js annotation rendering: 1 = let pdf.js paint the file's own markup,
   * 0 = leave it to us because we imported it into the editable model.
   */
  annotationMode?: number;
  onTextLayer?: (el: HTMLDivElement | null) => void;
  onLinkActivate?: (target: { page?: number; url?: string }) => void;
  onVisible?: (index: number, visible: boolean) => void;
  children?: React.ReactNode;
}

interface LinkBox {
  x: number;
  y: number;
  w: number;
  h: number;
  url?: string;
  dest?: unknown;
}

export default function PageView(p: PageViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rendered, setRendered] = useState(false);
  const [links, setLinks] = useState<LinkBox[]>([]);
  const pageRef = useRef<PDFPageProxy | null>(null);
  const textLayerRef = useRef<TextLayer | null>(null);

  const viewW = Math.round((p.rotation % 180 === 0 ? p.size.w : p.size.h) * p.scale);
  const viewH = Math.round((p.rotation % 180 === 0 ? p.size.h : p.size.w) * p.scale);
  const key = `${p.index}:${p.from}`;

  // --- visibility -----------------------------------------------------------
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        setVisible(entry.isIntersecting);
        p.onVisible?.(p.index, entry.isIntersecting);
      },
      { rootMargin: "900px 0px", threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.index]);

  // --- raster ---------------------------------------------------------------
  useEffect(() => {
    if (!visible || p.from == null) {
      if (p.from == null) setRendered(true);
      return;
    }
    let cancelled = false;
    setRendered(false);
    (async () => {
      const page = await p.engine.page(p.from!);
      if (cancelled) return;
      pageRef.current = page;
      const canvas = canvasRef.current;
      if (!canvas) return;
      p.scheduler.submit({
        key,
        page,
        canvas,
        scale: p.scale,
        rotation: p.rotation,
        dpr: effectiveDpr(p.size.w, p.size.h, p.scale, globalThis.devicePixelRatio || 1),
        priority: p.active ? 0 : Math.abs(p.index) + 1,
        optionalContentConfig: p.optionalContent,
        annotationMode: p.annotationMode,
        onDone: () => { if (!cancelled) setRendered(true); },
        onError: () => { if (!cancelled) setRendered(true); },
      });
    })();
    return () => {
      cancelled = true;
      p.scheduler.cancel(key);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, p.scale, p.rotation, p.from, p.optionalContent, p.annotationMode]);

  // --- selectable text ------------------------------------------------------
  useEffect(() => {
    if (!visible || p.from == null || !p.showTextLayer) return;
    let cancelled = false;
    (async () => {
      const page = await p.engine.page(p.from!);
      const container = textRef.current;
      if (cancelled || !container) return;
      try {
        textLayerRef.current?.cancel();
        container.replaceChildren();
        container.style.setProperty("--scale-factor", String(p.scale));
        const source = await p.engine.text(p.from!);
        if (cancelled) return;
        const viewport = page.getViewport({ scale: p.scale, rotation: p.rotation });
        const layer = new TextLayer({ textContentSource: source as never, container, viewport });
        textLayerRef.current = layer;
        await layer.render();
        if (!cancelled) p.onTextLayer?.(container);
      } catch { /* the text layer is additive — the page still renders */ }
    })();
    return () => {
      cancelled = true;
      textLayerRef.current?.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, p.scale, p.rotation, p.from, p.showTextLayer]);

  // --- the document's own links --------------------------------------------
  useEffect(() => {
    if (!visible || p.from == null) return;
    let cancelled = false;
    (async () => {
      const anns = (await p.engine.annotations(p.from!)) as {
        subtype?: string; rect?: number[]; url?: string; dest?: unknown; unsafeUrl?: string;
      }[];
      if (cancelled) return;
      const out: LinkBox[] = [];
      for (const a of anns) {
        if (a.subtype !== "Link" || !a.rect || a.rect.length < 4) continue;
        const [x1, y1, x2, y2] = a.rect;
        out.push({
          x: Math.min(x1, x2),
          y: p.size.h - Math.max(y1, y2),
          w: Math.abs(x2 - x1),
          h: Math.abs(y2 - y1),
          url: a.url ?? a.unsafeUrl,
          dest: a.dest,
        });
      }
      setLinks(out);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, p.from]);

  const themeDef = READING_THEMES.find((t) => t.id === p.theme) ?? READING_THEMES[0];

  return (
    <div
      ref={hostRef}
      className={`pdfx-page ${p.active ? "is-active" : ""} ${rendered ? "is-ready" : "is-loading"}`}
      data-page={p.index + 1}
      style={{ width: viewW, height: viewH, background: themeDef.canvas }}
    >
      <canvas ref={canvasRef} className="pdfx-page__canvas" style={{ filter: themeDef.filter }} />

      {p.from == null && p.image && (
        <img className="pdfx-page__image" src={p.image} alt="" draggable={false} style={{ filter: themeDef.filter }} />
      )}

      {!rendered && <div className="pdfx-page__skeleton" aria-hidden />}

      <div ref={textRef} className="pdfx-textlayer" style={{ display: p.showTextLayer ? undefined : "none" }} />

      {!!p.hits?.length && (
        <svg className="pdfx-hits" width={viewW} height={viewH} aria-hidden>
          {p.hits.map((hit, i) =>
            hit.quads.map((q, k) => (
              <polygon
                key={`${i}-${k}`}
                className={hit.active ? "pdfx-hit is-active" : "pdfx-hit"}
                points={q
                  .map((pt) => {
                    const v = psToView(pt, p.size, p.rotation);
                    return `${(v.x * p.scale).toFixed(1)},${(v.y * p.scale).toFixed(1)}`;
                  })
                  .join(" ")}
              />
            )),
          )}
        </svg>
      )}

      {!!links.length && (
        <div className="pdfx-linklayer">
          {links.map((l, i) => {
            const a = psToView({ x: l.x, y: l.y }, p.size, p.rotation);
            const b = psToView({ x: l.x + l.w, y: l.y + l.h }, p.size, p.rotation);
            const left = Math.min(a.x, b.x) * p.scale;
            const top = Math.min(a.y, b.y) * p.scale;
            return (
              <button
                key={i}
                type="button"
                className="pdfx-link"
                title={l.url ?? "Aller à la destination"}
                style={{
                  left,
                  top,
                  width: Math.abs(b.x - a.x) * p.scale,
                  height: Math.abs(b.y - a.y) * p.scale,
                }}
                onClick={async () => {
                  if (l.url) { p.onLinkActivate?.({ url: l.url }); return; }
                  const resolved = await p.engine.resolveDest(l.dest);
                  if (resolved.page) p.onLinkActivate?.({ page: resolved.page });
                }}
              />
            );
          })}
        </div>
      )}

      {p.children}

      <span className="pdfx-page__label">{p.label}</span>
    </div>
  );
}
