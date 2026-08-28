/**
 * Panneau latéral : relit le `DocumentModel` en texte simple et surligne
 * l'emplacement exact d'un `Finding` (le paragraphe entier, et en plus la
 * sous-chaîne précise quand `finding.evidence` se retrouve littéralement dans
 * le texte du paragraphe). Fenêtré (voir `previewWindow.ts`) pour rester
 * fluide sur un document de plusieurs centaines de pages.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button } from "../../ui/components";
import type { Finding, ParagraphModel } from "../types";
import { ensureCovers, windowAround, expandStart, expandEnd, type PreviewWindow } from "./previewWindow";
import "./DocumentPreview.css";

export default function DocumentPreview({
  paragraphs,
  focused,
  onClose,
}: {
  paragraphs: ParagraphModel[];
  focused: Finding | null;
  onClose: () => void;
}) {
  const total = paragraphs.length;
  const [win, setWin] = useState<PreviewWindow>(() =>
    windowAround(total, focused?.location.paragraphIndex ?? 0),
  );
  const paraRefs = useRef<Map<number, HTMLElement>>(new Map());
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const target = focused?.location.paragraphIndex;
    if (target == null) return;
    setWin((w) => ensureCovers(w, total, target));
    // Le nœud cible n'existe pas forcément encore dans le DOM tant que la
    // fenêtre n'a pas été étendue et re-rendue — un micro-délai suffit ici,
    // le scroll n'a pas besoin d'être synchrone avec le clic.
    const t = setTimeout(() => {
      paraRefs.current.get(target)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 30);
    return () => clearTimeout(t);
  }, [focused, total]);

  const focusedIndex = focused?.location.paragraphIndex;
  const visible = paragraphs.slice(win.start, win.end);

  return (
    <aside className="det-preview" aria-label="Aperçu du document">
      <div className="det-preview__head">
        <h3>Aperçu du document</h3>
        <Button variant="ghost" size="sm" onClick={onClose}>
          <X size={15} /> Fermer
        </Button>
      </div>
      <div className="det-preview__body" ref={bodyRef}>
        {win.start > 0 && (
          <button
            type="button"
            className="det-preview__more"
            onClick={() => setWin((w) => expandStart(w, total))}
          >
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
          const isFocused = p.index === focusedIndex;
          return (
            <p
              key={p.index}
              ref={(el) => {
                if (el) paraRefs.current.set(p.index, el);
                else paraRefs.current.delete(p.index);
              }}
              className={[
                "det-preview__para",
                isFocused ? "is-focused" : "",
                p.heading ? "is-heading" : "",
                p.listItem ? "is-list" : "",
              ]
                .filter(Boolean)
                .join(" ")}
            >
              {renderWithEvidence(p.text, isFocused ? focused?.evidence : undefined)}
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

function renderWithEvidence(text: string, evidence: string | undefined): ReactNode {
  if (!text) return " ";
  if (!evidence) return text;
  const idx = text.indexOf(evidence);
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="det-preview__mark">{text.slice(idx, idx + evidence.length)}</mark>
      {text.slice(idx + evidence.length)}
    </>
  );
}
