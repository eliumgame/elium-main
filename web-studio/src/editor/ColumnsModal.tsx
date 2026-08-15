import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button, Field } from "../ui/components";
import { MAX_COLUMNS, MIN_COLUMNS, clampColumns } from "./wordExtensions";

const MIN_GAP_MM = 2;
const MAX_GAP_MM = 40;

/**
 * Column layout for the selected blocks (Word's "Colonnes → Autres colonnes").
 * Applies to a real `columnSection` node, so the content genuinely flows across
 * the columns on screen, in print and in DOCX.
 */
export default function ColumnsModal({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const active = editor.isActive("columnSection");
  const current = editor.getAttributes("columnSection");
  const [count, setCount] = useState<number>(active ? clampColumns(Number(current.count)) : 2);
  const [gapMm, setGapMm] = useState<number>(active ? Number(current.gapMm) || 8 : 8);
  const [separator, setSeparator] = useState<boolean>(active ? current.separator === true : false);

  const apply = () => {
    const gap = Math.min(MAX_GAP_MM, Math.max(MIN_GAP_MM, Math.round(gapMm) || 8));
    if (count <= 1) {
      if (active) editor.chain().focus().unsetColumns().run();
      onClose();
      return;
    }
    if (active) editor.chain().focus().updateColumns({ count, gapMm: gap, separator }).run();
    else editor.chain().focus().setColumns({ count, gapMm: gap, separator }).run();
    onClose();
  };

  return (
    <Modal
      title="Colonnes"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          {active && (
            <Button
              variant="outline"
              onClick={() => {
                editor.chain().focus().unsetColumns().run();
                onClose();
              }}
            >
              Une seule colonne
            </Button>
          )}
          <Button onClick={apply}>Appliquer</Button>
        </>
      }
    >
      <div className="settings">
        <section className="settings__section">
          <h3 className="settings__title">Nombre de colonnes</h3>
          <div className="settings__row">
            {Array.from({ length: MAX_COLUMNS - MIN_COLUMNS + 1 }, (_, i) => MIN_COLUMNS + i).map((n) => (
              <button
                key={n}
                type="button"
                className={`col-preset ${count === n ? "is-active" : ""}`}
                onClick={() => setCount(n)}
                aria-pressed={count === n}
                title={n === 1 ? "Une colonne (retour au texte pleine largeur)" : `${n} colonnes`}
              >
                <span className="col-preset__vis" aria-hidden="true">
                  {Array.from({ length: n }, (_, k) => (
                    <i key={k} />
                  ))}
                </span>
                <span className="col-preset__label">{n === 1 ? "Une" : n}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="settings__section">
          <Field label="Espacement entre colonnes (mm)">
            <input
              type="number"
              className="settings__input settings__margin-input"
              min={MIN_GAP_MM}
              max={MAX_GAP_MM}
              value={gapMm}
              onChange={(e) => setGapMm(Number(e.target.value))}
              disabled={count <= 1}
            />
          </Field>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={separator}
              onChange={(e) => setSeparator(e.target.checked)}
              disabled={count <= 1}
            />
            <span>Ligne séparatrice entre les colonnes</span>
          </label>
        </section>

        <section className="settings__section">
          <p className="muted">
            {active
              ? "Les colonnes s'appliquent au bloc en cours."
              : "Les colonnes s'appliquent aux paragraphes sélectionnés (ou au paragraphe courant)."}
          </p>
        </section>
      </div>
    </Modal>
  );
}
