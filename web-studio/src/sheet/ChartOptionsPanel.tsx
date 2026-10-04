import "./chart.css";
/** Panneau de mise en forme d'un graphique : type, groupement, axes, légende, étiquettes, tendance, combiné. */
import type { ChartAxisFormat, ChartLegendPos, ChartOptions, ChartSpec, ChartType } from "./model";

export const CHART_TYPE_LABELS: Record<ChartType, string> = {
  bar: "Barres",
  line: "Lignes",
  area: "Aires",
  scatter: "Nuage de points",
  pie: "Secteurs",
  combo: "Combiné (barres + courbes)",
};

/** Retire les clés vides pour garder des options compactes (et un XLSX/CRDT minimal). */
export function cleanOptions(o: ChartOptions): ChartOptions | undefined {
  const out: ChartOptions = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === "" || v === false || (Array.isArray(v) && v.length === 0)) continue;
    if (typeof v === "number" && Number.isNaN(v)) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export default function ChartOptionsPanel({
  spec,
  seriesLabels,
  onChange,
  disabled,
}: {
  spec: ChartSpec;
  seriesLabels: string[];
  onChange: (next: ChartSpec) => void;
  disabled?: boolean;
}) {
  const o = spec.opts ?? {};
  const setOpts = (patch: Partial<ChartOptions>) => onChange({ ...spec, opts: cleanOptions({ ...o, ...patch }) });
  const num = (v: string): number | undefined =>
    v.trim() === "" || Number.isNaN(Number(v.replace(",", "."))) ? undefined : Number(v.replace(",", "."));
  const isCombo = spec.type === "combo";
  const stackable = spec.type === "bar" || spec.type === "area" || isCombo;

  return (
    <div className="chartopt" role="group" aria-label="Options du graphique">
      <label>
        Titre
        <input
          value={spec.title ?? ""}
          disabled={disabled}
          onChange={(e) => onChange({ ...spec, title: e.target.value || undefined })}
        />
      </label>
      <label>
        Type
        <select
          value={spec.type}
          disabled={disabled}
          onChange={(e) => onChange({ ...spec, type: e.target.value as ChartType })}
        >
          {(Object.keys(CHART_TYPE_LABELS) as ChartType[]).map((t) => (
            <option key={t} value={t}>
              {CHART_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      {stackable && (
        <label>
          Groupement
          <select
            value={o.grouping ?? "clustered"}
            disabled={disabled}
            onChange={(e) =>
              setOpts({
                grouping: e.target.value === "clustered" ? undefined : (e.target.value as ChartOptions["grouping"]),
              })
            }
          >
            <option value="clustered">Groupé</option>
            <option value="stacked">Empilé</option>
            <option value="percent">Empilé 100 %</option>
          </select>
        </label>
      )}
      {(spec.type === "bar" || isCombo) && (
        <label className="chartopt__check">
          <input
            type="checkbox"
            checked={!!o.horizontal}
            disabled={disabled}
            onChange={(e) => setOpts({ horizontal: e.target.checked })}
          />
          Barres horizontales
        </label>
      )}
      {spec.type !== "pie" && (
        <>
          <label>
            Titre axe X
            <input value={o.xTitle ?? ""} disabled={disabled} onChange={(e) => setOpts({ xTitle: e.target.value })} />
          </label>
          <label>
            Titre axe Y
            <input value={o.yTitle ?? ""} disabled={disabled} onChange={(e) => setOpts({ yTitle: e.target.value })} />
          </label>
          <label>
            Y min
            <input
              value={o.yMin ?? ""}
              inputMode="decimal"
              disabled={disabled}
              onChange={(e) => setOpts({ yMin: num(e.target.value) })}
            />
          </label>
          <label>
            Y max
            <input
              value={o.yMax ?? ""}
              inputMode="decimal"
              disabled={disabled}
              onChange={(e) => setOpts({ yMax: num(e.target.value) })}
            />
          </label>
          <label>
            Format
            <select
              value={o.yFormat ?? "general"}
              disabled={disabled}
              onChange={(e) =>
                setOpts({ yFormat: e.target.value === "general" ? undefined : (e.target.value as ChartAxisFormat) })
              }
            >
              <option value="general">Standard</option>
              <option value="int">Entier</option>
              <option value="decimal">2 décimales</option>
              <option value="percent">Pourcentage</option>
              <option value="currency">Monétaire (€)</option>
            </select>
          </label>
        </>
      )}
      <label>
        Légende
        <select
          value={o.legend ?? ""}
          disabled={disabled}
          onChange={(e) => setOpts({ legend: (e.target.value || undefined) as ChartLegendPos | undefined })}
        >
          <option value="">Automatique</option>
          <option value="none">Aucune</option>
          <option value="top">Haut</option>
          <option value="bottom">Bas</option>
          <option value="right">Droite</option>
        </select>
      </label>
      <label className="chartopt__check">
        <input
          type="checkbox"
          checked={!!o.dataLabels}
          disabled={disabled}
          onChange={(e) => setOpts({ dataLabels: e.target.checked })}
        />
        Étiquettes de données
      </label>
      {(spec.type === "line" || isCombo) && (
        <label className="chartopt__check">
          <input
            type="checkbox"
            checked={!!o.smooth}
            disabled={disabled}
            onChange={(e) => setOpts({ smooth: e.target.checked })}
          />
          Courbes lissées
        </label>
      )}
      {spec.type !== "pie" && (
        <>
          <label>
            Courbe de tendance
            <select
              value={o.trendline?.type ?? ""}
              disabled={disabled}
              onChange={(e) =>
                setOpts({
                  trendline: e.target.value
                    ? { ...(o.trendline ?? {}), type: e.target.value as "linear" | "poly" | "avg" }
                    : undefined,
                })
              }
            >
              <option value="">Aucune</option>
              <option value="linear">Linéaire</option>
              <option value="poly">Polynomiale</option>
              <option value="avg">Moyenne mobile</option>
            </select>
          </label>
          {o.trendline && seriesLabels.length > 1 && (
            <label>
              Série suivie
              <select
                value={o.trendline.series ?? 0}
                disabled={disabled}
                onChange={(e) => setOpts({ trendline: { ...o.trendline!, series: Number(e.target.value) } })}
              >
                {seriesLabels.map((l, i) => (
                  <option key={i} value={i}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          )}
          {o.trendline?.type === "poly" && (
            <label>
              Ordre
              <input
                type="number"
                min={2}
                max={6}
                value={o.trendline.order ?? 2}
                disabled={disabled}
                onChange={(e) => setOpts({ trendline: { ...o.trendline!, order: Number(e.target.value) } })}
              />
            </label>
          )}
          {o.trendline?.type === "avg" && (
            <label>
              Période
              <input
                type="number"
                min={2}
                max={50}
                value={o.trendline.period ?? 3}
                disabled={disabled}
                onChange={(e) => setOpts({ trendline: { ...o.trendline!, period: Number(e.target.value) } })}
              />
            </label>
          )}
        </>
      )}
      {isCombo && (
        <fieldset className="chartopt__series">
          <legend>Séries</legend>
          {seriesLabels.map((l, i) => {
            const kind = o.seriesTypes?.[i] ?? (i === 0 ? "bar" : "line");
            return (
              <div key={i} className="chartopt__row">
                <span>{l}</span>
                <select
                  aria-label={`Type de la série ${l}`}
                  value={kind}
                  disabled={disabled}
                  onChange={(e) => {
                    const types = seriesLabels.map((_, k) => o.seriesTypes?.[k] ?? (k === 0 ? "bar" : "line"));
                    types[i] = e.target.value as "bar" | "line";
                    setOpts({ seriesTypes: types });
                  }}
                >
                  <option value="bar">Barres</option>
                  <option value="line">Courbe</option>
                </select>
                <label className="chartopt__check">
                  <input
                    type="checkbox"
                    checked={!!o.secondary?.includes(i)}
                    disabled={disabled}
                    onChange={(e) => {
                      const set = new Set(o.secondary ?? []);
                      if (e.target.checked) set.add(i);
                      else set.delete(i);
                      setOpts({ secondary: [...set].sort() });
                    }}
                  />
                  Axe secondaire
                </label>
              </div>
            );
          })}
          <label>
            Titre axe secondaire
            <input value={o.y2Title ?? ""} disabled={disabled} onChange={(e) => setOpts({ y2Title: e.target.value })} />
          </label>
        </fieldset>
      )}
    </div>
  );
}
