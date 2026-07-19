import { useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { Modal, Button } from "../ui/components";
import { VALIDATION_OPS, describeValidation } from "./validation";
import { indexToCol } from "./formula";
import type { DataValidation, ValidationType, ValidationOp } from "./model";

type NewValidation = Omit<DataValidation, "id" | "c0" | "r0" | "c1" | "r1">;

interface Props {
  rangeLabel: string;
  validations: DataValidation[];
  onAdd: (v: NewValidation) => void;
  onRemove: (id: string) => void;
  onClose: () => void;
}

const TYPES: { value: ValidationType; label: string }[] = [
  { value: "list", label: "Liste déroulante" },
  { value: "number", label: "Nombre" },
  { value: "textLength", label: "Longueur du texte" },
  { value: "date", label: "Date" },
];

/**
 * Data-validation manager: constrain the current selection to a dropdown list or
 * a numeric / text-length / date rule, and review/delete existing rules. Soft
 * validation — invalid cells are flagged (red), never refused.
 */
export default function ValidationModal({ rangeLabel, validations, onAdd, onRemove, onClose }: Props) {
  const [type, setType] = useState<ValidationType>("list");
  const [op, setOp] = useState<ValidationOp>("between");
  const [v1, setV1] = useState("");
  const [v2, setV2] = useState("");
  const [listText, setListText] = useState("");
  const [allowBlank, setAllowBlank] = useState(true);

  const needs = VALIDATION_OPS.find((o) => o.value === op)?.needs ?? 1;

  const add = () => {
    if (type === "list") {
      const list = listText.split(/[\n,;]/).map((s) => s.trim()).filter(Boolean);
      if (!list.length) return;
      onAdd({ type: "list", list, allowBlank });
    } else {
      onAdd({ type, op, v1: v1 || undefined, v2: needs >= 2 ? v2 || undefined : undefined, allowBlank });
    }
    setV1(""); setV2(""); setListText("");
  };

  const placeholder = type === "date" ? "aaaa-mm-jj" : type === "textLength" ? "longueur" : "valeur";

  return (
    <Modal title="Validation des données" onClose={onClose} footer={<Button onClick={onClose}>Fermer</Button>}>
      <div className="settings">
        <section className="settings__section">
          <h3 className="settings__title">Nouvelle règle — plage {rangeLabel}</h3>
          <div className="cf-form">
            <select className="settings__select" value={type} onChange={(e) => setType(e.target.value as ValidationType)} aria-label="Type">
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
            {type !== "list" && (
              <select className="settings__select" value={op} onChange={(e) => setOp(e.target.value as ValidationOp)} aria-label="Condition">
                {VALIDATION_OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}
          </div>

          {type === "list" ? (
            <textarea
              className="settings__input" rows={3} value={listText} onChange={(e) => setListText(e.target.value)}
              placeholder="Valeurs autorisées, séparées par des virgules ou des retours à la ligne"
              style={{ width: "100%", marginTop: 8, resize: "vertical" }}
            />
          ) : (
            <div className="cf-form" style={{ marginTop: 8 }}>
              <input className="settings__input cf-val" value={v1} onChange={(e) => setV1(e.target.value)} placeholder={placeholder} />
              {needs >= 2 && (
                <>
                  <span className="cf-and">et</span>
                  <input className="settings__input cf-val" value={v2} onChange={(e) => setV2(e.target.value)} placeholder={placeholder} />
                </>
              )}
            </div>
          )}

          <label className="checkbox-row" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={allowBlank} onChange={(e) => setAllowBlank(e.target.checked)} />
            <span>Autoriser les cellules vides</span>
          </label>

          <div style={{ marginTop: 10 }}>
            <Button size="sm" variant="primary" onClick={add}><Plus size={14} /> Ajouter la règle</Button>
          </div>
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Règles ({validations.length})</h3>
          {validations.length === 0 ? (
            <p className="cf-empty">Aucune règle. Sélectionnez une plage et ajoutez-en une.</p>
          ) : (
            <ul className="cf-rule-list">
              {validations.map((v) => {
                const span = `${indexToCol(v.c0)}${v.r0 + 1}:${indexToCol(v.c1)}${v.r1 + 1}`;
                return (
                  <li key={v.id} className="cf-rule">
                    <span className="cf-rule__desc"><strong>{span}</strong> — {describeValidation(v)}</span>
                    <button className="icon-btn icon-btn--danger" title="Supprimer la règle" onClick={() => onRemove(v.id)}><Trash2 size={14} /></button>
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
