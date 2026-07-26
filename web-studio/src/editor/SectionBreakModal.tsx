import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button, Field } from "../ui/components";
import { sectionBreakLabelFor, type SectionBreakKind } from "./sections";

const KINDS: SectionBreakKind[] = ["nextPage", "continuous", "evenPage", "oddPage"];

const HINTS: Record<SectionBreakKind, string> = {
  nextPage: "La nouvelle section commence en haut de la page suivante.",
  continuous: "La nouvelle section commence sur la même page (utile pour changer de mise en page sans saut).",
  evenPage: "La nouvelle section commence sur la prochaine page paire.",
  oddPage: "La nouvelle section commence sur la prochaine page impaire.",
};

/**
 * Insert a section break (Word's "Sauts → Sauts de section").
 *
 * The break declares the setup of the section it OPENS: orientation, its own
 * header/footer, and whether page numbering restarts.
 */
export default function SectionBreakModal({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const [kind, setKind] = useState<SectionBreakKind>("nextPage");
  const [orientation, setOrientation] = useState<"" | "portrait" | "landscape">("");
  const [restart, setRestart] = useState(false);
  const [startAt, setStartAt] = useState(1);
  const [header, setHeader] = useState("");
  const [footer, setFooter] = useState("");

  const insert = () => {
    editor
      .chain()
      .focus()
      .insertSectionBreak({
        kind,
        orientation,
        restartNumbering: restart,
        startAt: Math.max(1, Math.round(startAt) || 1),
        header,
        footer,
      })
      .run();
    onClose();
  };

  return (
    <Modal
      title="Saut de section"
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
          <h3 className="settings__title">Type de saut</h3>
          {KINDS.map((k) => (
            <label key={k} className="checkbox-row">
              <input type="radio" name="section-kind" checked={kind === k} onChange={() => setKind(k)} />
              <span>
                <b>{sectionBreakLabelFor(k).replace("Saut de section — ", "")}</b>
                <span className="muted"> — {HINTS[k]}</span>
              </span>
            </label>
          ))}
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Mise en page de la nouvelle section</h3>
          <Field label="Orientation" hint="« Comme le document » conserve le réglage global.">
            <select
              className="settings__select"
              value={orientation}
              onChange={(e) => setOrientation(e.target.value as "" | "portrait" | "landscape")}
            >
              <option value="">Comme le document</option>
              <option value="portrait">Portrait</option>
              <option value="landscape">Paysage</option>
            </select>
          </Field>
          <Field label="En-tête de section (facultatif)" hint="Jetons : {titre}, {date}.">
            <input className="settings__input" value={header} onChange={(e) => setHeader(e.target.value)} placeholder="Vide = celui du document" />
          </Field>
          <Field label="Pied de section (facultatif)">
            <input className="settings__input" value={footer} onChange={(e) => setFooter(e.target.value)} placeholder="Vide = celui du document" />
          </Field>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Numérotation des pages</h3>
          <label className="checkbox-row">
            <input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} />
            <span>Recommencer la numérotation à</span>
          </label>
          <Field label="Premier numéro">
            <input
              type="number"
              className="settings__input settings__margin-input"
              min={1}
              value={startAt}
              onChange={(e) => setStartAt(Number(e.target.value))}
              disabled={!restart}
            />
          </Field>
        </section>
      </div>
    </Modal>
  );
}
