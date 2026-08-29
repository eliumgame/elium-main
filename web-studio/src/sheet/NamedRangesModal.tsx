import { useState } from "react";
import { Trash2, Plus } from "lucide-react";
import SheetModal from "./SheetModal";
import type { NamedRange } from "./model";

interface Props {
  rangeLabel: string; // the current selection (absolute, sheet-qualified) the new name will point to
  names: NamedRange[];
  onAdd: (name: string) => void;
  onRemove: (name: string) => void;
  onClose: () => void;
}

// A valid name is an identifier that does NOT look like a cell address (Excel rule).
const isValidName = (n: string) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(n) && !/^\$?[A-Za-z]+\$?[0-9]+$/.test(n);

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
    <SheetModal
      title="Plages nommées"
      onClose={onClose}
      footer={
        <button className="elx-mini" onClick={onClose}>
          Fermer
        </button>
      }
    >
      <section className="dcx-modal__section">
        <h3 className="dcx-modal__section-title">Nommer la sélection {rangeLabel}</h3>
        <div className="dcx-inline">
          <input
            className="elx-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Nom (ex. TVA, SALAIRES)"
            onKeyDown={(e) => {
              if (e.key === "Enter") add();
            }}
          />
          <button className="elx-mini elx-mini--primary" onClick={add} disabled={!canAdd}>
            <Plus size={14} /> {taken ? "Redéfinir" : "Ajouter"}
          </button>
        </div>
        {name.trim() !== "" && !valid && (
          <p className="elx-empty" style={{ color: "var(--el-danger)", padding: "4px 0", textAlign: "left" }}>
            Nom invalide : commencez par une lettre, sans espace, et évitez ce qui ressemble à une adresse (A1).
          </p>
        )}
      </section>

      <section className="dcx-modal__section">
        <h3 className="dcx-modal__section-title">Noms définis ({names.length})</h3>
        {names.length === 0 ? (
          <p className="elx-empty">Aucun nom. Sélectionnez une plage et nommez-la pour l'utiliser dans vos formules.</p>
        ) : (
          <ul className="cf-rule-list">
            {names.map((n) => (
              <li key={n.name} className="cf-rule">
                <span className="cf-rule__desc">
                  <strong>{n.name}</strong> → {n.ref}
                </span>
                <button className="elx-icon elx-icon--danger" title="Supprimer le nom" onClick={() => onRemove(n.name)}>
                  <Trash2 size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </SheetModal>
  );
}
