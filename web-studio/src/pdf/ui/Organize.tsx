import { useEffect, useMemo, useRef, useState } from "react";
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
import { renderToCanvas } from "../core/render";
import type { Page } from "../model/types";

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

function PageCard({ engine, page, index, size }: { engine: PdfEngine; page: Page; index: number; size: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || page.from == null) return;
    let done = false;
    const io = new IntersectionObserver(
      async ([entry]) => {
        if (!entry.isIntersecting || done) return;
        done = true;
        io.disconnect();
        try {
          const proxy = await engine.page(page.from!);
          const canvas = await renderToCanvas(proxy, { scale: 3, maxWidth: size * 2 });
          setSrc(canvas.toDataURL("image/png"));
        } catch {
          /* leave blank */
        }
      },
      { rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [engine, page.from, size]);

  const rot = page.rotate ?? 0;
  return (
    <div ref={ref} className="pdfx-org__thumb" style={{ width: size }}>
      {src ? (
        <img src={src} alt="" draggable={false} style={{ transform: rot ? `rotate(${rot}deg)` : undefined }} />
      ) : (
        <div className="pdfx-org__blank" style={{ height: size * 1.41 }}>
          {page.from == null ? "Page blanche" : ""}
        </div>
      )}
      <span className="pdfx-org__num">{page.label || index + 1}</span>
    </div>
  );
}

export default function Organize(p: OrganizeProps) {
  const [size, setSize] = useState(190);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const dragIds = useRef<string[]>([]);
  const lastClicked = useRef<number>(-1);

  const selectedSet = useMemo(() => new Set(p.selected), [p.selected]);
  const has = p.selected.length > 0;
  const targets = has ? p.selected : p.pages.map((q) => q.id);

  const click = (e: React.MouseEvent, page: Page, index: number) => {
    if (e.shiftKey && lastClicked.current >= 0) {
      const [from, to] = lastClicked.current < index ? [lastClicked.current, index] : [index, lastClicked.current];
      p.onSelect(p.pages.slice(from, to + 1).map((q) => q.id));
      return;
    }
    lastClicked.current = index;
    if (e.ctrlKey || e.metaKey) {
      p.onSelect(selectedSet.has(page.id) ? p.selected.filter((q) => q !== page.id) : [...p.selected, page.id]);
      return;
    }
    p.onSelect([page.id]);
  };

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
      <header className="pdfx-org__bar">
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
      </header>

      <div
        className="pdfx-org__grid"
        onClick={(e) => {
          if (e.target === e.currentTarget) p.onSelect([]);
        }}
      >
        {p.pages.map((page, i) => (
          <div
            key={page.id}
            className={`pdfx-org__cell ${selectedSet.has(page.id) ? "is-selected" : ""} ${page.skipped ? "is-skipped" : ""} ${dropAt === i ? "is-drop" : ""}`}
            draggable
            onDragStart={() => {
              dragIds.current = selectedSet.has(page.id) ? p.selected : [page.id];
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDropAt(i);
            }}
            onDragLeave={() => setDropAt((v) => (v === i ? null : v))}
            onDrop={(e) => {
              e.preventDefault();
              setDropAt(null);
              if (dragIds.current.length) p.onReorder(dragIds.current, i);
              dragIds.current = [];
            }}
            onClick={(e) => click(e, page, i)}
          >
            <PageCard engine={p.engine} page={page} index={i} size={size} />
            <div className="pdfx-org__cellops">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  p.onRotate([page.id], 90);
                }}
                title="Pivoter"
              >
                <RotateCw size={13} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  p.onDuplicate([page.id]);
                }}
                title="Dupliquer"
              >
                <Copy size={13} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  p.onInsertBlank(page.id);
                }}
                title="Insérer après"
              >
                <FilePlus2 size={13} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  p.onDelete([page.id]);
                }}
                title="Supprimer"
              >
                <Trash2 size={13} />
              </button>
            </div>
            {page.skipped && <span className="pdfx-org__skipbadge">Exclue</span>}
          </div>
        ))}
        <button className="pdfx-org__add" onClick={() => p.onInsertBlank(null)} title="Ajouter une page à la fin">
          <FilePlus2 size={22} />
          <span>Ajouter</span>
        </button>
      </div>

      <footer className="pdfx-org__foot">
        <Move size={13} /> Glissez pour réorganiser · Maj-clic pour une plage · Ctrl-clic pour ajouter à la sélection ·
        Suppr pour retirer
      </footer>
    </div>
  );
}
