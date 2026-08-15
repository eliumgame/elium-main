import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button, Field } from "../ui/components";
import { sectionBreakLabelFor, type SectionBreakKind } from "./sections";
import { PAGE_FORMATS, PAGE_FORMAT_LABELS } from "../format/pageSizes";
import type { PageFormat } from "../format/types";

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
  const [format, setFormat] = useState<PageFormat | "">("");
  const [orientation, setOrientation] = useState<"" | "portrait" | "landscape">("");
  const [ownMargins, setOwnMargins] = useState(false);
  const [margins, setMargins] = useState({ top: 25, right: 20, bottom: 25, left: 20 });
  const [restart, setRestart] = useState(false);
  const [startAt, setStartAt] = useState(1);
  const [header, setHeader] = useState("");
  const [footer, setFooter] = useState("");

  const insert = () => {
    const clamp = (v: number) => Math.min(60, Math.max(5, Math.round(v) || 20));
    editor
      .chain()
      .focus()
      .insertSectionBreak({
        kind,
        format,
        orientation,
        // Only sent when the user opted in — otherwise the section inherits.
        ...(ownMargins
          ? {
              margins: {
                top: clamp(margins.top),
                right: clamp(margins.right),
                bottom: clamp(margins.bottom),
                left: clamp(margins.left),
              },
            }
          : {}),
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
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
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
          <Field label="Format" hint="Chaque section peut avoir son propre format de feuille.">
            <select
              className="settings__select"
              value={format}
              onChange={(e) => setFormat(e.target.value as PageFormat | "")}
            >
              <option value="">Comme le document</option>
              {PAGE_FORMATS.filter((f) => f !== "Custom").map((f) => (
                <option key={f} value={f}>
                  {PAGE_FORMAT_LABELS[f]}
                </option>
              ))}
            </select>
          </Field>
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

          <label className="checkbox-row">
            <input type="checkbox" checked={ownMargins} onChange={(e) => setOwnMargins(e.target.checked)} />
            <span>Marges propres à cette section (mm)</span>
          </label>
          {ownMargins && (
            <div className="settings__margin-grid">
              {(["top", "right", "bottom", "left"] as const).map((side) => (
                <Field key={side} label={{ top: "Haut", right: "Droite", bottom: "Bas", left: "Gauche" }[side]}>
                  <input
                    type="number"
                    className="settings__input settings__margin-input"
                    min={5}
                    max={60}
                    value={margins[side]}
                    onChange={(e) => setMargins((m) => ({ ...m, [side]: Number(e.target.value) }))}
                  />
                </Field>
              ))}
            </div>
          )}
          <Field label="En-tête de section (facultatif)" hint="Jetons : {titre}, {date}.">
            <input
              className="settings__input"
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              placeholder="Vide = celui du document"
            />
          </Field>
          <Field label="Pied de section (facultatif)">
            <input
              className="settings__input"
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="Vide = celui du document"
            />
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
