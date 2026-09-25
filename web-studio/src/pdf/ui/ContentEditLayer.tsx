import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Italic, Move } from "lucide-react";
import type { Pt, Rect, Rotation, Size } from "../core/coords";
import { rectFromView, rectToView, viewToPs } from "../core/coords";
import type { PdfEngine } from "../core/engine";
import { buildRuns, groupBlocks, groupLines, type TextBlock } from "../core/text";
import type { ContentEdit } from "../model/types";
import { newId } from "../model/types";
import { BUILTIN_FONTS, customFontNames, fontCss } from "../../ui/fonts";

/**
 * « Modifier le texte » for one page — Acrobat's « Modifier le PDF ».
 *
 * The page's own paragraphs are detected from the text geometry and each gets
 * an editable box in place: its text, and — in the bar above it — the face,
 * size, weight, slant, colour and alignment; the grip moves the box, the right
 * handle changes its width (the text reflows). « Ajouter du texte » places new
 * text where the page is clicked. On save the original operators of the
 * paragraph are REMOVED from the content stream and the new text laid out in
 * their place — no white box, no hidden original underneath.
 */

export interface ContentEditLayerProps {
  engine: PdfEngine;
  from: number | null;
  pageId: string;
  size: Size;
  rotation: Rotation;
  scale: number;
  edits: ContentEdit[];
  /** « Ajouter du texte » armed: the next click on the page places new text. */
  adding?: boolean;
  onAdded?: () => void;
  onCommit: (edit: ContentEdit) => void;
  onBeginChange: () => void;
  onBlocks?: (pageId: string, blocks: TextBlock[]) => void;
}

/** What is being edited: a detected paragraph, or text added in Elium. */
interface Item {
  key: string;
  rect: Rect;
  text: string;
  fontSize: number;
  leading: number;
  align: ContentEdit["align"];
  fontFamily?: string;
  bold: boolean;
  italic: boolean;
  block: TextBlock | null;
}

interface Draft {
  text: string;
  fontFamily?: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  color?: string;
  align: ContentEdit["align"];
  placement: Rect;
}

const FAMILIES = () => [...BUILTIN_FONTS.map((f) => f.name), ...customFontNames()];

function ContentEditLayer(p: ContentEditLayerProps) {
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  /** Text being added, until its first commit makes it an edit. */
  const pendingNew = useRef<Item | null>(null);

  useEffect(() => {
    if (p.from == null) {
      setBlocks([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const page = await p.engine.page(p.from!);
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      const [tc, fonts] = await Promise.all([p.engine.text(p.from!), p.engine.fonts(p.from!)]);
      if (cancelled) return;
      const runs = buildRuns(tc, vp.transform as unknown as number[], fonts);
      const lines = groupLines(runs, tc.items);
      const grouped = groupBlocks(lines);
      setBlocks(grouped);
      p.onBlocks?.(p.pageId, grouped);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.engine, p.from, p.pageId]);

  const byKey = useMemo(() => new Map(p.edits.map((e) => [e.blockKey, e])), [p.edits]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = (blocks ?? []).map((b) => ({
      key: b.key,
      rect: b.rect,
      text: b.text,
      fontSize: b.fontSize,
      leading: b.leading,
      align: b.align,
      fontFamily: b.fontFamily,
      bold: b.bold,
      italic: b.italic,
      block: b,
    }));
    for (const e of p.edits) {
      if (!e.isNew || e.deleted) continue;
      out.push({
        key: e.blockKey,
        rect: e.rect,
        text: "",
        fontSize: e.fontSize,
        leading: e.leading,
        align: e.align,
        fontFamily: e.fontFamily,
        bold: !!e.bold,
        italic: !!e.italic,
        block: null,
      });
    }
    return out;
  }, [blocks, p.edits]);

  if (!blocks) return null;

  const view = (r: Rect) => {
    const v = rectToView(r, p.size, p.rotation);
    return { left: v.x * p.scale, top: v.y * p.scale, width: v.w * p.scale, height: v.h * p.scale };
  };
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = layer.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / p.scale, y: (e.clientY - r.top) / p.scale };
  };

  const open = (it: Item) => {
    const edit = byKey.get(it.key);
    p.onBeginChange();
    setActive(it.key);
    setDraft({
      text: edit ? edit.text : it.text,
      fontFamily: edit?.fontFamily ?? it.fontFamily,
      fontSize: edit?.fontSize ?? it.fontSize,
      bold: edit?.bold ?? it.bold,
      italic: edit?.italic ?? it.italic,
      color: edit?.color,
      align: edit?.align ?? it.align,
      placement: edit?.placement ?? edit?.rect ?? it.rect,
    });
  };

  const save = (it: Item, d: Draft, deleted = false) => {
    const existing = byKey.get(it.key);
    const restyled = (d.fontFamily ?? "") !== (it.fontFamily ?? "") || d.bold !== it.bold || d.italic !== it.italic;
    const moved =
      Math.abs(d.placement.x - it.rect.x) > 0.01 ||
      Math.abs(d.placement.y - it.rect.y) > 0.01 ||
      Math.abs(d.placement.w - it.rect.w) > 0.01;
    // Text grows downward: the box keeps its top, its height follows the lines.
    const lines = Math.max(1, d.text.split("\n").length);
    const placement = moved ? { ...d.placement, h: Math.max(d.placement.h, lines * it.leading) } : undefined;
    p.onCommit({
      id: existing?.id ?? newId("ce"),
      pageId: p.pageId,
      blockKey: it.key,
      original: it.text,
      text: d.text,
      rect: it.block ? it.block.rect : (placement ?? d.placement),
      fontSize: d.fontSize,
      leading: it.block ? it.leading * (d.fontSize / (it.fontSize || d.fontSize)) : d.fontSize * 1.25,
      align: d.align,
      color: d.color,
      fontFamily: d.fontFamily,
      bold: d.bold,
      italic: d.italic,
      deleted,
      ...(it.block ? { placement, restyled: restyled || undefined } : { placement: d.placement, isNew: true }),
    });
  };

  const close = (it: Item, d: Draft | null) => {
    if (d) save(it, d);
    setActive(null);
    setDraft(null);
  };

  /** Drag the active box (grip) or its width (right handle), in screen space through the rotation. */
  const drag = (e: React.PointerEvent, it: Item, mode: "move" | "width") => {
    if (!draft) return;
    e.preventDefault();
    e.stopPropagation();
    const start = local(e);
    const origin = draft.placement;
    const onMove = (ev: PointerEvent) => {
      const now = local(ev);
      if (mode === "move") {
        const a = viewToPs(start, p.size, p.rotation);
        const b = viewToPs(now, p.size, p.rotation);
        setDraft((d) => (d ? { ...d, placement: { ...origin, x: origin.x + b.x - a.x, y: origin.y + b.y - a.y } } : d));
      } else {
        const v = rectToView(origin, p.size, p.rotation);
        const w = Math.max(12, v.w + now.x - start.x);
        setDraft((d) => (d ? { ...d, placement: rectFromView({ ...v, w }, p.size, p.rotation) } : d));
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    void it;
  };

  const onLayerDown = (e: React.PointerEvent) => {
    if (!p.adding || e.target !== layer.current) return;
    e.preventDefault();
    const at = viewToPs(local(e), p.size, p.rotation);
    const key = `new:${newId("tx")}`;
    const it: Item = {
      key,
      rect: { x: at.x, y: at.y, w: 200, h: 16 },
      text: "",
      fontSize: 12,
      leading: 15,
      align: "left",
      fontFamily: "Arial",
      bold: false,
      italic: false,
      block: null,
    };
    p.onBeginChange();
    p.onAdded?.();
    setActive(key);
    setDraft({
      text: "",
      fontFamily: "Arial",
      fontSize: 12,
      bold: false,
      italic: false,
      color: "#000000",
      align: "left",
      placement: it.rect,
    });
    pendingNew.current = it;
  };
  const shown =
    pendingNew.current && active === pendingNew.current.key && !items.some((i) => i.key === active)
      ? [...items, pendingNew.current]
      : items;

  return (
    <div className={`pdfx-editlayer ${p.adding ? "is-adding" : ""}`} ref={layer} onPointerDown={onLayerDown}>
      {shown.map((it) => {
        const edit = byKey.get(it.key);
        const changed =
          !!edit && (edit.deleted || edit.isNew || edit.text !== edit.original || !!edit.placement || !!edit.restyled);
        const isActive = active === it.key && !!draft;
        const box = isActive ? draft.placement : (edit?.placement ?? it.rect);
        const pad = 3;
        const v = view(box);
        const style: React.CSSProperties = {
          position: "absolute",
          left: v.left - pad,
          top: v.top - pad,
          width: v.width + pad * 2,
          height:
            (isActive
              ? Math.max(v.height, it.leading * p.scale * Math.max(1, draft.text.split("\n").length))
              : v.height) +
            pad * 2,
        };
        if (!it.block && !isActive && (!edit || edit.deleted)) return null;

        return (
          <div
            key={it.key}
            className={`pdfx-editblock ${changed ? "is-changed" : ""} ${isActive ? "is-active" : ""}`}
            style={style}
            onBlur={(e) => {
              // Leaving the whole box (text AND its bar) commits.
              if (isActive && !e.currentTarget.contains(e.relatedTarget as Node | null)) close(it, draft);
            }}
          >
            {isActive ? (
              <>
                <div className="pdfx-editblock__bar" role="toolbar" aria-label="Mise en forme du texte">
                  <button
                    type="button"
                    className="pdfx-editblock__grip"
                    title="Déplacer"
                    aria-label="Déplacer"
                    onPointerDown={(e) => drag(e, it, "move")}
                  >
                    <Move size={13} />
                  </button>
                  <select
                    aria-label="Police"
                    value={draft.fontFamily ?? "Arial"}
                    onChange={(e) => setDraft({ ...draft, fontFamily: e.target.value })}
                  >
                    {FAMILIES().map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label="Taille"
                    type="number"
                    min={4}
                    max={144}
                    step={0.5}
                    value={Math.round(draft.fontSize * 10) / 10}
                    onChange={(e) =>
                      setDraft({ ...draft, fontSize: Math.max(4, Number(e.target.value) || draft.fontSize) })
                    }
                  />
                  <button
                    type="button"
                    aria-label="Gras"
                    aria-pressed={draft.bold}
                    className={draft.bold ? "is-on" : ""}
                    onClick={() => setDraft({ ...draft, bold: !draft.bold })}
                  >
                    <Bold size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label="Italique"
                    aria-pressed={draft.italic}
                    className={draft.italic ? "is-on" : ""}
                    onClick={() => setDraft({ ...draft, italic: !draft.italic })}
                  >
                    <Italic size={13} />
                  </button>
                  <input
                    aria-label="Couleur"
                    type="color"
                    value={draft.color ?? "#000000"}
                    onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                  />
                  {(
                    [
                      ["left", AlignLeft, "Aligner à gauche"],
                      ["center", AlignCenter, "Centrer"],
                      ["right", AlignRight, "Aligner à droite"],
                      ["justify", AlignJustify, "Justifier"],
                    ] as const
                  ).map(([a, Icon, label]) => (
                    <button
                      key={a}
                      type="button"
                      aria-label={label}
                      aria-pressed={draft.align === a}
                      className={draft.align === a ? "is-on" : ""}
                      onClick={() => setDraft({ ...draft, align: a })}
                    >
                      <Icon size={13} />
                    </button>
                  ))}
                  <button
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      save(it, draft, true);
                      setActive(null);
                      setDraft(null);
                    }}
                  >
                    Supprimer
                  </button>
                  {it.block && (
                    <button
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setDraft({
                          text: it.text,
                          fontFamily: it.fontFamily,
                          fontSize: it.fontSize,
                          bold: it.bold,
                          italic: it.italic,
                          color: undefined,
                          align: it.align,
                          placement: it.rect,
                        });
                      }}
                    >
                      Rétablir
                    </button>
                  )}
                </div>
                <textarea
                  autoFocus
                  className="pdfx-editblock__input"
                  style={{
                    fontSize: draft.fontSize * p.scale,
                    lineHeight: it.leading / it.fontSize || 1.2,
                    fontFamily: fontCss(draft.fontFamily),
                    fontWeight: draft.bold ? 700 : 400,
                    fontStyle: draft.italic ? "italic" : "normal",
                    textAlign: draft.align === "justify" ? "justify" : draft.align,
                    color: draft.color ?? undefined,
                  }}
                  value={draft.text}
                  onChange={(e) => setDraft({ ...draft, text: e.target.value })}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === "Escape") {
                      setActive(null);
                      setDraft(null);
                    }
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) close(it, draft);
                  }}
                />
                <span
                  className="pdfx-editblock__width"
                  title="Largeur de la zone"
                  aria-hidden="true"
                  onPointerDown={(e) => drag(e, it, "width")}
                />
              </>
            ) : (
              <button
                type="button"
                className="pdfx-editblock__hit"
                title="Cliquer pour modifier ce paragraphe"
                aria-label={`Modifier : ${(edit ? edit.text : it.text).slice(0, 60)}`}
                onClick={() => open(it)}
              />
            )}
            {changed && !isActive && (
              <span className="pdfx-editblock__badge" title="Paragraphe modifié">
                modifié
              </span>
            )}
          </div>
        );
      })}
      {!blocks.length && !p.edits.some((e) => e.isNew) && !p.adding && (
        <div className="pdfx-editlayer__empty">
          Aucun texte modifiable détecté sur cette page (document scanné ?). Lancez l'OCR pour le rendre éditable.
        </div>
      )}
    </div>
  );
}

// See annotLayerPropsEqual in AnnotLayer.tsx for why callback props (onCommit,
// onBeginChange, onBlocks) are skipped here: PdfWorkspace recreates them
// inline every render, but they don't close over anything that isn't also
// one of the other (compared) props, so ignoring their identity is safe.
function contentEditLayerPropsEqual(prev: ContentEditLayerProps, next: ContentEditLayerProps): boolean {
  for (const key of Object.keys(next) as (keyof ContentEditLayerProps)[]) {
    const a = prev[key];
    const b = next[key];
    if (typeof a === "function" || typeof b === "function") continue;
    if (!Object.is(a, b)) return false;
  }
  return true;
}

export default memo(ContentEditLayer, contentEditLayerPropsEqual);
