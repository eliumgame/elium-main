import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { Modal } from "../../ui/components";
import type { FieldCalculation, FieldFormat, FieldKind, FieldProps } from "../model/types";
import { parseFieldScripts } from "../core/forms/afscripts";

/**
 * « Propriétés du champ », Acrobat's tabs: Général, Aspect, Options, and for a
 * text field Format, Validation, Calcul. Returns only what changed (a file's
 * field then gets exactly those entries rewritten).
 */

export interface FieldPropertiesProps {
  kind: FieldKind;
  name: string;
  initial: FieldProps;
  /** Names of the other fields, for « Calcul ». */
  otherFields: readonly string[];
  /** Names already taken (a rename must not collide). */
  takenNames: ReadonlySet<string>;
  onConfirm: (v: { name: string; props: FieldProps }) => void;
  onClose: () => void;
}

type Tab = "general" | "look" | "options" | "format" | "validate" | "calculate";

const KIND_TITLE: Record<FieldKind, string> = {
  text: "champ texte",
  checkbox: "case à cocher",
  radio: "bouton radio",
  dropdown: "liste déroulante",
  listbox: "zone de liste",
  signature: "champ de signature",
  button: "bouton",
};

const DATE_MASKS = ["dd/mm/yyyy", "dd/mm/yy", "d mmmm yyyy", "yyyy-mm-dd", "mm/dd/yyyy", "mmmm yyyy"];

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** The keys of `next` that differ from `prev`. */
export function propsDiff(prev: FieldProps, next: FieldProps): FieldProps {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(next) as (keyof FieldProps)[]) {
    if (!same(prev[k], next[k])) out[k] = next[k];
  }
  return out as FieldProps;
}

export default function FieldPropertiesDialog(p: FieldPropertiesProps) {
  const [tab, setTab] = useState<Tab>("general");
  const [name, setName] = useState(p.name);
  const [v, setV] = useState<FieldProps>(() => ({
    tooltip: "",
    required: false,
    readOnly: false,
    hidden: false,
    noPrint: false,
    fontSize: 0,
    align: "left",
    format: { kind: "none" },
    validate: null,
    calculate: null,
    ...p.initial,
  }));
  const set = (patch: Partial<FieldProps>) => setV((s) => ({ ...s, ...patch }));
  const isText = p.kind === "text";
  const isList = p.kind === "dropdown" || p.kind === "listbox";
  const isBox = p.kind === "checkbox" || p.kind === "radio";

  const trimmed = name.trim();
  const nameError = !trimmed
    ? "Le nom est obligatoire."
    : trimmed !== p.name && p.takenNames.has(trimmed)
      ? "Ce nom est déjà utilisé."
      : null;

  const tabs: [Tab, string][] = [
    ["general", "Général"],
    ["look", "Aspect"],
    ["options", "Options"],
    ...(isText
      ? ([
          ["format", "Format"],
          ["validate", "Validation"],
          ["calculate", "Calcul"],
        ] as [Tab, string][])
      : []),
  ];

  const initialFull = useMemo(() => ({ ...v }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const confirm = () => {
    if (nameError) return;
    p.onConfirm({ name: trimmed, props: propsDiff(initialFull, v) });
  };

  return (
    <Modal
      title={`Propriétés du ${KIND_TITLE[p.kind]}`}
      onClose={p.onClose}
      footer={
        <>
          <button className="eb eb--outline eb--sm" onClick={p.onClose}>
            Annuler
          </button>
          <button className="eb eb--primary eb--sm" onClick={confirm} disabled={!!nameError}>
            Appliquer
          </button>
        </>
      }
    >
      <div className="pdfx-tabs" role="tablist" aria-label="Propriétés">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={`pdfx-tab ${tab === id ? "is-active" : ""}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="pdfx-form" role="tabpanel">
        {tab === "general" && (
          <>
            <label className="pdfx-form__row">
              <span>Nom</span>
              <input value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError} />
            </label>
            {nameError && <p className="pdfx-form__error">{nameError}</p>}
            <label className="pdfx-form__row">
              <span>Info-bulle</span>
              <input value={v.tooltip ?? ""} onChange={(e) => set({ tooltip: e.target.value })} />
            </label>
            <label className="pdfx-form__row">
              <span>Visibilité</span>
              <select
                value={v.hidden ? "hidden" : v.noPrint ? "screen" : "visible"}
                onChange={(e) => set({ hidden: e.target.value === "hidden", noPrint: e.target.value === "screen" })}
              >
                <option value="visible">Visible</option>
                <option value="screen">Visible, non imprimé</option>
                <option value="hidden">Masqué</option>
              </select>
            </label>
            <label className="pdfx-check pdfx-check--block">
              <input type="checkbox" checked={!!v.readOnly} onChange={(e) => set({ readOnly: e.target.checked })} />
              Lecture seule
            </label>
            {p.kind !== "button" && (
              <label className="pdfx-check pdfx-check--block">
                <input type="checkbox" checked={!!v.required} onChange={(e) => set({ required: e.target.checked })} />
                Obligatoire
              </label>
            )}
          </>
        )}

        {tab === "look" && (
          <>
            <label className="pdfx-form__row">
              <span>Taille du texte</span>
              <select value={String(v.fontSize ?? 0)} onChange={(e) => set({ fontSize: Number(e.target.value) })}>
                <option value="0">Automatique</option>
                {[6, 8, 9, 10, 11, 12, 14, 16, 18, 24].map((n) => (
                  <option key={n} value={n}>
                    {n} pt
                  </option>
                ))}
              </select>
            </label>
            {(isText || isList) && (
              <label className="pdfx-form__row">
                <span>Alignement</span>
                <select
                  value={v.align ?? "left"}
                  onChange={(e) => set({ align: e.target.value as FieldProps["align"] })}
                >
                  <option value="left">Gauche</option>
                  <option value="center">Centre</option>
                  <option value="right">Droite</option>
                </select>
              </label>
            )}
          </>
        )}

        {tab === "options" && (
          <>
            {isText && (
              <>
                <label className="pdfx-form__row">
                  <span>Valeur par défaut</span>
                  <input
                    value={typeof v.defaultValue === "string" ? v.defaultValue : ""}
                    onChange={(e) => set({ defaultValue: e.target.value })}
                  />
                </label>
                <label className="pdfx-check pdfx-check--block">
                  <input
                    type="checkbox"
                    checked={!!v.multiLine}
                    onChange={(e) => set({ multiLine: e.target.checked })}
                  />
                  Plusieurs lignes
                </label>
                <label className="pdfx-check pdfx-check--block">
                  <input type="checkbox" checked={!!v.password} onChange={(e) => set({ password: e.target.checked })} />
                  Mot de passe (caractères masqués)
                </label>
                <label className="pdfx-form__row">
                  <span>Nombre maximal de caractères</span>
                  <input
                    type="number"
                    min={0}
                    value={v.maxLen ?? 0}
                    onChange={(e) => set({ maxLen: Number(e.target.value) || null })}
                  />
                </label>
                <label className="pdfx-check pdfx-check--block">
                  <input
                    type="checkbox"
                    checked={!!v.comb}
                    disabled={!v.maxLen}
                    onChange={(e) => set({ comb: e.target.checked })}
                  />
                  Répartir en cases (peigne)
                </label>
              </>
            )}
            {isBox && (
              <label className="pdfx-form__row">
                <span>Valeur d'exportation</span>
                <input value={v.exportValue ?? ""} onChange={(e) => set({ exportValue: e.target.value })} />
              </label>
            )}
            {p.kind === "checkbox" && (
              <label className="pdfx-check pdfx-check--block">
                <input
                  type="checkbox"
                  checked={v.defaultValue !== undefined && v.defaultValue !== "Off" && v.defaultValue !== false}
                  onChange={(e) => set({ defaultValue: e.target.checked ? v.exportValue || "Oui" : "Off" })}
                />
                Cochée par défaut
              </label>
            )}
            {isList && <ListItems v={v} set={set} kind={p.kind} />}
          </>
        )}

        {tab === "format" && isText && (
          <FormatTab value={v.format ?? { kind: "none" }} onChange={(format) => set({ format })} />
        )}

        {tab === "validate" && isText && (
          <>
            <label className="pdfx-check pdfx-check--block">
              <input
                type="checkbox"
                checked={!!v.validate}
                onChange={(e) => set({ validate: e.target.checked ? { min: 0 } : null })}
              />
              La valeur doit être comprise dans une plage
            </label>
            {v.validate && (
              <>
                <label className="pdfx-form__row">
                  <span>Supérieure ou égale à</span>
                  <input
                    type="number"
                    value={v.validate.min ?? ""}
                    onChange={(e) =>
                      set({
                        validate: { ...v.validate, min: e.target.value === "" ? undefined : Number(e.target.value) },
                      })
                    }
                  />
                </label>
                <label className="pdfx-form__row">
                  <span>Inférieure ou égale à</span>
                  <input
                    type="number"
                    value={v.validate.max ?? ""}
                    onChange={(e) =>
                      set({
                        validate: { ...v.validate, max: e.target.value === "" ? undefined : Number(e.target.value) },
                      })
                    }
                  />
                </label>
              </>
            )}
          </>
        )}

        {tab === "calculate" && isText && (
          <CalculateTab
            value={v.calculate ?? null}
            fields={p.otherFields.filter((n) => n !== p.name)}
            onChange={(calculate) => set({ calculate })}
          />
        )}
      </div>
    </Modal>
  );
}

function ListItems({ v, set, kind }: { v: FieldProps; set: (p: Partial<FieldProps>) => void; kind: FieldKind }) {
  const items = v.options ?? [];
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const add = () => {
    const l = label.trim();
    if (!l) return;
    set({ options: [...items, { label: l, value: value.trim() || l }] });
    setLabel("");
    setValue("");
  };
  const move = (i: number, d: -1 | 1) => {
    const next = items.slice();
    const [it] = next.splice(i, 1);
    next.splice(i + d, 0, it);
    set({ options: next });
  };
  const def = typeof v.defaultValue === "string" ? v.defaultValue : "";
  return (
    <>
      <div className="pdfx-form__row">
        <span>Élément</span>
        <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Libellé affiché" />
      </div>
      <div className="pdfx-form__row">
        <span>Valeur d'exportation</span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="(le libellé)"
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
      </div>
      <button className="eb eb--outline eb--sm" onClick={add} disabled={!label.trim()}>
        <Plus size={14} /> Ajouter
      </button>
      <ul className="pdfx-form__list" aria-label="Éléments de la liste">
        {items.map((o, i) => (
          <li key={`${o.value}-${i}`}>
            <label>
              <input
                type="radio"
                name="field-default"
                checked={def === o.value}
                onChange={() => set({ defaultValue: o.value })}
                aria-label={`Valeur par défaut : ${o.label}`}
              />
              {o.label}
              {o.value !== o.label && <em> ({o.value})</em>}
            </label>
            <button className="eb eb--ghost eb--sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Monter">
              <ArrowUp size={13} />
            </button>
            <button
              className="eb eb--ghost eb--sm"
              disabled={i === items.length - 1}
              onClick={() => move(i, 1)}
              aria-label="Descendre"
            >
              <ArrowDown size={13} />
            </button>
            <button
              className="eb eb--ghost eb--sm"
              onClick={() => set({ options: items.filter((_, j) => j !== i) })}
              aria-label={`Supprimer ${o.label}`}
            >
              <Trash2 size={13} />
            </button>
          </li>
        ))}
      </ul>
      {kind === "dropdown" && (
        <label className="pdfx-check pdfx-check--block">
          <input type="checkbox" checked={!!v.editable} onChange={(e) => set({ editable: e.target.checked })} />
          Autoriser la saisie d'un texte personnalisé
        </label>
      )}
      {kind === "listbox" && (
        <label className="pdfx-check pdfx-check--block">
          <input type="checkbox" checked={!!v.multiSelect} onChange={(e) => set({ multiSelect: e.target.checked })} />
          Sélection multiple
        </label>
      )}
    </>
  );
}

function FormatTab({ value, onChange }: { value: FieldFormat; onChange: (f: FieldFormat) => void }) {
  const pick = (kind: FieldFormat["kind"]) => {
    switch (kind) {
      case "none":
        return onChange({ kind: "none" });
      case "number":
        return onChange({
          kind: "number",
          decimals: 2,
          sepStyle: 2,
          negStyle: 0,
          currency: "",
          currencyPrepend: false,
        });
      case "percent":
        return onChange({ kind: "percent", decimals: 0, sepStyle: 2 });
      case "date":
        return onChange({ kind: "date", pattern: "dd/mm/yyyy" });
      case "time":
        return onChange({ kind: "time", style: 0 });
      case "custom":
        return onChange({ kind: "custom", keystroke: "", format: "" });
    }
  };
  return (
    <>
      <label className="pdfx-form__row">
        <span>Catégorie</span>
        <select value={value.kind} onChange={(e) => pick(e.target.value as FieldFormat["kind"])}>
          <option value="none">Aucun</option>
          <option value="number">Nombre</option>
          <option value="percent">Pourcentage</option>
          <option value="date">Date</option>
          <option value="time">Heure</option>
          <option value="custom">Personnalisé (JavaScript)</option>
        </select>
      </label>
      {(value.kind === "number" || value.kind === "percent") && (
        <>
          <label className="pdfx-form__row">
            <span>Décimales</span>
            <input
              type="number"
              min={0}
              max={10}
              value={value.decimals}
              onChange={(e) => onChange({ ...value, decimals: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
          <label className="pdfx-form__row">
            <span>Séparateurs</span>
            <select
              value={value.sepStyle}
              onChange={(e) => onChange({ ...value, sepStyle: Number(e.target.value) as 0 | 1 | 2 | 3 | 4 })}
            >
              <option value={2}>1.234,56</option>
              <option value={3}>1234,56</option>
              <option value={0}>1,234.56</option>
              <option value={1}>1234.56</option>
              <option value={4}>1'234.56</option>
            </select>
          </label>
        </>
      )}
      {value.kind === "number" && (
        <>
          <label className="pdfx-form__row">
            <span>Symbole monétaire</span>
            <input
              value={value.currency}
              onChange={(e) => onChange({ ...value, currency: e.target.value })}
              placeholder=" €"
            />
          </label>
          <label className="pdfx-check pdfx-check--block">
            <input
              type="checkbox"
              checked={value.currencyPrepend}
              onChange={(e) => onChange({ ...value, currencyPrepend: e.target.checked })}
            />
            Symbole avant le nombre
          </label>
          <label className="pdfx-form__row">
            <span>Nombres négatifs</span>
            <select
              value={value.negStyle}
              onChange={(e) => onChange({ ...value, negStyle: Number(e.target.value) as 0 | 1 | 2 | 3 })}
            >
              <option value={0}>-1 234,56</option>
              <option value={1}>1 234,56 en rouge</option>
              <option value={2}>(1 234,56)</option>
              <option value={3}>(1 234,56) en rouge</option>
            </select>
          </label>
        </>
      )}
      {value.kind === "date" && (
        <label className="pdfx-form__row">
          <span>Format</span>
          <input
            list="pdfx-date-masks"
            value={value.pattern}
            onChange={(e) => onChange({ ...value, pattern: e.target.value })}
          />
          <datalist id="pdfx-date-masks">
            {DATE_MASKS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
      )}
      {value.kind === "time" && (
        <label className="pdfx-form__row">
          <span>Format</span>
          <select
            value={value.style}
            onChange={(e) => onChange({ ...value, style: Number(e.target.value) as 0 | 1 | 2 | 3 })}
          >
            <option value={0}>HH:MM</option>
            <option value={1}>h:MM tt</option>
            <option value={2}>HH:MM:ss</option>
            <option value={3}>h:MM:ss tt</option>
          </select>
        </label>
      )}
      {value.kind === "custom" && (
        <>
          <label className="pdfx-form__row pdfx-form__row--stack">
            <span>Script de format</span>
            <textarea
              rows={3}
              value={value.format ?? ""}
              onChange={(e) => onChange({ ...value, format: e.target.value })}
            />
          </label>
          <label className="pdfx-form__row pdfx-form__row--stack">
            <span>Script de frappe</span>
            <textarea
              rows={3}
              value={value.keystroke ?? ""}
              onChange={(e) => onChange({ ...value, keystroke: e.target.value })}
            />
          </label>
        </>
      )}
    </>
  );
}

function CalculateTab({
  value,
  fields,
  onChange,
}: {
  value: FieldCalculation | null;
  fields: readonly string[];
  onChange: (c: FieldCalculation | null) => void;
}) {
  const kind = value?.kind ?? "none";
  return (
    <>
      <label className="pdfx-form__row">
        <span>Valeur</span>
        <select
          value={kind}
          onChange={(e) => {
            const k = e.target.value;
            if (k === "none") onChange(null);
            else if (k === "simple") onChange({ kind: "simple", op: "SUM", fields: [] });
            else onChange({ kind: "custom", script: "" });
          }}
        >
          <option value="none">Non calculée</option>
          <option value="simple">Calculée à partir d'autres champs</option>
          <option value="custom">Script de calcul personnalisé</option>
        </select>
      </label>
      {value?.kind === "simple" && (
        <>
          <label className="pdfx-form__row">
            <span>Opération</span>
            <select value={value.op} onChange={(e) => onChange({ ...value, op: e.target.value as typeof value.op })}>
              <option value="SUM">Somme (+)</option>
              <option value="PRD">Produit (×)</option>
              <option value="AVG">Moyenne</option>
              <option value="MIN">Minimum</option>
              <option value="MAX">Maximum</option>
            </select>
          </label>
          <fieldset className="pdfx-form__set">
            <legend>Des champs</legend>
            {fields.map((n) => (
              <label key={n} className="pdfx-check pdfx-check--block">
                <input
                  type="checkbox"
                  checked={value.fields.includes(n)}
                  onChange={(e) =>
                    onChange({
                      ...value,
                      fields: e.target.checked ? [...value.fields, n] : value.fields.filter((x) => x !== n),
                    })
                  }
                />
                {n}
              </label>
            ))}
            {!fields.length && <p>Aucun autre champ dans ce document.</p>}
          </fieldset>
        </>
      )}
      {value?.kind === "custom" && (
        <label className="pdfx-form__row pdfx-form__row--stack">
          <span>Script (JavaScript Acrobat)</span>
          <textarea rows={5} value={value.script} onChange={(e) => onChange({ ...value, script: e.target.value })} />
        </label>
      )}
    </>
  );
}

/** What pdf.js reports about a widget (`getAnnotations()`), the part the dialog reads. */
export interface PdfjsWidgetData {
  fieldFlags?: number;
  annotationFlags?: number;
  alternativeText?: string;
  maxLen?: number | null;
  textAlignment?: number | null;
  defaultAppearanceData?: { fontSize?: number };
  options?: { exportValue?: string; displayValue?: string }[];
  exportValue?: string;
  buttonValue?: string;
  defaultFieldValue?: unknown;
}

/** A file field's current settings, as the dialog shows them. */
export function propsFromPdfjs(a: PdfjsWidgetData, actions?: Record<string, string[]> | null): FieldProps {
  const ff = a.fieldFlags ?? 0;
  const af = a.annotationFlags ?? 4;
  const scripts = parseFieldScripts(actions);
  const dv = a.defaultFieldValue;
  return {
    tooltip: a.alternativeText ?? "",
    readOnly: !!(ff & 1),
    required: !!(ff & 2),
    hidden: !!(af & 2),
    noPrint: !(af & 4) && !(af & 2),
    multiLine: !!(ff & (1 << 12)),
    password: !!(ff & (1 << 13)),
    comb: !!(ff & (1 << 24)),
    maxLen: a.maxLen && a.maxLen > 0 ? a.maxLen : null,
    fontSize: a.defaultAppearanceData?.fontSize ?? 0,
    align: (["left", "center", "right"] as const)[a.textAlignment ?? 0] ?? "left",
    options: a.options?.map((o) => ({
      value: o.exportValue ?? o.displayValue ?? "",
      label: o.displayValue ?? o.exportValue ?? "",
    })),
    editable: !!(ff & (1 << 18)),
    multiSelect: !!(ff & (1 << 21)),
    exportValue: a.exportValue ?? a.buttonValue,
    defaultValue: Array.isArray(dv)
      ? dv.length > 1
        ? dv.map(String)
        : String(dv[0] ?? "")
      : dv == null
        ? ""
        : String(dv),
    format: scripts.format,
    validate: scripts.validate ?? null,
    calculate: scripts.calculate,
  };
}
