/**
 * Le dialogue « Format de la forme », avec aperçu.
 *
 * Il sert AUSSI aux zones de texte : dans Word, l'encadré et la forme partagent
 * ce panneau, et c'est la même géométrie sous les deux (voir `textBox.ts`). Un
 * dialogue par famille aurait dupliqué la taille, la position, l'habillage et la
 * rotation — quatre occasions de divergence.
 *
 * Tout s'applique immédiatement : un aperçu de forme séparé de la page vaut moins
 * que la page elle-même, que l'on voit derrière le dialogue.
 */
import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import { Modal, Button } from "../ui/components";
import { WRAP_LABELS, WRAP_MODES, normalizeGeometry, type WrapMode } from "./textBox";
import {
  DASH_LABELS,
  SHAPES,
  SHAPE_GROUPS,
  normalizeShapeStyle,
  shapeDef,
  shapeSvg,
  type DashStyle,
  type ShapeKind,
  type ShapeStyle,
} from "./shapes";

/** Les deux nœuds que ce dialogue formate. */
type Target = "shape" | "textBox";

export default function ShapeFormatModal({ editor, onClose }: { editor: Editor; onClose: () => void }) {
  const target: Target | null = editor.isActive("shape") ? "shape" : editor.isActive("textBox") ? "textBox" : null;

  // Les attributs sont relus à chaque transaction : le dialogue reste juste même
  // si la forme est déplacée à la souris pendant qu'il est ouvert.
  const [attrs, setAttrs] = useState<Record<string, unknown>>(() => (target ? editor.getAttributes(target) : {}));
  useEffect(() => {
    if (!target) return;
    const sync = () => setAttrs(editor.getAttributes(target));
    sync();
    editor.on("transaction", sync);
    return () => {
      editor.off("transaction", sync);
    };
  }, [editor, target]);

  const patch = useCallback(
    (p: Record<string, unknown>) => {
      if (!target) return;
      editor.chain().focus().updateAttributes(target, p).run();
    },
    [editor, target],
  );

  if (!target) {
    return (
      <Modal title="Format de la forme" onClose={onClose} footer={<Button onClick={onClose}>Fermer</Button>}>
        <p className="muted">Sélectionnez une forme ou une zone de texte pour la formater.</p>
      </Modal>
    );
  }

  const g = normalizeGeometry(attrs);
  const isShape = target === "shape";
  const def = shapeDef(attrs.kind);
  const s: ShapeStyle = normalizeShapeStyle(attrs);
  const heightMm = g.heightMm > 0 ? g.heightMm : 25;

  return (
    <Modal
      title={isShape ? `Format de la forme — ${def.label}` : "Format de la zone de texte"}
      onClose={onClose}
      wide
      footer={
        <>
          <Button
            variant="danger"
            onClick={() => {
              editor.chain().focus().deleteNode(target).run();
              onClose();
            }}
          >
            Supprimer
          </Button>
          <Button onClick={onClose}>Fermer</Button>
        </>
      }
    >
      <div className="settings">
        {isShape && (
          <section className="settings__section">
            <h3 className="settings__title">Forme</h3>
            {/* Changer de forme conserve la taille, la position et le contenu : ce
                que Word appelle « Modifier la forme ». */}
            <select
              className="settings__select"
              value={def.kind}
              onChange={(e) =>
                editor
                  .chain()
                  .focus()
                  .setShapeKind(e.target.value as ShapeKind)
                  .run()
              }
            >
              {SHAPE_GROUPS.map((group) => (
                <optgroup key={group.id} label={group.label}>
                  {SHAPES.filter((sh) => sh.group === group.id).map((sh) => (
                    <option key={sh.kind} value={sh.kind}>
                      {sh.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            {def.adj && (
              <div className="settings__row">
                <label className="settings__label" htmlFor="sh-adj">
                  {def.adj.label}
                </label>
                <input
                  id="sh-adj"
                  type="range"
                  min={def.adj.min}
                  max={def.adj.max}
                  step={1}
                  value={Number(attrs.adj ?? def.adj.default)}
                  onChange={(e) => editor.chain().focus().setShapeAdj(Number(e.target.value)).run()}
                />
                <span className="settings__value">{Number(attrs.adj ?? def.adj.default)} %</span>
              </div>
            )}
          </section>
        )}

        <section className="settings__section">
          <h3 className="settings__title">Taille et position</h3>
          <div className="settings__row">
            <label className="settings__label" htmlFor="sh-w">
              Largeur
            </label>
            <input
              id="sh-w"
              className="settings__input settings__input--num"
              type="number"
              min={5}
              max={1200}
              step={1}
              value={g.widthMm}
              onChange={(e) => patch({ widthMm: Number(e.target.value) })}
            />
            <span className="settings__unit">mm</span>
            <label className="settings__label" htmlFor="sh-h">
              Hauteur
            </label>
            <input
              id="sh-h"
              className="settings__input settings__input--num"
              type="number"
              min={isShape ? 5 : 0}
              max={1200}
              step={1}
              value={g.heightMm}
              onChange={(e) => patch({ heightMm: Number(e.target.value) })}
            />
            <span className="settings__unit">mm</span>
          </div>
          {/* La position n'a de sens que hors du flux : en habillage carré, elle
              vient du texte, et l'afficher mentirait. */}
          {(g.wrap === "front" || g.wrap === "behind") && (
            <div className="settings__row">
              <label className="settings__label" htmlFor="sh-x">
                Position X
              </label>
              <input
                id="sh-x"
                className="settings__input settings__input--num"
                type="number"
                min={0}
                max={1200}
                step={1}
                value={g.x}
                onChange={(e) => patch({ x: Number(e.target.value) })}
              />
              <span className="settings__unit">mm</span>
              <label className="settings__label" htmlFor="sh-y">
                Position Y
              </label>
              <input
                id="sh-y"
                className="settings__input settings__input--num"
                type="number"
                min={0}
                max={1200}
                step={1}
                value={g.y}
                onChange={(e) => patch({ y: Number(e.target.value) })}
              />
              <span className="settings__unit">mm</span>
            </div>
          )}
          <div className="settings__row">
            <label className="settings__label" htmlFor="sh-rot">
              Rotation
            </label>
            <input
              id="sh-rot"
              type="range"
              min={0}
              max={359}
              step={1}
              value={g.rotation}
              onChange={(e) => patch({ rotation: Number(e.target.value) })}
            />
            <span className="settings__value">{g.rotation}°</span>
            <Button variant="ghost" onClick={() => patch({ rotation: 0 })}>
              Redresser
            </Button>
          </div>
          <div className="settings__row">
            <label className="settings__label" htmlFor="sh-wrap">
              Habillage
            </label>
            <select
              id="sh-wrap"
              className="settings__select"
              value={g.wrap}
              onChange={(e) => patch({ wrap: e.target.value as WrapMode })}
            >
              {WRAP_MODES.map((w) => (
                <option key={w} value={w}>
                  {WRAP_LABELS[w]}
                </option>
              ))}
            </select>
            {(g.wrap === "square" || g.wrap === "inline") && (
              <select
                className="settings__select"
                title="Côté"
                value={g.side}
                onChange={(e) => patch({ side: e.target.value })}
              >
                <option value="right">À droite</option>
                <option value="left">À gauche</option>
              </select>
            )}
          </div>
        </section>

        {isShape ? (
          <>
            <section className="settings__section">
              <h3 className="settings__title">Remplissage</h3>
              <div className="settings__row">
                <label className="settings__check">
                  <input
                    type="checkbox"
                    checked={!!s.fill}
                    onChange={(e) => patch({ fill: e.target.checked ? "#dbeafe" : "" })}
                  />
                  Remplir la forme
                </label>
                {!!s.fill && (
                  <>
                    <input type="color" value={s.fill} onChange={(e) => patch({ fill: e.target.value })} />
                    <select
                      className="settings__select"
                      title="Dégradé"
                      value={s.gradient}
                      onChange={(e) => patch({ gradient: e.target.value })}
                    >
                      <option value="">Couleur unie</option>
                      <option value="linear">Dégradé linéaire</option>
                      <option value="radial">Dégradé radial</option>
                    </select>
                    {s.gradient && (
                      <input type="color" value={s.fill2} onChange={(e) => patch({ fill2: e.target.value })} />
                    )}
                  </>
                )}
              </div>
              {!!s.fill && s.gradient === "linear" && (
                <div className="settings__row">
                  <label className="settings__label" htmlFor="sh-ga">
                    Angle du dégradé
                  </label>
                  <input
                    id="sh-ga"
                    type="range"
                    min={0}
                    max={359}
                    step={5}
                    value={s.gradientAngle}
                    onChange={(e) => patch({ gradientAngle: Number(e.target.value) })}
                  />
                  <span className="settings__value">{s.gradientAngle}°</span>
                </div>
              )}
              {!!s.fill && (
                <div className="settings__row">
                  <label className="settings__label" htmlFor="sh-op">
                    Opacité
                  </label>
                  <input
                    id="sh-op"
                    type="range"
                    min={5}
                    max={100}
                    step={5}
                    value={Math.round(s.fillOpacity * 100)}
                    onChange={(e) => patch({ fillOpacity: Number(e.target.value) / 100 })}
                  />
                  <span className="settings__value">{Math.round(s.fillOpacity * 100)} %</span>
                </div>
              )}
            </section>

            <section className="settings__section">
              <h3 className="settings__title">Contour</h3>
              <div className="settings__row">
                <label className="settings__label" htmlFor="sh-sw">
                  Épaisseur
                </label>
                <input
                  id="sh-sw"
                  type="range"
                  min={0}
                  max={12}
                  step={1}
                  value={s.strokeWidth}
                  onChange={(e) => patch({ strokeWidth: Number(e.target.value) })}
                />
                <span className="settings__value">{s.strokeWidth ? `${s.strokeWidth} px` : "Aucun"}</span>
                <input type="color" value={s.strokeColor} onChange={(e) => patch({ strokeColor: e.target.value })} />
                <select
                  className="settings__select"
                  title="Type de trait"
                  value={s.dash}
                  onChange={(e) => patch({ dash: e.target.value as DashStyle })}
                >
                  {(Object.keys(DASH_LABELS) as DashStyle[]).map((d) => (
                    <option key={d} value={d}>
                      {DASH_LABELS[d]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="settings__row">
                <label className="settings__check">
                  <input type="checkbox" checked={s.shadow} onChange={(e) => patch({ shadow: e.target.checked })} />
                  Ombre portée
                </label>
              </div>
            </section>

            {!def.line && (
              <section className="settings__section">
                <h3 className="settings__title">Texte dans la forme</h3>
                <div className="settings__row">
                  <label className="settings__label" htmlFor="sh-tc">
                    Couleur
                  </label>
                  <input
                    id="sh-tc"
                    type="color"
                    value={s.textColor}
                    onChange={(e) => patch({ textColor: e.target.value })}
                  />
                  <label className="settings__label" htmlFor="sh-va">
                    Alignement vertical
                  </label>
                  <select
                    id="sh-va"
                    className="settings__select"
                    value={s.vAlign}
                    onChange={(e) => patch({ vAlign: e.target.value })}
                  >
                    <option value="top">En haut</option>
                    <option value="middle">Au milieu</option>
                    <option value="bottom">En bas</option>
                  </select>
                </div>
                <div className="settings__row">
                  <label className="settings__label" htmlFor="sh-pad">
                    Marge intérieure
                  </label>
                  <input
                    id="sh-pad"
                    className="settings__input settings__input--num"
                    type="number"
                    min={0}
                    max={40}
                    step={0.5}
                    value={s.padMm}
                    onChange={(e) => patch({ padMm: Number(e.target.value) })}
                  />
                  <span className="settings__unit">mm</span>
                </div>
              </section>
            )}

            <section className="settings__section">
              <h3 className="settings__title">Aperçu</h3>
              <div
                className="shapedlg__preview"
                // L'aperçu est le MÊME générateur que la page : c'est la seule
                // façon d'être sûr que ce qu'on règle est ce qu'on obtient.
                dangerouslySetInnerHTML={{
                  __html: shapeSvg(def.kind, g.widthMm, heightMm, s, attrs.adj, "dlg"),
                }}
                style={{ aspectRatio: `${g.widthMm} / ${heightMm}` }}
              />
            </section>
          </>
        ) : (
          <section className="settings__section">
            <h3 className="settings__title">Encadré</h3>
            <div className="settings__row">
              <label className="settings__label" htmlFor="tb-bw">
                Filet
              </label>
              <input
                id="tb-bw"
                type="range"
                min={0}
                max={12}
                step={1}
                value={Number(attrs.borderWidth ?? 1)}
                onChange={(e) => patch({ borderWidth: Number(e.target.value) })}
              />
              <span className="settings__value">
                {Number(attrs.borderWidth ?? 1) ? `${Number(attrs.borderWidth ?? 1)} px` : "Aucun"}
              </span>
              <input
                type="color"
                value={String(attrs.borderColor ?? "#cbd5e1")}
                onChange={(e) => patch({ borderColor: e.target.value })}
              />
            </div>
            <div className="settings__row">
              <label className="settings__check">
                <input
                  type="checkbox"
                  checked={!!attrs.fill}
                  onChange={(e) => patch({ fill: e.target.checked ? "#f8fafc" : "" })}
                />
                Remplir l'encadré
              </label>
              {!!attrs.fill && (
                <input type="color" value={String(attrs.fill)} onChange={(e) => patch({ fill: e.target.value })} />
              )}
              <label className="settings__label" htmlFor="tb-r">
                Coins
              </label>
              <input
                id="tb-r"
                type="range"
                min={0}
                max={40}
                step={1}
                value={Number(attrs.radius ?? 4)}
                onChange={(e) => patch({ radius: Number(e.target.value) })}
              />
              <span className="settings__value">{Number(attrs.radius ?? 4)} px</span>
            </div>
            <div className="settings__row">
              <label className="settings__label" htmlFor="tb-pad">
                Marge intérieure
              </label>
              <input
                id="tb-pad"
                className="settings__input settings__input--num"
                type="number"
                min={0}
                max={40}
                step={0.5}
                value={Number(attrs.padMm ?? 3)}
                onChange={(e) => patch({ padMm: Number(e.target.value) })}
              />
              <span className="settings__unit">mm</span>
            </div>
          </section>
        )}
      </div>
      <p className="modal-live">Chaque réglage s'applique immédiatement à la forme sélectionnée.</p>
    </Modal>
  );
}
