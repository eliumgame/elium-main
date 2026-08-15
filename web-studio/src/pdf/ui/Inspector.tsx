import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Copy,
  Italic,
  Lock,
  Trash2,
  Underline,
  Unlock,
  Eye,
  EyeOff,
  ArrowUp,
  ArrowDown,
  Layers2,
} from "lucide-react";
import type { Annot, MeasureScale, ReviewStatus } from "../model/types";
import { isMeasure, isShape, isTextContent, isTextMarkup } from "../model/types";
import { allFontNames } from "../../ui/fonts";
import { KIND_LABEL, shortDate } from "./state";

/**
 * The right-hand properties panel: everything about the current selection,
 * editable in place. Multi-selection edits every compatible property at once,
 * showing "—" where the values differ.
 */

export interface InspectorProps {
  selection: Annot[];
  pageCount: number;
  measureScale: MeasureScale;
  onPatch: (patch: Partial<Annot>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onOrder: (where: "front" | "back" | "forward" | "backward") => void;
  onMeasureScale: (scale: MeasureScale) => void;
  onClose: () => void;
}

/** Shared value across a multi-selection, or undefined when they differ. */
function shared<T>(items: readonly Annot[], pick: (a: Annot) => T): T | undefined {
  if (!items.length) return undefined;
  const first = pick(items[0]);
  return items.every((a) => Object.is(pick(a), first)) ? first : undefined;
}

const STATUS: { id: ReviewStatus; label: string }[] = [
  { id: "none", label: "Aucun" },
  { id: "accepted", label: "Accepté" },
  { id: "rejected", label: "Rejeté" },
  { id: "cancelled", label: "Annulé" },
  { id: "completed", label: "Terminé" },
];

export default function Inspector(p: InspectorProps) {
  const sel = p.selection;
  if (!sel.length) return null;
  const one = sel.length === 1 ? sel[0] : null;
  const kinds = new Set(sel.map((a) => a.kind));
  const anyShape = sel.some((a) => isShape(a.kind));
  const anyText = sel.some((a) => isTextContent(a.kind));
  const anyMarkup = sel.some((a) => isTextMarkup(a.kind));
  const anyMeasure = sel.some((a) => isMeasure(a.kind));
  const locked = shared(sel, (a) => !!a.locked) ?? false;

  const colour = shared(sel, (a) => a.color) ?? "#000000";
  const fill = shared(sel, (a) => a.fill ?? "");
  const opacity = shared(sel, (a) => a.opacity) ?? 1;
  const stroke = shared(sel, (a) => a.strokeWidth) ?? 1;

  return (
    <aside className="pdfx-inspector">
      <header className="pdfx-inspector__head">
        <span className="pdfx-inspector__title">
          {sel.length === 1 ? KIND_LABEL[sel[0].kind] : `${sel.length} éléments`}
        </span>
        <button className="pdfx-icon" onClick={p.onClose} title="Fermer le panneau">
          ×
        </button>
      </header>

      <div className="pdfx-inspector__body">
        <section className="pdfx-insp-group">
          <h4>Apparence</h4>
          <label className="pdfx-insp-row">
            <span>Couleur</span>
            <input
              type="color"
              value={colour}
              onChange={(e) => p.onPatch({ color: e.target.value })}
              disabled={locked}
            />
          </label>
          {(anyShape || kinds.has("freetext") || kinds.has("callout")) && (
            <label className="pdfx-insp-row">
              <span>Remplissage</span>
              <span className="pdfx-insp-inline">
                <input
                  type="color"
                  value={fill || "#ffffff"}
                  onChange={(e) => p.onPatch({ fill: e.target.value })}
                  disabled={locked}
                />
                <button className="pdfx-mini" onClick={() => p.onPatch({ fill: null })} disabled={locked}>
                  Aucun
                </button>
              </span>
            </label>
          )}
          <label className="pdfx-insp-row">
            <span>Opacité</span>
            <span className="pdfx-insp-inline">
              <input
                type="range"
                min={0.05}
                max={1}
                step={0.05}
                value={opacity}
                onChange={(e) => p.onPatch({ opacity: Number(e.target.value) })}
                disabled={locked}
              />
              <b>{Math.round(opacity * 100)} %</b>
            </span>
          </label>
          {(anyShape || anyMarkup || anyMeasure) && (
            <label className="pdfx-insp-row">
              <span>Épaisseur</span>
              <span className="pdfx-insp-inline">
                <input
                  type="range"
                  min={0}
                  max={16}
                  step={0.5}
                  value={stroke}
                  onChange={(e) => p.onPatch({ strokeWidth: Number(e.target.value) })}
                  disabled={locked}
                />
                <b>{stroke}</b>
              </span>
            </label>
          )}
          {anyShape && (
            <label className="pdfx-insp-row">
              <span>Bordure</span>
              <select
                value={shared(sel, (a) => a.borderStyle ?? "solid") ?? "solid"}
                onChange={(e) => p.onPatch({ borderStyle: e.target.value as Annot["borderStyle"] })}
                disabled={locked}
              >
                <option value="solid">Continue</option>
                <option value="dashed">Tirets</option>
                <option value="cloudy">Nuage</option>
              </select>
            </label>
          )}
        </section>

        {anyText && (
          <section className="pdfx-insp-group">
            <h4>Texte</h4>
            <label className="pdfx-insp-row">
              <span>Police</span>
              <select
                value={shared(sel, (a) => a.fontFamily ?? "Helvetica") ?? ""}
                onChange={(e) => p.onPatch({ fontFamily: e.target.value })}
                disabled={locked}
              >
                {allFontNames().map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="pdfx-insp-row">
              <span>Taille</span>
              <input
                type="number"
                min={4}
                max={200}
                step={1}
                value={shared(sel, (a) => a.fontSize ?? 12) ?? 12}
                onChange={(e) => p.onPatch({ fontSize: Number(e.target.value) })}
                disabled={locked}
              />
            </label>
            <div className="pdfx-insp-row">
              <span>Style</span>
              <span className="pdfx-insp-inline">
                <button
                  className={`pdfx-toggle ${shared(sel, (a) => !!a.bold) ? "is-on" : ""}`}
                  onClick={() => p.onPatch({ bold: !shared(sel, (a) => !!a.bold) })}
                  disabled={locked}
                >
                  <Bold size={14} />
                </button>
                <button
                  className={`pdfx-toggle ${shared(sel, (a) => !!a.italic) ? "is-on" : ""}`}
                  onClick={() => p.onPatch({ italic: !shared(sel, (a) => !!a.italic) })}
                  disabled={locked}
                >
                  <Italic size={14} />
                </button>
                <button
                  className={`pdfx-toggle ${shared(sel, (a) => !!a.underline) ? "is-on" : ""}`}
                  onClick={() => p.onPatch({ underline: !shared(sel, (a) => !!a.underline) })}
                  disabled={locked}
                >
                  <Underline size={14} />
                </button>
              </span>
            </div>
            <div className="pdfx-insp-row">
              <span>Alignement</span>
              <span className="pdfx-insp-inline">
                {(
                  [
                    ["left", <AlignLeft key="l" size={14} />],
                    ["center", <AlignCenter key="c" size={14} />],
                    ["right", <AlignRight key="r" size={14} />],
                  ] as const
                ).map(([id, icon]) => (
                  <button
                    key={id}
                    className={`pdfx-toggle ${shared(sel, (a) => a.align ?? "left") === id ? "is-on" : ""}`}
                    onClick={() => p.onPatch({ align: id })}
                    disabled={locked}
                  >
                    {icon}
                  </button>
                ))}
              </span>
            </div>
            <label className="pdfx-insp-row">
              <span>Fond</span>
              <span className="pdfx-insp-inline">
                <input
                  type="color"
                  value={shared(sel, (a) => a.textBg ?? "#ffffff") ?? "#ffffff"}
                  onChange={(e) => p.onPatch({ textBg: e.target.value })}
                  disabled={locked}
                />
                <button className="pdfx-mini" onClick={() => p.onPatch({ textBg: null })} disabled={locked}>
                  Transparent
                </button>
              </span>
            </label>
          </section>
        )}

        {one?.kind === "link" && (
          <section className="pdfx-insp-group">
            <h4>Lien</h4>
            <label className="pdfx-insp-row">
              <span>Type</span>
              <select
                value={one.action?.type ?? "url"}
                onChange={(e) =>
                  p.onPatch({
                    action: e.target.value === "page" ? { type: "page", page: 1 } : { type: "url", url: "https://" },
                  })
                }
              >
                <option value="url">Adresse web</option>
                <option value="page">Page du document</option>
              </select>
            </label>
            {one.action?.type === "url" ? (
              <label className="pdfx-insp-row pdfx-insp-row--wide">
                <span>URL</span>
                <input
                  type="url"
                  value={one.action.url}
                  onChange={(e) => p.onPatch({ action: { type: "url", url: e.target.value } })}
                />
              </label>
            ) : (
              <label className="pdfx-insp-row">
                <span>Page</span>
                <input
                  type="number"
                  min={1}
                  max={p.pageCount}
                  value={one.action?.type === "page" ? one.action.page : 1}
                  onChange={(e) => p.onPatch({ action: { type: "page", page: Number(e.target.value) } })}
                />
              </label>
            )}
          </section>
        )}

        {one && (one.kind === "stamp" || one.kind === "signature" || one.kind === "image") && (
          <section className="pdfx-insp-group">
            <h4>Objet</h4>
            {!one.src && (
              <label className="pdfx-insp-row pdfx-insp-row--wide">
                <span>Libellé</span>
                <input value={one.stampLabel ?? ""} onChange={(e) => p.onPatch({ stampLabel: e.target.value })} />
              </label>
            )}
            <label className="pdfx-insp-row">
              <span>Rotation</span>
              <span className="pdfx-insp-inline">
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={1}
                  value={one.rotation ?? 0}
                  onChange={(e) => p.onPatch({ rotation: Number(e.target.value) })}
                />
                <b>{one.rotation ?? 0}°</b>
              </span>
            </label>
          </section>
        )}

        {one?.kind === "redact" && (
          <section className="pdfx-insp-group">
            <h4>Caviardage</h4>
            <label className="pdfx-insp-row pdfx-insp-row--wide">
              <span>Texte de recouvrement</span>
              <input
                value={one.redactText ?? ""}
                placeholder="ex. [CAVIARDÉ]"
                onChange={(e) => p.onPatch({ redactText: e.target.value })}
              />
            </label>
            <label className="pdfx-insp-row">
              <span>Couleur du bloc</span>
              <input
                type="color"
                value={one.redactFill ?? "#000000"}
                onChange={(e) => p.onPatch({ redactFill: e.target.value })}
              />
            </label>
            <p className="pdfx-insp-note">
              Le contenu situé sous la zone sera <b>définitivement supprimé</b> du fichier exporté, pas simplement
              masqué.
            </p>
          </section>
        )}

        {anyMeasure && (
          <section className="pdfx-insp-group">
            <h4>Échelle de mesure</h4>
            <label className="pdfx-insp-row">
              <span>1 point =</span>
              <input
                type="number"
                step="0.0001"
                min={0.0001}
                value={p.measureScale.unitsPerPoint}
                onChange={(e) =>
                  p.onMeasureScale({ ...p.measureScale, unitsPerPoint: Number(e.target.value) || 0.0001 })
                }
              />
            </label>
            <label className="pdfx-insp-row">
              <span>Unité</span>
              <input
                value={p.measureScale.unit}
                onChange={(e) => p.onMeasureScale({ ...p.measureScale, unit: e.target.value })}
              />
            </label>
            <label className="pdfx-insp-row">
              <span>Décimales</span>
              <input
                type="number"
                min={0}
                max={6}
                value={p.measureScale.precision}
                onChange={(e) => p.onMeasureScale({ ...p.measureScale, precision: Number(e.target.value) })}
              />
            </label>
          </section>
        )}

        <section className="pdfx-insp-group">
          <h4>Révision</h4>
          <label className="pdfx-insp-row pdfx-insp-row--wide">
            <span>Commentaire</span>
            <textarea
              rows={3}
              value={one?.contents ?? ""}
              placeholder={sel.length > 1 ? "Sélection multiple" : "Ajouter un commentaire…"}
              disabled={sel.length > 1}
              onChange={(e) => p.onPatch({ contents: e.target.value })}
            />
          </label>
          <label className="pdfx-insp-row">
            <span>Statut</span>
            <select
              value={shared(sel, (a) => a.status ?? "none") ?? "none"}
              onChange={(e) => p.onPatch({ status: e.target.value as ReviewStatus })}
            >
              {STATUS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          {one && (
            <p className="pdfx-insp-meta">
              {one.author} · créé le {shortDate(one.createdAt)}
              {one.modifiedAt !== one.createdAt && ` · modifié le ${shortDate(one.modifiedAt)}`}
            </p>
          )}
        </section>

        <section className="pdfx-insp-group">
          <h4>Disposition</h4>
          <div className="pdfx-insp-actions">
            <button className="pdfx-mini" onClick={() => p.onOrder("front")}>
              <Layers2 size={13} /> Premier plan
            </button>
            <button className="pdfx-mini" onClick={() => p.onOrder("forward")}>
              <ArrowUp size={13} /> Avancer
            </button>
            <button className="pdfx-mini" onClick={() => p.onOrder("backward")}>
              <ArrowDown size={13} /> Reculer
            </button>
            <button className="pdfx-mini" onClick={() => p.onOrder("back")}>
              <Layers2 size={13} /> Arrière-plan
            </button>
          </div>
        </section>
      </div>

      <footer className="pdfx-inspector__foot">
        <button className="pdfx-mini" onClick={() => p.onPatch({ locked: !locked })}>
          {locked ? <Unlock size={13} /> : <Lock size={13} />} {locked ? "Déverrouiller" : "Verrouiller"}
        </button>
        <button className="pdfx-mini" onClick={() => p.onPatch({ hidden: !(shared(sel, (a) => !!a.hidden) ?? false) })}>
          {shared(sel, (a) => !!a.hidden) ? <Eye size={13} /> : <EyeOff size={13} />} Masquer
        </button>
        <button className="pdfx-mini" onClick={p.onDuplicate}>
          <Copy size={13} /> Dupliquer
        </button>
        <button className="pdfx-mini pdfx-mini--danger" onClick={p.onDelete} disabled={locked}>
          <Trash2 size={13} /> Supprimer
        </button>
      </footer>
    </aside>
  );
}
