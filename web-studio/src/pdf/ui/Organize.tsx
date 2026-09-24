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
  drop: boolean;
  actions: CellActions;
}

/** Stable handlers shared by every cell (they read the organiser's latest props). */
interface CellActions {
  click: (e: React.MouseEvent, page: Page, index: number) => void;
  dragStart: (page: Page, selected: boolean) => void;
  dragOver: (index: number) => void;
  dragLeave: (index: number) => void;
  drop: (index: number) => void;
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
      className={`pdfx-org__cell ${selected ? "is-selected" : ""} ${page.skipped ? "is-skipped" : ""} ${drop ? "is-drop" : ""}`}
      draggable
      onDragStart={() => actions.dragStart(page, selected)}
      onDragOver={(e) => {
        e.preventDefault();
        actions.dragOver(i);
      }}
      onDragLeave={() => actions.dragLeave(i)}
      onDrop={(e) => {
        e.preventDefault();
        actions.drop(i);
      }}
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
  const [dropAt, setDropAt] = useState<number | null>(null);
  const dragIds = useRef<string[]>([]);
  const lastClicked = useRef<number>(-1);
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
      dragStart: (page, selected) => {
        dragIds.current = selected ? live.current.selected : [page.id];
      },
      dragOver: (i) => setDropAt(i),
      dragLeave: (i) => setDropAt((v) => (v === i ? null : v)),
      drop: (i) => {
        setDropAt(null);
        if (dragIds.current.length) live.current.onReorder(dragIds.current, i);
        dragIds.current = [];
      },
      rotate: (id) => live.current.onRotate([id], 90),
      duplicate: (id) => live.current.onDuplicate([id]),
      insertAfter: (id) => live.current.onInsertBlank(id),
      remove: (id) => live.current.onDelete([id]),
    }),
    [click],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

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
            title="Exclure de l'export sans supprimer"
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
        onClick={(e) => {
          if (e.target === e.currentTarget) p.onSelect([]);
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
              drop={dropAt === i}
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
        <Move size={13} /> Glissez pour réorganiser · Maj-clic pour une plage · Ctrl-clic pour ajouter à la sélection ·
        Suppr pour retirer
      </div>
    </div>
  );
}
