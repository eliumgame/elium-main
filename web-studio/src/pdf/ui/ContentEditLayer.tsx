import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Pt, Rect, Rotation, Size } from "../core/coords";
import { psToView, rectFromView, rectToView, viewToPs } from "../core/coords";
import type { PdfEngine } from "../core/engine";
import { buildRuns, groupBlocks, groupLines, type TextBlock } from "../core/text";
import type { ContentEdit, TextIndent, TextSpan, TextSpanStyle } from "../model/types";
import { newId } from "../model/types";
import { BUILTIN_FONTS, customFontNames } from "../../ui/fonts";
import TextFormatPanel from "./TextFormatPanel";
import {
  applyPatch,
  dominantStyle,
  insertAt,
  deleteRange,
  isCanonical,
  offsetAtPoint,
  readSpans,
  renderSpans,
  sameSpans,
  selectionOffsets,
  setSelectionOffsets,
  sliceSpans,
  spansText,
  styleAt,
  summarise,
  type StylePatch,
  type StyleSummary,
} from "./richtext";

/**
 * « Modifier le texte » for one page — Acrobat's « Modifier le PDF ».
 *
 * The page's own paragraphs are detected from the text geometry. Clicking one edits it IN PLACE:
 * the text stays on the page, where it is and as it looks (its own sizes, colours, bold words),
 * with a thin frame and the caret where you clicked — no window over it. The original glyphs are
 * hidden while you type (the preview rebuilds the page without them) and the paragraph reflows as
 * you add words. Formatting goes through the « Format du texte » panel on the right and applies
 * to the selection, or to what you type next. Frame edges move the box, the side handles change
 * its width. Clicking elsewhere (or Esc) keeps the change; on save the original operators of the
 * paragraph are REMOVED from the content stream and the new text laid out in their place.
 */

export interface EditingInfo {
  pageId: string;
  blockKey: string;
  /** The paragraph's ORIGINAL box: the glyphs to hide while it is being typed in. */
  rect: Rect;
}

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
  /** Where the « Format du texte » panel goes (a node in the workspace, to the right of the pages). */
  formatHost?: HTMLElement | null;
  onAdded?: () => void;
  onCommit: (edit: ContentEdit) => void;
  onBeginChange: () => void;
  onBlocks?: (pageId: string, blocks: TextBlock[]) => void;
  /** The paragraph being typed in (its original glyphs are hidden), or null. */
  onEditing?: (info: EditingInfo | null) => void;
}

/** What is being edited: a detected paragraph, or text added in Elium. */
interface Item {
  key: string;
  rect: Rect;
  /** The paragraph's text as detected (wrapped lines joined): what « unchanged » is compared with. */
  text: string;
  spans: TextSpan[];
  fontSize: number;
  leading: number;
  align: ContentEdit["align"];
  indent?: TextIndent;
  /** First baseline start, page space: the editor's text is put exactly on it. */
  baseline?: Pt;
  block: TextBlock | null;
}

interface Session {
  item: Item;
  /** The spans the editor starts from. */
  initial: TextSpan[];
  placement: Rect;
  align: ContentEdit["align"];
  /** Line spacing as a multiple of the main font size. */
  lineSpacing: number;
  /** Where the click that opened it was, to put the caret there. */
  click?: Pt;
}

const DEFAULT_STYLE: TextSpanStyle = { fontFamily: "Arial", fontSize: 12, color: "#000000" };

const FAMILIES = () => [...BUILTIN_FONTS.map((f) => f.name), ...customFontNames()];

/** The page's paragraphs (the engine's reading of the text and its styles). */
async function loadBlocks(engine: PdfEngine, from: number): Promise<TextBlock[]> {
  const page = await engine.page(from);
  const vp = page.getViewport({ scale: 1, rotation: 0 });
  const [tc, fonts] = await Promise.all([engine.text(from), engine.fonts(from)]);
  const runs = buildRuns(tc, vp.transform as unknown as number[], fonts);
  return groupBlocks(groupLines(runs, tc.items));
}

const spansOfBlock = (b: TextBlock): TextSpan[] =>
  b.spans?.length
    ? b.spans
    : [
        {
          text: b.text,
          style: {
            fontFamily: b.fontFamily ?? "Arial",
            bold: b.bold,
            italic: b.italic,
            fontSize: b.fontSize,
            color: "#000000",
          },
        },
      ];

const spansOfEdit = (e: ContentEdit): TextSpan[] =>
  e.text
    ? [
        {
          text: e.text,
          style: {
            fontResource: e.restyled ? null : e.fontResource,
            fontFamily: e.fontFamily ?? "Arial",
            bold: !!e.bold,
            italic: !!e.italic,
            fontSize: e.fontSize,
            color: e.color ?? "#000000",
          },
        },
      ]
    : [];

/**
 * The page's background colour around a box, when it is plain (so the hidden original text can be
 * covered by that colour while the page is rebuilt without it); null when something is behind.
 */
function sampleBackground(
  layer: HTMLElement,
  box: { left: number; top: number; width: number; height: number },
): string | null {
  const canvas = layer.closest(".pdfx-slot")?.querySelector("canvas");
  if (!canvas || !canvas.width) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const cr = canvas.getBoundingClientRect();
  const lr = layer.getBoundingClientRect();
  if (!cr.width || !cr.height) return null;
  const sx = canvas.width / cr.width;
  const sy = canvas.height / cr.height;
  const out = 4;
  const pts: [number, number][] = [
    [box.left - out, box.top + box.height / 2],
    [box.left + box.width + out, box.top + box.height / 2],
    [box.left + box.width / 2, box.top - out],
    [box.left + box.width / 2, box.top + box.height + out],
    [box.left - out, box.top - out],
    [box.left + box.width + out, box.top - out],
    [box.left - out, box.top + box.height + out],
    [box.left + box.width + out, box.top + box.height + out],
  ];
  const px: number[][] = [];
  try {
    for (const [x, y] of pts) {
      const cx = Math.round((lr.left - cr.left + x) * sx);
      const cy = Math.round((lr.top - cr.top + y) * sy);
      if (cx < 0 || cy < 0 || cx >= canvas.width || cy >= canvas.height) continue;
      const d = ctx.getImageData(cx, cy, 1, 1).data;
      px.push([d[0]!, d[1]!, d[2]!]);
    }
  } catch {
    return null;
  }
  if (px.length < 3) return null;
  const med = [0, 1, 2].map((c) => px.map((p) => p[c]!).sort((a, b) => a - b)[px.length >> 1]!);
  const plain = px.every((p) => [0, 1, 2].every((c) => Math.abs(p[c]! - med[c]!) <= 10));
  return plain ? `rgb(${med[0]}, ${med[1]}, ${med[2]})` : null;
}

function ContentEditLayer(p: ContentEditLayerProps) {
  const [blocks, setBlocks] = useState<TextBlock[] | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [summary, setSummary] = useState<StyleSummary>({ mixed: false });
  /** Distance from the editor's top to its first baseline, measured once laid out (null: not yet). */
  const [baselineOff, setBaselineOff] = useState<number | null>(null);
  const [mask, setMask] = useState<string | null>(null);
  const layer = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;
  /** The last selection seen inside the editor (it is lost while a panel control has the focus). */
  const lastSel = useRef<{ start: number; end: number } | null>(null);
  /** A style chosen with only the caret placed: applied to what is typed next. */
  const pending = useRef<{ patch: StylePatch; at: number } | null>(null);
  const frame = useRef(0);
  /** The latest props, for handlers that outlive a render (the layer's memo skips callback identity). */
  const cb = useRef(p);
  cb.current = p;
  /** The main style of the paragraph being edited (its size sets the line pitch). */
  const [mainStyle, setMainStyle] = useState<TextSpanStyle>(DEFAULT_STYLE);

  useEffect(() => {
    if (p.from == null) {
      setBlocks([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const grouped = await loadBlocks(p.engine, p.from!);
      if (cancelled) return;
      setBlocks(grouped);
      cb.current.onBlocks?.(p.pageId, grouped);
    })();
    return () => {
      cancelled = true;
    };
  }, [p.engine, p.from, p.pageId]);

  const byKey = useMemo(() => new Map(p.edits.map((e) => [e.blockKey, e])), [p.edits]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = (blocks ?? []).map((b) => ({
      key: b.key,
      rect: b.rect,
      text: b.text,
      spans: spansOfBlock(b),
      fontSize: b.fontSize,
      leading: b.leading,
      align: b.align,
      indent: b.indent,
      baseline: b.lines[0]?.origin,
      block: b,
    }));
    for (const e of p.edits) {
      if (!e.isNew || e.deleted) continue;
      out.push({
        key: e.blockKey,
        rect: e.rect,
        text: "",
        spans: e.spans?.length ? e.spans : spansOfEdit(e),
        fontSize: e.fontSize,
        leading: e.leading,
        align: e.align,
        indent: e.indent,
        block: null,
      });
    }
    return out;
  }, [blocks, p.edits]);

  const view = useCallback(
    (r: Rect) => {
      const v = rectToView(r, p.size, p.rotation);
      return { left: v.x * p.scale, top: v.y * p.scale, width: v.w * p.scale, height: v.h * p.scale };
    },
    [p.size, p.rotation, p.scale],
  );
  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = layer.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / p.scale, y: (e.clientY - r.top) / p.scale };
  };

  const fallbackFor = (s: Session | null): TextSpanStyle => {
    if (!s) return DEFAULT_STYLE;
    return dominantStyle(s.initial, {
      ...DEFAULT_STYLE,
      fontSize: s.item.fontSize || DEFAULT_STYLE.fontSize,
    });
  };

  /** What the format panel shows: the editor's style over the selection (plus a style chosen for the next characters). */
  const syncFormat = useCallback(() => {
    const root = editor.current;
    const s = sessionRef.current;
    if (!root || !s) return;
    const sel = selectionOffsets(root) ?? lastSel.current ?? { start: 0, end: 0 };
    const fb = fallbackFor(s);
    const spans = readSpans(root, fb);
    const sum = summarise(spans, sel.start, sel.end, fb);
    const pend = pending.current;
    if (pend && pend.at === sel.start && sel.start === sel.end) Object.assign(sum, pend.patch);
    setSummary(sum);
    setMainStyle((cur) => {
      const next = dominantStyle(spans, fb);
      return cur.fontSize === next.fontSize && cur.color === next.color ? cur : next;
    });
  }, []);

  const scheduleSync = useCallback(() => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(syncFormat);
  }, [syncFormat]);

  /** Selection moves: remembered, and the panel follows. */
  useEffect(() => {
    if (!session) return;
    const onSel = () => {
      const root = editor.current;
      if (!root) return;
      const sel = selectionOffsets(root);
      if (!sel) return;
      lastSel.current = sel;
      if (pending.current && pending.current.at !== sel.start) pending.current = null;
      scheduleSync();
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, [session, scheduleSync]);

  /** The editor is drawn from the paragraph's spans, then put exactly on the original baseline. */
  /**
   * The system font may not be the page's own: the editor's letter spacing is nudged so its lines are
   * as wide as the page's were (same wrapping at open, the caret under the character you clicked).
   */
  const calibrate = (root: HTMLElement, it: Item) => {
    root.style.letterSpacing = "";
    const b = it.block;
    if (!b || !b.lines.length) return;
    const lines = b.lines;
    // A justified line is stretched: its last line (the natural one) is the reference; else the widest.
    const ref =
      b.align === "justify" && lines.length > 1
        ? lines[lines.length - 1]!
        : lines.reduce((w, l) => (l.rect.w > w.rect.w ? l : w), lines[0]!);
    const spans = readSpans(root, DEFAULT_STYLE);
    const at = spansText(spans).indexOf(ref.text);
    const n = ref.text.length;
    if (at < 0 || n < 8) return;
    const probe = document.createElement("div");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "pre";
    probe.style.fontSize = root.style.fontSize;
    renderSpans(probe, sliceSpans(spans, at, at + n), cb.current.scale);
    root.parentElement?.appendChild(probe);
    const width = probe.getBoundingClientRect().width;
    probe.remove();
    const target = ref.rect.w * cb.current.scale;
    const off = Math.abs(target - width) / Math.max(target, 1);
    // Close fonts only: a very different face is left as it is.
    if (off > 0.003 && off < 0.12) root.style.letterSpacing = `${(target - width) / n}px`;
  };

  const layoutEditor = useCallback(() => {
    const root = editor.current;
    if (!root) return;
    const s = sessionRef.current;
    if (s) calibrate(root, s.item);
    const probe = document.createElement("span");
    probe.style.display = "inline-block";
    probe.style.width = "0";
    probe.style.height = "0";
    probe.style.verticalAlign = "baseline";
    root.insertBefore(probe, root.firstChild);
    const off = probe.offsetTop;
    probe.remove();
    setBaselineOff(off);
  }, []);

  const started = useRef<string | null>(null);
  useLayoutEffect(() => {
    const root = editor.current;
    if (!session || !root) {
      started.current = null;
      return;
    }
    const fresh = started.current !== session.item.key;
    started.current = session.item.key;
    if (fresh) renderSpans(root, session.initial, p.scale);
    else {
      // The zoom changed: the same text, redrawn at the new size, selection kept.
      const sel = selectionOffsets(root);
      renderSpans(root, readSpans(root, fallbackFor(session)), p.scale);
      if (sel) setSelectionOffsets(root, sel.start, sel.end);
    }
    layoutEditor();
    if (fresh) {
      const orig = view(session.item.rect);
      setMask(
        session.item.block
          ? sampleBackground(layer.current!, {
              left: orig.left - 1.5 * p.scale,
              top: orig.top - 1.5 * p.scale,
              width: orig.width + 3 * p.scale,
              height: orig.height + 3 * p.scale,
            })
          : null,
      );
      setMainStyle(dominantStyle(session.initial, fallbackFor(session)));
    }
    // Once per session, and when the zoom changes (the pixels of everything change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.item.key, p.scale]);

  /** Focus and caret, once the editor sits where it will stay. */
  useLayoutEffect(() => {
    const root = editor.current;
    const s = sessionRef.current;
    if (!s || !root || baselineOff === null) return;
    root.focus({ preventScroll: true });
    const total = spansText(readSpans(root, fallbackFor(s))).length;
    const at = s.click ? offsetAtPoint(root, s.click.x, s.click.y) : null;
    setSelectionOffsets(root, at ?? total);
    lastSel.current = selectionOffsets(root);
    syncFormat();
    // Only when this session's layout is first known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.item.key, baselineOff === null]);

  const finish = useCallback(() => {
    setSession(null);
    setBaselineOff(null);
    setMask(null);
    lastSel.current = null;
    pending.current = null;
    cb.current.onEditing?.(null);
  }, []);

  const open = (it: Item, click?: Pt) => {
    const edit = byKey.get(it.key);
    cb.current.onBeginChange();
    const spans = edit?.spans?.length ? edit.spans : edit ? spansOfEdit(edit) : it.spans;
    const dom = dominantStyle(spans, { ...DEFAULT_STYLE, fontSize: it.fontSize || 12 });
    const leading = edit?.leading ?? it.leading;
    setBaselineOff(null);
    setSession({
      item: it,
      initial: spans,
      placement: edit?.placement ?? edit?.rect ?? it.rect,
      align: edit?.align ?? it.align,
      lineSpacing: leading > 0 && dom.fontSize > 0 ? leading / dom.fontSize : 1.2,
      click,
    });
    cb.current.onEditing?.(it.block ? { pageId: p.pageId, blockKey: it.key, rect: it.rect } : null);
  };

  /** Keep what was typed (a change only if something differs from the original). */
  const commit = useCallback(
    (deleted = false) => {
      const s = sessionRef.current;
      const root = editor.current;
      if (!s) return;
      const it = s.item;
      const fb = fallbackFor(s);
      const spans = deleted ? [] : root ? readSpans(root, fb) : s.initial;
      const text = spansText(spans);
      const existing = byKey.get(it.key);
      const dom = dominantStyle(spans.length ? spans : s.initial, fb);
      const leading = s.lineSpacing * dom.fontSize;
      const moved =
        !!it.block &&
        (Math.abs(s.placement.x - it.rect.x) > 0.01 ||
          Math.abs(s.placement.y - it.rect.y) > 0.01 ||
          Math.abs(s.placement.w - it.rect.w) > 0.01);
      const styleChanged = !!it.block && !sameSpans(spans, it.spans);
      const changed =
        deleted ||
        text !== it.text ||
        styleChanged ||
        s.align !== it.align ||
        Math.abs(leading - it.leading) > 0.05 ||
        moved ||
        !it.block;
      // Text grows downward: the box keeps its top, its height follows the hard lines.
      const lines = Math.max(1, text.split("\n").length);
      const placement =
        moved || !it.block ? { ...s.placement, h: Math.max(s.placement.h, lines * leading) } : undefined;
      const faceChanged = spans.some((sp) => sp.style.fontResource === null);
      cb.current.onCommit({
        id: existing?.id ?? newId("ce"),
        pageId: p.pageId,
        blockKey: it.key,
        original: it.text,
        text,
        rect: it.block ? it.block.rect : (placement ?? s.placement),
        fontSize: dom.fontSize,
        leading,
        align: s.align,
        color: dom.color.toLowerCase() === "#000000" && !existing?.color ? undefined : dom.color,
        fontFamily: dom.fontFamily,
        bold: dom.bold,
        italic: dom.italic,
        deleted,
        ...(it.block ? { placement, restyled: faceChanged || undefined } : { placement: s.placement, isNew: true }),
        ...(changed && !deleted ? { spans, indent: it.indent } : {}),
      });
      finish();
    },

    [byKey, p.pageId, finish],
  );

  const redraw = (next: TextSpan[], sel: { start: number; end: number }) => {
    const root = editor.current;
    if (!root) return;
    renderSpans(root, next, p.scale);
    root.focus({ preventScroll: true });
    setSelectionOffsets(root, sel.start, sel.end);
    lastSel.current = sel;
  };

  /** Restyle the selection (or, with only the caret, what is typed next). */
  const patchSelection = (patch: StylePatch) => {
    const root = editor.current;
    const s = sessionRef.current;
    if (!root || !s) return;
    const sel = selectionOffsets(root) ?? lastSel.current;
    if (!sel) return;
    if (sel.start === sel.end) {
      pending.current = {
        patch: { ...(pending.current?.at === sel.start ? pending.current.patch : {}), ...patch },
        at: sel.start,
      };
      root.focus({ preventScroll: true });
      syncFormat();
      return;
    }
    redraw(applyPatch(readSpans(root, fallbackFor(s)), sel.start, sel.end, patch), sel);
    syncFormat();
  };

  /** Typing with a style chosen beforehand: the characters get it. */
  const onBeforeInput = (e: React.FormEvent<HTMLDivElement>) => {
    const ev = e.nativeEvent as InputEvent;
    const root = editor.current;
    const s = sessionRef.current;
    if (!root || !s) return;
    if (ev.inputType === "insertParagraph") {
      e.preventDefault();
      document.execCommand("insertLineBreak");
      return;
    }
    const pend = pending.current;
    if (ev.inputType === "insertText" && ev.data && pend) {
      e.preventDefault();
      const sel = selectionOffsets(root) ?? lastSel.current ?? { start: 0, end: 0 };
      const fb = fallbackFor(s);
      let spans = readSpans(root, fb);
      if (sel.end > sel.start) spans = deleteRange(spans, sel.start, sel.end);
      const base = styleAt(spans, sel.start, fb);
      const faceChanged = "fontFamily" in pend.patch || "bold" in pend.patch || "italic" in pend.patch;
      const style: TextSpanStyle = { ...base, ...pend.patch, ...(faceChanged ? { fontResource: null } : {}) };
      spans = insertAt(spans, sel.start, ev.data, style);
      const at = sel.start + ev.data.length;
      redraw(spans, { start: at, end: at });
      pending.current = { patch: pend.patch, at };
      syncFormat();
    }
  };

  const onInput = () => {
    const root = editor.current;
    const s = sessionRef.current;
    if (!root || !s) return;
    // The browser typed into its own structure: redraw as spans when it left a different one.
    if (!isCanonical(root)) {
      const sel = selectionOffsets(root);
      const spans = readSpans(root, fallbackFor(s));
      renderSpans(root, spans, p.scale);
      if (sel) setSelectionOffsets(root, sel.start, sel.end);
    }
    scheduleSync();
  };

  /** Drag the active box by its frame (move) or its side handles (width), in screen space through the rotation. */
  const drag = (e: React.PointerEvent, mode: "move" | "left" | "right") => {
    const s = sessionRef.current;
    if (!s) return;
    e.preventDefault();
    e.stopPropagation();
    const start = local(e);
    const origin = s.placement;
    const onMove = (ev: PointerEvent) => {
      const now = local(ev);
      if (mode === "move") {
        const a = viewToPs(start, p.size, p.rotation);
        const b = viewToPs(now, p.size, p.rotation);
        setSession((cur) =>
          cur ? { ...cur, placement: { ...origin, x: origin.x + b.x - a.x, y: origin.y + b.y - a.y } } : cur,
        );
      } else {
        const v = rectToView(origin, p.size, p.rotation);
        const dx = now.x - start.x;
        const next =
          mode === "right"
            ? { ...v, w: Math.max(12, v.w + dx) }
            : { ...v, x: v.x + Math.min(dx, v.w - 12), w: Math.max(12, v.w - dx) };
        setSession((cur) => (cur ? { ...cur, placement: rectFromView(next, p.size, p.rotation) } : cur));
      }
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      editor.current?.focus({ preventScroll: true });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const onLayerDown = (e: React.PointerEvent) => {
    if (!p.adding || e.target !== layer.current) return;
    e.preventDefault();
    const at = viewToPs(local(e), p.size, p.rotation);
    const key = `new:${newId("tx")}`;
    const it: Item = {
      key,
      rect: { x: at.x, y: at.y, w: 220, h: 16 },
      text: "",
      spans: [],
      fontSize: 12,
      leading: 15,
      align: "left",
      block: null,
    };
    cb.current.onBeginChange();
    cb.current.onAdded?.();
    setBaselineOff(null);
    setSession({ item: it, initial: [], placement: it.rect, align: "left", lineSpacing: 1.25 });
    cb.current.onEditing?.(null);
  };

  // Leaving the editor (mode left, page gone) ends the session: the hidden original is shown again.
  useEffect(() => () => cb.current.onEditing?.(null), []);

  if (!blocks) return null;

  const wrapperBlur = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && (wrap.current?.contains(next) || p.formatHost?.contains(next))) return;
    // Window switched, or the click is still landing on the panel: look again once it has settled.
    setTimeout(() => {
      if (!sessionRef.current || !document.hasFocus()) return;
      const a = document.activeElement;
      if (a && (wrap.current?.contains(a) || p.formatHost?.contains(a))) return;
      commit();
    }, 0);
  };

  const dom = mainStyle;

  const shown = session ? items.filter((i) => i.key !== session.item.key) : items;

  // The active box, in view pixels. The editor's first baseline sits on the original one.
  let wrapStyle: React.CSSProperties | undefined;
  let maskStyle: React.CSSProperties | undefined;
  if (session) {
    const v = view(session.placement);
    let top = v.top;
    const it = session.item;
    if (baselineOff !== null && it.baseline && p.rotation === 0) {
      const dx = session.placement.x - it.rect.x;
      const dy = session.placement.y - it.rect.y;
      const b = psToView({ x: it.baseline.x + dx, y: it.baseline.y + dy }, p.size, p.rotation);
      top = b.y * p.scale - baselineOff;
    }
    wrapStyle = {
      position: "absolute",
      left: v.left,
      top,
      width: v.width,
      visibility: baselineOff === null ? "hidden" : "visible",
    };
    if (mask && it.block) {
      const o = view(it.rect);
      const pad = 1.5 * p.scale;
      maskStyle = {
        position: "absolute",
        left: o.left - pad,
        top: o.top - pad,
        width: o.width + pad * 2,
        height: o.height + pad * 2,
        background: mask,
      };
    }
  }

  const lineHeightPx = session ? session.lineSpacing * dom.fontSize * p.scale : 0;
  const indent = session?.item.indent;
  const editorStyle: React.CSSProperties | undefined = session
    ? {
        fontSize: dom.fontSize * p.scale,
        lineHeight: `${lineHeightPx}px`,
        textAlign: session.align,
        paddingLeft: indent ? indent.rest * p.scale : 0,
        textIndent: indent ? (indent.first - indent.rest) * p.scale : 0,
      }
    : undefined;

  return (
    <div className={`pdfx-editlayer ${p.adding ? "is-adding" : ""}`} ref={layer} onPointerDown={onLayerDown}>
      {shown.map((it) => {
        const edit = byKey.get(it.key);
        const box = edit?.placement ?? it.rect;
        const v = view(box);
        const pad = 3;
        if (!it.block && (!edit || edit.deleted)) return null;
        return (
          <div
            key={it.key}
            className={`pdfx-editblock ${edit && !edit.deleted ? "is-edited" : ""}`}
            style={{
              position: "absolute",
              left: v.left - pad,
              top: v.top - pad,
              width: v.width + pad * 2,
              height: v.height + pad * 2,
            }}
          >
            <button
              type="button"
              className="pdfx-editblock__hit"
              title="Cliquer pour modifier ce paragraphe"
              aria-label={`Modifier : ${(edit ? edit.text : it.text).slice(0, 60)}`}
              onClick={(e) => open(it, { x: e.clientX, y: e.clientY })}
            />
          </div>
        );
      })}

      {maskStyle && <span className="pdfx-editblock__mask" style={maskStyle} aria-hidden="true" />}

      {session && (
        <div
          ref={wrap}
          className="pdfx-editblock is-active"
          style={wrapStyle}
          onBlur={wrapperBlur}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div
            ref={editor}
            className="pdfx-editblock__editor"
            role="textbox"
            aria-multiline="true"
            aria-label="Texte du paragraphe"
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            style={editorStyle}
            onBeforeInput={onBeforeInput}
            onInput={onInput}
            onPaste={(e) => {
              e.preventDefault();
              const t = e.clipboardData.getData("text/plain");
              if (t) document.execCommand("insertText", false, t);
            }}
            onDrop={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              e.stopPropagation();
              const mod = e.ctrlKey || e.metaKey;
              if (e.key === "Escape" || (mod && e.key === "Enter")) {
                e.preventDefault();
                commit();
                return;
              }
              if (e.key === "Tab") e.preventDefault();
              if (mod && !e.shiftKey && !e.altKey) {
                const k = e.key.toLowerCase();
                const flag = k === "b" ? "bold" : k === "i" ? "italic" : k === "u" ? "underline" : null;
                if (flag) {
                  e.preventDefault();
                  patchSelection({ [flag]: !summary[flag] });
                }
              }
            }}
          />
          <span
            className="pdfx-editblock__edge pdfx-editblock__edge--n"
            role="button"
            aria-label="Déplacer"
            title="Déplacer le texte"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => drag(e, "move")}
          />
          <span
            className="pdfx-editblock__edge pdfx-editblock__edge--s"
            aria-hidden="true"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => drag(e, "move")}
          />
          <span
            className="pdfx-editblock__edge pdfx-editblock__edge--w"
            aria-hidden="true"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => drag(e, "move")}
          />
          <span
            className="pdfx-editblock__edge pdfx-editblock__edge--e"
            aria-hidden="true"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => drag(e, "move")}
          />
          <span
            className="pdfx-editblock__handle pdfx-editblock__handle--w"
            title="Largeur de la zone"
            aria-hidden="true"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => drag(e, "left")}
          />
          <span
            className="pdfx-editblock__handle pdfx-editblock__handle--e"
            title="Largeur de la zone"
            aria-hidden="true"
            onMouseDown={(e) => e.preventDefault()}
            onPointerDown={(e) => drag(e, "right")}
          />
        </div>
      )}

      {session &&
        p.formatHost &&
        createPortal(
          <TextFormatPanel
            summary={summary}
            align={session.align}
            lineSpacing={session.lineSpacing}
            families={FAMILIES()}
            canRevert={!!session.item.block}
            onPatch={patchSelection}
            onAlign={(align) => setSession((cur) => (cur ? { ...cur, align } : cur))}
            onLineSpacing={(lineSpacing) => setSession((cur) => (cur ? { ...cur, lineSpacing } : cur))}
            onDelete={() => commit(true)}
            onRevert={() => {
              const s = sessionRef.current;
              if (!s || !s.item.block) return;
              const it = s.item;
              setSession({
                ...s,
                align: it.align,
                placement: it.rect,
                lineSpacing: it.leading / (dominantStyle(it.spans, DEFAULT_STYLE).fontSize || 12),
              });
              redraw(it.spans, { start: 0, end: 0 });
              syncFormat();
            }}
          />,
          p.formatHost,
        )}

      {!blocks.length && !p.edits.some((e) => e.isNew) && !p.adding && (
        <div className="pdfx-editlayer__empty">
          Aucun texte modifiable détecté sur cette page (document scanné ?). Lancez l'OCR pour le rendre éditable.
        </div>
      )}
    </div>
  );
}

// See annotLayerPropsEqual in AnnotLayer.tsx for why callback props (onCommit,
// onBeginChange, onBlocks, onEditing) are skipped here: PdfWorkspace recreates them
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
