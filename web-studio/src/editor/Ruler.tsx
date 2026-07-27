/**
 * La règle graduée horizontale, façon Word.
 *
 * Elle montre la géométrie réelle de la page — marges, retraits du paragraphe
 * courant, taquets — et sert à les manipuler : un clic pose un taquet du type
 * choisi, un glisser le déplace, un double-clic le retire. Le sélecteur à gauche
 * fait défiler les types, exactement comme le petit carré de Word.
 *
 * Toutes les positions sont en millimètres et converties à l'affichage par le
 * zoom courant : la règle et la feuille partagent ainsi la même échelle, sans
 * quoi un taquet posé à 4 cm n'atterrirait pas sous la graduation 4.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { CSS_PX_PER_MM } from "./Pagination";
import {
  TAB_ALIGNS, TAB_ALIGN_LABELS, addStop, moveStop, nearestStop, normalizeStops, removeStopNear,
  rulerLabels, rulerTicks, type TabAlign, type TabStop,
} from "./tabs";
import { tabStopsAt } from "./tabExtension";

/** Glyphe qui figure chaque type de taquet, comme les marqueurs de Word. */
const TAB_GLYPH: Record<TabAlign, string> = {
  left: "⌐",
  center: "⊥",
  right: "¬",
  decimal: "⊦",
  bar: "|",
};

export default function Ruler({
  editor,
  widthMm,
  marginLeftMm,
  marginRightMm,
  zoom = 1,
}: {
  editor: Editor | null;
  /** Largeur totale de la feuille, en mm. */
  widthMm: number;
  marginLeftMm: number;
  marginRightMm: number;
  zoom?: number;
}) {
  const [align, setAlign] = useState<TabAlign>("left");
  const [stops, setStops] = useState<TabStop[]>([]);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);

  const textWidthMm = Math.max(0, widthMm - marginLeftMm - marginRightMm);
  const pxPerMm = CSS_PX_PER_MM * zoom;

  // Les taquets affichés suivent le paragraphe où se trouve le curseur.
  const syncFromEditor = useCallback(() => {
    if (!editor || editor.isDestroyed) return;
    setStops(tabStopsAt(editor.state.doc as never, editor.state.selection.from));
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    syncFromEditor();
    editor.on("selectionUpdate", syncFromEditor);
    editor.on("update", syncFromEditor);
    return () => {
      editor.off("selectionUpdate", syncFromEditor);
      editor.off("update", syncFromEditor);
    };
  }, [editor, syncFromEditor]);

  const ticks = useMemo(() => rulerTicks(textWidthMm), [textWidthMm]);
  const labels = useMemo(() => rulerLabels(textWidthMm), [textWidthMm]);

  /** Position d'un événement souris, en mm depuis la marge gauche. */
  const mmAt = useCallback(
    (clientX: number): number => {
      const box = trackRef.current?.getBoundingClientRect();
      if (!box) return 0;
      const mm = (clientX - box.left) / pxPerMm;
      return Math.max(0, Math.min(textWidthMm, Math.round(mm * 10) / 10));
    },
    [pxPerMm, textWidthMm],
  );

  const commit = useCallback(
    (next: TabStop[]) => {
      setStops(next);
      editor?.chain().focus(undefined, { scrollIntoView: false }).setTabStops(next).run();
    },
    [editor],
  );

  const onTrackMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!editor) return;
      const pos = mmAt(e.clientX);
      const existing = nearestStop(stops, pos);
      if (existing) {
        // Un taquet sous le pointeur : on le déplace au lieu d'en empiler un.
        setDragFrom(existing.pos);
        e.preventDefault();
        return;
      }
      commit(addStop(stops, { pos, align, leader: "none" }));
      e.preventDefault();
    },
    [align, commit, editor, mmAt, stops],
  );

  // Le glisser se suit sur la fenêtre : relâcher hors de la règle doit terminer
  // proprement, pas laisser un taquet collé au pointeur.
  useEffect(() => {
    if (dragFrom == null) return;
    let current = dragFrom;
    const onMove = (e: MouseEvent) => {
      const to = mmAt(e.clientX);
      setStops((prev) => moveStop(prev, current, to));
      current = to;
    };
    const onUp = () => {
      setDragFrom(null);
      setStops((prev) => {
        const next = normalizeStops(prev);
        editor?.chain().focus(undefined, { scrollIntoView: false }).setTabStops(next).run();
        return next;
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragFrom, editor, mmAt]);

  const onTrackDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      const pos = mmAt(e.clientX);
      const next = removeStopNear(stops, pos);
      if (next !== stops) {
        commit(next);
        e.preventDefault();
      }
    },
    [commit, mmAt, stops],
  );

  const cycleAlign = useCallback(() => {
    setAlign((a) => TAB_ALIGNS[(TAB_ALIGNS.indexOf(a) + 1) % TAB_ALIGNS.length]!);
  }, []);

  if (!editor) return null;

  return (
    <div className="elium-ruler" role="group" aria-label="Règle graduée">
      <button
        type="button"
        className="elium-ruler__picker"
        onClick={cycleAlign}
        title={`Type de taquet : ${TAB_ALIGN_LABELS[align]} (cliquez pour changer)`}
        aria-label={`Type de taquet : ${TAB_ALIGN_LABELS[align]}`}
      >
        {TAB_GLYPH[align]}
      </button>

      <div className="elium-ruler__page" style={{ width: `${widthMm * pxPerMm}px` }}>
        <div className="elium-ruler__margin" style={{ width: `${marginLeftMm * pxPerMm}px` }} />
        <div
          ref={trackRef}
          className="elium-ruler__track"
          style={{ width: `${textWidthMm * pxPerMm}px` }}
          onMouseDown={onTrackMouseDown}
          onDoubleClick={onTrackDoubleClick}
          title="Cliquez pour poser un taquet, glissez pour le déplacer, double-cliquez pour le retirer"
        >
          {ticks.map((t) => (
            <span
              key={t.pos}
              className={`elium-ruler__tick${t.major ? " is-major" : ""}`}
              style={{ left: `${t.pos * pxPerMm}px` }}
            />
          ))}
          {labels.map((l) => (
            <span key={`l${l.pos}`} className="elium-ruler__label" style={{ left: `${l.pos * pxPerMm}px` }}>
              {l.label}
            </span>
          ))}
          {stops.map((s) => (
            <span
              key={s.pos}
              className={`elium-ruler__stop is-${s.align}${dragFrom === s.pos ? " is-dragging" : ""}`}
              style={{ left: `${s.pos * pxPerMm}px` }}
              title={`Taquet ${TAB_ALIGN_LABELS[s.align].toLowerCase()} à ${(s.pos / 10).toFixed(1)} cm`}
            >
              {TAB_GLYPH[s.align]}
            </span>
          ))}
        </div>
        <div className="elium-ruler__margin" style={{ width: `${marginRightMm * pxPerMm}px` }} />
      </div>
    </div>
  );
}
