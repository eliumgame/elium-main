import { useEffect, useRef, useState } from "react";
import type { Pt, Quad, Rect, Rotation, Size } from "../core/coords";
import { clamp, psToView, quadFromRect, rectFromPoints, rectOfPoints, viewToPs } from "../core/coords";
import type { Annot, AnnotKind, DraftStyle, Tool } from "../model/types";
import { isPolyKind, isTextMarkup, newId } from "../model/types";
import { fontCss } from "../../ui/fonts";
import { NOTE_SIZE } from "../ops/annots-pdf";

/** Image d'un tampon/image/signature avec repli LIBELLÉ : si la source est
 *  absente ou ne se charge pas (data URL cassée), on affiche une étiquette
 *  claire au lieu d'une boîte vide/glyphe « image cassée ». */
function StampImg({ src, fit, label, tone }: { src: string; fit: "fill" | "contain"; label: string; tone: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <div className="pdfx-stamp" data-tone={tone}>{label}</div>;
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      onError={() => setBroken(true)}
      style={{ width: "100%", height: "100%", objectFit: fit }}
    />
  );
}

/**
 * The interactive markup surface for one page.
 *
 * Geometry lives in page space; this component is the only place that converts
 * to and from screen pixels, so rotation and zoom stay a pure view concern.
 * Shapes render as one SVG (crisp at any zoom, cheap to repaint); text boxes,
 * notes and images render as HTML so they can be edited in place.
 */

export interface AnnotLayerProps {
  pageId: string;
  /** Unrotated page size in points. */
  size: Size;
  rotation: Rotation;
  scale: number;
  annots: Annot[];
  tool: Tool;
  style: DraftStyle;
  selectedIds: string[];
  editingId: string | null;
  author: string;
  snap: boolean;
  onCreate: (annot: Annot) => void;
  onUpdate: (id: string, patch: Partial<Annot>, live: boolean) => void;
  onSelect: (ids: string[], additive: boolean) => void;
  onEdit: (id: string | null) => void;
  onDelete: (ids: string[]) => void;
  onToolDone: () => void;
  onBeginGesture: () => void;
  onContextMenu: (annot: Annot, at: { x: number; y: number }) => void;
  onRequestImage: (at: Pt) => void;
  onRequestNoteText: (annot: Annot) => void;
}

interface DraftShape {
  kind: AnnotKind;
  rect?: Rect;
  path?: Pt[];
  polygon?: Pt[];
  hover?: Pt;
}

const HANDLE_KEYS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
type HandleKey = (typeof HANDLE_KEYS)[number];

const BOX_TOOLS: AnnotKind[] = ["square", "circle", "whiteout", "redact", "freetext", "typewriter", "callout", "stamp", "image", "signature", "link", "area"];
const LINE_TOOLS: AnnotKind[] = ["line", "arrow", "distance"];
const POLY_TOOLS: AnnotKind[] = ["polygon", "polyline", "cloud", "perimeter"];

export default function AnnotLayer(p: AnnotLayerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<DraftShape | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const polyRef = useRef<Pt[]>([]);

  const viewW = (p.rotation % 180 === 0 ? p.size.w : p.size.h) * p.scale;
  const viewH = (p.rotation % 180 === 0 ? p.size.h : p.size.w) * p.scale;

  /** Screen point (client coords) → page space. */
  const toPage = (e: { clientX: number; clientY: number }): Pt => {
    const host = hostRef.current;
    if (!host) return { x: 0, y: 0 };
    const r = host.getBoundingClientRect();
    const view = { x: (e.clientX - r.left) / p.scale, y: (e.clientY - r.top) / p.scale };
    const pt = viewToPs(view, p.size, p.rotation);
    return { x: clamp(pt.x, 0, p.size.w), y: clamp(pt.y, 0, p.size.h) };
  };

  /** Page space → CSS pixels within this layer. */
  const toView = (pt: Pt): Pt => {
    const v = psToView(pt, p.size, p.rotation);
    return { x: v.x * p.scale, y: v.y * p.scale };
  };

  const viewRect = (r: Rect): Rect => {
    const a = toView({ x: r.x, y: r.y });
    const b = toView({ x: r.x + r.w, y: r.y + r.h });
    return rectFromPoints(a, b);
  };

  const snapPt = (pt: Pt): Pt =>
    p.snap ? { x: Math.round(pt.x / 6) * 6, y: Math.round(pt.y / 6) * 6 } : pt;

  const drawing = p.tool !== "select" && p.tool !== "textSelect" && p.tool !== "hand" && p.tool !== "eraser" && !p.tool.startsWith("field:");

  // -- creating -------------------------------------------------------------

  const baseAnnot = (kind: AnnotKind, rect: Rect): Annot => {
    const now = new Date().toISOString();
    return {
      id: newId("an"),
      pageId: p.pageId,
      kind,
      rect,
      color: p.style.color,
      fill: p.style.fill,
      opacity: p.style.opacity,
      strokeWidth: p.style.strokeWidth,
      borderStyle: p.style.borderStyle,
      lineStart: p.style.lineStart,
      lineEnd: p.style.lineEnd,
      fontSize: p.style.fontSize,
      fontFamily: p.style.fontFamily,
      bold: p.style.bold,
      italic: p.style.italic,
      underline: p.style.underline,
      align: p.style.align,
      textBg: p.style.textBg,
      author: p.author,
      createdAt: now,
      modifiedAt: now,
      replies: [],
      status: "none",
    };
  };

  const finishPolygon = () => {
    const pts = polyRef.current;
    polyRef.current = [];
    setDraft(null);
    const kind = p.tool as AnnotKind;
    const min = kind === "polyline" || kind === "perimeter" ? 2 : 3;
    if (pts.length < min) { p.onToolDone(); return; }
    const annot = baseAnnot(kind, rectOfPoints(pts));
    annot.paths = [pts];
    if (kind === "cloud") annot.borderStyle = "cloudy";
    p.onCreate(annot);
    p.onToolDone();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button === 2) return;
    const target = e.target as HTMLElement;
    const onAnnot = !!target.closest("[data-annot-id]");

    if (!drawing) {
      if (!onAnnot && (p.tool === "select" || p.tool === "textSelect")) {
        // Marquee-select in the select tool; plain click clears the selection.
        if (p.tool === "select") {
          e.preventDefault();
          const start = toPage(e);
          const move = (ev: PointerEvent) => setMarquee(rectFromPoints(start, toPage(ev)));
          const up = (ev: PointerEvent) => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            const box = rectFromPoints(start, toPage(ev));
            setMarquee(null);
            if (box.w < 3 && box.h < 3) { p.onSelect([], false); return; }
            const hit = p.annots.filter((a) => intersects(a.rect, box)).map((a) => a.id);
            p.onSelect(hit, ev.shiftKey);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", up);
        } else {
          p.onSelect([], false);
        }
      }
      return;
    }

    e.preventDefault();
    e.stopPropagation();
    const kind = p.tool as AnnotKind;
    const start = snapPt(toPage(e));

    if (kind === "image") { p.onRequestImage(start); p.onToolDone(); return; }

    if (kind === "note") {
      const annot = baseAnnot("note", { x: start.x, y: start.y, w: NOTE_SIZE, h: NOTE_SIZE });
      annot.contents = "";
      p.onCreate(annot);
      p.onRequestNoteText(annot);
      p.onToolDone();
      return;
    }

    if (POLY_TOOLS.includes(kind)) {
      polyRef.current = [...polyRef.current, start];
      setDraft({ kind, polygon: [...polyRef.current], hover: start });
      return;
    }

    if (kind === "ink") {
      const pts: Pt[] = [start];
      setDraft({ kind, path: pts });
      const move = (ev: PointerEvent) => {
        const pt = toPage(ev);
        const last = pts[pts.length - 1];
        // Drop samples that add nothing; keeps the ink path small and smooth.
        if (Math.hypot(pt.x - last.x, pt.y - last.y) < 0.7) return;
        pts.push(pt);
        setDraft({ kind, path: [...pts] });
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setDraft(null);
        if (pts.length < 1) { p.onToolDone(); return; }
        const annot = baseAnnot("ink", rectOfPoints(pts));
        annot.paths = [pts];
        p.onCreate(annot);
        p.onToolDone();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }

    if (LINE_TOOLS.includes(kind)) {
      setDraft({ kind, path: [start, start] });
      const move = (ev: PointerEvent) => {
        let end = snapPt(toPage(ev));
        if (ev.shiftKey) end = constrainAngle(start, end);
        setDraft({ kind, path: [start, end] });
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setDraft(null);
        let end = snapPt(toPage(ev));
        if (ev.shiftKey) end = constrainAngle(start, end);
        if (Math.hypot(end.x - start.x, end.y - start.y) < 3) { p.onToolDone(); return; }
        const annot = baseAnnot(kind, rectOfPoints([start, end]));
        annot.paths = [[start, end]];
        if (kind === "arrow" || kind === "distance") annot.lineEnd = annot.lineEnd === "none" ? "arrow" : annot.lineEnd;
        p.onCreate(annot);
        p.onToolDone();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }

    if (BOX_TOOLS.includes(kind)) {
      setDraft({ kind, rect: { x: start.x, y: start.y, w: 0, h: 0 } });
      const move = (ev: PointerEvent) => {
        let cur = snapPt(toPage(ev));
        if (ev.shiftKey) cur = squareOff(start, cur);
        setDraft({ kind, rect: rectFromPoints(start, cur) });
      };
      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        setDraft(null);
        let cur = snapPt(toPage(ev));
        if (ev.shiftKey) cur = squareOff(start, cur);
        let rect = rectFromPoints(start, cur);
        const isText = kind === "freetext" || kind === "typewriter" || kind === "callout";
        if (rect.w < 5 || rect.h < 5) {
          if (!isText && kind !== "stamp" && kind !== "signature") { p.onToolDone(); return; }
          // A click (not a drag) creates a default-sized box, like Acrobat.
          rect = {
            x: start.x,
            y: start.y,
            w: kind === "callout" ? 190 : 200,
            h: isText ? Math.max(24, p.style.fontSize * 2) : 70,
          };
        }
        const annot = baseAnnot(kind, rect);
        if (kind === "callout") {
          annot.callout = [
            { x: Math.max(0, rect.x - 70), y: rect.y + rect.h + 40 },
            { x: Math.max(0, rect.x - 30), y: rect.y + rect.h + 12 },
            { x: rect.x + 12, y: rect.y + rect.h },
          ];
        }
        if (kind === "cloud") annot.borderStyle = "cloudy";
        if (kind === "redact") { annot.fill = "#000000"; annot.color = "#000000"; }
        if (kind === "whiteout") { annot.fill = "#ffffff"; annot.color = "#ffffff"; annot.strokeWidth = 0; }
        if (isText) annot.text = "";
        p.onCreate(annot);
        p.onSelect([annot.id], false);
        if (isText) p.onEdit(annot.id);
        p.onToolDone();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    }
  };

  // Polygon tools track the cursor between clicks and finish on Enter/Escape.
  useEffect(() => {
    if (!POLY_TOOLS.includes(p.tool as AnnotKind)) { polyRef.current = []; return; }
    const move = (ev: PointerEvent) => {
      if (!polyRef.current.length) return;
      setDraft({ kind: p.tool as AnnotKind, polygon: [...polyRef.current], hover: toPage(ev) });
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Enter") { ev.preventDefault(); finishPolygon(); }
      if (ev.key === "Escape") { polyRef.current = []; setDraft(null); p.onToolDone(); }
    };
    const dbl = () => finishPolygon();
    window.addEventListener("pointermove", move);
    window.addEventListener("keydown", key);
    window.addEventListener("dblclick", dbl);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("keydown", key);
      window.removeEventListener("dblclick", dbl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.tool, p.scale, p.rotation]);

  // -- moving / resizing ----------------------------------------------------

  const startMove = (e: React.PointerEvent, annot: Annot) => {
    if (annot.locked) return;
    if (p.tool === "eraser") { p.onDelete([annot.id]); return; }
    if (p.tool !== "select" && p.tool !== "textSelect") return;
    e.preventDefault();
    e.stopPropagation();
    const already = p.selectedIds.includes(annot.id);
    if (!already) p.onSelect([annot.id], e.shiftKey);
    const ids = already ? p.selectedIds : e.shiftKey ? [...p.selectedIds, annot.id] : [annot.id];

    const start = toPage(e);
    const originals = new Map(p.annots.filter((a) => ids.includes(a.id)).map((a) => [a.id, cloneGeometry(a)]));
    let moved = false;
    const move = (ev: PointerEvent) => {
      const cur = toPage(ev);
      let dx = cur.x - start.x;
      let dy = cur.y - start.y;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      if (!moved && Math.hypot(dx, dy) < 1.5) return;
      if (!moved) { moved = true; p.onBeginGesture(); }
      for (const [id, geo] of originals) p.onUpdate(id, translate(geo, dx, dy), true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startResize = (e: React.PointerEvent, annot: Annot, handle: HandleKey) => {
    e.preventDefault();
    e.stopPropagation();
    p.onBeginGesture();
    const start = toPage(e);
    const geo = cloneGeometry(annot);
    const o = { ...annot.rect };
    const move = (ev: PointerEvent) => {
      const cur = toPage(ev);
      const dx = cur.x - start.x;
      const dy = cur.y - start.y;
      let { x, y, w, h } = o;
      if (handle.includes("w")) { x = o.x + dx; w = o.w - dx; }
      if (handle.includes("e")) { w = o.w + dx; }
      if (handle.includes("n")) { y = o.y + dy; h = o.h - dy; }
      if (handle.includes("s")) { h = o.h + dy; }
      if (ev.shiftKey && o.w > 0 && o.h > 0) {
        const ratio = o.w / o.h;
        if (Math.abs(w - o.w) > Math.abs(h - o.h)) h = w / ratio;
        else w = h * ratio;
      }
      if (w < 6) { w = 6; }
      if (h < 6) { h = 6; }
      p.onUpdate(annot.id, scaleGeometry(geo, o, { x, y, w, h }), true);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startVertexDrag = (e: React.PointerEvent, annot: Annot, index: number, which: "path" | "callout") => {
    e.preventDefault();
    e.stopPropagation();
    p.onBeginGesture();
    const move = (ev: PointerEvent) => {
      const pt = snapPt(toPage(ev));
      if (which === "callout") {
        const next = (annot.callout ?? []).map((q, i) => (i === index ? pt : q));
        p.onUpdate(annot.id, { callout: next }, true);
      } else {
        const path = (annot.paths?.[0] ?? []).map((q, i) => (i === index ? pt : q));
        p.onUpdate(annot.id, { paths: [path], rect: rectOfPoints(path) }, true);
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // -- rendering -------------------------------------------------------------

  const svgPath = (pts: readonly Pt[], close = false): string => {
    if (!pts.length) return "";
    const v = pts.map(toView);
    return `M ${v.map((q) => `${q.x.toFixed(2)} ${q.y.toFixed(2)}`).join(" L ")}${close ? " Z" : ""}`;
  };

  /** Catmull-Rom → cubic Bézier, mirroring what the export painter draws. */
  const smoothSvg = (pts: readonly Pt[]): string => {
    const v = pts.map(toView);
    if (v.length < 2) return "";
    if (v.length === 2) return `M ${v[0].x} ${v[0].y} L ${v[1].x} ${v[1].y}`;
    let d = `M ${v[0].x.toFixed(2)} ${v[0].y.toFixed(2)}`;
    for (let i = 0; i < v.length - 1; i++) {
      const p0 = v[i - 1] ?? v[i];
      const p1 = v[i];
      const p2 = v[i + 1];
      const p3 = v[i + 2] ?? p2;
      const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
      const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
      d += ` C ${c1.x.toFixed(2)} ${c1.y.toFixed(2)} ${c2.x.toFixed(2)} ${c2.y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
    return d;
  };

  const strokeProps = (a: Annot) => ({
    stroke: a.color,
    strokeWidth: Math.max(0.4, a.strokeWidth) * p.scale,
    strokeOpacity: a.opacity,
    strokeDasharray: a.borderStyle === "dashed" ? `${4 * p.scale} ${3 * p.scale}` : undefined,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: a.fill ?? "none",
    fillOpacity: a.fill ? a.opacity : 0,
  });

  const renderShape = (a: Annot) => {
    const selected = p.selectedIds.includes(a.id);
    const common = {
      "data-annot-id": a.id,
      className: `pdfx-shape ${selected ? "is-selected" : ""} ${a.locked ? "is-locked" : ""}`,
      onPointerDown: (e: React.PointerEvent) => startMove(e, a),
      onDoubleClick: () => { if (isTextMarkup(a.kind) || a.kind === "note") p.onRequestNoteText(a); },
      onContextMenu: (e: React.MouseEvent) => {
        e.preventDefault();
        p.onContextMenu(a, { x: e.clientX, y: e.clientY });
      },
    };

    if (isTextMarkup(a.kind)) {
      const quads = a.quads ?? [quadFromRect(a.rect)];
      return (
        <g key={a.id} {...common}>
          {quads.map((q, i) => renderMarkupQuad(a, q, i))}
        </g>
      );
    }

    switch (a.kind) {
      case "ink":
        return (
          <g key={a.id} {...common}>
            {(a.paths ?? []).map((path, i) => (
              <path key={i} d={smoothSvg(path)} {...strokeProps(a)} fill="none" fillOpacity={0} />
            ))}
            {/* Fat transparent hit area so thin ink is still grabbable. */}
            {(a.paths ?? []).map((path, i) => (
              <path key={`hit${i}`} d={smoothSvg(path)} stroke="transparent" strokeWidth={Math.max(10, a.strokeWidth * p.scale + 8)} fill="none" />
            ))}
          </g>
        );
      case "square":
      case "whiteout":
      case "redact": {
        const r = viewRect(a.rect);
        const inset = (a.strokeWidth * p.scale) / 2;
        return (
          <g key={a.id} {...common}>
            <rect
              x={r.x + inset} y={r.y + inset}
              width={Math.max(0, r.w - inset * 2)} height={Math.max(0, r.h - inset * 2)}
              {...strokeProps(a)}
              fill={a.kind === "redact" ? (a.fill ?? "#000") : a.kind === "whiteout" ? "#fff" : (a.fill ?? "none")}
              fillOpacity={a.kind === "redact" || a.kind === "whiteout" ? 1 : a.fill ? a.opacity : 0}
            />
            {a.kind === "redact" && (
              <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="none" stroke="#dc2626" strokeWidth={1.5} strokeDasharray="5 3" />
            )}
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="transparent" />
          </g>
        );
      }
      case "circle": {
        const r = viewRect(a.rect);
        const inset = (a.strokeWidth * p.scale) / 2;
        return (
          <g key={a.id} {...common}>
            <ellipse
              cx={r.x + r.w / 2} cy={r.y + r.h / 2}
              rx={Math.max(0.5, r.w / 2 - inset)} ry={Math.max(0.5, r.h / 2 - inset)}
              {...strokeProps(a)}
            />
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="transparent" />
          </g>
        );
      }
      case "line":
      case "arrow":
      case "distance": {
        const pts = a.paths?.[0] ?? [{ x: a.rect.x, y: a.rect.y }, { x: a.rect.x + a.rect.w, y: a.rect.y + a.rect.h }];
        const v = pts.map(toView);
        return (
          <g key={a.id} {...common}>
            <line x1={v[0].x} y1={v[0].y} x2={v[1].x} y2={v[1].y} {...strokeProps(a)} fill="none" markerEnd={undefined} />
            {a.lineEnd && a.lineEnd !== "none" && renderArrowHead(v[1], v[0], a, p.scale)}
            {a.lineStart && a.lineStart !== "none" && renderArrowHead(v[0], v[1], a, p.scale)}
            <line x1={v[0].x} y1={v[0].y} x2={v[1].x} y2={v[1].y} stroke="transparent" strokeWidth={Math.max(12, a.strokeWidth * p.scale + 10)} />
            {a.kind === "distance" && renderCaption(a, midpoint(v[0], v[1]), measureLabel(a, pts))}
          </g>
        );
      }
      case "polygon":
      case "polyline":
      case "cloud":
      case "perimeter":
      case "area": {
        const pts = a.paths?.[0] ?? [];
        const close = a.kind !== "polyline" && a.kind !== "perimeter" ? true : a.kind === "perimeter";
        return (
          <g key={a.id} {...common}>
            <path d={svgPath(pts, close)} {...strokeProps(a)} />
            <path d={svgPath(pts, close)} stroke="transparent" strokeWidth={Math.max(12, a.strokeWidth * p.scale + 10)} fill="none" />
            {(a.kind === "perimeter" || a.kind === "area") && renderCaption(a, centroid(pts.map(toView)), measureLabel(a, pts))}
          </g>
        );
      }
      case "callout": {
        const pts = (a.callout ?? []).map(toView);
        if (pts.length < 2) return null;
        return (
          <g key={`${a.id}-leader`} data-annot-id={a.id} className="pdfx-shape" onPointerDown={(e) => startMove(e, a)}>
            <path d={`M ${pts.map((q) => `${q.x} ${q.y}`).join(" L ")}`} stroke={a.color} strokeWidth={Math.max(1, a.strokeWidth) * p.scale} fill="none" strokeLinejoin="round" />
            {renderArrowHead(pts[0], pts[1], a, p.scale)}
          </g>
        );
      }
      case "link": {
        const r = viewRect(a.rect);
        return (
          <g key={a.id} {...common}>
            <rect x={r.x} y={r.y} width={r.w} height={r.h} fill="rgba(37,99,235,.08)" stroke="#2563eb" strokeWidth={1} strokeDasharray="4 3" />
          </g>
        );
      }
      default:
        return null;
    }
  };

  const renderMarkupQuad = (a: Annot, q: Quad, i: number) => {
    const v = q.map(toView);
    const poly = v.map((pt) => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(" ");
    if (a.kind === "highlight") {
      return <polygon key={i} points={poly} fill={a.color} fillOpacity={a.opacity} style={{ mixBlendMode: "multiply" }} />;
    }
    const [tl, tr, br, bl] = v;
    const w = Math.max(0.6, a.strokeWidth) * p.scale;
    if (a.kind === "underline") {
      return <line key={i} x1={bl.x} y1={bl.y - (bl.y - tl.y) * 0.08} x2={br.x} y2={br.y - (br.y - tr.y) * 0.08} stroke={a.color} strokeWidth={w} strokeOpacity={a.opacity} />;
    }
    if (a.kind === "strikeout") {
      return <line key={i} x1={tl.x} y1={(tl.y + bl.y) / 2} x2={tr.x} y2={(tr.y + br.y) / 2} stroke={a.color} strokeWidth={w} strokeOpacity={a.opacity} />;
    }
    // squiggly
    const y = bl.y - 1;
    const amp = Math.max(1.2, (bl.y - tl.y) * 0.12);
    const step = amp * 2;
    let d = `M ${bl.x} ${y}`;
    let up = true;
    for (let x = bl.x + step; x < br.x; x += step) {
      d += ` L ${x.toFixed(2)} ${(up ? y - amp : y).toFixed(2)}`;
      up = !up;
    }
    return <path key={i} d={d} stroke={a.color} strokeWidth={w} strokeOpacity={a.opacity} fill="none" />;
  };

  const renderCaption = (a: Annot, at: Pt, label: string) => (
    <g pointerEvents="none">
      <rect
        x={at.x - label.length * 3 - 4} y={at.y - 9}
        width={label.length * 6 + 8} height={16}
        rx={3} fill="rgba(255,255,255,.92)"
      />
      <text x={at.x} y={at.y + 3} textAnchor="middle" fontSize={11} fill={a.color} fontFamily="Inter, sans-serif">{label}</text>
    </g>
  );

  const measureLabel = (a: Annot, pts: readonly Pt[]): string => {
    const scale = a.measure;
    if (!scale) return "";
    if (a.kind === "distance") {
      const len = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      return `${(len * scale.unitsPerPoint).toFixed(scale.precision)} ${scale.unit}`;
    }
    if (a.kind === "perimeter") {
      let len = 0;
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (pts.length > 2) len += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
      return `${(len * scale.unitsPerPoint).toFixed(scale.precision)} ${scale.unit}`;
    }
    let sum = 0;
    for (let i = 0; i < pts.length; i++) {
      const q = pts[(i + 1) % pts.length];
      sum += pts[i].x * q.y - q.x * pts[i].y;
    }
    const area = Math.abs(sum) / 2;
    return `${(area * scale.unitsPerPoint * scale.unitsPerPoint).toFixed(scale.precision)} ${scale.unit}²`;
  };

  /** Text boxes, notes, stamps and images live in HTML so they can be edited. */
  const renderHtml = (a: Annot) => {
    const selected = p.selectedIds.includes(a.id);
    const r = viewRect(a.kind === "note" ? { ...a.rect, w: NOTE_SIZE, h: NOTE_SIZE } : a.rect);
    const base: React.CSSProperties = {
      position: "absolute",
      left: r.x,
      top: r.y,
      width: r.w,
      height: r.h,
      opacity: a.opacity,
      transform: a.rotation ? `rotate(${a.rotation}deg)` : undefined,
    };
    const wrapper = (children: React.ReactNode, cls = "") => (
      <div
        key={a.id}
        data-annot-id={a.id}
        className={`pdfx-html ${cls} ${selected ? "is-selected" : ""} ${a.locked ? "is-locked" : ""}`}
        style={base}
        onPointerDown={(e) => startMove(e, a)}
        onContextMenu={(e) => { e.preventDefault(); p.onContextMenu(a, { x: e.clientX, y: e.clientY }); }}
      >
        {children}
      </div>
    );

    if (a.kind === "note") {
      return wrapper(
        <button
          type="button"
          className="pdfx-note"
          style={{ background: a.color }}
          title={a.contents || "Note"}
          onClick={(e) => { e.stopPropagation(); p.onRequestNoteText(a); }}
        >
          <span className="pdfx-note__tail" style={{ borderTopColor: a.color }} />
          {(a.replies?.length ?? 0) > 0 && <span className="pdfx-note__count">{a.replies!.length}</span>}
        </button>,
        "pdfx-html--note",
      );
    }

    if (a.kind === "stamp" || a.kind === "image" || a.kind === "signature") {
      const tone = a.stampTone ?? "red";
      const label = a.kind === "signature" ? "Signature" : a.kind === "image" ? "Image" : (a.stampLabel || "TAMPON");
      return wrapper(
        a.src
          ? <StampImg src={a.src} fit={a.kind === "image" ? "fill" : "contain"} label={label} tone={tone} />
          : <div className="pdfx-stamp" data-tone={tone}>{label}</div>,
      );
    }

    // freetext / typewriter / callout
    const editing = p.editingId === a.id;
    const textStyle: React.CSSProperties = {
      color: a.color,
      fontSize: (a.fontSize ?? 12) * p.scale,
      lineHeight: 1.25,
      fontFamily: fontCss(a.fontFamily),
      fontWeight: a.bold ? 700 : 400,
      fontStyle: a.italic ? "italic" : "normal",
      textDecoration: a.underline ? "underline" : "none",
      textAlign: a.align ?? "left",
      padding: 3 * p.scale,
    };
    return wrapper(
      <>
        <div
          className="pdfx-textbox__bg"
          style={{
            background: a.textBg ?? "transparent",
            border: a.strokeWidth > 0 && a.kind !== "typewriter"
              ? `${a.strokeWidth * p.scale}px ${a.borderStyle === "dashed" ? "dashed" : "solid"} ${a.color}`
              : "none",
          }}
        />
        {editing ? (
          <textarea
            className="pdfx-textbox__input"
            autoFocus
            style={textStyle}
            value={a.text ?? ""}
            onChange={(e) => p.onUpdate(a.id, { text: e.target.value }, true)}
            onFocus={() => p.onBeginGesture()}
            onBlur={() => p.onEdit(null)}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") { e.preventDefault(); p.onEdit(null); }
            }}
          />
        ) : (
          <div
            className="pdfx-textbox__text"
            style={textStyle}
            onDoubleClick={(e) => { e.stopPropagation(); if (!a.locked) p.onEdit(a.id); }}
          >
            {a.text || <span className="pdfx-textbox__hint">Double-cliquez pour saisir</span>}
          </div>
        )}
      </>,
      "pdfx-html--text",
    );
  };

  const renderHandles = (a: Annot) => {
    if (a.locked) return null;
    const r = viewRect(a.rect);
    const poly = isPolyKind(a.kind) || a.kind === "line" || a.kind === "arrow" || a.kind === "distance";
    return (
      <div key={`h-${a.id}`} className="pdfx-handles" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>
        {!poly && HANDLE_KEYS.map((k) => (
          <span
            key={k}
            className={`pdfx-handle pdfx-handle--${k}`}
            onPointerDown={(e) => startResize(e, a, k)}
          />
        ))}
        {poly && (a.paths?.[0] ?? []).map((pt, i) => {
          const v = toView(pt);
          return (
            <span
              key={i}
              className="pdfx-handle pdfx-handle--vertex"
              style={{ left: v.x - r.x, top: v.y - r.y }}
              onPointerDown={(e) => startVertexDrag(e, a, i, "path")}
            />
          );
        })}
        {a.kind === "callout" && (a.callout ?? []).map((pt, i) => {
          const v = toView(pt);
          return (
            <span
              key={`c${i}`}
              className="pdfx-handle pdfx-handle--callout"
              style={{ left: v.x - r.x, top: v.y - r.y }}
              onPointerDown={(e) => startVertexDrag(e, a, i, "callout")}
            />
          );
        })}
      </div>
    );
  };

  const shapes = p.annots.filter((a) => !a.hidden && !isHtmlKind(a.kind));
  const htmls = p.annots.filter((a) => !a.hidden && isHtmlKind(a.kind));
  const selected = p.annots.filter((a) => p.selectedIds.includes(a.id));

  return (
    <div
      ref={hostRef}
      className={`pdfx-annot-layer ${drawing ? "is-drawing" : ""} ${p.tool === "eraser" ? "is-erasing" : ""} ${p.tool === "select" ? "is-selecting" : ""}`}
      style={{ width: viewW, height: viewH }}
      onPointerDown={onPointerDown}
    >
      <svg className="pdfx-annot-svg" width={viewW} height={viewH} aria-hidden>
        {shapes.map(renderShape)}
        {htmls.filter((a) => a.kind === "callout").map(renderShape)}
        {draft && renderDraft(draft, p.style, toView, p.scale)}
        {marquee && (
          <rect
            {...toSvgRect(viewRect(marquee))}
            className="pdfx-marquee"
          />
        )}
      </svg>
      {htmls.map(renderHtml)}
      {p.tool === "select" && selected.map(renderHandles)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function isHtmlKind(k: AnnotKind): boolean {
  return k === "note" || k === "freetext" || k === "typewriter" || k === "callout" || k === "stamp" || k === "image" || k === "signature";
}

function toSvgRect(r: Rect) {
  return { x: r.x, y: r.y, width: Math.max(0, r.w), height: Math.max(0, r.h) };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function midpoint(a: Pt, b: Pt): Pt {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function centroid(pts: readonly Pt[]): Pt {
  if (!pts.length) return { x: 0, y: 0 };
  return {
    x: pts.reduce((s, q) => s + q.x, 0) / pts.length,
    y: pts.reduce((s, q) => s + q.y, 0) / pts.length,
  };
}

/** Shift-drag constrains a line to 15° increments, like Acrobat. */
function constrainAngle(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  const step = Math.PI / 12;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + Math.cos(angle) * len, y: from.y + Math.sin(angle) * len };
}

function squareOff(from: Pt, to: Pt): Pt {
  const s = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y));
  return { x: from.x + Math.sign(to.x - from.x || 1) * s, y: from.y + Math.sign(to.y - from.y || 1) * s };
}

function cloneGeometry(a: Annot): Pick<Annot, "rect" | "quads" | "paths" | "callout"> {
  return {
    rect: { ...a.rect },
    quads: a.quads?.map((q) => q.map((pt) => ({ ...pt })) as Quad),
    paths: a.paths?.map((path) => path.map((pt) => ({ ...pt }))),
    callout: a.callout?.map((pt) => ({ ...pt })),
  };
}

function translate(geo: ReturnType<typeof cloneGeometry>, dx: number, dy: number): Partial<Annot> {
  const shift = (pt: Pt) => ({ x: pt.x + dx, y: pt.y + dy });
  return {
    rect: { ...geo.rect, x: geo.rect.x + dx, y: geo.rect.y + dy },
    quads: geo.quads?.map((q) => q.map(shift) as Quad),
    paths: geo.paths?.map((path) => path.map(shift)),
    callout: geo.callout?.map(shift),
  };
}

function scaleGeometry(geo: ReturnType<typeof cloneGeometry>, from: Rect, to: Rect): Partial<Annot> {
  const sx = from.w > 0.01 ? to.w / from.w : 1;
  const sy = from.h > 0.01 ? to.h / from.h : 1;
  const map = (pt: Pt) => ({ x: to.x + (pt.x - from.x) * sx, y: to.y + (pt.y - from.y) * sy });
  return {
    rect: to,
    quads: geo.quads?.map((q) => q.map(map) as Quad),
    paths: geo.paths?.map((path) => path.map(map)),
    callout: geo.callout?.map(map),
  };
}

function renderArrowHead(tip: Pt, from: Pt, a: Annot, scale: number) {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const s = Math.max(4, a.strokeWidth * 3.2) * scale;
  const p1 = { x: tip.x - Math.cos(angle - 0.42) * s, y: tip.y - Math.sin(angle - 0.42) * s };
  const p2 = { x: tip.x - Math.cos(angle + 0.42) * s, y: tip.y - Math.sin(angle + 0.42) * s };
  return (
    <polygon
      points={`${tip.x},${tip.y} ${p1.x},${p1.y} ${p2.x},${p2.y}`}
      fill={a.color}
      fillOpacity={a.opacity}
      stroke={a.color}
      strokeWidth={Math.max(0.5, a.strokeWidth * 0.4) * scale}
    />
  );
}

function renderDraft(draft: DraftShape, style: DraftStyle, toView: (p: Pt) => Pt, scale: number) {
  const stroke = {
    stroke: style.color,
    strokeWidth: Math.max(0.6, style.strokeWidth) * scale,
    strokeOpacity: 0.95,
    fill: style.fill ?? "none",
    fillOpacity: style.fill ? style.opacity : 0,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (draft.rect) {
    const a = toView({ x: draft.rect.x, y: draft.rect.y });
    const b = toView({ x: draft.rect.x + draft.rect.w, y: draft.rect.y + draft.rect.h });
    const r = rectFromPoints(a, b);
    if (draft.kind === "circle") {
      return <ellipse cx={r.x + r.w / 2} cy={r.y + r.h / 2} rx={r.w / 2} ry={r.h / 2} {...stroke} strokeDasharray="5 4" />;
    }
    return <rect {...toSvgRect(r)} {...stroke} strokeDasharray="5 4" />;
  }
  if (draft.path) {
    const v = draft.path.map(toView);
    const d = `M ${v.map((q) => `${q.x} ${q.y}`).join(" L ")}`;
    return <path d={d} {...stroke} fill="none" fillOpacity={0} />;
  }
  if (draft.polygon) {
    const pts = [...draft.polygon, ...(draft.hover ? [draft.hover] : [])].map(toView);
    return (
      <g>
        <path d={`M ${pts.map((q) => `${q.x} ${q.y}`).join(" L ")}`} {...stroke} fill="none" fillOpacity={0} strokeDasharray="5 4" />
        {draft.polygon.map(toView).map((q, i) => (
          <circle key={i} cx={q.x} cy={q.y} r={3} fill="#fff" stroke={style.color} strokeWidth={1.5} />
        ))}
      </g>
    );
  }
  return null;
}
