/**
 * Le dialogue « Options du quadrillage », avec aperçu.
 *
 * L'aperçu est le **même** fond que la feuille (`gridBackground`) : un pas se juge
 * à l'œil, et un aperçu approximatif ferait choisir un réglage puis découvrir
 * autre chose sur la page.
 *
 * Les réglages s'appliquent au fil des modifications (le quadrillage est un
 * repère, pas une mise en forme : rien à valider), ce que dit le pied du dialogue.
 */
import { useMemo, useState } from "react";
import { Modal, Button } from "../ui/components";
import {
  DEFAULT_GRID, MAX_EVERY, MAX_SPACING_MM, MIN_SPACING_MM, drawnStepX, drawnStepY,
  gridBackground, normalizeGrid, type GridSettings,
} from "./grid";

export default function GridModal({
  value,
  onChange,
  onClose,
}: {
  value?: GridSettings | null;
  onChange: (grid: GridSettings) => void;
  onClose: () => void;
}) {
  const [grid, setGrid] = useState<GridSettings>(() => normalizeGrid(value ?? DEFAULT_GRID));

  /** Applique immédiatement : le quadrillage se règle en le regardant. */
  const patch = (p: Partial<GridSettings>) => {
    const next = normalizeGrid({ ...grid, ...p });
    setGrid(next);
    onChange(next);
  };

  const preview = useMemo(() => gridBackground({ ...grid, visible: true }, 0, 0), [grid]);
  const stepX = drawnStepX(grid);
  const stepY = drawnStepY(grid);

  return (
    <Modal
      title="Options du quadrillage"
      onClose={onClose}
      footer={
        <>
          <Button
            variant="outline"
            onClick={() => {
              const next = normalizeGrid({ ...DEFAULT_GRID, visible: grid.visible });
              setGrid(next);
              onChange(next);
            }}
          >
            Réinitialiser
          </Button>
          <Button onClick={onClose}>Fermer</Button>
        </>
      }
    >
      <div className="settings__row">
        <label className="settings__check">
          <input type="checkbox" checked={grid.visible} onChange={(e) => patch({ visible: e.target.checked })} />
          Afficher le quadrillage
        </label>
        <label className="settings__check">
          <input type="checkbox" checked={grid.snap} onChange={(e) => patch({ snap: e.target.checked })} />
          Aligner les objets sur le quadrillage
        </label>
      </div>

      <div className="settings__row">
        <label className="settings__label" htmlFor="grid-sx">Pas horizontal</label>
        <input
          id="grid-sx"
          className="settings__input settings__input--num"
          type="number"
          min={MIN_SPACING_MM}
          max={MAX_SPACING_MM}
          step={0.5}
          value={grid.spacingXMm}
          onChange={(e) => patch({ spacingXMm: Number(e.target.value) })}
        />
        <span className="settings__unit">mm</span>
        <label className="settings__label" htmlFor="grid-sy">Pas vertical</label>
        <input
          id="grid-sy"
          className="settings__input settings__input--num"
          type="number"
          min={MIN_SPACING_MM}
          max={MAX_SPACING_MM}
          step={0.5}
          value={grid.spacingYMm}
          onChange={(e) => patch({ spacingYMm: Number(e.target.value) })}
        />
        <span className="settings__unit">mm</span>
      </div>

      {/* « Une ligne sur N » est le réglage de Word : on aligne finement tout en
          gardant un tracé lisible. À 0, l'axe n'est pas dessiné du tout. */}
      <div className="settings__row">
        <label className="settings__label" htmlFor="grid-ex">Lignes verticales</label>
        <select
          id="grid-ex"
          className="settings__select"
          value={grid.everyX}
          onChange={(e) => patch({ everyX: Number(e.target.value) })}
        >
          <option value={0}>Aucune</option>
          {Array.from({ length: MAX_EVERY }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n === 1 ? "Toutes" : `Une sur ${n}`}</option>
          ))}
        </select>
        <label className="settings__label" htmlFor="grid-ey">Lignes horizontales</label>
        <select
          id="grid-ey"
          className="settings__select"
          value={grid.everyY}
          onChange={(e) => patch({ everyY: Number(e.target.value) })}
        >
          <option value={0}>Aucune</option>
          {Array.from({ length: MAX_EVERY }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>{n === 1 ? "Toutes" : `Une sur ${n}`}</option>
          ))}
        </select>
      </div>

      <div className="settings__row">
        <label className="settings__label" htmlFor="grid-color">Couleur des lignes</label>
        <input
          id="grid-color"
          type="color"
          value={grid.color}
          onChange={(e) => patch({ color: e.target.value })}
        />
        <label className="settings__check">
          <input
            type="checkbox"
            checked={grid.tableGridlines}
            onChange={(e) => patch({ tableGridlines: e.target.checked })}
          />
          Quadrillage des tableaux sans bordure
        </label>
      </div>

      <div className="settings__row">
        <label className="settings__check">
          <input
            type="checkbox"
            checked={grid.fromMargins}
            onChange={(e) => patch({ fromMargins: e.target.checked })}
          />
          Origine au coin de la zone de texte
        </label>
      </div>

      {!grid.fromMargins && (
        <div className="settings__row">
          <label className="settings__label" htmlFor="grid-ox">Origine horizontale</label>
          <input
            id="grid-ox"
            className="settings__input settings__input--num"
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={grid.originXMm}
            onChange={(e) => patch({ originXMm: Number(e.target.value) })}
          />
          <span className="settings__unit">mm</span>
          <label className="settings__label" htmlFor="grid-oy">Origine verticale</label>
          <input
            id="grid-oy"
            className="settings__input settings__input--num"
            type="number"
            min={0}
            max={100}
            step={0.5}
            value={grid.originYMm}
            onChange={(e) => patch({ originYMm: Number(e.target.value) })}
          />
          <span className="settings__unit">mm</span>
        </div>
      )}

      <div className="settings__label">Aperçu</div>
      <div
        className="griddlg__preview"
        style={
          preview
            ? {
                backgroundImage: preview.backgroundImage,
                backgroundPosition: preview.backgroundPosition,
                backgroundSize: preview.backgroundSize,
              }
            : undefined
        }
      >
        {!preview && <span className="griddlg__empty">Aucune ligne à tracer</span>}
      </div>
      <p className="modal-live">
        {stepX > 0 || stepY > 0
          ? `Maillage tracé : ${stepX > 0 ? `${stepX} mm` : "—"} × ${stepY > 0 ? `${stepY} mm` : "—"} · ` +
            `alignement au pas de ${grid.spacingXMm} × ${grid.spacingYMm} mm. ` +
            "Maintenez Alt pendant un déplacement pour ignorer l'alignement."
          : "Le quadrillage n'est pas tracé, mais l'alignement des objets reste actif s'il est coché."}
        {" "}Le quadrillage ne s'imprime pas et n'apparaît pas dans les exports.
      </p>
    </Modal>
  );
}
