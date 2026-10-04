import "./chart.css";
import type { ChartOptions, ChartType } from "./model";
import { layoutChart, type ChartSeries, type Prim } from "./chart-layout";

export type ChartSeriesData = ChartSeries;

function renderPrim(p: Prim, i: number) {
  switch (p.k) {
    case "rect":
      return <rect key={i} x={+p.x.toFixed(1)} y={+p.y.toFixed(1)} width={+p.w.toFixed(1)} height={+p.h.toFixed(1)} rx={p.rx} fill={p.fill} />;
    case "line":
      return (
        <line
          key={i}
          x1={+p.x1.toFixed(1)}
          y1={+p.y1.toFixed(1)}
          x2={+p.x2.toFixed(1)}
          y2={+p.y2.toFixed(1)}
          className={p.cls === "grid" ? "chart-grid" : "chart-axis"}
        />
      );
    case "poly":
      return (
        <polyline
          key={i}
          fill="none"
          stroke={p.stroke}
          strokeWidth={p.w}
          strokeLinejoin="round"
          strokeDasharray={p.dash ? "5 3" : undefined}
          points={p.pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")}
        />
      );
    case "path":
      return <path key={i} d={p.d} fill={p.fill} opacity={p.opacity} />;
    case "circle":
      return <circle key={i} cx={+p.cx.toFixed(1)} cy={+p.cy.toFixed(1)} r={p.r} fill={p.fill} />;
    case "text":
      return (
        <text
          key={i}
          x={+p.x.toFixed(1)}
          y={+p.y.toFixed(1)}
          textAnchor={p.anchor}
          className={p.cls === "legend" ? "chart-legend-label" : p.cls === "title" ? "chart-title" : p.cls === "axis-title" ? "chart-axis-title" : p.cls === "value" ? "chart-value" : "chart-label"}
          transform={p.rotate ? `rotate(${p.rotate} ${p.x.toFixed(1)} ${p.y.toFixed(1)})` : undefined}
        >
          {p.text}
        </text>
      );
  }
}

/** Graphique SVG sans dépendance : barres, courbes, aires, nuage de points, secteurs, combiné ; options avancées (voir chart-layout.ts). */
export default function SheetChart({
  type,
  labels,
  series,
  title,
  opts,
  width,
  height,
}: {
  type: ChartType;
  labels: string[];
  series: ChartSeriesData[];
  title?: string;
  opts?: ChartOptions;
  width?: number;
  height?: number;
}) {
  const lay = layoutChart({ type, labels, series, title, opts, width, height });
  if (lay.empty) return <div className="chart-empty">Plage vide</div>;
  return (
    <svg viewBox={`0 0 ${lay.width} ${lay.height}`} className="chart-svg" role="img" aria-label={title ?? "Graphique"}>
      {lay.prims.map(renderPrim)}
    </svg>
  );
}
