import { useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { Modal, Button } from "../ui/components";
import { COND_OPS, describeRule } from "./condformat";
import { indexToCol } from "./formula";
import type { CondRule, CondOp } from "./model";

type NewRule = Omit<CondRule, "id" | "c0" | "r0" | "c1" | "r1">;

interface Props {
  rangeLabel: string;
  rules: CondRule[];
  onAdd: (rule: NewRule) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}

/**
 * Conditional-formatting manager: add a rule over the current selection (value
 * comparison + style, or a colour scale) and review/delete existing rules.
 */
export default function CondFormatModal({ rangeLabel, rules, onAdd, onRemove, onClose }: Props) {
  const [op, setOp] = useState<CondOp>("gt");
  const [v1, setV1] = useState("");
  const [v2, setV2] = useState("");
  const [fill, setFill] = useState("#fde68a");
  const [color, setColor] = useState("#0f172a");
  const [bold, setBold] = useState(false);
  const [scaleMin, setScaleMin] = useState("#f8696b");
  const [scaleMid, setScaleMid] = useState("#ffeb84");
  const [scaleMax, setScaleMax] = useState("#63be7b");
  const [useMid, setUseMid] = useState(true);

  const needs = COND_OPS.find((o) => o.value === op)?.needs ?? 0;
  const isScale = op === "colorScale";

  const add = () => {
    const rule: NewRule =
      isScale
        ? { op, scale: { min: scaleMin, max: scaleMax, ...(useMid ? { mid: scaleMid } : {}) } }
        : { op, v1: needs >= 1 ? v1 : undefined, v2: needs >= 2 ? v2 : undefined, fill, color, bold };
    onAdd(rule);
    setV1("");
    setV2("");
  };

  return (
    <Modal title="Mise en forme conditionnelle" onClose={onClose} footer={<Button onClick={onClose}>Fermer</Button>}>
      <div className="settings">
        <section className="settings__section">
          <h3 className="settings__title">Nouvelle règle — plage {rangeLabel}</h3>
          <div className="cf-form">
            <select className="settings__select" value={op} onChange={(e) => setOp(e.target.value as CondOp)} aria-label="Condition">
              {COND_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            {needs >= 1 && !isScale && (
              <input className="settings__input cf-val" value={v1} onChange={(e) => setV1(e.target.value)} placeholder={op === "contains" ? "texte" : "valeur"} />
            )}
            {needs >= 2 && !isScale && (
              <>
                <span className="cf-and">et</span>
                <input className="settings__input cf-val" value={v2} onChange={(e) => setV2(e.target.value)} placeholder="valeur" />
              </>
            )}
          </div>

          {isScale ? (
            <div className="cf-scale-row">
              <label className="tool-color" title="Couleur minimale"><span>Min</span><input type="color" value={scaleMin} onChange={(e) => setScaleMin(e.target.value)} /></label>
              <label className="checkbox-row cf-mid-toggle">
                <input type="checkbox" checked={useMid} onChange={(e) => setUseMid(e.target.checked)} />
                <span>Milieu</span>
              </label>
              {useMid && <label className="tool-color" title="Couleur médiane"><input type="color" value={scaleMid} onChange={(e) => setScaleMid(e.target.value)} /></label>}
              <label className="tool-color" title="Couleur maximale"><span>Max</span><input type="color" value={scaleMax} onChange={(e) => setScaleMax(e.target.value)} /></label>
              <span className="cf-scale-preview" style={{ background: `linear-gradient(90deg, ${scaleMin}, ${useMid ? scaleMid + "," : ""} ${scaleMax})` }} />
            </div>
          ) : (
            <div className="cf-style-row">
              <label className="tool-color" title="Remplissage"><span>Remplissage</span><input type="color" value={fill} onChange={(e) => setFill(e.target.value)} /></label>
              <label className="tool-color" title="Texte"><span>Texte</span><input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
              <label className="checkbox-row"><input type="checkbox" checked={bold} onChange={(e) => setBold(e.target.checked)} /><span>Gras</span></label>
              <span className="cf-preview" style={{ background: fill, color, fontWeight: bold ? 700 : 400 }}>Aa 123</span>
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            <Button size="sm" variant="primary" onClick={add}><Plus size={14} /> Ajouter la règle</Button>
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Règles ({rules.length})</h3>
          {rules.length === 0 ? (
            <p className="cf-empty">Aucune règle. Sélectionnez une plage et ajoutez-en une.</p>
          ) : (
            <ul className="cf-rule-list">
              {rules.map((r) => {
                const span = `${indexToCol(r.c0)}${r.r0 + 1}:${indexToCol(r.c1)}${r.r1 + 1}`;
                const swatch = r.op === "colorScale"
                  ? `linear-gradient(90deg, ${r.scale?.min}, ${r.scale?.mid ? r.scale.mid + "," : ""} ${r.scale?.max})`
                  : (r.fill ?? "transparent");
                return (
                  <li key={r.id} className="cf-rule">
                    <span className="cf-swatch" style={{ background: swatch, color: r.color }} />
                    <span className="cf-rule__desc"><strong>{span}</strong> — {describeRule(r)}</span>
                    <button className="icon-btn icon-btn--danger" title="Supprimer la règle" onClick={() => onRemove(r.id)}><Trash2 size={14} /></button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
