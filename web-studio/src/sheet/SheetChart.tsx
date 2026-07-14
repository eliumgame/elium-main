import type { ChartType } from "./model";

const PALETTE = ["#1d4ed8", "#16a34a", "#f59e0b", "#7c3aed", "#0891b2", "#dc2626", "#3b82f6", "#15803d"];
const W = 280;
const H = 170;
const PAD = 28;

/** Dependency-free SVG chart (bar / line / pie) for a spreadsheet range. */
export default function SheetChart({ type, labels, values }: { type: ChartType; labels: string[]; values: number[] }) {
  if (values.length === 0) return <div className="chart-empty">Plage vide</div>;

  if (type === "pie") {
    const total = values.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    let acc = 0;
    const cx = W / 2, cy = H / 2, rad = Math.min(W, H) / 2 - 12;
    return (
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img">
        {values.map((v, i) => {
          const frac = Math.max(0, v) / total;
          const a0 = acc * 2 * Math.PI - Math.PI / 2;
          acc += frac;
          const a1 = acc * 2 * Math.PI - Math.PI / 2;
          const large = frac > 0.5 ? 1 : 0;
          const x0 = cx + rad * Math.cos(a0), y0 = cy + rad * Math.sin(a0);
          const x1 = cx + rad * Math.cos(a1), y1 = cy + rad * Math.sin(a1);
          if (frac === 0) return null;
          return <path key={i} d={`M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${rad},${rad} 0 ${large} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z`} fill={PALETTE[i % PALETTE.length]} />;
        })}
      </svg>
    );
  }

  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const span = max - min || 1;
  const plotW = W - PAD * 2, plotH = H - PAD * 2;
  const x = (i: number) => PAD + (values.length === 1 ? plotW / 2 : (i / (values.length - 1)) * plotW);
  const y = (v: number) => PAD + plotH - ((v - min) / span) * plotH;
  const zeroY = y(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img">
      <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} className="chart-axis" />
      {type === "bar"
        ? values.map((v, i) => {
            const bw = (plotW / values.length) * 0.62;
            const bx = PAD + (i + 0.5) * (plotW / values.length) - bw / 2;
            const top = y(Math.max(v, 0));
            const h = Math.abs(y(v) - zeroY);
            return <rect key={i} x={bx.toFixed(1)} y={top.toFixed(1)} width={bw.toFixed(1)} height={Math.max(1, h).toFixed(1)} rx="2" fill={PALETTE[i % PALETTE.length]} />;
          })
        : (
          <polyline
            fill="none"
            stroke="var(--primary, #2563eb)"
            strokeWidth="2"
            strokeLinejoin="round"
            points={values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}
          />
        )}
      {type === "line" && values.map((v, i) => <circle key={i} cx={x(i).toFixed(1)} cy={y(v).toFixed(1)} r="2.5" fill="var(--primary, #2563eb)" />)}
      {labels.map((l, i) => (
        <text key={i} x={(type === "bar" ? PAD + (i + 0.5) * (plotW / values.length) : x(i)).toFixed(1)} y={H - 8} textAnchor="middle" className="chart-label">{l.length > 6 ? l.slice(0, 6) : l}</text>
      ))}
    </svg>
  );
}
