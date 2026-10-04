/**
 * Sérialise une mise en page de graphique (chart-layout.ts) en SVG autonome, styles en ligne :
 * sert à l'export HTML/PDF des graphiques de documents et au rendu du nœud « graphique ».
 */
import type { ChartLayout } from "./chart-layout";

const esc = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const f1 = (n: number): string => String(Math.round(n * 10) / 10);
const SIZES = { label: 9, legend: 8, title: 11, "axis-title": 9, value: 8 } as const;

export function layoutToSvg(lay: ChartLayout, label = "Graphique"): string {
  const body = lay.prims
    .map((p) => {
      switch (p.k) {
        case "rect":
          return `<rect x="${f1(p.x)}" y="${f1(p.y)}" width="${f1(p.w)}" height="${f1(p.h)}"${p.rx ? ` rx="${p.rx}"` : ""} fill="${esc(p.fill)}"/>`;
        case "line":
          return `<line x1="${f1(p.x1)}" y1="${f1(p.y1)}" x2="${f1(p.x2)}" y2="${f1(p.y2)}" stroke="${p.cls === "grid" ? "#e2e8f0" : "#94a3b8"}" stroke-width="${p.cls === "grid" ? 0.6 : 1}"/>`;
        case "poly":
          return `<polyline fill="none" stroke="${esc(p.stroke)}" stroke-width="${p.w}" stroke-linejoin="round"${p.dash ? ' stroke-dasharray="5 3"' : ""} points="${p.pts.map(([x, y]) => `${f1(x)},${f1(y)}`).join(" ")}"/>`;
        case "path":
          return `<path d="${p.d}" fill="${esc(p.fill)}"${p.opacity !== undefined ? ` opacity="${p.opacity}"` : ""}/>`;
        case "circle":
          return `<circle cx="${f1(p.cx)}" cy="${f1(p.cy)}" r="${p.r}" fill="${esc(p.fill)}"/>`;
        case "text":
          return `<text x="${f1(p.x)}" y="${f1(p.y)}" text-anchor="${p.anchor}" font-size="${SIZES[p.cls]}"${p.cls === "title" ? ' font-weight="600"' : ""} fill="${p.cls === "title" || p.cls === "value" ? "#0f172a" : "#64748b"}"${p.rotate ? ` transform="rotate(${p.rotate} ${f1(p.x)} ${f1(p.y)})"` : ""}>${esc(p.text)}</text>`;
      }
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lay.width} ${lay.height}" role="img" aria-label="${esc(label)}" font-family="Calibri,Carlito,Arial,sans-serif">${body}</svg>`;
}
