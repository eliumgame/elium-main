/**
 * Panneau latéral : relit le `DocumentModel` en texte simple, propre (pas de
 * gros bloc de fond), et souligne en rouge ondulé — même langage visuel que
 * les soulignements du correcteur dans l'éditeur (`editor/proofingExtension.ts`)
 * — chaque passage repéré par le rapport, pas seulement celui sur lequel on
 * vient de cliquer. « Voir dans le document » scrolle vers le bon paragraphe
 * et lui applique un bref flash, sans altérer durablement la lecture.
 * Fenêtré (voir `previewWindow.ts`) pour rester fluide sur un document de
 * plusieurs centaines de pages.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "../../ui/components";
import type { ParagraphModel } from "../types";
import { ensureCovers, windowAround, expandStart, expandEnd, type PreviewWindow } from "./previewWindow";
import { flagsByParagraph, segmentParagraph, type PreviewFlag } from "./previewFlags";
import "./DocumentPreview.css";

export default function DocumentPreview({
  paragraphs,
  flags,
  focusedId,
  onClose,
}: {
  paragraphs: ParagraphModel[];
  flags: PreviewFlag[];
  focusedId: string | null;
  onClose: () => void;
}) {
  const total = paragraphs.length;
  const focused = flags.find((f) => f.id === focusedId) ?? null;
  const [win, setWin] = useState<PreviewWindow>(() => windowAround(total, focused?.paragraphIndex ?? 0));
  const paraRefs = useRef<Map<number, HTMLElement>>(new Map());
  const grouped = useMemo(() => flagsByParagraph(flags), [flags]);
  const [flashIndex, setFlashIndex] = useState<number | null>(null);

  useEffect(() => {
    const target = focused?.paragraphIndex;
    if (target == null) return;
    setWin((w) => ensureCovers(w, total, target));
    const t = setTimeout(() => {
      paraRefs.current.get(target)?.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashIndex(target);
    }, 30);
    const clear = setTimeout(() => setFlashIndex(null), 1800);
    return () => {
      clearTimeout(t);
      clearTimeout(clear);
    };
  }, [focused, total]);

  const visible = paragraphs.slice(win.start, win.end);

  return (
    <aside className="det-preview" aria-label="Aperçu du document">
      <div className="det-preview__head">
        <div>
          <h3>Aperçu du document</h3>
          {flags.length > 0 && (
            <p className="det-preview__head-hint">{flags.length} passage(s) repéré(s), soulignés en rouge</p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X size={15} /> Fermer
        </Button>
      </div>
      <div className="det-preview__body">
        {win.start > 0 && (
          <button type="button" className="det-preview__more" onClick={() => setWin((w) => expandStart(w, total))}>
            Charger les paragraphes précédents ({win.start} restants)
          </button>
        )}
        {win.truncated && (
          <p className="det-preview__notice">
            Aperçu limité aux paragraphes {win.start + 1}–{win.end} sur {total} pour rester fluide — utilisez « Voir
            dans le document » sur un point du rapport pour vous y rendre directement.
          </p>
        )}
        {visible.map((p) => {
          const paraFlags = grouped.get(p.index);
          return (
            <p
              key={p.index}
              ref={(el) => {
                if (el) paraRefs.current.set(p.index, el);
                else paraRefs.current.delete(p.index);
              }}
              className={[
                "det-preview__para",
                p.heading ? "is-heading" : "",
                p.listItem ? "is-list" : "",
                flashIndex === p.index ? "is-flash" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {renderParagraph(p.text, paraFlags)}
            </p>
          );
        })}
        {win.end < total && (
          <button type="button" className="det-preview__more" onClick={() => setWin((w) => expandEnd(w, total))}>
            Charger les paragraphes suivants ({total - win.end} restants)
          </button>
        )}
      </div>
    </aside>
  );
}

function renderParagraph(text: string, flags: PreviewFlag[] | undefined): ReactNode {
  if (!text) return " ";
  if (!flags || flags.length === 0) return text;
  const segments = segmentParagraph(text, flags);
  return segments.map((seg, i) =>
    seg.flagged ? (
      <span key={i} className="det-preview__flag" title={seg.labels?.join(" · ")}>
        {seg.text}
      </span>
    ) : (
      <span key={i}>{seg.text}</span>
    ),
  );
}
