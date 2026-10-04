/** Données et rendu statique d'un graphique de document (pur : utilisable par les exports). */
import { layoutChart } from "../sheet/chart-layout";
import { layoutToSvg } from "../sheet/chart-svg";
import type { ChartOptions, ChartType } from "../sheet/model";

export interface DocChartData {
  chartType: ChartType;
  title: string;
  labels: string[];
  series: { label: string; values: number[] }[];
  opts?: ChartOptions;
  widthMm?: number;
  heightMm?: number;
}

export const DEFAULT_CHART: DocChartData = {
  chartType: "bar",
  title: "",
  labels: ["T1", "T2", "T3", "T4"],
  series: [{ label: "Série 1", values: [12, 19, 9, 22] }],
  widthMm: 150,
  heightMm: 90,
};

/** Données d'un nœud (valeurs par défaut sur les attributs absents). */
export function chartDataOf(attrs: Record<string, unknown> | undefined): DocChartData {
  const a = attrs ?? {};
  return {
    chartType: (a.chartType as ChartType) || "bar",
    title: String(a.title ?? ""),
    labels: Array.isArray(a.labels) ? (a.labels as unknown[]).map(String) : [],
    series: Array.isArray(a.series) ? (a.series as DocChartData["series"]) : [],
    opts: (a.opts as ChartOptions | undefined) ?? undefined,
    widthMm: Number(a.widthMm) || 150,
    heightMm: Number(a.heightMm) || 90,
  };
}

/** SVG statique d'un graphique de document (aperçu, export HTML/PDF). */
export function chartSvg(d: DocChartData): string {
  const px = (mm: number) => Math.round((mm / 25.4) * 96);
  const lay = layoutChart({
    type: d.chartType,
    labels: d.labels,
    series: d.series,
    title: d.title || undefined,
    opts: d.opts,
    width: Math.max(160, Math.min(900, px(d.widthMm ?? 150))),
    height: Math.max(100, Math.min(600, px(d.heightMm ?? 90))),
  });
  return layoutToSvg(lay, d.title || "Graphique");
}

