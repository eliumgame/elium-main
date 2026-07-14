import { useRef, useState } from "react";
import { type Anno, type Tool, newId, HIGHLIGHT_COLOR, WHITEOUT_COLOR } from "./model";
import { fontCss } from "../ui/fonts";

/** The active text/drawing style applied to newly created annotations. */
export interface Draft { color: string; strokeWidth: number; fontSize: number; fontFamily?: string; bold?: boolean; italic?: boolean; underline?: boolean; }

interface Props {
  pageId: string;
  w: number; h: number; // page size at scale 1 (PDF points)
  scale: number;
  annos: Anno[];
  tool: Tool;
  selId: string | null;
  editingId: string | null;
  draft: Draft;
  onAdd: (a: Anno) => void;
  onUpdate: (id: string, patch: Partial<Anno>) => void;
  onSelect: (id: string | null) => void;
  onEdit: (id: string | null) => void;
  onToolDone: () => void;
  onBeginChange?: () => void; // checkpoint for undo, at the start of a move/resize/edit gesture
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Editing surface drawn over one rendered PDF page; coords are page points. */
export default function PageEditLayer(p: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLInputElement>(null);
  const [draftBox, setDraftBox] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [draftPts, setDraftPts] = useState<{ x: number; y: number }[] | null>(null);
  const pendImg = useRef<{ x: number; y: number } | null>(null);

  const ptFromEvent = (e: { clientX: number; clientY: number }) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / p.scale, y: (e.clientY - r.top) / p.scale };
  };

  // --- creating new annotations (when a drawing tool is active) ------------
  const onLayerDown = (e: React.MouseEvent) => {
    if (p.tool === "select") {
      if (e.target === ref.current) { p.onSelect(null); p.onEdit(null); }
      return;
    }
    e.preventDefault();
    const start = ptFromEvent(e);

    if (p.tool === "image") {
      pendImg.current = start;
      imgRef.current?.click();
      return;
    }
    if (p.tool === "text") {
      const a: Anno = {
        id: newId("an"), type: "text", x: start.x, y: start.y, w: 200, h: p.draft.fontSize * 1.6,
        color: p.draft.color, strokeWidth: p.draft.strokeWidth, fontSize: p.draft.fontSize, text: "",
        fontFamily: p.draft.fontFamily, bold: p.draft.bold, italic: p.draft.italic, underline: p.draft.underline,
      };
      p.onAdd(a); p.onSelect(a.id); p.onEdit(a.id); p.onToolDone();
      return;
    }
    if (p.tool === "draw") {
      const pts = [start];
      const move = (ev: MouseEvent) => { pts.push(ptFromEvent(ev)); setDraftPts([...pts]); };
      const up = () => {
        window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
        setDraftPts(null);
        if (pts.length > 1) {
          const xs = pts.map((q) => q.x), ys = pts.map((q) => q.y);
          const x = Math.min(...xs), y = Math.min(...ys);
          p.onAdd({ id: newId("an"), type: "draw", x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y, color: p.draft.color, strokeWidth: p.draft.strokeWidth, fontSize: p.draft.fontSize, points: pts });
        }
        p.onToolDone();
      };
      window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
      return;
    }
    // box tools: rect / ellipse / line / highlight / whiteout
    const move = (ev: MouseEvent) => {
      const cur = ptFromEvent(ev);
      setDraftBox({ x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) });
    };
    const up = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up);
      const cur = ptFromEvent(ev);
      const box = { x: Math.min(start.x, cur.x), y: Math.min(start.y, cur.y), w: Math.abs(cur.x - start.x), h: Math.abs(cur.y - start.y) };
      setDraftBox(null);
      if (box.w < 4 && box.h < 4) { p.onToolDone(); return; }
      const a: Anno = { id: newId("an"), type: p.tool as Anno["type"], ...box, color: p.draft.color, strokeWidth: p.draft.strokeWidth, fontSize: p.draft.fontSize };
      p.onAdd(a); p.onSelect(a.id); p.onToolDone();
    };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  const onImageFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const at = pendImg.current;
    if (!file || !at) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      const im = new Image();
      im.onload = () => {
        const maxW = Math.min(260, p.w - at.x);
        const ratio = im.height / im.width || 1;
        const wdt = Math.min(maxW, im.width);
        const a: Anno = { id: newId("an"), type: "image", x: at.x, y: at.y, w: wdt, h: wdt * ratio, color: p.draft.color, strokeWidth: 0, fontSize: 0, src };
        p.onAdd(a); p.onSelect(a.id);
      };
      im.src = src;
    };
    reader.readAsDataURL(file);
    p.onToolDone();
  };

  // --- moving / resizing an existing annotation ----------------------------
  const startDrag = (e: React.MouseEvent, a: Anno, mode: "move" | "resize") => {
    if (p.tool !== "select") return;
    e.preventDefault(); e.stopPropagation();
    p.onSelect(a.id);
    p.onBeginChange?.();
    const s = ptFromEvent(e);
    const o = { x: a.x, y: a.y, w: a.w, h: a.h };
    const move = (ev: MouseEvent) => {
      const c = ptFromEvent(ev);
      const dx = c.x - s.x, dy = c.y - s.y;
      if (mode === "move") p.onUpdate(a.id, { x: clamp(o.x + dx, 0, p.w - o.w), y: clamp(o.y + dy, 0, p.h - o.h) });
      else p.onUpdate(a.id, { w: Math.max(8, o.w + dx), h: Math.max(8, o.h + dy) });
    };
    const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
    window.addEventListener("mousemove", move); window.addEventListener("mouseup", up);
  };

  const S = p.scale;
  const pe = p.tool === "select"; // pointer-events on annotations only in select mode

  const renderAnno = (a: Anno) => {
    const sel = p.selId === a.id;
    const box: React.CSSProperties = {
      position: "absolute", left: a.x * S, top: a.y * S, width: a.w * S, height: a.h * S,
      pointerEvents: pe ? "auto" : "none",
    };
    const common = `pdf-anno ${sel ? "is-selected" : ""}`;
    const handle = sel && p.tool === "select" && a.type !== "draw" && a.type !== "line"
      ? <span className="pdf-anno__handle" onMouseDown={(e) => startDrag(e, a, "resize")} />
      : null;

    if (a.type === "text") {
      const editing = p.editingId === a.id;
      return (
        <div key={a.id} className={common} style={box} onMouseDown={(e) => startDrag(e, a, "move")} onDoubleClick={() => p.onEdit(a.id)}>
          {(() => {
            const textStyle: React.CSSProperties = {
              color: a.color, fontSize: a.fontSize * S, lineHeight: 1.2,
              fontFamily: fontCss(a.fontFamily),
              fontWeight: a.bold ? 700 : 400,
              fontStyle: a.italic ? "italic" : "normal",
              textDecoration: a.underline ? "underline" : "none",
            };
            return editing ? (
              <textarea
                className="pdf-anno__text-edit" autoFocus
                style={textStyle}
                value={a.text || ""}
                onFocus={() => p.onBeginChange?.()}
                onChange={(e) => p.onUpdate(a.id, { text: e.target.value })}
                onBlur={() => p.onEdit(null)}
                onMouseDown={(e) => e.stopPropagation()}
              />
            ) : (
              <div className="pdf-anno__text" style={textStyle}>{a.text || "Texte…"}</div>
            );
          })()}
          {handle}
        </div>
      );
    }
    if (a.type === "image") {
      return (
        <div key={a.id} className={common} style={box} onMouseDown={(e) => startDrag(e, a, "move")}>
          <img src={a.src} alt="" style={{ width: "100%", height: "100%", objectFit: "fill" }} draggable={false} />
          {handle}
        </div>
      );
    }
    if (a.type === "rect" || a.type === "ellipse" || a.type === "highlight" || a.type === "whiteout") {
      const style: React.CSSProperties = { ...box };
      if (a.type === "rect") { style.border = `${a.strokeWidth * S}px solid ${a.color}`; }
      else if (a.type === "ellipse") { style.border = `${a.strokeWidth * S}px solid ${a.color}`; style.borderRadius = "50%"; }
      else if (a.type === "highlight") { style.background = HIGHLIGHT_COLOR; style.opacity = 0.4; }
      else { style.background = WHITEOUT_COLOR; }
      return (
        <div key={a.id} className={common} style={style} onMouseDown={(e) => startDrag(e, a, "move")}>{handle}</div>
      );
    }
    // line / draw → inline SVG within the bounding box
    const pts = a.type === "draw" && a.points
      ? a.points.map((q) => `${(q.x - a.x) * S},${(q.y - a.y) * S}`).join(" ")
      : `0,0 ${a.w * S},${a.h * S}`;
    return (
      <div key={a.id} className={common} style={box} onMouseDown={(e) => startDrag(e, a, "move")}>
        <svg width="100%" height="100%" style={{ overflow: "visible", display: "block" }}>
          <polyline points={pts} fill="none" stroke={a.color} strokeWidth={a.strokeWidth * S} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    );
  };

  return (
    <div
      ref={ref}
      className={`pdf-edit-layer ${p.tool !== "select" ? "is-drawing" : ""}`}
      style={{ width: p.w * S, height: p.h * S }}
      onMouseDown={onLayerDown}
    >
      {p.annos.map(renderAnno)}
      {draftBox && (
        <div className="pdf-anno pdf-anno--draft" style={{ position: "absolute", left: draftBox.x * S, top: draftBox.y * S, width: draftBox.w * S, height: draftBox.h * S }} />
      )}
      {draftPts && draftPts.length > 1 && (
        <svg className="pdf-anno--draft" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}>
          <polyline points={draftPts.map((q) => `${q.x * S},${q.y * S}`).join(" ")} fill="none" stroke={p.draft.color} strokeWidth={p.draft.strokeWidth * S} strokeLinecap="round" />
        </svg>
      )}
      <input ref={imgRef} type="file" accept="image/*" hidden onChange={onImageFile} />
    </div>
  );
}
