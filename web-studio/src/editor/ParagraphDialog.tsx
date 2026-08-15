import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button, Field } from "../ui/components";
import { LINE_HEIGHTS } from "./typography";
import type { BorderSide, ParagraphBorders } from "./paragraphFormat";

const SIDES: { side: BorderSide; label: string }[] = [
  { side: "top", label: "Haut" },
  { side: "right", label: "Droite" },
  { side: "bottom", label: "Bas" },
  { side: "left", label: "Gauche" },
];

/**
 * The Paragraphe dialog (Word's Paragraph dialog): alignment, indents, spacing,
 * pagination control, borders and shading for the current paragraph or heading.
 *
 * Applies immediately, like the rest of the ribbon.
 */
export default function ParagraphDialog({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [tick, setTick] = useState(0);
  const type = editor.isActive("heading") ? "heading" : "paragraph";
  const attrs = editor.getAttributes(type);
  const chain = () => editor.chain().focus();
  const run = (fn: () => void) => {
    fn();
    setTick((t) => t + 1);
  };

  const num = (v: unknown, fallback = 0) => {
    const n = parseFloat(String(v ?? ""));
    return Number.isFinite(n) ? n : fallback;
  };
  const borders = (attrs.borders ?? null) as ParagraphBorders | null;
  const setBorder = (patch: Partial<ParagraphBorders>) => {
    const next: ParagraphBorders = { ...(borders ?? {}), ...patch };
    const anySide = SIDES.some((s) => next[s.side]);
    run(() =>
      chain()
        .setParagraphBorders(anySide ? next : null)
        .run(),
    );
  };

  return (
    <Modal title="Paragraphe" onClose={onClose} wide footer={<Button onClick={onClose}>Fermer</Button>}>
      <div className="settings" data-tick={tick}>
        <section className="settings__section">
          <h3 className="settings__title">Alignement et interligne</h3>
          <div className="settings__row">
            <select
              className="settings__select"
              aria-label="Alignement"
              value={String(attrs.textAlign ?? "left")}
              onChange={(e) => run(() => chain().setTextAlign(e.target.value).run())}
            >
              <option value="left">Gauche</option>
              <option value="center">Centré</option>
              <option value="right">Droite</option>
              <option value="justify">Justifié</option>
            </select>
            <select
              className="settings__select"
              aria-label="Interligne"
              value={String(attrs.lineHeight ?? "")}
              onChange={(e) =>
                run(() =>
                  e.target.value ? chain().setLineHeight(e.target.value).run() : chain().unsetLineHeight().run(),
                )
              }
            >
              <option value="">Interligne par défaut</option>
              {LINE_HEIGHTS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Espacement (px)</h3>
          <div className="settings__margin-grid">
            <Field label="Avant">
              <input
                type="number"
                className="settings__input settings__margin-input"
                min={0}
                max={200}
                value={num(attrs.spaceBefore)}
                onChange={(e) =>
                  run(() =>
                    chain()
                      .setParagraphSpacing({ before: Number(e.target.value) || null })
                      .run(),
                  )
                }
              />
            </Field>
            <Field label="Après">
              <input
                type="number"
                className="settings__input settings__margin-input"
                min={0}
                max={200}
                value={num(attrs.spaceAfter)}
                onChange={(e) =>
                  run(() =>
                    chain()
                      .setParagraphSpacing({ after: Number(e.target.value) || null })
                      .run(),
                  )
                }
              />
            </Field>
            <Field label="1ʳᵉ ligne" hint="Négatif = retrait négatif.">
              <input
                type="number"
                className="settings__input settings__margin-input"
                min={-200}
                max={200}
                value={num(attrs.firstLineIndent)}
                onChange={(e) =>
                  run(() =>
                    chain()
                      .setFirstLineIndent(Number(e.target.value) || null)
                      .run(),
                  )
                }
              />
            </Field>
          </div>
          <div className="settings__row">
            <Button variant="outline" size="sm" onClick={() => run(() => chain().outdent().run())}>
              Diminuer le retrait
            </Button>
            <Button variant="outline" size="sm" onClick={() => run(() => chain().indent().run())}>
              Augmenter le retrait
            </Button>
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Enchaînements</h3>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={attrs.keepNext === true}
              onChange={() => run(() => chain().toggleKeepNext().run())}
            />
            <span>
              Paragraphes solidaires <span className="muted">— reste avec le paragraphe suivant</span>
            </span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={attrs.keepLines === true}
              onChange={() => run(() => chain().toggleKeepLines().run())}
            />
            <span>
              Lignes solidaires <span className="muted">— jamais coupé entre deux pages</span>
            </span>
          </label>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={attrs.pageBreakBefore === true}
              onChange={() => run(() => chain().togglePageBreakBefore().run())}
            />
            <span>Saut de page avant</span>
          </label>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Bordures et trame</h3>
          <div className="settings__row">
            {SIDES.map(({ side, label }) => (
              <label key={side} className="checkbox-row">
                <input
                  type="checkbox"
                  checked={borders?.[side] === true}
                  onChange={(e) => setBorder({ [side]: e.target.checked })}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <div className="settings__row">
            <Field label="Couleur de bordure">
              <input
                type="color"
                value={borders?.color ?? "#cbd5e1"}
                onChange={(e) => setBorder({ color: e.target.value })}
                aria-label="Couleur de bordure"
              />
            </Field>
            <Field label="Épaisseur (px)">
              <input
                type="number"
                className="settings__input settings__margin-input"
                min={1}
                max={8}
                value={borders?.width ?? 1}
                onChange={(e) => setBorder({ width: Number(e.target.value) || 1 })}
              />
            </Field>
            <Field label="Trame de fond">
              <input
                type="color"
                value={String(attrs.shading ?? "#f1f5f9")}
                onChange={(e) => run(() => chain().setParagraphShading(e.target.value).run())}
                aria-label="Trame de fond"
              />
            </Field>
            <Button variant="outline" size="sm" onClick={() => run(() => chain().setParagraphShading(null).run())}>
              Aucune trame
            </Button>
          </div>
        </section>
      </div>
      <p className="settings__hint modal-live">
        Les changements s'appliquent immédiatement à la sélection ; « Fermer » ne les annule pas.
      </p>
    </Modal>
  );
}
