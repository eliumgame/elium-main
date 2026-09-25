import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  Copy,
  Crop,
  EyeOff,
  Eye,
  FileImage,
  FilePlus2,
  FileText,
  Hash,
  Move,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import type { PdfEngine } from "../core/engine";
import { gridColumns, gridRowHeights, stackRows } from "../core/viewer/virtual";
import { thumbAspect, thumbnailsFor } from "../core/thumbs";
import type { Page } from "../model/types";
import ThumbCanvas from "./ThumbCanvas";
import { useListWindow } from "./useListWindow";

/**
 * The page organiser: a full-surface grid of every page with drag-and-drop
 * reordering, rubber-band multi-selection and bulk operations.
 *
 * Acrobat puts this behind a mode switch rather than a modal, because
 * reorganising a long document is a task you stay in — so does Elium.
 */

export interface OrganizeProps {
  engine: PdfEngine;
  pages: Page[];
  selected: string[];
  onSelect: (ids: string[]) => void;
  onReorder: (ids: string[], to: number) => void;
  onRotate: (ids: string[], delta: number) => void;
  onDelete: (ids: string[]) => void;
  onDuplicate: (ids: string[]) => void;
  onSkip: (ids: string[], skipped: boolean) => void;
  onExtract: (ids: string[]) => void;
  onInsertBlank: (afterId: string | null) => void;
  onInsertFile: () => void;
  onInsertImage: () => void;
  /** Files dragged in from the desktop or the Drive, dropped at page position `at`. */
  onDropFiles?: (files: File[], at: number) => void;
  /** Ctrl+V in the organiser: pasted files or text, as pages at `at`. */
  onPaste?: (files: File[], text: string, at: number) => void;
  onCrop: () => void;
  onLabels: () => void;
  onReverse: () => void;
  onClose: () => void;
}

const SIZES = [120, 150, 190, 240, 300];
/** `.pdfx-org__grid { gap; padding }`. */
const GRID_GAP = 18;
const GRID_PAD = 22;
/** `.pdfx-org__cell { padding: 6px; border: 2px }` around the picture. */
const CELL_EXTRA_W = 16;
/** `.pdfx-org__add { min-height }`. */
const ADD_H = 190;
const GRID_OVERSCAN = 800;

interface CellProps {
  engine: PdfEngine;
  page: Page;
  index: number;
  size: number;
  height: number;
  rotation: number;
  selected: boolean;
  /** The drop marker: before or after this page. */
  drop: "before" | "after" | null;
  actions: CellActions;
}

/** Where a drag would land: before or after page `cell`. */
interface DropMark {
  cell: number;
  side: "before" | "after";
}

/** The drag payload of pages moved inside the organiser (Firefox starts no drag without data). */
const PAGE_DRAG = "application/x-elium-pages";

const draggingFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

/** Stable handlers shared by every cell (they read the organiser's latest props). */
interface CellActions {
  click: (e: React.MouseEvent, page: Page, index: number) => void;
  dragStart: (e: React.DragEvent, page: Page, selected: boolean) => void;
  dragOver: (e: React.DragEvent, index: number) => void;
  dragLeave: (index: number) => void;
  drop: (e: React.DragEvent, index: number) => void;
  dragEnd: () => void;
  rotate: (id: string) => void;
  duplicate: (id: string) => void;
  insertAfter: (id: string) => void;
  remove: (id: string) => void;
}

/**
 * One page of the grid. Memoised: scrolling re-renders only the cells that
 * mount, a selection only the cells whose state changes.
 */
const OrgCell = memo(function OrgCell({
  engine,
  page,
  index: i,
  size,
  height,
  rotation,
  selected,
  drop,
  actions,
}: CellProps) {
  return (
    <div
      className={`pdfx-org__cell ${selected ? "is-selected" : ""} ${page.skipped ? "is-skipped" : ""} ${drop ? `is-drop-${drop}` : ""}`}
      data-page-id={page.id}
      data-index={i}
      draggable
      onDragStart={(e) => actions.dragStart(e, page, selected)}
      onDragOver={(e) => actions.dragOver(e, i)}
      onDragLeave={() => actions.dragLeave(i)}
      onDrop={(e) => actions.drop(e, i)}
      onDragEnd={actions.dragEnd}
      onClick={(e) => actions.click(e, page, i)}
    >
      <div className="pdfx-org__thumb" style={{ width: size }}>
        {page.from == null && !page.image ? (
          <div className="pdfx-org__blank" style={{ height }}>
            Page blanche
          </div>
        ) : (
          <ThumbCanvas
            className="pdfx-org__canvas"
            engine={engine}
            page={page}
            rotation={rotation}
            width={size}
            height={height}
          />
        )}
        <span className="pdfx-org__num">{page.label || i + 1}</span>
      </div>
      <div className="pdfx-org__cellops">
        <button
          onClick={(e) => {
            e.stopPropagation();
            actions.rotate(page.id);
          }}
          title="Pivoter"
        >
          <RotateCw size={13} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            actions.duplicate(page.id);
          }}
          title="Dupliquer"
        >
          <Copy size={13} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            actions.insertAfter(page.id);
          }}
          title="Insérer après"
        >
          <FilePlus2 size={13} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            actions.remove(page.id);
          }}
          title="Supprimer"
        >
          <Trash2 size={13} />
        </button>
      </div>
      {page.skipped && <span className="pdfx-org__skipbadge">Exclue</span>}
    </div>
  );
});

export default function Organize(p: OrganizeProps) {
  const [size, setSize] = useState(190);
  const [dropAt, setDropAt] = useState<DropMark | null>(null);
  /** The rubber band, in client coordinates, while one is drawn. */
  const [band, setBand] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const dragIds = useRef<string[]>([]);
  const lastClicked = useRef<number>(-1);
  /** The fixed end of a Shift+arrow range. */
  const anchorRef = useRef<number>(-1);
  const live = useRef(p);
  live.current = p;

  // --- windowing: only the rows of cells near the visible part are mounted ---
  const gridRef = useRef<HTMLDivElement>(null);
  const engine = p.engine;
  const win = useListWindow(gridRef, {
    overscan: GRID_OVERSCAN,
    offset: GRID_PAD,
    initial: { width: 1000, height: 800 },
    // Thumbnails wait for the grid to stop moving.
    onScroll: () => thumbnailsFor(engine).noteScroll(),
  });
  /** Cell height minus picture height, measured from a mounted cell. */
  const [chrome, setChrome] = useState(40);

  const cellW = size + CELL_EXTRA_W;
  const columns = gridColumns(win.width - 2 * GRID_PAD, cellW, GRID_GAP);
  // Page sizes start as estimates: the engine's geometry version keys the memo.
  const geometry = p.engine.geometryVersion;
  const cells = useMemo(
    () =>
      p.pages.map((page) => {
        const { aspect, rotation } = thumbAspect(p.engine, page);
        return { rotation, h: Math.round(size * aspect) };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.pages, p.engine, size, geometry],
  );
  // The "Ajouter" button is the grid's last cell.
  const stack = useMemo(
    () => stackRows(gridRowHeights([...cells.map((c) => c.h + chrome), ADD_H], columns), GRID_GAP),
    [cells, chrome, columns],
  );
  const rows = win.band(stack);
  const firstCell = rows ? rows.first * columns : 0;
  const endCell = rows ? Math.min(p.pages.length, (rows.last + 1) * columns) : 0;
  const showAdd = !!rows && rows.last === stack.tops.length - 1;

  useLayoutEffect(() => {
    const cell = gridRef.current?.querySelector<HTMLElement>(".pdfx-org__cell");
    const pic = cell?.querySelector<HTMLElement>(".pdfx-org__canvas, .pdfx-org__blank");
    if (!cell || !pic) return;
    const next = cell.offsetHeight - pic.offsetHeight;
    if (next > 0 && Math.abs(next - chrome) > 0.5) setChrome(next);
  }, [chrome, size, firstCell, endCell]);

  const selectedSet = useMemo(() => new Set(p.selected), [p.selected]);
  const has = p.selected.length > 0;
  const targets = has ? p.selected : p.pages.map((q) => q.id);

  const click = useCallback((e: React.MouseEvent, page: Page, index: number) => {
    const q = live.current;
    if (e.shiftKey && lastClicked.current >= 0) {
      const [from, to] = lastClicked.current < index ? [lastClicked.current, index] : [index, lastClicked.current];
      q.onSelect(q.pages.slice(from, to + 1).map((x) => x.id));
      return;
    }
    lastClicked.current = index;
    if (e.ctrlKey || e.metaKey) {
      q.onSelect(q.selected.includes(page.id) ? q.selected.filter((x) => x !== page.id) : [...q.selected, page.id]);
      return;
    }
    q.onSelect([page.id]);
  }, []);
  const actions = useMemo<CellActions>(
    () => ({
      click,
      dragStart: (e, page, selected) => {
        // The selection, in document order, when the dragged page is part of it.
        const q = live.current;
        const chosen = new Set(q.selected);
        dragIds.current = selected ? q.pages.filter((x) => chosen.has(x.id)).map((x) => x.id) : [page.id];
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData(PAGE_DRAG, dragIds.current.join(","));
      },
      dragOver: (e, i) => {
        if (!dragIds.current.length && !(draggingFiles(e) && live.current.onDropFiles)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = dragIds.current.length ? "move" : "copy";
        const r = e.currentTarget.getBoundingClientRect();
        const side = e.clientX > r.left + r.width / 2 ? "after" : "before";
        setDropAt((v) => (v?.cell === i && v.side === side ? v : { cell: i, side }));
      },
      dragLeave: (i) => setDropAt((v) => (v?.cell === i ? null : v)),
      drop: (e, i) => {
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        dropInto(e, e.clientX > r.left + r.width / 2 ? i + 1 : i);
      },
      dragEnd: () => {
        dragIds.current = [];
        setDropAt(null);
      },
      rotate: (id) => live.current.onRotate([id], 90),
      duplicate: (id) => live.current.onDuplicate([id]),
      insertAfter: (id) => live.current.onInsertBlank(id),
      remove: (id) => live.current.onDelete([id]),
    }),
    [click],
  );

  /** Finish a drag at gap `at` (0 = before the first page, n = after the last). */
  function dropInto(e: React.DragEvent, at: number) {
    setDropAt(null);
    const q = live.current;
    if (dragIds.current.length) q.onReorder(dragIds.current, at);
    else if (e.dataTransfer.files.length && q.onDropFiles) q.onDropFiles(Array.from(e.dataTransfer.files), at);
    dragIds.current = [];
  }

  // --- rubber band: drawn from the grid's background, selects the pages it touches ---
  const bandStart = (e: React.PointerEvent<HTMLDivElement>) => {
    const grid = e.currentTarget;
    const t = e.target as HTMLElement;
    if (e.button !== 0 || (t !== grid && !t.classList.contains("pdfx-org__spacer"))) return;
    // The scrollbar is not background.
    if (e.clientX > grid.getBoundingClientRect().left + grid.clientWidth) return;
    e.preventDefault();
    grid.setPointerCapture(e.pointerId);
    const base = e.ctrlKey || e.metaKey || e.shiftKey ? live.current.selected : [];
    const start = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY };
    let moved = false;
    const pick = (b: typeof start) => {
      const left = Math.min(b.x0, b.x1);
      const right = Math.max(b.x0, b.x1);
      const top = Math.min(b.y0, b.y1);
      const bottom = Math.max(b.y0, b.y1);
      const hit = new Set(base);
      grid.querySelectorAll<HTMLElement>(".pdfx-org__cell").forEach((cell) => {
        const r = cell.getBoundingClientRect();
        if (r.right >= left && r.left <= right && r.bottom >= top && r.top <= bottom) hit.add(cell.dataset.pageId!);
      });
      const q = live.current;
      q.onSelect(q.pages.filter((x) => hit.has(x.id)).map((x) => x.id));
    };
    const move = (ev: PointerEvent) => {
      const b = { ...start, x1: ev.clientX, y1: ev.clientY };
      if (!moved && Math.hypot(b.x1 - b.x0, b.y1 - b.y0) < 4) return;
      moved = true;
      setBand(b);
      pick(b);
      // Near an edge, the grid scrolls on so the band can reach pages out of view.
      const r = grid.getBoundingClientRect();
      if (ev.clientY < r.top + 30) grid.scrollTop -= 18;
      else if (ev.clientY > r.bottom - 30) grid.scrollTop += 18;
    };
    const up = () => {
      grid.removeEventListener("pointermove", move);
      grid.removeEventListener("pointerup", up);
      grid.removeEventListener("pointercancel", up);
      setBand(null);
      // A plain click on the background clears the selection.
      if (!moved && !base.length) live.current.onSelect([]);
    };
    grid.addEventListener("pointermove", move);
    grid.addEventListener("pointerup", up);
    grid.addEventListener("pointercancel", up);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Keys typed in a field or a dialog (crop, labels…) are theirs, not the organiser's.
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable ||
          t.closest('[role="dialog"], dialog, .modal-overlay'))
      ) {
        return;
      }
      if (e.key === "Escape") {
        p.onClose();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        p.onSelect(p.pages.map((q) => q.id));
      }
      if ((e.key === "Delete" || e.key === "Backspace") && p.selected.length) {
        e.preventDefault();
        p.onDelete(p.selected);
      }
      const step =
        e.key === "ArrowLeft"
          ? -1
          : e.key === "ArrowRight"
            ? 1
            : e.key === "ArrowUp"
              ? -columns
              : e.key === "ArrowDown"
                ? columns
                : e.key === "Home"
                  ? -Infinity
                  : e.key === "End"
                    ? Infinity
                    : 0;
      if (!step || !p.pages.length) return;
      e.preventDefault();
      const n = p.pages.length;
      const chosen = new Set(p.selected);
      const at = p.pages.map((x, i) => (chosen.has(x.id) ? i : -1)).filter((i) => i >= 0);
      if (e.altKey && at.length) {
        // Alt + arrow: the selected pages move (Acrobat drags; the keyboard needs a way too).
        const first = at[0];
        const last = at[at.length - 1];
        const to = step < 0 ? Math.max(0, first + Math.max(step, -n)) : Math.min(n, last + 1 + Math.min(step, n));
        p.onReorder(
          at.map((i) => p.pages[i].id),
          to,
        );
        return;
      }
      const from = lastClicked.current >= 0 && lastClicked.current < n ? lastClicked.current : (at[0] ?? -1);
      const next = from < 0 ? 0 : Math.max(0, Math.min(n - 1, from + (Number.isFinite(step) ? step : step * n)));
      if (e.shiftKey && from >= 0) {
        const anchor = anchorRef.current >= 0 ? anchorRef.current : from;
        const [a, b] = anchor < next ? [anchor, next] : [next, anchor];
        anchorRef.current = anchor;
        p.onSelect(p.pages.slice(a, b + 1).map((x) => x.id));
      } else {
        anchorRef.current = -1;
        p.onSelect([p.pages[next].id]);
      }
      lastClicked.current = next;
      gridRef.current
        ?.querySelector<HTMLElement>(`.pdfx-org__cell[data-index="${next}"]`)
        ?.scrollIntoView({ block: "nearest" });
    };
    // Ctrl+V: what was copied becomes pages, after the selection (or at the end).
    const onPaste = (e: ClipboardEvent) => {
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (!p.onPaste || !e.clipboardData) return;
      if (
        t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest('[role="dialog"]'))
      )
        return;
      const files = Array.from(e.clipboardData.files);
      const text = files.length ? "" : e.clipboardData.getData("text/plain");
      if (!files.length && !text.trim()) return;
      e.preventDefault();
      const chosen = new Set(p.selected);
      const last = p.pages.reduce((m, x, i) => (chosen.has(x.id) ? i : m), -1);
      p.onPaste(files, text, last >= 0 ? last + 1 : p.pages.length);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, [p, columns]);

  return (
    <div className="pdfx-org">
      <div className="pdfx-org__bar" role="region" aria-label="Organiser les pages">
        <span className="pdfx-org__title">Organiser les pages</span>
        <span className="pdfx-org__count">
          {p.selected.length
            ? `${p.selected.length} sélectionnée${p.selected.length > 1 ? "s" : ""}`
            : `${p.pages.length} pages`}
        </span>

        <div className="pdfx-org__group">
          <button className="pdfx-cmd" onClick={() => p.onRotate(targets, -90)} title="Pivoter à gauche">
            <RotateCcw size={16} />
          </button>
          <button className="pdfx-cmd" onClick={() => p.onRotate(targets, 90)} title="Pivoter à droite">
            <RotateCw size={16} />
          </button>
          <button className="pdfx-cmd" onClick={() => p.onDuplicate(targets)} title="Dupliquer">
            <Copy size={16} />
          </button>
          <button className="pdfx-cmd" onClick={() => p.onExtract(targets)} title="Extraire dans un nouveau PDF">
            <Scissors size={16} />
          </button>
          <button
            className="pdfx-cmd is-danger"
            onClick={() => p.onDelete(targets)}
            title="Supprimer"
            disabled={p.pages.length <= 1}
          >
            <Trash2 size={16} />
          </button>
        </div>

        <div className="pdfx-org__group">
          <button
            className="pdfx-cmd"
            onClick={() => p.onInsertBlank(p.selected[p.selected.length - 1] ?? null)}
            title="Insérer une page blanche"
          >
            <FilePlus2 size={16} />
          </button>
          <button className="pdfx-cmd" onClick={p.onInsertFile} title="Insérer un PDF">
            <FileText size={16} />
          </button>
          <button className="pdfx-cmd" onClick={p.onInsertImage} title="Insérer une image">
            <FileImage size={16} />
          </button>
        </div>

        <div className="pdfx-org__group">
          <button className="pdfx-cmd" onClick={p.onCrop} title="Recadrer">
            <Crop size={16} />
          </button>
          <button className="pdfx-cmd" onClick={p.onLabels} title="Étiquettes de page">
            <Hash size={16} />
          </button>
          <button className="pdfx-cmd" onClick={p.onReverse} title="Inverser l'ordre">
            <ArrowLeftRight size={16} />
          </button>
          <button
            className="pdfx-cmd"
            onClick={() => p.onSkip(targets, !p.pages.find((q) => targets.includes(q.id))?.skipped)}
            title="Exclure des copies, impressions et extractions (la page reste dans le document)"
          >
            {p.pages.find((q) => targets.includes(q.id))?.skipped ? <Eye size={16} /> : <EyeOff size={16} />}
          </button>
        </div>

        <span className="pdfx-org__spacer" />

        <div className="pdfx-org__group">
          <button
            className="pdfx-cmd"
            onClick={() => setSize((s) => SIZES[Math.max(0, SIZES.indexOf(s) - 1)] ?? s)}
            title="Réduire"
          >
            <ZoomOut size={16} />
          </button>
          <button
            className="pdfx-cmd"
            onClick={() => setSize((s) => SIZES[Math.min(SIZES.length - 1, SIZES.indexOf(s) + 1)] ?? s)}
            title="Agrandir"
          >
            <ZoomIn size={16} />
          </button>
        </div>
        <button className="eb eb--sm eb--primary" onClick={p.onClose}>
          <X size={14} /> Terminer
        </button>
      </div>

      <div
        ref={gridRef}
        className="pdfx-org__grid"
        role="region"
        aria-label="Pages du document"
        style={{ gridTemplateColumns: `repeat(${columns}, ${cellW}px)` }}
        onPointerDown={bandStart}
        onDragOver={(e) => {
          // Over the background or the « Ajouter » cell: after the last page.
          if (e.defaultPrevented) return;
          if (!dragIds.current.length && !(draggingFiles(e) && p.onDropFiles)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = dragIds.current.length ? "move" : "copy";
          if (p.pages.length) setDropAt({ cell: p.pages.length - 1, side: "after" });
        }}
        onDrop={(e) => {
          if (e.defaultPrevented) return;
          e.preventDefault();
          dropInto(e, p.pages.length);
        }}
      >
        {rows && rows.first > 0 && (
          <div className="pdfx-org__spacer" style={{ height: Math.max(0, stack.tops[rows.first] - GRID_GAP) }} />
        )}
        {p.pages.slice(firstCell, endCell).map((page, k) => {
          const i = firstCell + k;
          return (
            <OrgCell
              key={page.id}
              engine={p.engine}
              page={page}
              index={i}
              size={size}
              height={cells[i].h}
              rotation={cells[i].rotation}
              selected={selectedSet.has(page.id)}
              drop={dropAt?.cell === i ? dropAt.side : null}
              actions={actions}
            />
          );
        })}
        {showAdd ? (
          <button className="pdfx-org__add" onClick={() => p.onInsertBlank(null)} title="Ajouter une page à la fin">
            <FilePlus2 size={22} />
            <span>Ajouter</span>
          </button>
        ) : (
          rows && (
            <div
              className="pdfx-org__spacer"
              style={{
                height: Math.max(0, stack.total - (stack.tops[rows.last] + stack.heights[rows.last]) - GRID_GAP),
              }}
            />
          )
        )}
      </div>

      <div className="pdfx-org__foot" role="region" aria-label="Astuce">
        <Move size={13} /> Glissez pour réorganiser, ou déposez des PDF et des images · Maj-clic pour une plage ·
        Ctrl-clic pour ajouter à la sélection · Flèches pour se déplacer, Alt + flèches pour déplacer les pages · Suppr
        pour retirer
      </div>
      {band && (
        <div
          className="pdfx-org__band"
          style={{
            left: Math.min(band.x0, band.x1),
            top: Math.min(band.y0, band.y1),
            width: Math.abs(band.x1 - band.x0),
            height: Math.abs(band.y1 - band.y0),
          }}
        />
      )}
    </div>
  );
}
