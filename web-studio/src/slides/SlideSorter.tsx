/**
 * Trieuse de diapositives : grille de miniatures avec glisser-déposer, sections
 * repliables (renommer / supprimer / déplacer), masquage, duplication et
 * suppression. Toute la logique de réordonnancement est dans sections.ts (pur) ;
 * ce composant ne fait que piloter le DeckStore (local ou collaboratif).
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, Copy, Eye, EyeOff, FolderPlus, Trash2, X } from "lucide-react";
import "./sorter.css";
import SlideCanvas from "./canvas";
import { elementsOf, REF_H, type SlideTheme } from "./model";
import {
  addSectionAt,
  hiddenCount,
  moveSection,
  removeSection,
  renameSection,
  sectionRanges,
  toggleSectionCollapsed,
} from "./sections";
import type { DeckStore } from "./store";

const THUMB_W = 200;

export default function SlideSorter({
  store,
  theme,
  onClose,
}: {
  store: DeckStore;
  theme: SlideTheme;
  onClose: () => void;
}) {
  const { deck, canWrite } = store;
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragSection, setDragSection] = useState<string | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);
  const ranges = sectionRanges(deck.slides, deck.sections);
  const hidden = hiddenCount(deck.slides);

  const setSections = (sections: ReturnType<typeof addSectionAt>) => store.setDeckField({ sections });

  const dropOn = (to: number) => {
    if (dragFrom === null) return;
    // Déposer sur une miniature la place AVANT elle (index final tenant compte du retrait de la source).
    const final = dragFrom < to ? to - 1 : to;
    if (final !== dragFrom) store.reorderSlide(dragFrom, Math.max(0, final));
    setDragFrom(null);
    setOverIdx(null);
  };
  const dropAtEnd = () => {
    if (dragFrom === null) return;
    store.reorderSlide(dragFrom, deck.slides.length - 1);
    setDragFrom(null);
    setOverIdx(null);
  };
  const dropSectionBefore = (beforeId: string | null) => {
    if (!dragSection || dragSection === beforeId) return setDragSection(null);
    const next = moveSection(deck.slides, deck.sections, dragSection, beforeId);
    store.setSlideOrder(next.map((s) => s.id));
    setDragSection(null);
  };

  return (
    <div className="sorter" role="dialog" aria-label="Trieuse de diapositives">
      <div className="sorter__bar">
        <strong>Trieuse de diapositives</strong>
        <span className="sorter__count">
          {deck.slides.length} diapositive{deck.slides.length > 1 ? "s" : ""}
          {hidden ? ` · ${hidden} masquée${hidden > 1 ? "s" : ""}` : ""}
        </span>
        <span className="sorter__hint">Glissez une miniature (ou un titre de section) pour la déplacer.</span>
        <button className="icon-btn" onClick={onClose} title="Fermer la trieuse" aria-label="Fermer la trieuse">
          <X size={16} />
        </button>
      </div>
      <div className="sorter__body">
        {ranges.map((range, ri) => {
          const sec = range.section;
          return (
            <section key={sec?.id ?? `none-${ri}`} className="sorter__section">
              {sec ? (
                <header
                  className="sorter__sechead"
                  draggable={canWrite}
                  onDragStart={() => setDragSection(sec.id)}
                  onDragOver={(e) => dragSection && e.preventDefault()}
                  onDrop={() => dropSectionBefore(sec.id)}
                >
                  <button
                    className="icon-btn"
                    title={sec.collapsed ? "Développer la section" : "Réduire la section"}
                    aria-label={sec.collapsed ? "Développer la section" : "Réduire la section"}
                    onClick={() => store.setDeckField({ sections: toggleSectionCollapsed(deck.sections, sec.id) })}
                  >
                    {sec.collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
                  </button>
                  <input
                    className="sorter__secname"
                    defaultValue={sec.name}
                    disabled={!canWrite}
                    aria-label="Nom de la section"
                    onBlur={(e) => {
                      if (e.target.value !== sec.name)
                        store.setDeckField({ sections: renameSection(deck.sections, sec.id, e.target.value) });
                    }}
                  />
                  <span className="sorter__seccount">{range.to - range.from + 1}</span>
                  {canWrite && (
                    <button
                      className="icon-btn icon-btn--danger"
                      title="Supprimer la section (les diapositives sont conservées)"
                      aria-label="Supprimer la section"
                      onClick={() => store.setDeckField({ sections: removeSection(deck.sections, sec.id) })}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </header>
              ) : (
                ranges.length > 1 && <header className="sorter__sechead sorter__sechead--none">Sans section</header>
              )}
              {!sec?.collapsed && (
                <div className="sorter__grid">
                  {deck.slides.slice(range.from, range.to + 1).map((s, k) => {
                    const i = range.from + k;
                    return (
                      <div
                        key={s.id}
                        className={`sorter__item ${i === store.active ? "is-active" : ""} ${s.hidden ? "is-hidden" : ""} ${
                          overIdx === i && dragFrom !== null ? "is-drop" : ""
                        }`}
                        draggable={canWrite}
                        onDragStart={() => setDragFrom(i)}
                        onDragEnd={() => {
                          setDragFrom(null);
                          setOverIdx(null);
                        }}
                        onDragOver={(e) => {
                          if (dragFrom !== null) {
                            e.preventDefault();
                            setOverIdx(i);
                          }
                        }}
                        onDrop={() => dropOn(i)}
                      >
                        <button
                          className="sorter__thumb"
                          onClick={() => store.setActive(i)}
                          onDoubleClick={() => {
                            store.setActive(i);
                            onClose();
                          }}
                          aria-label={`Diapositive ${i + 1}${s.hidden ? " (masquée)" : ""}`}
                        >
                          <span className="slide-thumb__num">{i + 1}</span>
                          {s.hidden && <span className="sorter__badge">Masquée</span>}
                          <SlideCanvas
                            slide={s}
                            elements={s.elements ?? elementsOf(s)}
                            theme={theme}
                            scale={THUMB_W / (REF_H * (16 / 9))}
                          />
                        </button>
                        {canWrite && (
                          <div className="sorter__actions">
                            <button
                              className="icon-btn"
                              title={s.hidden ? "Afficher la diapositive" : "Masquer la diapositive"}
                              aria-label={s.hidden ? "Afficher la diapositive" : "Masquer la diapositive"}
                              onClick={() => store.patchSlideAt(i, { hidden: !s.hidden })}
                            >
                              {s.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                            <button
                              className="icon-btn"
                              title="Commencer une section ici"
                              aria-label="Commencer une section ici"
                              onClick={() => setSections(addSectionAt(deck.slides, deck.sections, i, "Nouvelle section"))}
                            >
                              <FolderPlus size={14} />
                            </button>
                            <button className="icon-btn" title="Dupliquer" aria-label="Dupliquer" onClick={() => store.duplicateSlide(i)}>
                              <Copy size={14} />
                            </button>
                            <button
                              className="icon-btn icon-btn--danger"
                              title="Supprimer"
                              aria-label="Supprimer"
                              disabled={deck.slides.length <= 1}
                              onClick={() => store.removeSlide(i)}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {ri === ranges.length - 1 && (
                    <div
                      className={`sorter__end ${overIdx === deck.slides.length ? "is-drop" : ""}`}
                      onDragOver={(e) => {
                        if (dragFrom !== null) {
                          e.preventDefault();
                          setOverIdx(deck.slides.length);
                        }
                      }}
                      onDrop={dropAtEnd}
                    >
                      Déposer ici pour placer à la fin
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
        {dragSection && (
          <div className="sorter__end" onDragOver={(e) => e.preventDefault()} onDrop={() => dropSectionBefore(null)}>
            Déposer ici pour placer la section à la fin
          </div>
        )}
      </div>
    </div>
  );
}
