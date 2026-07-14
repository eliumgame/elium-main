/**
 * Free-canvas slide renderer + editor surface. Every slide is a set of absolutely
 * positioned elements (text / shape / image) in % of the canvas, with free
 * rotation and z-order — the PowerPoint-style object model. When `editable`,
 * elements can be selected, moved, resized (8 handles), rotated, and text can be
 * edited in place; smart guides snap to the slide centre, edges and a light grid.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Slide, SlideElement, SlideTheme, ShapeKind } from "./model";
import type { RevealState } from "./playback";
import SheetChart from "../sheet/SheetChart";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// --- Shape geometry (viewBox 0..100, preserveAspectRatio none) -------------
function shapePoints(kind: ShapeKind): string | null {
  switch (kind) {
    case "triangle": return "50,2 98,98 2,98";
    case "diamond": return "50,2 98,50 50,98 2,50";
    case "pentagon": return "50,2 98,38 79,98 21,98 2,38";
    case "hexagon": return "25,4 75,4 98,50 75,96 25,96 2,50";
    case "chevron": return "2,2 60,2 98,50 60,98 2,98 40,50";
    case "star": return "50,2 61,38 98,38 68,60 79,96 50,74 21,96 32,60 2,38 39,38";
    default: return null;
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
            <marker id={`ah-${el.id}`} markerWidth="6" markerHeight="6" refX="4" refY="3" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L6,3 L0,6 z" fill={stroke} />
            </marker>
          </defs>
        )}
        <line x1="2" y1="50" x2="98" y2="50" stroke={stroke} strokeWidth={sw} strokeLinecap="round" vectorEffect="non-scaling-stroke" markerEnd={kind === "arrow" ? `url(#ah-${el.id})` : undefined} />
      </>
    );
  } else if (kind === "ellipse") {
    inner = <ellipse cx="50" cy="50" rx="48" ry="48" {...common} />;
  } else if (kind === "rect" || kind === "roundRect") {
    const r = kind === "roundRect" ? clamp(el.radius ?? 12, 0, 50) : 0;
    inner = <rect x="1" y="1" width="98" height="98" rx={r} ry={r} {...common} />;
  } else if (kind === "heart") {
    inner = <path d="M50,88 C10,58 4,30 26,20 C38,14 48,22 50,32 C52,22 62,14 74,20 C96,30 90,58 50,88 Z" {...common} />;
  } else if (kind === "cloud") {
    inner = <path d="M28,78 C10,78 8,58 22,54 C20,38 44,32 50,44 C56,30 84,34 80,54 C96,56 94,78 76,78 Z" {...common} />;
  } else if (pts) {
    inner = <polygon points={pts} {...common} />;
  } else {
    inner = <rect x="1" y="1" width="98" height="98" {...common} />;
  }
  return <svg className="ce-svg" viewBox="0 0 100 100" preserveAspectRatio="none">{inner}</svg>;
}

// --- Theme backgrounds ------------------------------------------------------
export function slideBackground(slide: Slide, theme: SlideTheme): string {
  if (slide.background) return slide.background;
  if (theme === "dark") return "#0d1117";
  if (theme === "brand") return "linear-gradient(160deg, #1d4ed8, #1e3a8a)";
  return "#ffffff";
}
export function themeText(theme: SlideTheme): string {
  return theme === "dark" || theme === "brand" ? "#f8fafc" : "#0f172a";
}

type DragMode = "move" | "rotate" | `resize-${"nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w"}`;
interface Guide { x?: number; y?: number }

export interface SlideCanvasProps {
  slide: Slide;
  elements: SlideElement[];
  theme: SlideTheme;
  scale: number; // px per REF_H (for font sizing); provided by parent measuring
  editable?: boolean;
  selectedId?: string | null;
  onSelect?: (id: string | null) => void;
  onChange?: (id: string, patch: Partial<SlideElement>, commit: boolean) => void;
  onBeginChange?: () => void;
  /** Presenter playback: hides not-yet-revealed elements, animates entering ones. */
  reveal?: RevealState;
}

/** A table cell — mirrors the text element's focus-guarded contentEditable so
 *  typing never resets the caret while remote/state updates flow in. */
function TableCell({ value, head, editing, onChange }: { value: string; head: boolean; editing: boolean; onChange: (t: string) => void }) {
  const ref = useRef<HTMLTableCellElement>(null);
  useEffect(() => {
    const n = ref.current;
    if (n && document.activeElement !== n && n.innerText !== value) n.innerText = value;
  }, [value, editing]);
  return (
    <td
      ref={ref}
      className={`ce-td ${head ? "ce-td--head" : ""}`}
      contentEditable={editing}
      suppressContentEditableWarning
      onInput={editing ? (e) => onChange((e.currentTarget as HTMLElement).innerText) : undefined}
    />
  );
}

/** Renders one element (read-only or as part of the editable surface). */
function ElementView({ el, scale, editing, onEditInput, onCellEdit }: { el: SlideElement; scale: number; editing: boolean; onEditInput?: (html: string) => void; onCellEdit?: (r: number, c: number, text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    if (node && editing && document.activeElement !== node && el.html != null && node.innerHTML !== el.html) node.innerHTML = el.html;
  }, [editing, el.html]);

  if (el.type === "shape") {
    return (
      <>
        <ShapeSvg el={el} />
        {el.text && <span className="ce-shape-text" style={{ fontSize: 18 * scale }}>{el.text}</span>}
      </>
    );
  }
  if (el.type === "image") {
    return el.src ? <img className="ce-img" src={el.src} alt="" draggable={false} /> : <div className="ce-imgph">Image</div>;
  }
  if (el.type === "table" && el.table) {
    return (
      <table className="ce-table" style={{ fontSize: (el.fontSize ?? 18) * scale, color: el.color }}>
        <tbody>
          {el.table.cells.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <TableCell key={c} value={cell} head={r === 0} editing={editing} onChange={(t) => onCellEdit?.(r, c, t)} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (el.type === "chart") {
    return el.chart ? <div className="ce-chart"><SheetChart type={el.chart.kind} labels={el.chart.labels} values={el.chart.values} /></div> : <div className="ce-imgph">Graphique</div>;
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
    return <div ref={ref} className="ce-text ce-text--edit" style={style} contentEditable suppressContentEditableWarning onInput={(e) => onEditInput?.((e.currentTarget as HTMLDivElement).innerHTML)} />;
  }
  return <div className="ce-text" style={style} dangerouslySetInnerHTML={{ __html: el.html ?? "" }} />;
}

export default function SlideCanvas({ slide, elements, theme, scale, editable, selectedId, onSelect, onChange, onBeginChange, reveal }: SlideCanvasProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const drag = useRef<{ id: string; mode: DragMode; sx: number; sy: number; o: SlideElement; cx: number; cy: number; rect: DOMRect } | null>(null);

  useEffect(() => { if (selectedId == null) setEditingId(null); }, [selectedId]);

  const begin = useCallback((e: React.MouseEvent, elId: string, mode: DragMode) => {
    if (!editable) return;
    e.preventDefault(); e.stopPropagation();
    const rect = boxRef.current?.getBoundingClientRect();
    const o = elements.find((x) => x.id === elId);
    if (!rect || !o) return;
    onSelect?.(elId);
    onBeginChange?.();
    drag.current = { id: elId, mode, sx: e.clientX, sy: e.clientY, o: { ...o }, cx: o.x + o.w / 2, cy: o.y + o.h / 2, rect };

    const move = (ev: MouseEvent) => {
      const d = drag.current; if (!d) return;
      const dxp = ((ev.clientX - d.sx) / d.rect.width) * 100;
      const dyp = ((ev.clientY - d.sy) / d.rect.height) * 100;
      const g: Guide[] = [];
      if (d.mode === "move") {
        let nx = clamp(d.o.x + dxp, -d.o.w + 5, 100 - 5);
        let ny = clamp(d.o.y + dyp, -d.o.h + 5, 100 - 5);
        // snap centre / edges to slide guides
        const cx = nx + d.o.w / 2, cy = ny + d.o.h / 2;
        const snap = (val: number, target: number) => (Math.abs(val - target) < 1.2 ? target : null);
        for (const t of [50, 0, 100]) { const s = snap(cx, t); if (s != null) { nx = s - d.o.w / 2; g.push({ x: t }); break; } }
        for (const t of [0, 100]) { if (Math.abs(nx - t) < 1.2) { nx = t; g.push({ x: t }); } if (Math.abs(nx + d.o.w - t) < 1.2) { nx = t - d.o.w; g.push({ x: t }); } }
        for (const t of [50, 0, 100]) { const s = snap(cy, t); if (s != null) { ny = s - d.o.h / 2; g.push({ y: t }); break; } }
        for (const t of [0, 100]) { if (Math.abs(ny - t) < 1.2) { ny = t; g.push({ y: t }); } if (Math.abs(ny + d.o.h - t) < 1.2) { ny = t - d.o.h; g.push({ y: t }); } }
        setGuides(g);
        onChange?.(d.id, { x: Math.round(nx * 10) / 10, y: Math.round(ny * 10) / 10 }, false);
      } else if (d.mode === "rotate") {
        const cxPx = d.rect.left + (d.cx / 100) * d.rect.width;
        const cyPx = d.rect.top + (d.cy / 100) * d.rect.height;
        let ang = (Math.atan2(ev.clientY - cyPx, ev.clientX - cxPx) * 180) / Math.PI + 90;
        if (!ev.shiftKey) ang = Math.round(ang / 15) * 15;
        onChange?.(d.id, { rotation: Math.round(ang) }, false);
      } else {
        // resize — adjust the relevant edges
        const m = d.mode.slice(7);
        let { x, y, w, h } = d.o;
        if (m.includes("e")) w = clamp(d.o.w + dxp, 3, 100 - d.o.x);
        if (m.includes("s")) h = clamp(d.o.h + dyp, 3, 100 - d.o.y);
        if (m.includes("w")) { const nx = clamp(d.o.x + dxp, 0, d.o.x + d.o.w - 3); w = d.o.w + (d.o.x - nx); x = nx; }
        if (m.includes("n")) { const ny = clamp(d.o.y + dyp, 0, d.o.y + d.o.h - 3); h = d.o.h + (d.o.y - ny); y = ny; }
        onChange?.(d.id, { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, w: Math.round(w * 10) / 10, h: Math.round(h * 10) / 10 }, false);
      }
    };
    const up = () => {
      const d = drag.current; drag.current = null;
      setGuides([]);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (d) onChange?.(d.id, {}, true); // commit checkpoint
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }, [editable, elements, onSelect, onChange, onBeginChange]);

  const bg = slideBackground(slide, theme);
  const baseColor = themeText(theme);

  return (
    <div ref={boxRef} className={`slide-cv ${editable ? "is-editable" : ""}`} style={{ background: bg, color: baseColor }} onMouseDown={() => { if (editable) { onSelect?.(null); setEditingId(null); } }}>
      {elements.map((elm) => {
        const selected = editable && selectedId === elm.id;
        const editing = editingId === elm.id;
        const hidden = reveal?.hidden.has(elm.id) ?? false;
        const anim = reveal?.entering.get(elm.id);
        const box: React.CSSProperties = {
          left: `${elm.x}%`, top: `${elm.y}%`, width: `${elm.w}%`, height: `${elm.h}%`,
          ["--rot" as string]: `${elm.rotation ?? 0}deg`,
          transform: "rotate(var(--rot))",
          opacity: elm.opacity ?? 1,
          ...(anim?.durationMs ? { ["--anim-dur" as string]: `${anim.durationMs}ms` } : {}),
          ...(anim?.delayMs ? { animationDelay: `${anim.delayMs}ms` } : {}),
        };
        return (
          <div
            key={elm.id}
            className={`ce ce--${elm.type} ${selected ? "is-selected" : ""} ${editing ? "is-editing" : ""} ${hidden ? "sv-hidden" : ""} ${anim ? `sv-anim sv-anim--${anim.effect}` : ""}`}
            style={box}
            onMouseDown={(e) => { if (!editing) begin(e, elm.id, "move"); }}
            onDoubleClick={(e) => { if (editable && (elm.type === "text" || elm.type === "table")) { e.stopPropagation(); onSelect?.(elm.id); setEditingId(elm.id); } }}
          >
            <ElementView
              el={elm}
              scale={scale}
              editing={editing}
              onEditInput={(html) => onChange?.(elm.id, { html }, false)}
              onCellEdit={(r, c, text) => {
                const t = elm.table; if (!t) return;
                const cells = t.cells.map((row) => row.slice());
                if (cells[r]) cells[r]![c] = text;
                onChange?.(elm.id, { table: { ...t, cells } }, false);
              }}
            />
            {selected && !editing && (
              <>
                <span className="ce-rot" onMouseDown={(e) => begin(e, elm.id, "rotate")} title="Pivoter" />
                {(["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((h) => (
                  <span key={h} className={`ce-h ce-h--${h}`} onMouseDown={(e) => begin(e, elm.id, `resize-${h}`)} />
                ))}
              </>
            )}
          </div>
        );
      })}
      {editable && guides.map((g, i) => (
        <div key={i} className={`cv-guide ${g.x != null ? "cv-guide--v" : "cv-guide--h"}`} style={g.x != null ? { left: `${g.x}%` } : { top: `${g.y}%` }} />
      ))}
    </div>
  );
}
