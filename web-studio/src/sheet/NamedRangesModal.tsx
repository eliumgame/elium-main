import { useState } from "react";
import { Trash2, Plus } from "lucide-react";
import { Modal, Button } from "../ui/components";
import type { NamedRange } from "./model";

interface Props {
  rangeLabel: string; // the current selection (absolute, sheet-qualified) the new name will point to
  names: NamedRange[];
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  onClose: () => void;
}

// A valid name is an identifier that does NOT look like a cell address (Excel rule).
const isValidName = (n: string) =>
  /^[A-Za-z_][A-Za-z0-9_.]*$/.test(n) && !/^\$?[A-Za-z]+\$?[0-9]+$/.test(n);

/**
 * Named-ranges manager: give the current selection a name usable in formulas
 * (e.g. `=SUM(SALAIRES)`), and review/delete existing names. Names are
 * workbook-scoped and stored as absolute, sheet-qualified references.
 */
export default function NamedRangesModal({ rangeLabel, names, onAdd, onRemove, onClose }: Props) {
  const [name, setName] = useState("");
  const taken = names.some((n) => n.name.toUpperCase() === name.trim().toUpperCase());
  const valid = isValidName(name.trim());
  const canAdd = name.trim() !== "" && valid;

  const add = () => {
    if (!canAdd) return;
    onAdd(name.trim());
    setName("");
  };

  return (
    <Modal title="Plages nommées" onClose={onClose} footer={<Button onClick={onClose}>Fermer</Button>}>
      <div className="settings">
        <section className="settings__section">
          <h3 className="settings__title">Nommer la sélection {rangeLabel}</h3>
          <div className="cf-form">
            <input
              className="settings__input" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="Nom (ex. TVA, SALAIRES)" onKeyDown={(e) => { if (e.key === "Enter") add(); }}
            />
            <Button size="sm" variant="primary" onClick={add} disabled={!canAdd}><Plus size={14} /> {taken ? "Redéfinir" : "Ajouter"}</Button>
          </div>
          {name.trim() !== "" && !valid && (
            <p className="cf-empty" style={{ color: "var(--danger)" }}>
              Nom invalide : commencez par une lettre, sans espace, et évitez ce qui ressemble à une adresse (A1).
            </p>
          )}
        </section>

        <section className="settings__section">
          <h3 className="settings__title">Noms définis ({names.length})</h3>
          {names.length === 0 ? (
            <p className="cf-empty">Aucun nom. Sélectionnez une plage et nommez-la pour l'utiliser dans vos formules.</p>
          ) : (
            <ul className="cf-rule-list">
              {names.map((n) => (
                <li key={n.name} className="cf-rule">
                  <span className="cf-rule__desc"><strong>{n.name}</strong> → {n.ref}</span>
                  <button className="icon-btn icon-btn--danger" title="Supprimer le nom" onClick={() => onRemove(n.name)}><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}
