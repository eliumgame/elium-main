import { useEffect, useRef, useState } from "react";
import type { Pt, Rect, Rotation, Size } from "../core/coords";
import { rectFromView, rectToView, viewToPs } from "../core/coords";
import type { PdfEngine } from "../core/engine";
import type { CreatedField, FieldEdit, FieldKind } from "../model/types";
import { readFields, type FieldBox, type RawWidget } from "../ops/forms";

/**
 * « Préparer un formulaire » for one page: every field of the page — the
 * file's own (with the edits made so far) and those created in Elium — as a
 * box that can be selected (Maj : ajout à la sélection), moved, resized by its
 * handles, nudged with the arrow keys (Maj : 10 pt), deleted (Suppr), opened
 * (double-clic / Entrée) — and new fields drawn with a field tool (a click
 * alone places one at its usual size). Rotation-aware: positions are kept in
 * the page's unrotated top-left space, like annotations.
 */

export interface PrepBox {
  /** « c:<id> » for a created field, « w:<pdf.js widget id> » for the file's. */
  key: string;
  name: string;
  kind: FieldKind;
  rect: Rect;
  required?: boolean;
  readOnly?: boolean;
}

export interface PrepareLayerProps {
  boxes: readonly PrepBox[];
  size: Size;
  rotation: Rotation;
  scale: number;
  /** The field tool in use (« field:text »…) or anything else for selection. */
  tool: string;
  selected: readonly string[];
  onSelect: (keys: string[], additive: boolean) => void;
  onCreate: (kind: FieldKind, rect: Rect) => void;
  /** Positions changed (a move, a resize, the arrow keys). */
  onChangeRects: (changes: { key: string; rect: Rect }[]) => void;
  /** Called once before a change, for a single undo step. */
  onBeginChange: () => void;
  onOpen: (key: string) => void;
  onDelete: (keys: string[]) => void;
}

const KIND_OF_TOOL: Record<string, FieldKind> = {
  "field:text": "text",
  "field:checkbox": "checkbox",
  "field:radio": "radio",
  "field:dropdown": "dropdown",
  "field:listbox": "listbox",
  "field:signature": "signature",
  "field:button": "button",
};

/** Size of a field placed by a click, as Acrobat does (points). */
export const DEFAULT_FIELD_SIZE: Record<FieldKind, { w: number; h: number }> = {
  text: { w: 150, h: 22 },
  checkbox: { w: 14, h: 14 },
  radio: { w: 14, h: 14 },
  dropdown: { w: 150, h: 22 },
  listbox: { w: 150, h: 66 },
  signature: { w: 180, h: 50 },
  button: { w: 90, h: 24 },
};

const KIND_LABEL: Record<FieldKind, string> = {
  text: "Texte",
  checkbox: "Case",
  radio: "Radio",
  dropdown: "Liste",
  listbox: "Zone de liste",
  signature: "Signature",
  button: "Bouton",
};

const MIN = 6;
type Handle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

type Gesture =
  | { kind: "draw"; start: Pt; now: Pt; fieldKind: FieldKind }
  | { kind: "move"; start: Pt; keys: string[]; origin: Map<string, Rect>; moved: boolean }
  | { kind: "resize"; start: Pt; key: string; handle: Handle; origin: Rect };

export default function PrepareLayer(p: PrepareLayerProps) {
  const host = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const [preview, setPreview] = useState<Map<string, Rect> | null>(null);
  const drawKind = KIND_OF_TOOL[p.tool];

  /** Pointer → view space (unscaled page view units). */
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = host.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / p.scale, y: (e.clientY - r.top) / p.scale };
  };
  const toPage = (v: Pt) => viewToPs(v, p.size, p.rotation);
  const clampRect = (r: Rect): Rect => {
    const w = Math.max(MIN, r.w);
    const h = Math.max(MIN, r.h);
    return { x: Math.min(Math.max(0, r.x), p.size.w - w), y: Math.min(Math.max(0, r.y), p.size.h - h), w, h };
  };

  const rectOf = (b: PrepBox) => preview?.get(b.key) ?? b.rect;

  useEffect(() => {
    if (!gesture) return;
    const onMove = (e: PointerEvent) => {
      const now = local(e);
      if (gesture.kind === "draw") {
        setGesture({ ...gesture, now });
        return;
      }
      if (gesture.kind === "move") {
        const a = toPage(gesture.start);
        const b = toPage(now);
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        if (!gesture.moved && Math.hypot(now.x - gesture.start.x, now.y - gesture.start.y) * p.scale < 3) return;
        if (!gesture.moved) {
          p.onBeginChange();
          gesture.moved = true;
        }
        const next = new Map<string, Rect>();
        for (const [k, r] of gesture.origin) next.set(k, clampRect({ ...r, x: r.x + dx, y: r.y + dy }));
        setPreview(next);
        return;
      }
      // Resize, in view space so the handles follow the pointer on a rotated page.
      const v = rectToView(gesture.origin, p.size, p.rotation);
      const dx = now.x - gesture.start.x;
      const dy = now.y - gesture.start.y;
      let { x, y, w, h } = v;
      if (gesture.handle.includes("e")) w += dx;
      if (gesture.handle.includes("s")) h += dy;
      if (gesture.handle.includes("w")) {
        x += dx;
        w -= dx;
      }
      if (gesture.handle.includes("n")) {
        y += dy;
        h -= dy;
      }
      const view = { x: w < 0 ? x + w : x, y: h < 0 ? y + h : y, w: Math.abs(w), h: Math.abs(h) };
      setPreview(new Map([[gesture.key, clampRect(rectFromView(view, p.size, p.rotation))]]));
    };
    const onUp = (e: PointerEvent) => {
      const g = gesture;
      setGesture(null);
      if (g.kind === "draw") {
        const a = toPage(g.start);
        const b = toPage(local(e));
        const small = Math.hypot(b.x - a.x, b.y - a.y) * p.scale < 4;
        const d = DEFAULT_FIELD_SIZE[g.fieldKind];
        const r = small
          ? { x: a.x, y: a.y, w: d.w, h: d.h }
          : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
        p.onCreate(g.fieldKind, clampRect(r));
        return;
      }
      const changes = preview ? [...preview].map(([key, rect]) => ({ key, rect })) : [];
      setPreview(null);
      if (g.kind === "resize" && changes.length) p.onBeginChange();
      if (changes.length && (g.kind === "resize" || g.moved)) p.onChangeRects(changes);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gesture, preview, p.scale, p.size, p.rotation]);

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    host.current?.focus({ preventScroll: true });
    if (drawKind) {
      e.preventDefault();
      const at = local(e);
      setGesture({ kind: "draw", start: at, now: at, fieldKind: drawKind });
      return;
    }
    if (!e.shiftKey) p.onSelect([], false);
  };

  const onBoxDown = (e: React.PointerEvent, b: PrepBox) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    host.current?.focus({ preventScroll: true });
    const already = p.selected.includes(b.key);
    let keys: string[];
    if (e.shiftKey) {
      keys = already ? p.selected.filter((k) => k !== b.key) : [...p.selected, b.key];
      p.onSelect(keys, true);
      if (already) return;
    } else {
      keys = already ? [...p.selected] : [b.key];
      if (!already) p.onSelect(keys, false);
    }
    const origin = new Map<string, Rect>();
    for (const box of p.boxes) if (keys.includes(box.key)) origin.set(box.key, box.rect);
    setGesture({ kind: "move", start: local(e), keys, origin, moved: false });
  };

  const onHandleDown = (e: React.PointerEvent, b: PrepBox, handle: Handle) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setGesture({ kind: "resize", start: local(e), key: b.key, handle, origin: b.rect });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const sel = p.boxes.filter((b) => p.selected.includes(b.key));
    if (!sel.length) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      p.onBeginChange();
      p.onDelete(sel.map((b) => b.key));
      return;
    }
    if (e.key === "Enter" && sel.length === 1) {
      e.preventDefault();
      p.onOpen(sel[0].key);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    // Arrow keys move on SCREEN: through the rotation, like the pointer.
    const dir: Record<string, Pt> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const d = dir[e.key];
    if (!d) return;
    e.preventDefault();
    const a = toPage({ x: 0, y: 0 });
    const b = toPage(d);
    p.onBeginChange();
    p.onChangeRects(
      sel.map((box) => ({
        key: box.key,
        rect: clampRect({ ...box.rect, x: box.rect.x + b.x - a.x, y: box.rect.y + b.y - a.y }),
      })),
    );
  };

  const view = (r: Rect) => {
    const v = rectToView(r, p.size, p.rotation);
    return { left: v.x * p.scale, top: v.y * p.scale, width: v.w * p.scale, height: v.h * p.scale };
  };

  let drawRect: Rect | null = null;
  if (gesture?.kind === "draw") {
    const a = toPage(gesture.start);
    const b = toPage(gesture.now);
    drawRect = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
  }

  return (
    <div
      ref={host}
      className={`pdfx-prep ${drawKind ? "is-drawing" : ""}`}
      tabIndex={0}
      role="application"
      aria-label="Préparation du formulaire : champs de la page"
      onPointerDown={onBackgroundDown}
      onKeyDown={onKeyDown}
    >
      {p.boxes.map((b) => {
        const selected = p.selected.includes(b.key);
        const only = selected && p.selected.length === 1;
        return (
          <div
            key={b.key}
            data-key={b.key}
            className={`pdfx-prep-box pdfx-prep-box--${b.kind} ${selected ? "is-selected" : ""} ${b.required ? "is-required" : ""}`}
            style={view(rectOf(b))}
            title={`${KIND_LABEL[b.kind]} « ${b.name} »`}
            onPointerDown={(e) => onBoxDown(e, b)}
            onDoubleClick={(e) => {
              e.stopPropagation();
              p.onOpen(b.key);
            }}
          >
            <span className="pdfx-prep-name">{b.name}</span>
            {only &&
              HANDLES.map((h) => (
                <span
                  key={h}
                  className={`pdfx-prep-handle pdfx-prep-handle--${h}`}
                  onPointerDown={(e) => onHandleDown(e, b, h)}
                  aria-hidden="true"
                />
              ))}
          </div>
        );
      })}
      {drawRect && <div className="pdfx-prep-draft" style={view(drawRect)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One page of « Préparer » : the file's fields (edits applied) + created ones
// ---------------------------------------------------------------------------

export interface PreparePageProps extends Omit<PrepareLayerProps, "boxes" | "onChangeRects" | "onDelete" | "onOpen"> {
  engine: PdfEngine;
  /** Source page index (null: a page added in Elium). */
  from: number | null;
  pageId: string;
  created: readonly CreatedField[];
  edits: readonly FieldEdit[];
  /** `fieldName`: the file field (original name) behind a « w: » key. */
  onChangeRects: (changes: { key: string; rect: Rect; fieldName?: string }[]) => void;
  onDelete: (items: { key: string; fieldName?: string }[]) => void;
  onOpen: (key: string, fieldName?: string) => void;
}

/** The file's widgets of a source page, read once per page. */
function useFileBoxes(engine: PdfEngine, from: number | null, pageHeight: number): FieldBox[] {
  const [boxes, setBoxes] = useState<FieldBox[]>([]);
  useEffect(() => {
    if (from == null) {
      setBoxes([]);
      return;
    }
    let cancelled = false;
    void engine
      .annotations(from)
      .then((anns) => {
        if (cancelled) return;
        const info = engine.pages[from];
        setBoxes(readFields(anns as RawWidget[], pageHeight, { x: info?.ox ?? 0, y: info?.oy ?? 0 }));
      })
      .catch(() => setBoxes([]));
    return () => {
      cancelled = true;
    };
  }, [engine, from, pageHeight]);
  return boxes;
}

export function PreparePage(p: PreparePageProps) {
  const fileBoxes = useFileBoxes(p.engine, p.from, p.size.h);
  const boxes: PrepBox[] = [];
  const nameOf = new Map<string, string>();
  for (const b of fileBoxes) {
    const edit = p.edits.find((e) => e.name === b.name);
    if (edit?.deleted || edit?.removeWidgets?.includes(b.key)) continue;
    nameOf.set(`w:${b.key}`, b.name);
    boxes.push({
      key: `w:${b.key}`,
      name: edit?.rename ?? b.name,
      kind: b.kind,
      rect: edit?.rects?.[b.key] ?? b.rect,
      required: edit?.props?.required ?? b.required,
      readOnly: edit?.props?.readOnly ?? b.readOnly,
    });
  }
  for (const f of p.created) {
    if (f.pageId !== p.pageId) continue;
    boxes.push({
      key: `c:${f.id}`,
      name: f.name,
      kind: f.kind,
      rect: f.rect,
      required: f.required,
      readOnly: f.readOnly,
    });
  }
  const { engine: _e, from: _f, pageId: _p, created: _c, edits: _d, onChangeRects, onDelete, onOpen, ...layer } = p;
  void [_e, _f, _p, _c, _d];
  return (
    <PrepareLayer
      {...layer}
      boxes={boxes}
      onChangeRects={(changes) => onChangeRects(changes.map((c) => ({ ...c, fieldName: nameOf.get(c.key) })))}
      onDelete={(keys) => onDelete(keys.map((key) => ({ key, fieldName: nameOf.get(key) })))}
      onOpen={(key) => onOpen(key, nameOf.get(key))}
    />
  );
}
