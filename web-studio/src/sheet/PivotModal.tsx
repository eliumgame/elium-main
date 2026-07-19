import { useState } from "react";
import { Table2 } from "lucide-react";
import { Modal, Button } from "../ui/components";
import { PIVOT_AGGS, type PivotAgg, type PivotConfig } from "./pivot";

interface Props {
  headers: string[]; // field names = first row of the selected range
  rangeLabel: string;
  onCreate: (cfg: PivotConfig) => void;
  onClose: () => void;
}

/**
 * Pivot-table builder: pick the row field, an optional column field, the value
 * field and an aggregation. The result is written to a new sheet. Fields are the
 * headers of the currently selected range (its first row).
 */
export default function PivotModal({ headers, rangeLabel, onCreate, onClose }: Props) {
  const fields = headers.map((h, i) => ({ i, label: h.trim() || `Colonne ${i + 1}` }));
  const [rowField, setRowField] = useState(0);
  const [colField, setColField] = useState<number | null>(null);
  const [valueField, setValueField] = useState(fields.length > 1 ? fields.length - 1 : 0);
  const [agg, setAgg] = useState<PivotAgg>("sum");

  const enough = fields.length >= 2;

  const create = () => {
    if (!enough) return;
    onCreate({ rowField, colField, valueField, agg });
  };

  return (
    <Modal
      title="Tableau croisé dynamique"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button variant="primary" onClick={create} disabled={!enough}><Table2 size={14} /> Créer dans une nouvelle feuille</Button>
        </>
      }
    >
      <div className="settings">
        <section className="settings__section">
          <h3 className="settings__title">Source — plage {rangeLabel}</h3>
          {!enough ? (
            <p className="cf-empty">
              Sélectionnez une plage d'au moins deux colonnes, en-têtes compris (la première ligne sert de noms de champs).
            </p>
          ) : (
            <div className="pivot-form">
              <label className="pivot-row">
                <span className="pivot-row__lbl">Lignes</span>
                <select className="settings__select" value={rowField} onChange={(e) => setRowField(Number(e.target.value))}>
                  {fields.map((f) => <option key={f.i} value={f.i}>{f.label}</option>)}
                </select>
              </label>
              <label className="pivot-row">
                <span className="pivot-row__lbl">Colonnes</span>
                <select
                  className="settings__select"
                  value={colField === null ? "" : colField}
                  onChange={(e) => setColField(e.target.value === "" ? null : Number(e.target.value))}
                >
                  <option value="">(aucune)</option>
                  {fields.map((f) => <option key={f.i} value={f.i}>{f.label}</option>)}
                </select>
              </label>
              <label className="pivot-row">
                <span className="pivot-row__lbl">Valeurs</span>
                <select className="settings__select" value={valueField} onChange={(e) => setValueField(Number(e.target.value))}>
                  {fields.map((f) => <option key={f.i} value={f.i}>{f.label}</option>)}
                </select>
              </label>
              <label className="pivot-row">
                <span className="pivot-row__lbl">Agréger par</span>
                <select className="settings__select" value={agg} onChange={(e) => setAgg(e.target.value as PivotAgg)}>
                  {PIVOT_AGGS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </label>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
