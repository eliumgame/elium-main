import type { ChartType } from "./model";

const PALETTE = ["#1d4ed8", "#16a34a", "#f59e0b", "#7c3aed", "#0891b2", "#dc2626", "#3b82f6", "#15803d"];
const W = 280;
const H = 170;
const PAD = 28;
const LEGEND_H = 18;

export interface ChartSeriesData {
  label: string;
  values: number[];
}

/** Dependency-free SVG chart (bar / line / pie) for a spreadsheet range, one or more series. */
export default function SheetChart({
  type,
  labels,
  series,
}: {
  type: ChartType;
  labels: string[];
  series: ChartSeriesData[];
}) {
  const first = series[0]?.values ?? [];
  if (first.length === 0) return <div className="chart-empty">Plage vide</div>;
  const showLegend = series.length > 1;
  const totalH = H + (showLegend ? LEGEND_H : 0);

  const legend = showLegend ? (
    <g transform={`translate(${PAD}, ${H + 2})`}>
      {series.map((se, si) => (
        <g key={si} transform={`translate(${(si % 3) * 92}, ${Math.floor(si / 3) * 12})`}>
          <rect width="8" height="8" y="1" fill={PALETTE[si % PALETTE.length]} rx="1" />
          <text x="12" y="9" className="chart-legend-label">
            {se.label.length > 12 ? `${se.label.slice(0, 11)}…` : se.label}
          </text>
        </g>
      ))}
    </g>
  ) : null;

  if (type === "pie") {
    const total = first.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    let acc = 0;
    const cx = W / 2,
      cy = H / 2,
      rad = Math.min(W, H) / 2 - 12;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img">
        {first.map((v, i) => {
          const frac = Math.max(0, v) / total;
          const a0 = acc * 2 * Math.PI - Math.PI / 2;
          acc += frac;
          const a1 = acc * 2 * Math.PI - Math.PI / 2;
          const large = frac > 0.5 ? 1 : 0;
          const x0 = cx + rad * Math.cos(a0),
            y0 = cy + rad * Math.sin(a0);
          const x1 = cx + rad * Math.cos(a1),
            y1 = cy + rad * Math.sin(a1);
          if (frac === 0) return null;
          return (
            <path
              key={i}
              d={`M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${rad},${rad} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z`}
              fill={PALETTE[i % PALETTE.length]}
            />
          );
        })}
      </svg>
    );
  }

  const n = first.length;
  const allValues = series.flatMap((se) => se.values);
  const max = Math.max(0, ...allValues);
  const min = Math.min(0, ...allValues);
  const span = max - min || 1;
  const plotW = W - PAD * 2,
    plotH = H - PAD * 2;
  const x = (i: number) => PAD + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => PAD + plotH - ((v - min) / span) * plotH;
  const zeroY = y(0);
  const slotW = plotW / n;

  return (
    <svg viewBox={`0 0 ${W} ${totalH}`} className="chart-svg" role="img">
      <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} className="chart-axis" />
      {type === "bar"
        ? series.map((se, si) => {
            const groupW = slotW * 0.7;
            const barW = (groupW / series.length) * 0.82;
            return se.values.map((v, i) => {
              const groupX = PAD + i * slotW + (slotW - groupW) / 2;
              const bx = groupX + si * (groupW / series.length) + (groupW / series.length - barW) / 2;
              const top = y(Math.max(v, 0));
              const h = Math.abs(y(v) - zeroY);
              return (
                <rect
                  key={`${si}-${i}`}
                  x={bx.toFixed(1)}
                  y={top.toFixed(1)}
                  width={barW.toFixed(1)}
                  height={Math.max(1, h).toFixed(1)}
                  rx="2"
                  fill={PALETTE[si % PALETTE.length]}
                />
              );
            });
          })
        : series.map((se, si) => (
            <polyline
              key={si}
              fill="none"
              stroke={series.length > 1 ? PALETTE[si % PALETTE.length] : "var(--primary, #2563eb)"}
              strokeWidth="2"
              strokeLinejoin="round"
              points={se.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
            />
          ))}
      {type === "line" &&
        series.map((se, si) =>
          se.values.map((v, i) => (
            <circle
              key={`${si}-${i}`}
              cx={x(i).toFixed(1)}
              cy={y(v).toFixed(1)}
              r="2.5"
              fill={series.length > 1 ? PALETTE[si % PALETTE.length] : "var(--primary, #2563eb)"}
            />
          )),
        )}
      {labels.map((l, i) => (
        <text
          key={i}
          x={(type === "bar" ? PAD + (i + 0.5) * slotW : x(i)).toFixed(1)}
          y={H - 8}
          textAnchor="middle"
          className="chart-label"
        >
          {l.length > 6 ? l.slice(0, 6) : l}
        </text>
      ))}
      {legend}
    </svg>
  );
}
