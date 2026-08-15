import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Minus, Plus, Maximize2 } from "lucide-react";
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

const fr = (n: number) => n.toLocaleString("fr-FR");

/**
 * Bottom status bar: pagination, live counts, and the zoom control.
 *
 * Reworked to look like a status bar rather than a row of loose text. Three
 * things drove the layout:
 *   - **Real dividers**, not a "·" character at half opacity.
 *   - **Tabular figures**, so the bar does not twitch as the counts grow while
 *     typing — a proportional "5 407" is wider than "5 408" and the whole row
 *     shifted on every keystroke.
 *   - **No wrapping**: the bar keeps a fixed height and drops its least useful
 *     items on narrow screens instead of growing to two lines, which used to
 *     shove the editor up and down.
 *
 * The counts are a button: clicking them opens the statistics dialog, the way
 * Word's word count does.
 */
export default function EditorStatusBar({
  editor,
  pageInfo,
  zoom,
  zoomMode,
  onZoom,
  onZoomMode,
  onOpenStats,
}: {
  editor: Editor | null;
  pageInfo?: PageInfo;
  /** Effective zoom (1 = 100%). When omitted the zoom control is not shown. */
  zoom?: number;
  zoomMode?: ZoomMode;
  onZoom?: (z: number) => void;
  onZoomMode?: (m: ZoomMode) => void;
  /** Opens the statistics dialog when the counts are clicked. */
  onOpenStats?: () => void;
}) {
  const [stats, setStats] = useState<Stats>({ words: 0, chars: 0, selWords: 0, selChars: 0 });

  useEffect(() => {
    if (!editor) return;
    const update = () => {
      // A destroyed editor can still receive one last effect (StrictMode's
      // double-mount, or the remount App performs after loading a file) and its
      // schema is gone by then. The status bar must never be what takes the app
      // down, so it bails out rather than reading a dead editor.
      if (editor.isDestroyed) return;
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
    <div className="statusbar" role="status" aria-live="polite">
      {pageInfo && (
        <>
          <span className="statusbar__item statusbar__item--page">
            Page <b>{fr(pageInfo.currentPage)}</b> sur <b>{fr(pageInfo.pageCount)}</b>
          </span>
          <span className="statusbar__div" aria-hidden="true" />
        </>
      )}

      <button
        type="button"
        className="statusbar__item statusbar__item--counts"
        onClick={() => onOpenStats?.()}
        title="Statistiques du document"
      >
        <b>{fr(stats.words)}</b> mot{plural(stats.words)}
        <span className="statusbar__thin">{fr(stats.chars)} car.</span>
      </button>

      {hasSel && (
        <>
          <span className="statusbar__div" aria-hidden="true" />
          <span className="statusbar__item statusbar__sel">
            <b>{fr(stats.selWords)}</b> mot{plural(stats.selWords)} sélectionné{plural(stats.selWords)}
            <span className="statusbar__thin">{fr(stats.selChars)} car.</span>
          </span>
        </>
      )}

      {zoom != null && onZoom && onZoomMode && (
        <div className="statusbar__zoom" role="group" aria-label="Zoom">
          <span className="statusbar__div" aria-hidden="true" />
          <button
            type="button"
            className="statusbar__btn"
            title="Ajuster à la largeur de la page"
            aria-label="Ajuster à la largeur de la page"
            aria-pressed={zoomMode === "fitWidth"}
            onClick={() => onZoomMode("fitWidth")}
          >
            <Maximize2 size={13} />
          </button>
          <button
            type="button"
            className="statusbar__btn"
            title="Réduire le zoom"
            aria-label="Réduire le zoom"
            disabled={zoom <= MIN_ZOOM}
            onClick={() => onZoom(stepZoom(zoom, -1))}
          >
            <Minus size={13} />
          </button>
          <input
            className="statusbar__slider"
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
            className="statusbar__btn"
            title="Agrandir le zoom"
            aria-label="Agrandir le zoom"
            disabled={zoom >= MAX_ZOOM}
            onClick={() => onZoom(stepZoom(zoom, 1))}
          >
            <Plus size={13} />
          </button>
          <select
            className="statusbar__select"
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
              <option key={s} value={String(Math.round(s * 100))}>
                {zoomLabel(s)}
              </option>
            ))}
            <option value="fitWidth">Largeur</option>
            <option value="fitPage">Page entière</option>
          </select>
        </div>
      )}
    </div>
  );
}
