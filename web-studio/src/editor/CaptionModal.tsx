import { useMemo, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button, Field } from "../ui/components";
import { CAPTION_LABELS, captionLabels, captionPrefix, collectCaptions } from "./captions";

/**
 * Insert a caption (Word's "Insérer une légende").
 *
 * The number is NOT asked for: it is derived from document order, so inserting a
 * figure earlier renumbers everything after it on its own. The dialog only needs
 * the label, the text and whether the caption goes above or below.
 */
export default function CaptionModal({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const entries = useMemo(() => collectCaptions(editor.state.doc), [editor]);
  const used = captionLabels(entries);
  const labels = [...new Set([...CAPTION_LABELS, ...used])];

  // Default to the label that fits what the cursor is on.
  const guessed = editor.isActive("table") ? "Tableau" : "Figure";
  const [label, setLabel] = useState<string>(guessed);
  const [custom, setCustom] = useState("");
  const [text, setText] = useState("");
  const [position, setPosition] = useState<"above" | "below">("below");

  const effectiveLabel = (label === "__custom" ? custom : label).trim() || "Figure";
  const nextNumber = entries.filter((e) => e.label === effectiveLabel).length + 1;

  const insert = () => {
    editor.chain().focus().insertCaption({ label: effectiveLabel, text: text.trim(), position }).run();
    onClose();
  };

  return (
    <Modal
      title="Insérer une légende"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button onClick={insert}>Insérer</Button>
        </>
      }
    >
      <div className="settings">
        <section className="settings__section">
          <Field label="Étiquette">
            <select className="settings__select" value={label} onChange={(e) => setLabel(e.target.value)}>
              {labels.map((l) => (
                <option key={l} value={l}>{l}</option>
              ))}
              <option value="__custom">Autre étiquette…</option>
            </select>
          </Field>
          {label === "__custom" && (
            <Field label="Nom de l'étiquette">
              <input
                className="settings__input"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="ex. Schéma"
                autoFocus
              />
            </Field>
          )}
          <Field label="Texte de la légende">
            <input
              className="settings__input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="ex. Répartition des signatures par mois"
            />
          </Field>
          <Field label="Position">
            <select
              className="settings__select"
              value={position}
              onChange={(e) => setPosition(e.target.value as "above" | "below")}
            >
              <option value="below">Sous l'élément sélectionné</option>
              <option value="above">Au-dessus de l'élément sélectionné</option>
            </select>
          </Field>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Aperçu</h3>
          <p className="xref-preview">
            {captionPrefix(effectiveLabel, nextNumber)}
            {text.trim() || "…"}
          </p>
          <p className="muted">
            Le numéro est calculé à partir de l'ordre du document : insérer une légende plus haut renumérote
            automatiquement les suivantes.
          </p>
        </section>
      </div>
    </Modal>
  );
}
