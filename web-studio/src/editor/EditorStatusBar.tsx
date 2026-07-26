import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Minus, Plus } from "lucide-react";
import type { PageInfo } from "./Pagination";
import { MAX_ZOOM, MIN_ZOOM, ZOOM_STEPS, stepZoom, zoomLabel, type ZoomMode } from "./zoom";

/** Counts words in a plain-text string (whitespace-separated, Unicode-friendly). */
function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

interface Stats {
  words: number;
  chars: number;
  selWords: number;
  selChars: number;
}

/**
 * Bottom status bar showing live word/character counts for the whole document,
 * and for the current selection when there is one. Read-only friendly.
 */
export default function EditorStatusBar({
  editor, pageInfo, zoom, zoomMode, onZoom, onZoomMode,
}: {
  editor: Editor | null;
  pageInfo?: PageInfo;
  /** Effective zoom (1 = 100%). When omitted the zoom control is not shown. */
  zoom?: number;
  zoomMode?: ZoomMode;
  onZoom?: (z: number) => void;
  onZoomMode?: (m: ZoomMode) => void;
}) {
  const [stats, setStats] = useState<Stats>({ words: 0, chars: 0, selWords: 0, selChars: 0 });

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const text = editor.getText({ blockSeparator: "\n" });
      const { from, to, empty } = editor.state.selection;
      let selWords = 0;
      let selChars = 0;
      if (!empty) {
        const selText = editor.state.doc.textBetween(from, to, "\n", " ");
        selChars = selText.length;
        selWords = countWords(selText);
      }
      setStats({ words: countWords(text), chars: text.length, selWords, selChars });
    };
    update();
    editor.on("update", update);
    editor.on("selectionUpdate", update);
    return () => {
      editor.off("update", update);
      editor.off("selectionUpdate", update);
    };
  }, [editor]);

  if (!editor) return null;
  const plural = (n: number) => (n > 1 ? "s" : "");
  const hasSel = stats.selChars > 0;

  return (
    <div className="editor-statusbar" role="status" aria-live="polite">
      {pageInfo && (
        <>
          <span>
            Page {pageInfo.currentPage.toLocaleString("fr-FR")} sur {pageInfo.pageCount.toLocaleString("fr-FR")}
          </span>
          <span className="editor-statusbar__sep">·</span>
        </>
      )}
      <span>{stats.words.toLocaleString("fr-FR")} mot{plural(stats.words)}</span>
      <span className="editor-statusbar__sep">·</span>
      <span>{stats.chars.toLocaleString("fr-FR")} caractère{plural(stats.chars)}</span>
      {hasSel && (
        <span className="editor-statusbar__sel">
          sélection : {stats.selWords.toLocaleString("fr-FR")} mot{plural(stats.selWords)} ·{" "}
          {stats.selChars.toLocaleString("fr-FR")} car.
        </span>
      )}

      {zoom != null && onZoom && onZoomMode && (
        <div className="editor-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="editor-zoom__btn"
            title="Réduire le zoom"
            aria-label="Réduire le zoom"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => onZoom(stepZoom(zoom, -1))}
          >
            <Minus size={13} />
          </button>
          <input
            className="editor-zoom__slider"
            type="range"
            min={MIN_ZOOM * 100}
            max={MAX_ZOOM * 100}
            step={5}
            value={Math.round(zoom * 100)}
            onChange={(e) => onZoom(Number(e.target.value) / 100)}
            aria-label="Niveau de zoom"
            title={`Zoom : ${zoomLabel(zoom)}`}
          />
          <button
            type="button"
            className="editor-zoom__btn"
            title="Agrandir le zoom"
            aria-label="Agrandir le zoom"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => onZoom(stepZoom(zoom, 1))}
          >
            <Plus size={13} />
          </button>
          <select
            className="editor-zoom__select"
            aria-label="Zoom"
            title="Zoom"
            value={zoomMode === "manual" ? String(Math.round(zoom * 100)) : zoomMode}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "fitWidth" || v === "fitPage") onZoomMode(v);
              else onZoom(Number(v) / 100);
            }}
          >
            {/* A manual value off the preset list still needs to be selectable. */}
            {zoomMode === "manual" && !ZOOM_STEPS.some((s) => Math.round(s * 100) === Math.round(zoom * 100)) && (
              <option value={String(Math.round(zoom * 100))}>{zoomLabel(zoom)}</option>
            )}
            {ZOOM_STEPS.map((s) => (
              <option key={s} value={String(Math.round(s * 100))}>{zoomLabel(s)}</option>
            ))}
            <option value="fitWidth">Largeur de la page</option>
            <option value="fitPage">Page entière</option>
          </select>
        </div>
      )}
    </div>
  );
}
