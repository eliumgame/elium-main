import { useEffect, useState } from "react";
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Italic, Strikethrough, Underline } from "lucide-react";
import type { ContentEdit } from "../model/types";
import type { StylePatch, StyleSummary } from "./richtext";

/**
 * « Format » — the right-hand panel shown while a paragraph is being edited, as Acrobat does
 * (the text itself stays on the page, with no floating window). It acts on the selection, or on
 * what is typed next when only the caret is placed. A value shown as « — » differs inside the
 * selection.
 */

export interface TextFormatPanelProps {
  summary: StyleSummary;
  align: ContentEdit["align"];
  /** Line spacing as a multiple of the font size. */
  lineSpacing: number;
  families: string[];
  canRevert: boolean;
  onPatch: (patch: StylePatch) => void;
  onAlign: (align: ContentEdit["align"]) => void;
  onLineSpacing: (multiple: number) => void;
  onDelete: () => void;
  onRevert: () => void;
}

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72, 96];

const ALIGNS = [
  ["left", AlignLeft, "Aligner à gauche"],
  ["center", AlignCenter, "Centrer"],
  ["right", AlignRight, "Aligner à droite"],
  ["justify", AlignJustify, "Justifier"],
] as const;

export default function TextFormatPanel(p: TextFormatPanelProps) {
  const s = p.summary;
  // The size box is typed in: kept as text until it is validated (Enter, leaving it, or a spinner step).
  const [size, setSize] = useState(s.fontSize === undefined ? "" : String(s.fontSize));
  useEffect(() => setSize(s.fontSize === undefined ? "" : String(Math.round(s.fontSize * 10) / 10)), [s.fontSize]);
  const applySize = (text: string) => {
    const n = Number(text.replace(",", "."));
    if (Number.isFinite(n) && n >= 4 && n <= 400 && n !== s.fontSize)
      p.onPatch({ fontSize: Math.round(n * 100) / 100 });
  };

  const toggle = (key: "bold" | "italic" | "underline" | "strike", label: string, icon: React.ReactNode) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={!!s[key]}
      className={`pdfx-fmt__btn ${s[key] ? "is-on" : ""} ${s[key] === undefined ? "is-mixed" : ""}`}
      onClick={() => p.onPatch({ [key]: !s[key] })}
    >
      {icon}
    </button>
  );

  return (
    <aside
      className="pdfx-inspector pdfx-fmt"
      aria-label="Format du texte"
      tabIndex={-1}
      // Clicking blank space in the panel must not take the keyboard from the text being edited.
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLElement) || !/^(INPUT|SELECT|OPTION|TEXTAREA)$/.test(e.target.tagName))
          e.preventDefault();
      }}
    >
      <header className="pdfx-inspector__head">
        <span className="pdfx-inspector__title">Format du texte</span>
      </header>
      <div className="pdfx-inspector__body">
        <section className="pdfx-insp-group">
          <h4>Police</h4>
          <label className="pdfx-insp-row">
            <span>Police</span>
            <select
              aria-label="Police"
              value={s.fontFamily ?? ""}
              onChange={(e) => e.target.value && p.onPatch({ fontFamily: e.target.value })}
            >
              {s.fontFamily === undefined && <option value="">—</option>}
              {s.fontFamily !== undefined && !p.families.includes(s.fontFamily) && (
                <option value={s.fontFamily}>{s.fontFamily || "Police du document"}</option>
              )}
              {p.families.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className="pdfx-insp-row">
            <span>Taille</span>
            <input
              aria-label="Taille"
              type="number"
              min={4}
              max={400}
              step={0.5}
              list="pdfx-fmt-sizes"
              value={size}
              placeholder="—"
              onChange={(e) => {
                setSize(e.target.value);
                // A spinner step or a pick from the list: apply at once; typing waits for Enter / leaving.
                const inputType = (e.nativeEvent as InputEvent).inputType;
                if (!inputType || inputType === "insertReplacementText") applySize(e.target.value);
              }}
              onBlur={(e) => applySize(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applySize((e.target as HTMLInputElement).value);
                }
              }}
            />
            <datalist id="pdfx-fmt-sizes">
              {SIZES.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </label>
          <div className="pdfx-insp-row">
            <span>Style</span>
            <span className="pdfx-fmt__group" role="group" aria-label="Style du texte">
              {toggle("bold", "Gras", <Bold size={14} />)}
              {toggle("italic", "Italique", <Italic size={14} />)}
              {toggle("underline", "Souligné", <Underline size={14} />)}
              {toggle("strike", "Barré", <Strikethrough size={14} />)}
            </span>
          </div>
          <label className="pdfx-insp-row">
            <span>Couleur</span>
            <input
              aria-label="Couleur du texte"
              type="color"
              value={s.color ?? "#000000"}
              title={s.color === undefined ? "Couleurs différentes dans la sélection" : undefined}
              onChange={(e) => p.onPatch({ color: e.target.value })}
            />
          </label>
        </section>

        <section className="pdfx-insp-group">
          <h4>Paragraphe</h4>
          <div className="pdfx-insp-row">
            <span>Alignement</span>
            <span className="pdfx-fmt__group" role="group" aria-label="Alignement">
              {ALIGNS.map(([a, Icon, label]) => (
                <button
                  key={a}
                  type="button"
                  aria-label={label}
                  title={label}
                  aria-pressed={p.align === a}
                  className={`pdfx-fmt__btn ${p.align === a ? "is-on" : ""}`}
                  onClick={() => p.onAlign(a)}
                >
                  <Icon size={14} />
                </button>
              ))}
            </span>
          </div>
          <label className="pdfx-insp-row">
            <span>Interligne</span>
            <input
              aria-label="Interligne"
              type="number"
              min={0.8}
              max={4}
              step={0.05}
              value={Math.round(p.lineSpacing * 100) / 100}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n) && n >= 0.8 && n <= 4) p.onLineSpacing(n);
              }}
            />
          </label>
        </section>

        <section className="pdfx-insp-group pdfx-insp-actions">
          <button type="button" className="pdfx-mini" onClick={p.onRevert} disabled={!p.canRevert}>
            Rétablir l'original
          </button>
          <button type="button" className="pdfx-mini" onClick={p.onDelete}>
            Supprimer le texte
          </button>
        </section>
      </div>
    </aside>
  );
}
