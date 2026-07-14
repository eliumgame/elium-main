import { useState } from "react";
import { Modal, Button, Field } from "../ui/components";
import type { PageSettings } from "../format/types";

interface PageSettingsModalProps {
  page: PageSettings;
  onUpdate: (patch: Partial<PageSettings>) => void;
  onClose: () => void;
}

type MarginSide = "top" | "right" | "bottom" | "left";

const MIN_MARGIN_MM = 5;
const MAX_MARGIN_MM = 60;
const clampMargin = (v: number) => Math.min(MAX_MARGIN_MM, Math.max(MIN_MARGIN_MM, Math.round(v)));

const MARGIN_PRESETS: { label: string; margins: PageSettings["margins"] }[] = [
  { label: "Normales", margins: { top: 25, right: 20, bottom: 25, left: 20 } },
  { label: "Étroites", margins: { top: 12, right: 12, bottom: 12, left: 12 } },
  { label: "Larges", margins: { top: 35, right: 30, bottom: 35, left: 30 } },
];

/**
 * Page setup: format/orientation, margins, header & footer text (with
 * {titre}/{date} tokens), page numbers, and heading auto-numbering. Every
 * change is pushed straight into the document's page settings (persisted in
 * the .elium).
 */
export default function PageSettingsModal({ page, onUpdate, onClose }: PageSettingsModalProps) {
  // Convenience UI toggle only — the model always keeps 4 independent margins.
  const [symmetric, setSymmetric] = useState(
    () => page.margins.top === page.margins.bottom && page.margins.left === page.margins.right,
  );

  const applyMargin = (side: MarginSide, value: number) => {
    if (symmetric && (side === "top" || side === "bottom")) onUpdate({ margins: { ...page.margins, top: value, bottom: value } });
    else if (symmetric) onUpdate({ margins: { ...page.margins, left: value, right: value } });
    else onUpdate({ margins: { ...page.margins, [side]: value } });
  };

  const onMarginChange = (side: MarginSide) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const n = Number(e.target.value);
    if (!Number.isNaN(n)) applyMargin(side, n);
  };
  // Out-of-range values are only clamped once the user leaves the field, so
  // typing a two-digit number isn't fought digit by digit.
  const onMarginBlur = (side: MarginSide) => (e: React.FocusEvent<HTMLInputElement>) => {
    applyMargin(side, clampMargin(Number(e.target.value) || page.margins[side]));
  };

  const marginField = (side: MarginSide, label: string) => (
    <Field label={label}>
      <input
        type="number"
        className="settings__input settings__margin-input"
        min={MIN_MARGIN_MM}
        max={MAX_MARGIN_MM}
        value={page.margins[side]}
        onChange={onMarginChange(side)}
        onBlur={onMarginBlur(side)}
        aria-label={`Marge ${label.toLowerCase()} (mm)`}
      />
    </Field>
  );

  return (
    <Modal title="Mise en page" onClose={onClose} footer={<Button onClick={onClose}>Fermer</Button>}>
      <div className="settings">
        <section className="settings__section">
          <h3 className="settings__title">Format</h3>
          <div className="settings__row">
            <select
              className="settings__select"
              style={{ maxWidth: 160 }}
              value={page.format}
              onChange={(e) => onUpdate({ format: e.target.value as PageSettings["format"] })}
              aria-label="Format de page"
            >
              <option value="A4">A4</option>
              <option value="Letter">Letter (US)</option>
            </select>
            <select
              className="settings__select"
              style={{ maxWidth: 160 }}
              value={page.orientation}
              onChange={(e) => onUpdate({ orientation: e.target.value as PageSettings["orientation"] })}
              aria-label="Orientation"
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Paysage</option>
            </select>
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Marges (mm)</h3>
          <div className="settings__row">
            {MARGIN_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="settings__preset-btn"
                onClick={() => onUpdate({ margins: preset.margins })}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <label className="checkbox-row">
            <input type="checkbox" checked={symmetric} onChange={(e) => setSymmetric(e.target.checked)} />
            <span>Marges symétriques (haut = bas, gauche = droite)</span>
          </label>
          <div className="settings__margin-grid">
            {marginField("top", "Haut")}
            {marginField("right", "Droite")}
            {marginField("bottom", "Bas")}
            {marginField("left", "Gauche")}
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">En-tête et pied de page</h3>
          <Field label="En-tête" hint="Jetons disponibles : {titre}, {date}.">
            <input
              className="settings__input"
              value={page.header ?? ""}
              onChange={(e) => onUpdate({ header: e.target.value })}
              placeholder="ex. {titre} — confidentiel"
            />
          </Field>
          <Field label="Pied de page" hint="Jetons disponibles : {titre}, {date}.">
            <input
              className="settings__input"
              value={page.footer ?? ""}
              onChange={(e) => onUpdate({ footer: e.target.value })}
              placeholder="ex. {date}"
            />
          </Field>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={!!page.showPageNumbers}
              onChange={(e) => onUpdate({ showPageNumbers: e.target.checked })}
            />
            <span>Afficher les numéros de page (à l'impression / export PDF)</span>
          </label>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Structure</h3>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={!!page.numberedHeadings}
              onChange={(e) => onUpdate({ numberedHeadings: e.target.checked })}
            />
            <span>Numéroter automatiquement les titres (1. / 1.1 / 1.1.1)</span>
          </label>
        </section>
      </div>
    </Modal>
  );
}
