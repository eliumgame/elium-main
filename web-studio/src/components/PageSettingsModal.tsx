import { useState } from "react";
import { Modal, Button, Field } from "../ui/components";
import type { PageSettings } from "../format/types";
import { DEFAULT_BORDER, DEFAULT_LINE_NUMBERING, normalizeBackground, type PageBorder } from "../editor/pageDecor";
import {
  DEFAULT_CUSTOM_MM,
  MAX_PAGE_MM,
  MIN_PAGE_MM,
  PAGE_FORMATS,
  PAGE_FORMAT_LABELS,
  pageSizeOf,
} from "../format/pageSizes";

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
const clampPageMm = (v: number) =>
  Number.isFinite(v) ? Math.min(MAX_PAGE_MM, Math.max(MIN_PAGE_MM, Math.round(v))) : DEFAULT_CUSTOM_MM.width;

export default function PageSettingsModal({ page, onUpdate, onClose }: PageSettingsModalProps) {
  const size = pageSizeOf(page);
  // Convenience UI toggle only — the model always keeps 4 independent margins.
  const [symmetric, setSymmetric] = useState(
    () => page.margins.top === page.margins.bottom && page.margins.left === page.margins.right,
  );

  const applyMargin = (side: MarginSide, value: number) => {
    if (symmetric && (side === "top" || side === "bottom"))
      onUpdate({ margins: { ...page.margins, top: value, bottom: value } });
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
              style={{ maxWidth: 220 }}
              value={page.format}
              onChange={(e) => onUpdate({ format: e.target.value as PageSettings["format"] })}
              aria-label="Format de page"
            >
              {PAGE_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {PAGE_FORMAT_LABELS[f]}
                </option>
              ))}
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

          {page.format === "Custom" && (
            <div className="settings__margin-grid">
              <Field label="Largeur (mm)">
                <input
                  type="number"
                  className="settings__input settings__margin-input"
                  min={MIN_PAGE_MM}
                  max={MAX_PAGE_MM}
                  value={page.customWidthMm ?? DEFAULT_CUSTOM_MM.width}
                  onChange={(e) => onUpdate({ customWidthMm: Number(e.target.value) })}
                  onBlur={(e) => onUpdate({ customWidthMm: clampPageMm(Number(e.target.value)) })}
                />
              </Field>
              <Field label="Hauteur (mm)">
                <input
                  type="number"
                  className="settings__input settings__margin-input"
                  min={MIN_PAGE_MM}
                  max={MAX_PAGE_MM}
                  value={page.customHeightMm ?? DEFAULT_CUSTOM_MM.height}
                  onChange={(e) => onUpdate({ customHeightMm: Number(e.target.value) })}
                  onBlur={(e) => onUpdate({ customHeightMm: clampPageMm(Number(e.target.value)) })}
                />
              </Field>
            </div>
          )}

          <p className="muted">
            Feuille actuelle :{" "}
            <b>
              {size.width} × {size.height} mm
            </b>
            {page.orientation === "landscape" ? " (paysage)" : ""}
          </p>
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
          <h3 className="settings__title">Apparence de la page</h3>
          <Field label="Couleur de fond">
            <div className="checkbox-row">
              <input
                type="color"
                aria-label="Couleur de fond de la page"
                value={normalizeBackground(page.background) ?? "#ffffff"}
                onChange={(e) => onUpdate({ background: e.target.value })}
              />
              <Button variant="ghost" onClick={() => onUpdate({ background: undefined })} disabled={!page.background}>
                Aucune
              </Button>
            </div>
          </Field>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={!!page.pageBorder}
              onChange={(e) => onUpdate({ pageBorder: e.target.checked ? { ...DEFAULT_BORDER } : undefined })}
            />
            <span>Bordure de page</span>
          </label>
          {page.pageBorder && (
            <div className="settings__grid">
              <Field label="Style">
                <select
                  className="settings__input"
                  value={page.pageBorder.style}
                  onChange={(e) => onUpdate({ pageBorder: { ...page.pageBorder!, style: e.target.value as PageBorder["style"] } })}
                >
                  <option value="solid">Trait plein</option>
                  <option value="double">Double</option>
                  <option value="dashed">Tirets</option>
                  <option value="dotted">Pointillés</option>
                </select>
              </Field>
              <Field label="Épaisseur (pt)">
                <input
                  className="settings__input"
                  type="number"
                  min={0.25}
                  max={12}
                  step={0.25}
                  value={page.pageBorder.widthPt}
                  onChange={(e) => onUpdate({ pageBorder: { ...page.pageBorder!, widthPt: Number(e.target.value) || 1 } })}
                />
              </Field>
              <Field label="Couleur">
                <input
                  type="color"
                  aria-label="Couleur de la bordure"
                  value={page.pageBorder.color}
                  onChange={(e) => onUpdate({ pageBorder: { ...page.pageBorder!, color: e.target.value } })}
                />
              </Field>
              <Field label="Distance du bord (mm)">
                <input
                  className="settings__input"
                  type="number"
                  min={2}
                  max={30}
                  value={page.pageBorder.offsetMm}
                  onChange={(e) => onUpdate({ pageBorder: { ...page.pageBorder!, offsetMm: Number(e.target.value) || 10 } })}
                />
              </Field>
            </div>
          )}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={!!page.lineNumbers}
              onChange={(e) => onUpdate({ lineNumbers: e.target.checked ? { ...DEFAULT_LINE_NUMBERING } : undefined })}
            />
            <span>Numéroter les lignes</span>
          </label>
          {page.lineNumbers && (
            <div className="settings__grid">
              <Field label="Numérotation">
                <select
                  className="settings__input"
                  value={page.lineNumbers.mode}
                  onChange={(e) => onUpdate({ lineNumbers: { ...page.lineNumbers!, mode: e.target.value as "continuous" | "page" } })}
                >
                  <option value="continuous">Continue</option>
                  <option value="page">Redémarrer à chaque page</option>
                </select>
              </Field>
              <Field label="Afficher un numéro toutes les">
                <input
                  className="settings__input"
                  type="number"
                  min={1}
                  max={100}
                  value={page.lineNumbers.step}
                  onChange={(e) => onUpdate({ lineNumbers: { ...page.lineNumbers!, step: Math.max(1, Math.round(Number(e.target.value) || 1)) } })}
                />
              </Field>
            </div>
          )}
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
