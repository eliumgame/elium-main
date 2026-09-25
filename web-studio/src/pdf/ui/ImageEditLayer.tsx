import { useEffect, useMemo, useRef, useState } from "react";
import type { Pt, Rect, Rotation, Size } from "../core/coords";
import { psToView, viewToPs } from "../core/coords";
import type { ImageEdit } from "../model/types";
import { newId } from "../model/types";
import type { PageImage } from "../ops/editpreview";

/**
 * The page's own pictures in « Modifier le texte et les images »: each image
 * the content stream draws gets a frame that can be selected, moved, resized
 * (corner handles, proportions kept unless Shift), replaced, deleted and
 * restored; « Ajouter une image » puts a new picture INTO the page content
 * (not an annotation on top of it).
 *
 * Nothing is painted here but frames: the result shows through the real
 * rebuilt page of `ContentEditPreview`, the same one the save writes. Only an
 * image being dragged, or one added to a page Elium created (which has no
 * source to rebuild from), is drawn directly.
 */

export interface ImageEditLayerProps {
  pageId: string;
  /** The document the page comes from, and its index there (null: a page added in Elium). */
  source: { bytes: Uint8Array; password?: string | null } | null;
  from: number | null;
  size: Size;
  rotation: Rotation;
  scale: number;
  edits: ImageEdit[];
  /** A picture waiting to be placed: the next click on the page drops it there. */
  adding?: string | null;
  onAdded?: () => void;
  onBeginChange: () => void;
  onChange: (edit: ImageEdit) => void;
  onRemove: (id: string) => void;
}

interface Item {
  id: string;
  occurrence: number;
  /** Where it is drawn now (edits applied). */
  rect: Rect;
  deleted: boolean;
  /** Has an edit that « Rétablir » would undo (originals only). */
  edited: boolean;
  added: boolean;
  src?: string;
}

type Drag = { id: string; kind: "move" | "nw" | "ne" | "sw" | "se"; start: Pt; base: Rect; rect: Rect; moved: boolean };

const MIN = 4;

export const originalImageId = (pageId: string, occurrence: number) => `img:${pageId}:${occurrence}`;

/** The frame a corner drag gives: the opposite corner stays, proportions kept unless `free`. */
export function resizeFrom(base: Rect, corner: "nw" | "ne" | "sw" | "se", at: Pt, free: boolean): Rect {
  const fx = corner === "nw" || corner === "sw" ? base.x + base.w : base.x;
  const fy = corner === "nw" || corner === "ne" ? base.y + base.h : base.y;
  let w = Math.max(MIN, Math.abs(at.x - fx));
  let h = Math.max(MIN, Math.abs(at.y - fy));
  if (!free && base.w > 0 && base.h > 0) {
    const ratio = base.h / base.w;
    if (h / w > ratio) w = h / ratio;
    else h = w * ratio;
  }
  const x = corner === "nw" || corner === "sw" ? fx - w : fx;
  const y = corner === "nw" || corner === "ne" ? fy - h : fy;
  return { x, y, w, h };
}

function readFile(f: File): Promise<string> {
  return new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => ko(r.error);
    r.readAsDataURL(f);
  });
}

function naturalRatio(src: string): Promise<number> {
  return new Promise((ok) => {
    const img = new Image();
    img.onload = () => ok(img.naturalWidth ? img.naturalHeight / img.naturalWidth : 1);
    img.onerror = () => ok(1);
    img.src = src;
  });
}

export default function ImageEditLayer(p: ImageEditLayerProps) {
  const [images, setImages] = useState<PageImage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    setImages([]);
    if (!p.source || p.from == null) return;
    void import("../ops/editpreview")
      .then(({ pageImages }) => pageImages(p.source!.bytes, p.source!.password, p.from!))
      .then((list) => live && setImages(list))
      .catch(() => live && setImages([]));
    return () => {
      live = false;
    };
    // The source object is rebuilt every render; its bytes are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.source?.bytes, p.source?.password, p.from]);

  const items = useMemo<Item[]>(() => {
    const byOcc = new Map(p.edits.filter((e) => e.occurrence >= 0).map((e) => [e.occurrence, e]));
    const out: Item[] = images.map((img) => {
      const e = byOcc.get(img.occurrence);
      return {
        id: e?.id ?? originalImageId(p.pageId, img.occurrence),
        occurrence: img.occurrence,
        rect: e?.rect ?? img.rect,
        deleted: e?.action === "delete",
        edited: !!e,
        added: false,
        src: e?.action === "replace" ? e.src : undefined,
      };
    });
    for (const e of p.edits) {
      if (e.occurrence >= 0 || e.action !== "add" || !e.rect) continue;
      out.push({ id: e.id, occurrence: -1, rect: e.rect, deleted: false, edited: true, added: true, src: e.src });
    }
    return out;
  }, [images, p.edits, p.pageId]);

  const current = (id: string) => p.edits.find((e) => e.id === id);
  const originalOf = (it: Item) => images.find((i) => i.occurrence === it.occurrence);

  const commitRect = (it: Item, rect: Rect) => {
    if (it.added) {
      const e = current(it.id);
      if (e) p.onChange({ ...e, rect });
      return;
    }
    const e = current(it.id);
    p.onChange({
      id: it.id,
      pageId: p.pageId,
      occurrence: it.occurrence,
      // Moving a replaced picture keeps the replacement.
      action: e?.action === "replace" ? "replace" : "move",
      src: e?.action === "replace" ? e.src : undefined,
      rect,
    });
  };

  const remove = (it: Item) => {
    p.onBeginChange();
    if (it.added) p.onRemove(it.id);
    else p.onChange({ id: it.id, pageId: p.pageId, occurrence: it.occurrence, action: "delete" });
  };

  const restore = (it: Item) => {
    if (it.added || !it.edited) return;
    p.onBeginChange();
    p.onRemove(it.id);
  };

  const replaceWith = async (it: Item, f: File) => {
    const src = await readFile(f);
    const ratio = await naturalRatio(src);
    // The new picture fits the old frame's width, with its own proportions.
    const base = it.rect;
    const rect = { x: base.x, y: base.y, w: base.w, h: base.w * ratio };
    p.onBeginChange();
    if (it.added) {
      const e = current(it.id);
      if (e) p.onChange({ ...e, src, rect });
    } else {
      p.onChange({ id: it.id, pageId: p.pageId, occurrence: it.occurrence, action: "replace", src, rect });
    }
  };

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = layer.current!.getBoundingClientRect();
    return viewToPs({ x: (e.clientX - r.left) / p.scale, y: (e.clientY - r.top) / p.scale }, p.size, p.rotation);
  };

  const clamp = (r: Rect): Rect => ({
    ...r,
    x: Math.min(Math.max(r.x, -r.w + MIN), p.size.w - MIN),
    y: Math.min(Math.max(r.y, -r.h + MIN), p.size.h - MIN),
  });

  const startDrag = (e: React.PointerEvent, it: Item, kind: Drag["kind"]) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelected(it.id);
    // preventDefault below would keep the focus away: the frame takes the keys (Suppr, arrows).
    (e.currentTarget as HTMLElement).closest<HTMLElement>(".pdfx-imagebox")?.focus({ preventScroll: true });
    // A deleted picture can only be selected (to restore it).
    if (it.deleted) return;
    e.preventDefault();
    const d: Drag = { id: it.id, kind, start: local(e), base: it.rect, rect: it.rect, moved: false };
    setDrag(d);
    let last = d;
    const onMove = (ev: PointerEvent) => {
      const at = local(ev);
      const rect =
        kind === "move"
          ? clamp({ ...d.base, x: d.base.x + at.x - d.start.x, y: d.base.y + at.y - d.start.y })
          : resizeFrom(d.base, kind, at, ev.shiftKey);
      const moved = last.moved || Math.hypot(at.x - d.start.x, at.y - d.start.y) * p.scale > 2;
      last = { ...d, rect, moved };
      setDrag(last);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setDrag(null);
      if (last.moved) {
        p.onBeginChange();
        commitRect(it, last.rect);
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // A click anywhere else lets go of the picture (the layer itself lets clicks through).
  useEffect(() => {
    if (!selected) return;
    const off = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t && layer.current?.contains(t) && t !== layer.current) return;
      setSelected(null);
    };
    window.addEventListener("pointerdown", off, true);
    return () => window.removeEventListener("pointerdown", off, true);
  }, [selected]);

  const onLayerDown = async (e: React.PointerEvent) => {
    if (e.target !== layer.current || !p.adding) return;
    e.preventDefault();
    const at = local(e);
    const src = p.adding;
    p.onAdded?.();
    const ratio = await naturalRatio(src);
    const w = Math.min(240, Math.max(MIN, p.size.w - at.x));
    const id = newId("im");
    p.onBeginChange();
    p.onChange({
      id,
      pageId: p.pageId,
      occurrence: -1,
      action: "add",
      src,
      rect: clamp({ x: at.x, y: at.y, w, h: w * ratio }),
    });
    setSelected(id);
  };

  const onKey = (e: React.KeyboardEvent, it: Item) => {
    if (e.key === "Escape") {
      setSelected(null);
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      if (!it.deleted) remove(it);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d && !it.deleted) {
      e.preventDefault();
      e.stopPropagation();
      // Arrows are in screen directions: map them through the view's rotation.
      const o = viewToPs({ x: 0, y: 0 }, p.size, p.rotation);
      const t = viewToPs({ x: d[0], y: d[1] }, p.size, p.rotation);
      p.onBeginChange();
      commitRect(it, clamp({ ...it.rect, x: it.rect.x + t.x - o.x, y: it.rect.y + t.y - o.y }));
    }
  };

  const toView = (r: Rect) => {
    const a = psToView({ x: r.x, y: r.y }, p.size, p.rotation);
    const b = psToView({ x: r.x + r.w, y: r.y + r.h }, p.size, p.rotation);
    return {
      left: Math.min(a.x, b.x) * p.scale,
      top: Math.min(a.y, b.y) * p.scale,
      width: Math.abs(b.x - a.x) * p.scale,
      height: Math.abs(b.y - a.y) * p.scale,
    };
  };

  const sel = items.find((i) => i.id === selected);

  return (
    <div
      className={`pdfx-imagelayer ${p.adding ? "is-adding" : ""} ${selected ? "has-selection" : ""}`}
      ref={layer}
      onPointerDown={(e) => void onLayerDown(e)}
      data-testid="image-layer"
    >
      {items.map((it) => {
        const dragging = drag?.id === it.id ? drag : null;
        const rect = dragging?.rect ?? it.rect;
        const box = toView(rect);
        const isSel = it.id === selected;
        // What to draw ourselves: a dragged picture (the rebuilt page still shows it
        // at its old place), or an added one on a page with nothing to rebuild.
        const draw = dragging?.moved || (it.added && p.from == null);
        const original = !it.added ? originalOf(it) : undefined;
        return (
          <div
            key={it.id}
            className={`pdfx-imagebox ${isSel ? "is-selected" : ""} ${it.deleted ? "is-deleted" : ""} ${dragging?.moved ? "is-dragging" : ""}`}
            style={box}
            tabIndex={0}
            role="button"
            aria-label={it.deleted ? "Image supprimée" : it.added ? "Image ajoutée" : "Image de la page"}
            data-occurrence={it.occurrence}
            onPointerDown={(e) => startDrag(e, it, "move")}
            onClick={() => setSelected(it.id)}
            onKeyDown={(e) => onKey(e, it)}
          >
            {draw && (it.src || it.added) && (
              <img className="pdfx-imagebox__img" src={it.src} alt="" draggable={false} />
            )}
            {draw && !it.src && original && <span className="pdfx-imagebox__ghost" />}
            {isSel && !it.deleted && (
              <>
                {(["nw", "ne", "sw", "se"] as const).map((c) => (
                  <span
                    key={c}
                    className={`pdfx-imagebox__handle pdfx-imagebox__handle--${c}`}
                    data-handle={c}
                    onPointerDown={(e) => startDrag(e, it, c)}
                  />
                ))}
              </>
            )}
          </div>
        );
      })}
      {sel && !drag && (
        <div
          className="pdfx-imagebar"
          style={{ left: toView(sel.rect).left, top: Math.max(0, toView(sel.rect).top - 34) }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          {!sel.deleted && (
            <>
              <button type="button" onClick={() => picker.current?.click()}>
                Remplacer…
              </button>
              <button type="button" onClick={() => remove(sel)}>
                Supprimer
              </button>
            </>
          )}
          {!sel.added && sel.edited && (
            <button type="button" onClick={() => restore(sel)}>
              Rétablir
            </button>
          )}
        </div>
      )}
      <input
        ref={picker}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        hidden
        data-testid="image-replace-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f && sel) void replaceWith(sel, f);
        }}
      />
    </div>
  );
}
