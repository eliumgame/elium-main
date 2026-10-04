/**
 * Free-canvas slide renderer + editor surface. Every slide is a set of absolutely
 * positioned elements (text / shape / image) in % of the canvas, with free
 * rotation and z-order — the PowerPoint-style object model. When `editable`,
 * elements can be selected, moved, resized (8 handles), rotated, and text can be
 * edited in place; smart guides snap to the slide centre, edges and a light grid.
 */
import "./master.css";
import { playbackSrc } from "./media";
import { cellClass, isCovered, mergeAt } from "./table";
import { layoutDiagram, nodeFontPx, type DEdge, type DNode } from "./diagram";
import { isPromptOnly, withSlideNumber } from "./master";
import { useCallback, useEffect, useRef, useState } from "react";
import { REF_H, REF_W, type Slide, type SlideElement, type SlideTheme, type ShapeKind } from "./model";
import type { RevealState } from "./playback";
import {
  selectionAfterClick,
  marqueeHits,
  resizeGeometry,
  describeElement,
  keyboardPatch,
  nextElementId,
  type Rect,
} from "./selection";
import { announce } from "../ui/announce";
import SheetChart from "../sheet/SheetChart";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// --- Shape geometry (viewBox 0..100, preserveAspectRatio none) -------------
function shapePoints(kind: ShapeKind): string | null {
  switch (kind) {
    case "triangle":
      return "50,2 98,98 2,98";
    case "diamond":
      return "50,2 98,50 50,98 2,50";
    case "pentagon":
      return "50,2 98,38 79,98 21,98 2,38";
    case "hexagon":
      return "25,4 75,4 98,50 75,96 25,96 2,50";
    case "chevron":
      return "2,2 60,2 98,50 60,98 2,98 40,50";
    case "star":
      return "50,2 61,38 98,38 68,60 79,96 50,74 21,96 32,60 2,38 39,38";
    default:
      return null;
  }
}

function ShapeSvg({ el }: { el: SlideElement }) {
  const fill = el.fill ?? "#bfdbfe";
  const stroke = el.stroke ?? "#2563eb";
  const sw = el.strokeWidth ?? 2;
  const common = { fill, stroke, strokeWidth: sw, vectorEffect: "non-scaling-stroke" as const };
  const kind = el.shape ?? "rect";
  const pts = shapePoints(kind);
  let inner: React.ReactNode;
  if (kind === "line" || kind === "arrow") {
    inner = (
      <>
        {kind === "arrow" && (
          <defs>
            <marker
              id={`ah-${el.id}`}
              markerWidth="6"
              markerHeight="6"
              refX="4"
              refY="3"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M0,0 L6,3 L0,6 z" fill={stroke} />
            </marker>
          </defs>
        )}
        <line
          x1="2"
          y1="50"
          x2="98"
          y2="50"
          stroke={stroke}
          strokeWidth={sw}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          markerEnd={kind === "arrow" ? `url(#ah-${el.id})` : undefined}
        />
      </>
    );
  } else if (kind === "ellipse") {
    inner = <ellipse cx="50" cy="50" rx="48" ry="48" {...common} />;
  } else if (kind === "rect" || kind === "roundRect") {
    const r = kind === "roundRect" ? clamp(el.radius ?? 12, 0, 50) : 0;
    inner = <rect x="1" y="1" width="98" height="98" rx={r} ry={r} {...common} />;
  } else if (kind === "heart") {
    inner = (
      <path d="M50,88 C10,58 4,30 26,20 C38,14 48,22 50,32 C52,22 62,14 74,20 C96,30 90,58 50,88 Z" {...common} />
    );
  } else if (kind === "cloud") {
    inner = (
      <path d="M28,78 C10,78 8,58 22,54 C20,38 44,32 50,44 C56,30 84,34 80,54 C96,56 94,78 76,78 Z" {...common} />
    );
  } else if (pts) {
    inner = <polygon points={pts} {...common} />;
  } else {
    inner = <rect x="1" y="1" width="98" height="98" {...common} />;
  }
  return (
    <svg className="ce-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
      {inner}
    </svg>
  );
}

// --- Theme backgrounds ------------------------------------------------------
/** The slide background a theme renders with when no per-slide override is set
 *  — also used by the "Réglages" dialog to preview each theme swatch. */
export function themeDefaultBg(theme: SlideTheme): string {
  if (theme === "dark") return "#0d1117";
  if (theme === "brand") return "linear-gradient(160deg, #1d4ed8, #1e3a8a)";
  return "#ffffff";
}
export function slideBackground(slide: Slide, theme: SlideTheme): string {
  return slide.background ?? themeDefaultBg(theme);
}
export function themeText(theme: SlideTheme): string {
  return theme === "dark" || theme === "brand" ? "#f8fafc" : "#0f172a";
}

type DragMode = "move" | "rotate" | `resize-${"nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w"}`;
interface Guide {
  x?: number;
  y?: number;
}

export interface SlideCanvasProps {
  slide: Slide;
  elements: SlideElement[];
  theme: SlideTheme;
  scale: number; // px per REF_H (for font sizing); provided by parent measuring
  editable?: boolean;
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
  onChange?: (id: string, patch: Partial<SlideElement>, commit: boolean) => void;
  onBeginChange?: () => void;
  /** Right-click on one element, resp. on the empty canvas — opens a context menu. */
  onElementContext?: (e: React.MouseEvent, id: string) => void;
  onCanvasContext?: (e: React.MouseEvent) => void;
  /** Presenter playback: hides not-yet-revealed elements, animates entering ones. */
  reveal?: RevealState;
  /** Numéro de cette diapositive (remplace le jeton ‹#› des espaces réservés « numéro »). */
  slideNumber?: number;
  /** Projection : les médias sont lisibles (et démarrent seuls si « lecture automatique »). */
  playMedia?: boolean;
}

/** A table cell — mirrors the text element's focus-guarded contentEditable so
 *  typing never resets the caret while remote/state updates flow in. */
function TableCell({
  value,
  cls,
  rowSpan,
  colSpan,
  editing,
  onChange,
}: {
  value: string;
  cls: string;
  rowSpan?: number;
  colSpan?: number;
  editing: boolean;
  onChange: (t: string) => void;
}) {
  const ref = useRef<HTMLTableCellElement>(null);
  useEffect(() => {
    const n = ref.current;
    if (n && document.activeElement !== n && n.innerText !== value) n.innerText = value;
  }, [value, editing]);
  return (
    <td
      ref={ref}
      className={`ce-td ${cls}`}
      rowSpan={rowSpan}
      colSpan={colSpan}
      contentEditable={editing}
      suppressContentEditableWarning
      onInput={editing ? (e) => onChange((e.currentTarget as HTMLElement).innerText) : undefined}
    />
  );
}

/** Diagramme SmartArt : recalculé depuis son plan à chaque rendu (toujours modifiable). */
export function DiagramView({ d, scale, w, h }: { d: NonNullable<SlideElement["diagram"]>; scale: number; w: number; h: number }) {
  const lay = layoutDiagram(d.kind, d.outline, d.colors);
  const byId = new Map<number, DNode>(lay.nodes.map((n) => [n.id, n]));
  const boxW = (w / 100) * REF_W;
  const boxH = (h / 100) * REF_H;
  const edgePath = (e: DEdge): string | null => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return null;
    if (e.kind === "line") {
      const x1 = a.x + a.w / 2;
      const y1 = a.y + a.h;
      const x2 = b.x + b.w / 2;
      const y2 = b.y;
      const my = (y1 + y2) / 2;
      return `M${x1},${y1} L${x1},${my} L${x2},${my} L${x2},${y2}`;
    }
    return `M${a.x + a.w / 2},${a.y + a.h / 2} L${b.x + b.w / 2},${b.y + b.h / 2}`;
  };
  return (
    <div className="ce-diagram" role="img" aria-label={`Diagramme (${lay.nodes.length} éléments) : ${lay.nodes.map((n) => n.text).join(", ")}`}>
      <svg className="ce-diagram__edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <marker id="dg-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
            <path d="M0,0 L6,3 L0,6 Z" fill="#64748b" />
          </marker>
        </defs>
        {lay.edges.map((e, i) => {
          const p = edgePath(e);
          return p ? <path key={i} d={p} fill="none" stroke="#64748b" strokeWidth={2} vectorEffect="non-scaling-stroke" markerEnd={e.kind === "arrow" ? "url(#dg-arrow)" : undefined} /> : null;
        })}
      </svg>
      {lay.nodes.map((n) => (
        <div
          key={n.id}
          className={`ce-diagram__node ${n.round ? "is-round" : ""}`}
          style={{ left: `${n.x}%`, top: `${n.y}%`, width: `${n.w}%`, height: `${n.h}%`, background: n.color, fontSize: nodeFontPx(n, boxH, boxW) * scale }}
        >
          <span>{n.text}</span>
        </div>
      ))}
    </div>
  );
}

/** Audio/vidéo : lecteur en projection, vignette partout ailleurs (miniatures, éditeur). */
function MediaView({ m, play }: { m: NonNullable<SlideElement["media"]>; play: boolean }) {
  const ref = useRef<HTMLMediaElement>(null);
  if (!play)
    return (
      <div className="ce-media-ph" role="img" aria-label={`${m.kind === "video" ? "Vidéo" : "Audio"}${m.name ? ` : ${m.name}` : ""}`}>
        <span aria-hidden="true">{m.kind === "video" ? "▶" : "♪"}</span>
        <span className="ce-media-ph__name">{m.name ?? (m.kind === "video" ? "Vidéo" : "Audio")}</span>
      </div>
    );
  const common = {
    ref: ref as never,
    src: playbackSrc(m),
    controls: true,
    loop: !!m.loop,
    autoPlay: !!m.autoplay,
    preload: "auto" as const,
    onClick: (e: React.MouseEvent) => e.stopPropagation(), // un clic sur le lecteur ne fait pas avancer le diaporama
    onTimeUpdate: () => {
      const el = ref.current;
      if (el && m.trimEnd && m.trimEnd > 0 && el.currentTime >= m.trimEnd) {
        if (m.loop) el.currentTime = m.trimStart ?? 0;
        else el.pause();
      }
    },
  };
  return m.kind === "video" ? <video className="ce-media" {...common} /> : <audio className="ce-media ce-media--audio" {...common} />;
}

/** Renders one element (read-only or as part of the editable surface). */
function ElementView({
  el,
  scale,
  slideNumber,
  playMedia,
  editing,
  onEditInput,
  onCellEdit,
}: {
  el: SlideElement;
  slideNumber?: number;
  playMedia?: boolean;
  scale: number;
  editing: boolean;
  onEditInput?: (html: string) => void;
  onCellEdit?: (r: number, c: number, text: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node && editing && document.activeElement !== node && el.html != null && node.innerHTML !== el.html)
      node.innerHTML = el.html;
  }, [editing, el.html]);

  if (el.type === "shape") {
    return (
      <>
        <ShapeSvg el={el} />
        {el.text && (
          <span className="ce-shape-text" style={{ fontSize: 18 * scale }}>
            {el.text}
          </span>
        )}
      </>
    );
  }
  if (el.type === "image") {
    return el.src ? (
      <img className="ce-img" src={el.src} alt="" draggable={false} />
    ) : (
      <div className="ce-imgph">Image</div>
    );
  }
  if (el.type === "diagram" && el.diagram) {
    return <DiagramView d={el.diagram} scale={scale} w={el.w} h={el.h} />;
  }
  if (el.type === "media" && el.media) {
    return <MediaView m={el.media} play={!!playMedia} />;
  }
  if (el.type === "table" && el.table) {
    return (
      <table className="ce-table" style={{ fontSize: (el.fontSize ?? 18) * scale, color: el.color }}>
        <tbody>
          {el.table.cells.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => {
                const t = el.table!;
                if (isCovered(t, r, c)) return null; // masquée par une fusion
                const m = mergeAt(t, r, c);
                return (
                  <TableCell
                    key={c}
                    value={cell}
                    cls={cellClass(t, r, c)}
                    rowSpan={m && m.rs > 1 ? m.rs : undefined}
                    colSpan={m && m.cs > 1 ? m.cs : undefined}
                    editing={editing}
                    onChange={(txt) => onCellEdit?.(r, c, txt)}
                  />
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (el.type === "chart") {
    return el.chart ? (
      <div className="ce-chart">
        <SheetChart
          type={el.chart.kind}
          labels={el.chart.labels}
          series={[{ label: "Série 1", values: el.chart.values }]}
        />
      </div>
    ) : (
      <div className="ce-imgph">Graphique</div>
    );
  }
  // text
  const style: React.CSSProperties = {
    fontSize: (el.fontSize ?? 24) * scale,
    color: el.color,
    textAlign: el.align ?? "left",
    fontFamily: el.fontFamily,
    justifyContent: el.valign === "middle" ? "center" : el.valign === "bottom" ? "flex-end" : "flex-start",
  };
  if (editing) {
    return (
      <div
        ref={ref}
        className="ce-text ce-text--edit"
        style={style}
        contentEditable
        suppressContentEditableWarning
        onInput={(e) => onEditInput?.((e.currentTarget as HTMLDivElement).innerHTML)}
      />
    );
  }
  return (
    <div
      className={`ce-text${isPromptOnly(el) ? " ce-text--prompt" : ""}`}
      style={style}
      dangerouslySetInnerHTML={{ __html: withSlideNumber(el.html, slideNumber) }}
    />
  );
}

export default function SlideCanvas({
  slide,
  elements,
  theme,
  scale,
  editable,
  selectedIds,
  onSelectionChange,
  onChange,
  onBeginChange,
  onElementContext,
  onCanvasContext,
  reveal,
  slideNumber,
  playMedia,
}: SlideCanvasProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const drag = useRef<
    | { kind: "move"; sx: number; sy: number; rect: DOMRect; items: { id: string; o: SlideElement }[] }
    | {
        kind: "handle";
        id: string;
        mode: DragMode;
        sx: number;
        sy: number;
        rect: DOMRect;
        o: SlideElement;
        cx: number;
        cy: number;
      }
    | null
  >(null);

  const sel = selectedIds ?? [];
  const selSet = new Set(sel);
  // Leave in-place text editing whenever the edited element is no longer the
  // sole selection.
  useEffect(() => {
    if (editingId && !(sel.length === 1 && sel[0] === editingId)) setEditingId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  // --- Move (drag): the whole current selection moves together --------------
  const beginMove = useCallback(
    (e: React.MouseEvent, elId: string) => {
      if (!editable) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = boxRef.current?.getBoundingClientRect();
      if (!rect) return;
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      const nextSel = selectionAfterClick(elements, selectedIds ?? [], elId, additive);
      onSelectionChange?.(nextSel);
      if (additive) return; // shift/ctrl-click toggles selection; no drag
      const moving = new Set(nextSel);
      const items = elements.filter((x) => moving.has(x.id)).map((x) => ({ id: x.id, o: { ...x } }));
      if (!items.length) return;
      onBeginChange?.();
      drag.current = { kind: "move", sx: e.clientX, sy: e.clientY, rect, items };
      const move = (ev: MouseEvent) => {
        const d = drag.current;
        if (!d || d.kind !== "move") return;
        const dxp = ((ev.clientX - d.sx) / d.rect.width) * 100;
        const dyp = ((ev.clientY - d.sy) / d.rect.height) * 100;
        if (d.items.length === 1) {
          // single element → snap to slide centre / edges with guides
          const o = d.items[0]!.o;
          let nx = clamp(o.x + dxp, -o.w + 5, 100 - 5);
          let ny = clamp(o.y + dyp, -o.h + 5, 100 - 5);
          const g: Guide[] = [];
          const cx = nx + o.w / 2,
            cy = ny + o.h / 2;
          const snap = (val: number, target: number) => (Math.abs(val - target) < 1.2 ? target : null);
          for (const t of [50, 0, 100]) {
            const s = snap(cx, t);
            if (s != null) {
              nx = s - o.w / 2;
              g.push({ x: t });
              break;
            }
          }
          for (const t of [0, 100]) {
            if (Math.abs(nx - t) < 1.2) {
              nx = t;
              g.push({ x: t });
            }
            if (Math.abs(nx + o.w - t) < 1.2) {
              nx = t - o.w;
              g.push({ x: t });
            }
          }
          for (const t of [50, 0, 100]) {
            const s = snap(cy, t);
            if (s != null) {
              ny = s - o.h / 2;
              g.push({ y: t });
              break;
            }
          }
          for (const t of [0, 100]) {
            if (Math.abs(ny - t) < 1.2) {
              ny = t;
              g.push({ y: t });
            }
            if (Math.abs(ny + o.h - t) < 1.2) {
              ny = t - o.h;
              g.push({ y: t });
            }
          }
          setGuides(g);
          onChange?.(d.items[0]!.id, { x: Math.round(nx * 10) / 10, y: Math.round(ny * 10) / 10 }, false);
        } else {
          for (const it of d.items) {
            const nx = clamp(it.o.x + dxp, -it.o.w + 5, 100 - 5);
            const ny = clamp(it.o.y + dyp, -it.o.h + 5, 100 - 5);
            onChange?.(it.id, { x: Math.round(nx * 10) / 10, y: Math.round(ny * 10) / 10 }, false);
          }
        }
      };
      const up = () => {
        const d = drag.current;
        drag.current = null;
        setGuides([]);
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        if (d && d.kind === "move" && d.items[0]) onChange?.(d.items[0].id, {}, true); // commit checkpoint
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [editable, elements, selectedIds, onSelectionChange, onChange, onBeginChange],
  );

  // --- Handles (resize/rotate) on the single selected element ---------------
  const beginHandle = useCallback(
    (e: React.MouseEvent, elId: string, mode: DragMode) => {
      if (!editable) return;
      e.preventDefault();
      e.stopPropagation();
      const rect = boxRef.current?.getBoundingClientRect();
      const o = elements.find((x) => x.id === elId);
      if (!rect || !o) return;
      onBeginChange?.();
      drag.current = {
        kind: "handle",
        id: elId,
        mode,
        sx: e.clientX,
        sy: e.clientY,
        o: { ...o },
        cx: o.x + o.w / 2,
        cy: o.y + o.h / 2,
        rect,
      };
      const move = (ev: MouseEvent) => {
        const d = drag.current;
        if (!d || d.kind !== "handle") return;
        const dxp = ((ev.clientX - d.sx) / d.rect.width) * 100;
        const dyp = ((ev.clientY - d.sy) / d.rect.height) * 100;
        if (d.mode === "rotate") {
          const cxPx = d.rect.left + (d.cx / 100) * d.rect.width;
          const cyPx = d.rect.top + (d.cy / 100) * d.rect.height;
          let ang = (Math.atan2(ev.clientY - cyPx, ev.clientX - cxPx) * 180) / Math.PI + 90;
          if (!ev.shiftKey) ang = Math.round(ang / 15) * 15;
          onChange?.(d.id, { rotation: Math.round(ang) }, false);
        } else {
          // resize — Shift keeps the aspect ratio on corner handles
          const r = resizeGeometry(d.o, d.mode.slice(7), dxp, dyp, ev.shiftKey);
          onChange?.(d.id, r, false);
        }
      };
      const up = () => {
        const d = drag.current;
        drag.current = null;
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        if (d && d.kind === "handle") onChange?.(d.id, {}, true);
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [editable, elements, onChange, onBeginChange],
  );

  // --- Marquee (rubber-band) selection on the empty canvas ------------------
  const beginMarquee = useCallback(
    (e: React.MouseEvent) => {
      if (!editable) return;
      const rect = boxRef.current?.getBoundingClientRect();
      if (!rect) return;
      setEditingId(null);
      const sx = ((e.clientX - rect.left) / rect.width) * 100;
      const sy = ((e.clientY - rect.top) / rect.height) * 100;
      let moved = false;
      setMarquee({ x: sx, y: sy, w: 0, h: 0 });
      const move = (ev: MouseEvent) => {
        const w = ((ev.clientX - rect.left) / rect.width) * 100 - sx;
        const h = ((ev.clientY - rect.top) / rect.height) * 100 - sy;
        if (Math.abs(w) > 0.6 || Math.abs(h) > 0.6) moved = true;
        const box = { x: sx, y: sy, w, h };
        setMarquee(box);
        onSelectionChange?.(marqueeHits(elements, box));
      };
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        setMarquee(null);
        if (!moved) onSelectionChange?.([]); // a bare click clears the selection
      };
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [editable, elements, onSelectionChange],
  );

  const bg = slideBackground(slide, theme);
  const baseColor = themeText(theme);
  const single = sel.length === 1;

  // --- Keyboard access: Tab between elements, arrows move, Alt+arrows resize, Esc clears ---
  const announceSelection = (id: string | undefined) => {
    const at = id ? elements.findIndex((x) => x.id === id) : -1;
    announce(at >= 0 ? `${describeElement(elements[at]!, at, elements.length)}, sélectionné` : "Aucune sélection");
  };
  const onCanvasKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Typing inside an element (or a cell) belongs to that element.
    if (!editable || editingId || e.target !== e.currentTarget) return;
    if (e.key === "Tab") {
      const next = nextElementId(elements, sel[sel.length - 1], e.shiftKey);
      if (next === null) {
        if (sel.length) onSelectionChange?.([]); // past the last element: focus moves on
        return;
      }
      e.preventDefault();
      onSelectionChange?.([next]);
      announceSelection(next);
    } else if (e.key === "Escape") {
      if (sel.length) {
        e.preventDefault();
        onSelectionChange?.([]);
        announce("Sélection effacée");
      }
    } else if (e.key === "Enter" || e.key === "F2") {
      const target = single ? elements.find((x) => x.id === sel[0]) : undefined;
      if (target && (target.type === "text" || target.type === "table")) {
        e.preventDefault();
        setEditingId(target.id);
        announce("Édition du texte : Échap pour terminer");
      }
    } else if (e.key.startsWith("Arrow") && sel.length) {
      const targets = elements.filter((x) => selSet.has(x.id));
      const patches = targets.map((x) => [x, keyboardPatch(x, e.key, e.shiftKey, e.altKey)] as const);
      if (!patches.some(([, p]) => p)) return;
      e.preventDefault();
      onBeginChange?.();
      for (const [x, p] of patches) if (p) onChange?.(x.id, p, true);
      const first = targets[0]!;
      announce(
        e.altKey
          ? `${Math.round(first.w)} % sur ${Math.round(first.h)} %`
          : `Position ${Math.round(first.x)} %, ${Math.round(first.y)} %`,
      );
    }
  };

  return (
    <div
      ref={boxRef}
      className={`slide-cv ${editable ? "is-editable" : ""}`}
      style={{ background: bg, color: baseColor }}
      {...(editable
        ? {
            tabIndex: 0,
            role: "group",
            "aria-roledescription": "diapositive modifiable",
            "aria-label": `Diapositive, ${elements.length} élément(s). Tab : élément suivant, flèches : déplacer, Alt + flèches : redimensionner, Entrée : modifier le texte, Suppr : supprimer.`,
            onKeyDown: onCanvasKeyDown,
          }
        : {})}
      onMouseDown={(e) => {
        if (editable && e.target === e.currentTarget) beginMarquee(e);
      }}
      onContextMenu={(e) => {
        if (editable && e.target === e.currentTarget && onCanvasContext) {
          e.preventDefault();
          onCanvasContext(e);
        }
      }}
    >
      {(editable ? elements : elements.filter((e) => !isPromptOnly(e))).map((elm) => {
        const selected = editable && selSet.has(elm.id);
        const editing = editingId === elm.id;
        const hidden = reveal?.hidden.has(elm.id) ?? false;
        const anim = reveal?.entering.get(elm.id);
        const box: React.CSSProperties = {
          left: `${elm.x}%`,
          top: `${elm.y}%`,
          width: `${elm.w}%`,
          height: `${elm.h}%`,
          ["--rot" as string]: `${elm.rotation ?? 0}deg`,
          transform: "rotate(var(--rot))",
          opacity: elm.opacity ?? 1,
          ...(anim?.durationMs ? { ["--anim-dur" as string]: `${anim.durationMs}ms` } : {}),
          ...(anim?.delayMs ? { animationDelay: `${anim.delayMs}ms` } : {}),
        };
        return (
          <div
            key={elm.id}
            role={editable ? "group" : undefined}
            aria-label={editable ? describeElement(elm, elements.indexOf(elm), elements.length) : undefined}
            aria-current={selected ? "true" : undefined}
            className={`ce ce--${elm.type} ${selected ? "is-selected" : ""} ${editing ? "is-editing" : ""} ${hidden ? "sv-hidden" : ""} ${anim ? `sv-anim sv-anim--${anim.effect}` : ""}`}
            style={box}
            onMouseDown={(e) => {
              if (!editing) beginMove(e, elm.id);
            }}
            onContextMenu={(e) => {
              if (!editable || !onElementContext) return;
              e.preventDefault();
              e.stopPropagation();
              onElementContext(e, elm.id);
            }}
            onDoubleClick={(e) => {
              if (editable && (elm.type === "text" || elm.type === "table")) {
                e.stopPropagation();
                onSelectionChange?.([elm.id]);
                setEditingId(elm.id);
              }
            }}
          >
            <ElementView
              el={elm}
              slideNumber={slideNumber}
              playMedia={playMedia}
              scale={scale}
              editing={editing}
              onEditInput={(html) => onChange?.(elm.id, { html }, false)}
              onCellEdit={(r, c, text) => {
                const t = elm.table;
                if (!t) return;
                const cells = t.cells.map((row) => row.slice());
                if (cells[r]) cells[r]![c] = text;
                onChange?.(elm.id, { table: { ...t, cells } }, false);
              }}
            />
            {selected && !editing && single && (
              <>
                <span className="ce-rot" onMouseDown={(e) => beginHandle(e, elm.id, "rotate")} title="Pivoter" />
                {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((h) => (
                  <span
                    key={h}
                    className={`ce-h ce-h--${h}`}
                    onMouseDown={(e) => beginHandle(e, elm.id, `resize-${h}`)}
                  />
                ))}
              </>
            )}
          </div>
        );
      })}
      {editable &&
        guides.map((g, i) => (
          <div
            key={i}
            className={`cv-guide ${g.x != null ? "cv-guide--v" : "cv-guide--h"}`}
            style={g.x != null ? { left: `${g.x}%` } : { top: `${g.y}%` }}
          />
        ))}
      {editable && marquee && (
        <div
          className="cv-marquee"
          style={{
            left: `${Math.min(marquee.x, marquee.x + marquee.w)}%`,
            top: `${Math.min(marquee.y, marquee.y + marquee.h)}%`,
            width: `${Math.abs(marquee.w)}%`,
            height: `${Math.abs(marquee.h)}%`,
          }}
        />
      )}
    </div>
  );
}
