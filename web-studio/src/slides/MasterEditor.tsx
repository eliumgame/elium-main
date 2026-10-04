/**
 * Éditeur du masque : thème (polices, couleurs, pied de page, numéro) et dispositions
 * (espaces réservés positionnables) avec aperçu. « Appliquer » répercute le masque sur toutes
 * les diapositives liées à une disposition (une seule annulation).
 */
import { useState } from "react";
import { Modal, Button } from "../ui/components";
import { allFontNames } from "../ui/fonts";
import type { LayoutPlaceholder, PlaceholderKind, SlideMaster } from "./model";
import {
  addLayout,
  addPlaceholder,
  defaultMaster,
  removeLayout,
  removePlaceholder,
  renameLayout,
  updatePlaceholder,
} from "./master";
import "./master.css";

const KIND_LABEL: Record<PlaceholderKind, string> = {
  title: "Titre",
  body: "Corps",
  footer: "Pied de page",
  slideNumber: "Numéro",
};
const KIND_COLOR: Record<PlaceholderKind, string> = {
  title: "#2563eb",
  body: "#16a34a",
  footer: "#f59e0b",
  slideNumber: "#7c3aed",
};

export default function MasterEditor({
  master,
  onApply,
  onClose,
}: {
  master?: SlideMaster;
  onApply: (m: SlideMaster) => void;
  onClose: () => void;
}) {
  const [m, setM] = useState<SlideMaster>(() => master ?? defaultMaster());
  const [layoutId, setLayoutId] = useState(m.layouts[0]!.id);
  const layout = m.layouts.find((l) => l.id === layoutId) ?? m.layouts[0]!;
  const fonts = allFontNames();
  const num = (v: string): number => Number(v.replace(",", "."));
  const upd = (phId: string, patch: Partial<LayoutPlaceholder>) =>
    setM((x) => updatePlaceholder(x, layout.id, phId, patch));

  return (
    <Modal
      title="Masque des diapositives"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="ghost" onClick={() => setM(defaultMaster())}>
            Rétablir le masque par défaut
          </Button>
          <Button
            onClick={() => {
              onApply(m);
              onClose();
            }}
          >
            Appliquer à toutes les diapositives
          </Button>
        </>
      }
    >
      <div className="mastered">
        <section className="mastered__theme" aria-label="Thème">
          <h3>Thème</h3>
          <label>
            Police des titres
            <select value={m.fontHeading} onChange={(e) => setM({ ...m, fontHeading: e.target.value })}>
              {[...new Set([m.fontHeading, ...fonts])].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          <label>
            Police du texte
            <select value={m.fontBody} onChange={(e) => setM({ ...m, fontBody: e.target.value })}>
              {[...new Set([m.fontBody, ...fonts])].map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          </label>
          {(
            [
              ["colorTitle", "Couleur des titres"],
              ["colorBody", "Couleur du texte"],
              ["colorAccent", "Couleur d'accent"],
              ["background", "Arrière-plan"],
            ] as const
          ).map(([k, label]) => (
            <label key={k}>
              {label}
              <input
                type="color"
                value={m[k]}
                onChange={(e) => setM({ ...m, [k]: e.target.value })}
                aria-label={label}
              />
            </label>
          ))}
          <label>
            Texte du pied de page
            <input
              value={m.footerText}
              onChange={(e) => setM({ ...m, footerText: e.target.value })}
              placeholder="(aucun)"
            />
          </label>
          <label className="mastered__check">
            <input
              type="checkbox"
              checked={m.showSlideNumber !== false}
              onChange={(e) => setM({ ...m, showSlideNumber: e.target.checked })}
            />
            Numéros de diapositive
          </label>
        </section>

        <section className="mastered__layouts" aria-label="Dispositions">
          <h3>Dispositions</h3>
          <ul className="mastered__list">
            {m.layouts.map((l) => (
              <li key={l.id}>
                <button
                  className={`mastered__item ${l.id === layout.id ? "is-active" : ""}`}
                  onClick={() => setLayoutId(l.id)}
                >
                  {l.name}
                </button>
              </li>
            ))}
          </ul>
          <div className="mastered__row">
            <Button variant="ghost" onClick={() => setM((x) => addLayout(x, "Nouvelle disposition"))}>
              + Disposition
            </Button>
            <Button
              variant="ghost"
              disabled={m.layouts.length <= 1}
              onClick={() => {
                const next = removeLayout(m, layout.id);
                setM(next);
                setLayoutId(next.layouts[0]!.id);
              }}
            >
              Supprimer
            </Button>
          </div>
        </section>

        <section className="mastered__edit" aria-label="Disposition sélectionnée">
          <label>
            Nom
            <input value={layout.name} onChange={(e) => setM((x) => renameLayout(x, layout.id, e.target.value))} />
          </label>
          <div className="mastered__preview" aria-hidden="true" style={{ background: m.background }}>
            {layout.placeholders.map((p) => (
              <div
                key={p.id}
                className="mastered__ph"
                style={{
                  left: `${p.x}%`,
                  top: `${p.y}%`,
                  width: `${p.w}%`,
                  height: `${p.h}%`,
                  borderColor: KIND_COLOR[p.kind],
                  color: KIND_COLOR[p.kind],
                }}
              >
                {KIND_LABEL[p.kind]}
              </div>
            ))}
          </div>
          <table className="mastered__table">
            <thead>
              <tr>
                <th>Espace</th>
                <th>X %</th>
                <th>Y %</th>
                <th>L %</th>
                <th>H %</th>
                <th>Taille</th>
                <th>Align.</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {layout.placeholders.map((p) => (
                <tr key={p.id}>
                  <td>{KIND_LABEL[p.kind]}</td>
                  {(["x", "y", "w", "h", "fontSize"] as const).map((k) => (
                    <td key={k}>
                      <input
                        aria-label={`${KIND_LABEL[p.kind]} ${k}`}
                        type="number"
                        value={p[k]}
                        step={k === "fontSize" ? 1 : 0.5}
                        onChange={(e) => upd(p.id, { [k]: num(e.target.value) })}
                      />
                    </td>
                  ))}
                  <td>
                    <select
                      aria-label={`${KIND_LABEL[p.kind]} alignement`}
                      value={p.align}
                      onChange={(e) => upd(p.id, { align: e.target.value as LayoutPlaceholder["align"] })}
                    >
                      <option value="left">Gauche</option>
                      <option value="center">Centré</option>
                      <option value="right">Droite</option>
                    </select>
                  </td>
                  <td>
                    <button
                      className="icon-btn"
                      aria-label={`Retirer ${KIND_LABEL[p.kind]}`}
                      onClick={() => setM((x) => removePlaceholder(x, layout.id, p.id))}
                    >
                      ×
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mastered__row">
            {(["title", "body", "footer", "slideNumber"] as PlaceholderKind[]).map((k) => (
              <Button key={k} variant="ghost" onClick={() => setM((x) => addPlaceholder(x, layout.id, k))}>
                + {KIND_LABEL[k]}
              </Button>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}
