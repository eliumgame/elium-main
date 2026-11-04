import { useState } from "react";
import { ArrowLeft, ArrowRight, Copy, Plus, Trash2 } from "lucide-react";
import { MAX_CHART_POINTS, MAX_CHART_SERIES, type ChartData, type ChartKind } from "./model";
import {
  addPoint,
  addSeries,
  changeKind,
  chartColumns,
  columnLabel,
  duplicateSeries,
  moveSeries,
  parseChartNumber,
  removePoint,
  removeSeries,
  renameSeries,
  setLabel,
  setStacked,
  setValue,
  usedColumns,
} from "./chart-edit";

/** Tableau éditable « étiquettes × séries » d'un graphique de présentation. */
export default function ChartDataPanel({ chart, onChange }: { chart: ChartData; onChange: (c: ChartData) => void }) {
  // Saisies numériques en cours (clé « série:point ») : on ne valide qu'un nombre correct.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [status, setStatus] = useState("");
  const isPie = chart.kind === "pie";
  const cols = usedColumns(chart);
  const total = chartColumns(chart).length;
  const hidden = isPie ? total - 1 : 0;

  const apply = (next: ChartData | null, refusal: string) => {
    if (!next) {
      setStatus(refusal);
      return;
    }
    setStatus("");
    onChange(next);
  };
  const onKind = (kind: ChartKind) => {
    const r = changeKind(chart, kind);
    setStatus(r.warning ?? "");
    onChange(r.chart);
  };
  const dropDraft = (key: string) =>
    setDrafts((d) => {
      const { [key]: _gone, ...rest } = d;
      void _gone;
      return rest;
    });
  const onValue = (s: number, i: number, raw: string) => {
    const key = `${s}:${i}`;
    setDrafts((d) => ({ ...d, [key]: raw }));
    const n = parseChartNumber(raw);
    if (n === null) {
      setStatus(raw.trim() === "" ? "" : `« ${raw} » n'est pas un nombre : saisissez par exemple 12 ou 12,5.`);
      return;
    }
    setStatus("");
    onChange(setValue(chart, s, i, n));
  };

  return (
    <div className="sv-chart-panel">
      <label className="sv-anim-row">
        <span>Type</span>
        <select className="input" value={chart.kind} onChange={(e) => onKind(e.target.value as ChartKind)}>
          <option value="bar">Barres</option>
          <option value="line">Courbe</option>
          <option value="pie">Camembert</option>
        </select>
      </label>
      {chart.kind === "bar" && (
        <label className="sv-chart-check">
          <input
            type="checkbox"
            checked={!!chart.stacked}
            onChange={(e) => onChange(setStacked(chart, e.target.checked))}
          />
          <span>Barres empilées</span>
        </label>
      )}
      {hidden > 0 && (
        <p className="sv-chart-note">
          Camembert : seule la première série est utilisée ({hidden} autre{hidden > 1 ? "s" : ""} conservée
          {hidden > 1 ? "s" : ""} dans le graphique).
        </p>
      )}
      <div className="sv-chart-scroll">
        <table className="sv-chart-table">
          <caption className="sv-sr-only">
            Données du graphique : une ligne par étiquette, une colonne par série
          </caption>
          <thead>
            <tr>
              <th scope="col">Étiquette</th>
              {cols.map((col, s) => (
                <th scope="col" key={s}>
                  <input
                    className="input"
                    value={col.name}
                    placeholder={columnLabel(col, s)}
                    aria-label={`Nom de la série ${s + 1}`}
                    onChange={(e) => onChange(renameSeries(chart, s, e.target.value))}
                  />
                  {!isPie && (
                    <span className="sv-chart-tools">
                      <button
                        className="icon-btn"
                        title="Déplacer la série vers la gauche"
                        aria-label={`Déplacer la série ${s + 1} vers la gauche`}
                        disabled={s === 0}
                        onClick={() => apply(moveSeries(chart, s, -1), "")}
                      >
                        <ArrowLeft size={12} />
                      </button>
                      <button
                        className="icon-btn"
                        title="Déplacer la série vers la droite"
                        aria-label={`Déplacer la série ${s + 1} vers la droite`}
                        disabled={s === cols.length - 1}
                        onClick={() => apply(moveSeries(chart, s, 1), "")}
                      >
                        <ArrowRight size={12} />
                      </button>
                      <button
                        className="icon-btn"
                        title="Dupliquer la série"
                        aria-label={`Dupliquer la série ${s + 1}`}
                        onClick={() =>
                          apply(duplicateSeries(chart, s), `Maximum ${MAX_CHART_SERIES} séries par graphique.`)
                        }
                      >
                        <Copy size={12} />
                      </button>
                      <button
                        className="icon-btn icon-btn--danger"
                        title="Supprimer la série"
                        aria-label={`Supprimer la série ${s + 1}`}
                        disabled={total <= 1}
                        onClick={() => apply(removeSeries(chart, s), "Un graphique garde au moins une série.")}
                      >
                        <Trash2 size={12} />
                      </button>
                    </span>
                  )}
                </th>
              ))}
              <th scope="col">
                <span className="sv-sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {chart.labels.map((lb, i) => (
              <tr key={i}>
                <td>
                  <input
                    className="input"
                    value={lb}
                    placeholder="Libellé"
                    aria-label={`Étiquette du point ${i + 1}`}
                    onChange={(e) => onChange(setLabel(chart, i, e.target.value))}
                  />
                </td>
                {cols.map((col, s) => {
                  const key = `${s}:${i}`;
                  const draft = drafts[key];
                  const invalid = draft !== undefined && draft.trim() !== "" && parseChartNumber(draft) === null;
                  return (
                    <td key={s}>
                      <input
                        className="input sv-num"
                        inputMode="decimal"
                        value={draft ?? String(col.values[i] ?? 0).replace(".", ",")}
                        aria-label={`${columnLabel(col, s)}, ${lb || `point ${i + 1}`}`}
                        aria-invalid={invalid || undefined}
                        onChange={(e) => onValue(s, i, e.target.value)}
                        onBlur={() => dropDraft(key)}
                      />
                    </td>
                  );
                })}
                <td>
                  <button
                    className="icon-btn icon-btn--danger"
                    title="Retirer le point"
                    aria-label={`Retirer le point ${i + 1}`}
                    disabled={chart.labels.length <= 1}
                    onClick={() => apply(removePoint(chart, i), "Un graphique garde au moins un point.")}
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="sv-chart-actions">
        <button
          className="eb eb--sm eb--outline"
          onClick={() => apply(addPoint(chart), `Maximum ${MAX_CHART_POINTS} points par graphique.`)}
        >
          <Plus size={13} /> Point
        </button>
        {!isPie && (
          <button
            className="eb eb--sm eb--outline"
            onClick={() => apply(addSeries(chart), `Maximum ${MAX_CHART_SERIES} séries par graphique.`)}
          >
            <Plus size={13} /> Série
          </button>
        )}
      </div>
      <p className="sv-chart-status" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
