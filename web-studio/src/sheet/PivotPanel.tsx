/** Volet latéral du tableau croisé dynamique persistant : champs, agrégation, dates, champs calculés, actualisation. */
import { useMemo, useState } from "react";
import { PIVOT_AGGS, type PivotAgg } from "./pivot";
import {
  DATE_GROUP_LABELS,
  applyPivotResult,
  buildPivot,
  pivotIsStale,
  readSource,
  sourceHeaders,
  type CalcField,
  type DateGroup,
  type PivotObject,
} from "./pivot-object";
import { indexToCol } from "./formula";
import type { SheetStore } from "./store";
import "./pivot-panel.css";

export default function PivotPanel({
  store,
  active,
  onClose,
}: {
  store: SheetStore;
  active: number;
  onClose: () => void;
}) {
  const sheet = store.wb.sheets[active]!;
  const p = sheet.pivot!;
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [calcName, setCalcName] = useState("");
  const [calcFormula, setCalcFormula] = useState("");
  const src = useMemo(() => readSource(store.wb, p.source), [store.wb, p.source]);
  const headers = useMemo(() => sourceHeaders(src?.headers ?? [], p.calcFields), [src, p.calcFields]);
  const stale = useMemo(() => pivotIsStale(store.wb, active), [store.wb, active]);

  /** Applique une nouvelle définition : recalcule le résultat et le range dans cette feuille. */
  const commit = (next: PivotObject) => {
    let error = "";
    let warn: string[] = [];
    store.transformWorkbook((w) => {
      const i = w.sheets.findIndex((s) => s.pivot?.id === next.id);
      if (i < 0) return w;
      const built = buildPivot(w, next, w.sheets[i]!.name);
      if ("error" in built) {
        error = built.error;
        return w;
      }
      warn = built.warnings;
      const sheets = w.sheets.slice();
      sheets[i] = applyPivotResult(sheets[i]!, built.sheet, next);
      return { ...w, sheets };
    });
    setErr(error);
    setMsg(error ? "" : warn.length ? warn.join(" ") : "Tableau actualisé.");
  };
  const patch = (x: Partial<PivotObject>) => commit({ ...p, ...x });
  const writable = store.canWrite;

  const addCalc = () => {
    const name = calcName.trim();
    if (!name || !calcFormula.trim()) return setErr("Nom et formule sont obligatoires.");
    if (headers.some((h) => h.toLowerCase() === name.toLowerCase())) return setErr("Un champ porte déjà ce nom.");
    patch({ calcFields: [...(p.calcFields ?? []), { name, formula: calcFormula.trim() } as CalcField] });
    setCalcName("");
    setCalcFormula("");
  };

  return (
    <aside className="pivotpanel" aria-label="Tableau croisé dynamique">
      <div className="pivotpanel__head">
        <strong>Tableau croisé dynamique</strong>
        <button className="icon-btn" onClick={onClose} aria-label="Fermer le volet" title="Fermer le volet">
          ×
        </button>
      </div>
      <p className="pivotpanel__src">
        Source : {p.source.sheet}!{indexToCol(p.source.c0)}
        {p.source.r0 + 1}:{indexToCol(p.source.c1)}
        {p.source.r1 + 1}
      </p>
      {stale && (
        <p role="status" className="pivotpanel__stale">
          La source a changé depuis le dernier calcul.
        </p>
      )}
      {(msg || err) && (
        <p role={err ? "alert" : "status"} className={err ? "pivotpanel__err" : "pivotpanel__msg"}>
          {err || msg}
        </p>
      )}
      <label className="dcx-field">
        <span>Lignes</span>
        <select value={p.rowField} disabled={!writable} onChange={(e) => patch({ rowField: e.target.value })}>
          {headers.map((h) => (
            <option key={h}>{h}</option>
          ))}
        </select>
      </label>
      <label className="dcx-field">
        <span>Regrouper les dates (lignes)</span>
        <select
          value={p.rowDateGroup ?? "none"}
          disabled={!writable}
          onChange={(e) => patch({ rowDateGroup: e.target.value as DateGroup })}
        >
          {(Object.keys(DATE_GROUP_LABELS) as DateGroup[]).map((k) => (
            <option key={k} value={k}>
              {DATE_GROUP_LABELS[k]}
            </option>
          ))}
        </select>
      </label>
      <label className="dcx-field">
        <span>Colonnes</span>
        <select
          value={p.colField ?? ""}
          disabled={!writable}
          onChange={(e) => patch({ colField: e.target.value || null })}
        >
          <option value="">(aucune)</option>
          {headers.map((h) => (
            <option key={h}>{h}</option>
          ))}
        </select>
      </label>
      {p.colField && (
        <label className="dcx-field">
          <span>Regrouper les dates (colonnes)</span>
          <select
            value={p.colDateGroup ?? "none"}
            disabled={!writable}
            onChange={(e) => patch({ colDateGroup: e.target.value as DateGroup })}
          >
            {(Object.keys(DATE_GROUP_LABELS) as DateGroup[]).map((k) => (
              <option key={k} value={k}>
                {DATE_GROUP_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="dcx-field">
        <span>Valeurs</span>
        <select value={p.valueField} disabled={!writable} onChange={(e) => patch({ valueField: e.target.value })}>
          {headers.map((h) => (
            <option key={h}>{h}</option>
          ))}
        </select>
      </label>
      <label className="dcx-field">
        <span>Agrégation</span>
        <select value={p.agg} disabled={!writable} onChange={(e) => patch({ agg: e.target.value as PivotAgg })}>
          {PIVOT_AGGS.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <label className="dcx-field">
        <span>Tri des lignes</span>
        <select
          value={p.sort ?? "none"}
          disabled={!writable}
          onChange={(e) => patch({ sort: e.target.value as PivotObject["sort"] })}
        >
          <option value="none">Ordre de la source</option>
          <option value="asc">Croissant</option>
          <option value="desc">Décroissant</option>
        </select>
      </label>
      <fieldset className="pivotpanel__calc">
        <legend>Champs calculés</legend>
        <ul>
          {(p.calcFields ?? []).map((f) => (
            <li key={f.name}>
              <code>
                {f.name} = {f.formula}
              </code>{" "}
              <button
                className="elx-mini"
                disabled={!writable}
                onClick={() => patch({ calcFields: (p.calcFields ?? []).filter((x) => x.name !== f.name) })}
              >
                Retirer
              </button>
            </li>
          ))}
        </ul>
        <input
          aria-label="Nom du champ calculé"
          placeholder="Nom (ex. Marge)"
          value={calcName}
          onChange={(e) => setCalcName(e.target.value)}
        />
        <input
          aria-label="Formule du champ calculé"
          placeholder="[Ventes]-[Coûts]"
          value={calcFormula}
          onChange={(e) => setCalcFormula(e.target.value)}
        />
        <button className="elx-mini" onClick={addCalc} disabled={!writable}>
          Ajouter le champ
        </button>
      </fieldset>
      <div className="pivotpanel__actions">
        <button className="elx-mini elx-mini--primary" onClick={() => commit(p)} disabled={!writable}>
          Actualiser
        </button>
      </div>
    </aside>
  );
}
