/**
 * Le dialogue de filigrane, avec aperçu.
 *
 * L'aperçu est le même rendu que la feuille (`watermarkCss`), à échelle réduite :
 * un aperçu approximatif serait pire que pas d'aperçu du tout, puisque le réglage
 * de l'opacité et de l'angle se juge à l'œil.
 */
import { useMemo, useState } from "react";
import { Modal, Button } from "../ui/components";
import {
  DEFAULT_WATERMARK, WATERMARK_PRESETS, normalizeWatermark, watermarkCss, type Watermark,
} from "./ornaments";

export default function WatermarkModal({
  value,
  pageWidthMm,
  pageHeightMm,
  onApply,
  onClose,
}: {
  value?: Watermark | null;
  pageWidthMm: number;
  pageHeightMm: number;
  onApply: (mark: Watermark) => void;
  onClose: () => void;
}) {
  const [mark, setMark] = useState<Watermark>(() => normalizeWatermark(value ?? DEFAULT_WATERMARK));
  const patch = (p: Partial<Watermark>) => setMark((m) => normalizeWatermark({ ...m, ...p }));

  const preview = useMemo(
    () => watermarkCss({ ...mark, kind: "text" }, pageWidthMm, pageHeightMm),
    [mark, pageHeightMm, pageWidthMm],
  );

  return (
    <Modal
      title="Filigrane"
      onClose={onClose}
      footer={
        <>
          {/* Ce dialogue n'applique QUE sur son bouton d'action : il doit donc
              offrir « Annuler ». C'était le seul de sa famille à n'avoir aucun
              moyen visible de renoncer — Échap marchait, sans que rien ne le dise. */}
          <Button variant="ghost" onClick={onClose}>Annuler</Button>
          <Button variant="outline" onClick={() => { onApply(normalizeWatermark({ ...mark, kind: "none" })); onClose(); }}>
            Aucun filigrane
          </Button>
          <Button onClick={() => { onApply(normalizeWatermark({ ...mark, kind: "text" })); onClose(); }}>
            Appliquer
          </Button>
        </>
      }
    >
      <div className="settings__row">
        <label className="settings__label" htmlFor="wm-text">Texte</label>
        <input
          id="wm-text"
          className="settings__input"
          value={mark.text}
          onChange={(e) => patch({ text: e.target.value })}
          placeholder="BROUILLON"
        />
      </div>

      <div className="wmdlg__presets">
        {WATERMARK_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            className={`wmdlg__preset${mark.text === p ? " is-active" : ""}`}
            onClick={() => patch({ text: p })}
          >
            {p}
          </button>
        ))}
      </div>

      <div className="settings__row">
        <label className="settings__label" htmlFor="wm-angle">Inclinaison</label>
        <input
          id="wm-angle"
          type="range"
          min={-90}
          max={90}
          step={5}
          value={mark.angle}
          onChange={(e) => patch({ angle: Number(e.target.value) })}
        />
        <span className="settings__value">{mark.angle}°</span>
      </div>

      <div className="settings__row">
        <label className="settings__label" htmlFor="wm-opacity">Opacité</label>
        <input
          id="wm-opacity"
          type="range"
          min={2}
          max={100}
          step={1}
          value={Math.round(mark.opacity * 100)}
          onChange={(e) => patch({ opacity: Number(e.target.value) / 100 })}
        />
        <span className="settings__value">{Math.round(mark.opacity * 100)} %</span>
      </div>

      <div className="settings__row">
        <label className="settings__label" htmlFor="wm-color">Couleur</label>
        <input
          id="wm-color"
          type="color"
          value={mark.color}
          onChange={(e) => patch({ color: e.target.value })}
        />
        <label className="settings__label" htmlFor="wm-size">Taille</label>
        <select
          id="wm-size"
          className="settings__select"
          value={mark.sizePt}
          onChange={(e) => patch({ sizePt: Number(e.target.value) })}
        >
          <option value={0}>Ajustée à la page</option>
          {[36, 48, 72, 96, 128, 160, 200].map((s) => (
            <option key={s} value={s}>{s} pt</option>
          ))}
        </select>
      </div>

      <div className="settings__label">Aperçu</div>
      <div
        className="wmdlg__preview"
        style={{
          aspectRatio: `${pageWidthMm} / ${pageHeightMm}`,
          backgroundImage: preview,
        }}
      >
        <span className="wmdlg__preview-text">Texte du document…</span>
      </div>
    </Modal>
  );
}
