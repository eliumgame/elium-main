/**
 * Mise en page PURE des graphiques (Tableur, Documents, Présentations) : à partir
 * du type, des libellés, des séries et des options, produit une liste de
 * primitives de dessin (rect, ligne, polyligne, tracé, cercle, texte). Le rendu
 * SVG (SheetChart.tsx) n'a plus qu'à les afficher ; les export XLSX/DOCX
 * réutilisent les mêmes options. Aucune dépendance à React ni au DOM.
 */
import type { ChartAxisFormat, ChartOptions, ChartTrendline, ChartType } from "./model";

export interface ChartSeries {
  label: string;
  values: number[];
}

export type Prim =
  | { k: "rect"; x: number; y: number; w: number; h: number; fill: string; rx?: number }
  | { k: "line"; x1: number; y1: number; x2: number; y2: number; cls: "axis" | "grid" | "trend"; stroke?: string; dash?: boolean }
  | { k: "poly"; pts: [number, number][]; stroke: string; w: number; dash?: boolean }
  | { k: "path"; d: string; fill: string; opacity?: number }
  | { k: "circle"; cx: number; cy: number; r: number; fill: string }
  | { k: "text"; x: number; y: number; text: string; anchor: "start" | "middle" | "end"; cls: "label" | "legend" | "title" | "axis-title" | "value"; rotate?: number };

export const PALETTE = ["#1d4ed8", "#16a34a", "#f59e0b", "#7c3aed", "#0891b2", "#dc2626", "#3b82f6", "#15803d"];

// --- Outils numériques ------------------------------------------------------

/** Graduation « lisible » : pas de 1/2/5 × 10^n, bornes alignées. */
export function niceTicks(min: number, max: number, target = 5): { min: number; max: number; step: number; ticks: number[] } {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, step: 0.25, ticks: [0, 0.25, 0.5, 0.75, 1] };
  if (min === max) {
    if (min === 0) max = 1;
    else {
      min = Math.min(min, 0);
      max = Math.max(max, 0) || 1;
    }
  }
  const raw = (max - min) / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let k = Math.round(lo / step); k * step <= hi + step / 2; k++) ticks.push(Number((k * step).toPrecision(12)));
  return { min: lo, max: hi, step, ticks };
}

export function formatAxis(v: number, fmt: ChartAxisFormat | undefined, step = 1): string {
  const dec = step < 1 ? Math.min(4, Math.ceil(-Math.log10(step))) : 0;
  switch (fmt) {
    case "percent":
      return `${String(Math.round(v * 1000) / 10).replace(".", ",")} %`;
    case "int":
      return String(Math.round(v));
    case "decimal":
      return v.toFixed(2).replace(".", ",");
    case "currency":
      return `${Math.round(v * 100) / 100} €`;
    default:
      return (dec ? v.toFixed(dec) : String(Math.round(v * 1e6) / 1e6)).replace(".", ",");
  }
}

/** Régression linéaire y = a + b·x. */
export function linearFit(xs: number[], ys: number[]): { a: number; b: number } {
  const n = xs.length;
  if (n === 0) return { a: 0, b: 0 };
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) ** 2;
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  const b = sxx === 0 ? 0 : sxy / sxx;
  return { a: my - b * mx, b };
}

/** Régression polynomiale (moindres carrés, équations normales résolues par Gauss). Retourne les coefficients c0..cOrder. */
export function polyFit(xs: number[], ys: number[], order: number): number[] {
  const m = Math.max(1, Math.min(6, Math.round(order)));
  const n = m + 1;
  const A: number[][] = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) A[i]![j] = xs.reduce((s, x) => s + x ** (i + j), 0);
    A[i]![n] = xs.reduce((s, x, k) => s + ys[k]! * x ** i, 0);
  }
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    [A[c], A[p]] = [A[p]!, A[c]!];
    const piv = A[c]![c]!;
    if (Math.abs(piv) < 1e-12) continue;
    for (let j = c; j <= n; j++) A[c]![j]! /= piv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r]![c]!;
      for (let j = c; j <= n; j++) A[r]![j]! -= f * A[c]![j]!;
    }
  }
  return A.map((row) => row[n] ?? 0);
}

/** Points de la courbe de tendance pour une série (x = abscisses numériques). */
export function trendPoints(xs: number[], ys: number[], t: ChartTrendline): [number, number][] {
  if (xs.length < 2) return [];
  if (t.type === "linear") {
    const { a, b } = linearFit(xs, ys);
    return xs.map((x) => [x, a + b * x]);
  }
  if (t.type === "poly") {
    const order = Math.max(2, Math.min(6, Math.round(t.order ?? 2)));
    if (xs.length <= order) return [];
    const c = polyFit(xs, ys, order);
    return xs.map((x) => [x, c.reduce((s, ck, k) => s + ck * x ** k, 0)]);
  }
  const period = Math.max(2, Math.min(xs.length, Math.round(t.period ?? 3)));
  const out: [number, number][] = [];
  for (let i = period - 1; i < xs.length; i++) {
    let s = 0;
    for (let k = 0; k < period; k++) s += ys[i - k]!;
    out.push([xs[i]!, s / period]);
  }
  return out;
}

/** Empilement : pour chaque série, les bornes [bas, haut] de chaque point (100 % normalisé si demandé). */
export function stackBounds(series: ChartSeries[], percent: boolean): { lo: number; hi: number }[][] {
  const n = series[0]?.values.length ?? 0;
  const out: { lo: number; hi: number }[][] = series.map(() => []);
  for (let i = 0; i < n; i++) {
    let pos = 0;
    let neg = 0;
    const total = series.reduce((s, se) => s + Math.abs(se.values[i] ?? 0), 0) || 1;
    series.forEach((se, si) => {
      const raw = se.values[i] ?? 0;
      const v = percent ? raw / total : raw;
      if (v >= 0) {
        out[si]!.push({ lo: pos, hi: pos + v });
        pos += v;
      } else {
        out[si]!.push({ lo: neg + v, hi: neg });
        neg += v;
      }
    });
  }
  return out;
}

// --- Mise en page -----------------------------------------------------------

export interface ChartLayoutInput {
  type: ChartType;
  labels: string[];
  series: ChartSeries[];
  title?: string;
  opts?: ChartOptions;
  width?: number;
  height?: number;
}
export interface ChartLayout {
  width: number;
  height: number;
  prims: Prim[];
  empty: boolean;
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s);

export function layoutChart(inp: ChartLayoutInput): ChartLayout {
  const W = inp.width ?? 280;
  const H0 = inp.height ?? 170;
  const o = inp.opts ?? {};
  const colors = o.colors?.length ? o.colors : PALETTE;
  const colorOf = (i: number) => colors[i % colors.length]!;
  const series = inp.series;
  const first = series[0]?.values ?? [];
  const prims: Prim[] = [];
  if (first.length === 0) return { width: W, height: H0, prims, empty: true };

  const legendPos = o.legend ?? (series.length > 1 || inp.type === "pie" ? (inp.type === "pie" ? "none" : "bottom") : "none");
  const legendLabels = inp.type === "pie" ? inp.labels : series.map((s) => s.label);
  const titleH = inp.title ? 18 : 0;
  const xTitleH = o.xTitle ? 14 : 0;
  const legendRowH = 14;
  const legendRight = legendPos === "right" ? 88 : 0;
  const legendBottomH = legendPos === "bottom" ? legendRowH * Math.ceil(legendLabels.length / Math.max(1, Math.floor((W - 20) / 92))) + 2 : 0;
  const legendTopH = legendPos === "top" ? legendRowH * Math.ceil(legendLabels.length / Math.max(1, Math.floor((W - 20) / 92))) + 2 : 0;
  const H = H0 + legendBottomH + legendTopH + titleH + xTitleH;

  if (inp.title) prims.push({ k: "text", x: W / 2, y: 13, text: trunc(inp.title, 48), anchor: "middle", cls: "title" });

  const drawLegend = () => {
    if (legendPos === "none") return;
    const perRow = legendPos === "right" ? 1 : Math.max(1, Math.floor((W - 20) / 92));
    legendLabels.forEach((lab, i) => {
      const col = i % perRow;
      const row = Math.floor(i / perRow);
      const lx = legendPos === "right" ? W - legendRight + 6 : 10 + col * 92;
      const ly = legendPos === "right" ? titleH + 14 + row * legendRowH : legendPos === "top" ? titleH + 4 + row * legendRowH : H - legendBottomH + 2 + row * legendRowH;
      prims.push({ k: "rect", x: lx, y: ly, w: 8, h: 8, fill: colorOf(i), rx: 1 });
      prims.push({ k: "text", x: lx + 12, y: ly + 8, text: trunc(lab, legendPos === "right" ? 12 : 12), anchor: "start", cls: "legend" });
    });
  };

  // ---- secteurs
  if (inp.type === "pie") {
    const total = first.reduce((a, b) => a + Math.max(0, b), 0) || 1;
    const areaH = H - titleH - legendBottomH - legendTopH;
    const cx = (W - legendRight) / 2;
    const cy = titleH + legendTopH + areaH / 2;
    const rad = Math.min(W - legendRight, areaH) / 2 - 12;
    let acc = 0;
    first.forEach((v, i) => {
      const frac = Math.max(0, v) / total;
      if (frac === 0) return;
      const a0 = acc * 2 * Math.PI - Math.PI / 2;
      acc += frac;
      const a1 = acc * 2 * Math.PI - Math.PI / 2;
      const x0 = cx + rad * Math.cos(a0);
      const y0 = cy + rad * Math.sin(a0);
      const x1 = cx + rad * Math.cos(a1);
      const y1 = cy + rad * Math.sin(a1);
      const d =
        frac >= 0.9999
          ? `M${cx - rad},${cy} A${rad},${rad} 0 1 1 ${cx + rad},${cy} A${rad},${rad} 0 1 1 ${cx - rad},${cy} Z`
          : `M${cx},${cy} L${x0.toFixed(1)},${y0.toFixed(1)} A${rad},${rad} 0 ${frac > 0.5 ? 1 : 0} 1 ${x1.toFixed(1)},${y1.toFixed(1)} Z`;
      prims.push({ k: "path", d, fill: colorOf(i) });
      if (o.dataLabels) {
        const mid = (a0 + a1) / 2;
        prims.push({ k: "text", x: cx + rad * 0.65 * Math.cos(mid), y: cy + rad * 0.65 * Math.sin(mid) + 3, text: `${Math.round(frac * 100)} %`, anchor: "middle", cls: "value" });
      }
    });
    if (legendPos === "none" && o.legend === undefined) {
      /* pas de légende par défaut sur un camembert historique */
    }
    drawLegend();
    return { width: W, height: H, prims, empty: false };
  }

  // ---- axes cartésiens
  const horizontal = !!o.horizontal && (inp.type === "bar" || inp.type === "combo");
  const stackedMode = o.grouping === "stacked" || o.grouping === "percent";
  const percent = o.grouping === "percent";
  const seriesKind = (si: number): "bar" | "line" | "area" | "scatter" =>
    inp.type === "combo" ? (o.seriesTypes?.[si] ?? (si === 0 ? "bar" : "line")) : inp.type === "bar" ? "bar" : inp.type === "area" ? "area" : inp.type === "scatter" ? "scatter" : "line";
  const onSecondary = (si: number) => inp.type === "combo" && !!o.secondary?.includes(si);
  const primary = series.map((_, i) => i).filter((i) => !onSecondary(i));
  const secondary = series.map((_, i) => i).filter(onSecondary);

  // bornes de l'axe primaire
  const stackable = primary.filter((i) => seriesKind(i) === "bar" || seriesKind(i) === "area");
  const stackBnds = stackedMode && stackable.length ? stackBounds(stackable.map((i) => series[i]!), percent) : null;
  const rangeOf = (idx: number[], useStack: boolean): { min: number; max: number } => {
    let mn = 0;
    let mx = 0;
    idx.forEach((si) => {
      series[si]!.values.forEach((v, i) => {
        if (useStack && stackBnds && stackable.includes(si)) {
          const b = stackBnds[stackable.indexOf(si)]![i]!;
          mn = Math.min(mn, b.lo);
          mx = Math.max(mx, b.hi);
        } else {
          mn = Math.min(mn, v);
          mx = Math.max(mx, v);
        }
      });
    });
    if (useStack && percent) return { min: 0, max: 1 };
    return { min: mn, max: mx };
  };
  const scatter = inp.type === "scatter";
  const xNums = inp.labels.map((l) => Number(String(l).replace(",", ".")));
  const xIsNumeric = scatter && xNums.length === first.length && xNums.every((v) => Number.isFinite(v));

  const pr = rangeOf(primary, true);
  const yAxis = niceTicks(o.yMin ?? pr.min, o.yMax ?? pr.max);
  const yMin = o.yMin ?? yAxis.min;
  const yMax = o.yMax ?? yAxis.max;
  const sr = secondary.length ? rangeOf(secondary, false) : null;
  const y2Axis = sr ? niceTicks(sr.min, sr.max) : null;

  const left = 34 + (o.yTitle ? 12 : 0);
  const right = (y2Axis ? 34 + (o.y2Title ? 12 : 0) : 10) + legendRight;
  const top = titleH + legendTopH + 10;
  const bottom = H - legendBottomH - xTitleH - 22;
  const plotW = W - left - right;
  const plotH = bottom - top;
  const n = first.length;

  const yPix = (v: number) => bottom - ((v - yMin) / (yMax - yMin || 1)) * plotH;
  const y2Pix = (v: number) => (y2Axis ? bottom - ((v - y2Axis.min) / (y2Axis.max - y2Axis.min || 1)) * plotH : 0);

  // abscisses
  const xs = xIsNumeric ? xNums : first.map((_, i) => i);
  const xMin = xIsNumeric ? Math.min(...xs) : 0;
  const xMax = xIsNumeric ? Math.max(...xs) : n - 1;
  const xAxis = xIsNumeric ? niceTicks(xMin, xMax) : null;
  const xPix = (x: number): number => {
    if (xIsNumeric && xAxis) return left + ((x - xAxis.min) / (xAxis.max - xAxis.min || 1)) * plotW;
    if (scatter || inp.type === "line" || inp.type === "area") return left + (n === 1 ? plotW / 2 : (x / (n - 1)) * plotW);
    return left + (x + 0.5) * (plotW / n);
  };
  const slotW = plotW / n;
  const usesBands = !scatter && series.some((_, si) => seriesKind(si) === "bar") ;
  const xPos = (i: number): number => {
    if (xIsNumeric) return xPix(xs[i]!);
    if (usesBands) return left + (i + 0.5) * slotW;
    return xPix(i);
  };

  // quadrillage + graduations Y
  const horizPlot = horizontal;
  yAxis.ticks.forEach((t) => {
    if (t < yMin - 1e-9 || t > yMax + 1e-9) return;
    if (horizPlot) {
      const x = left + ((t - yMin) / (yMax - yMin || 1)) * plotW;
      prims.push({ k: "line", x1: x, y1: top, x2: x, y2: bottom, cls: "grid" });
      prims.push({ k: "text", x, y: bottom + 11, text: formatAxis(percent ? t : t, percent ? "percent" : o.yFormat, yAxis.step), anchor: "middle", cls: "label" });
    } else {
      const y = yPix(t);
      prims.push({ k: "line", x1: left, y1: y, x2: W - right, y2: y, cls: t === 0 ? "axis" : "grid" });
      prims.push({ k: "text", x: left - 4, y: y + 3, text: formatAxis(t, percent ? "percent" : o.yFormat, yAxis.step), anchor: "end", cls: "label" });
    }
  });
  if (y2Axis)
    y2Axis.ticks.forEach((t) => prims.push({ k: "text", x: W - right + 4, y: y2Pix(t) + 3, text: formatAxis(t, undefined, y2Axis.step), anchor: "start", cls: "label" }));
  if (xAxis && !horizPlot)
    xAxis.ticks.forEach((t) => prims.push({ k: "text", x: xPix(t), y: bottom + 11, text: formatAxis(t, undefined, xAxis.step), anchor: "middle", cls: "label" }));
  if (!xIsNumeric && !horizPlot)
    inp.labels.forEach((l, i) => prims.push({ k: "text", x: xPos(i), y: bottom + 11, text: trunc(String(l), Math.max(3, Math.floor(slotW / 5))), anchor: "middle", cls: "label" }));
  if (!xIsNumeric && horizPlot)
    inp.labels.forEach((l, i) => prims.push({ k: "text", x: left - 4, y: top + (i + 0.5) * (plotH / n) + 3, text: trunc(String(l), 6), anchor: "end", cls: "label" }));

  if (o.xTitle) prims.push({ k: "text", x: left + plotW / 2, y: bottom + 24, text: o.xTitle, anchor: "middle", cls: "axis-title" });
  if (o.yTitle) prims.push({ k: "text", x: 9, y: top + plotH / 2, text: o.yTitle, anchor: "middle", cls: "axis-title", rotate: -90 });
  if (o.y2Title && y2Axis) prims.push({ k: "text", x: W - legendRight - 6, y: top + plotH / 2, text: o.y2Title, anchor: "middle", cls: "axis-title", rotate: 90 });

  // séries
  const barSeries = series.map((_, i) => i).filter((i) => seriesKind(i) === "bar");
  series.forEach((se, si) => {
    const kind = seriesKind(si);
    const color = colorOf(si);
    const yp = onSecondary(si) ? y2Pix : yPix;
    if (kind === "bar") {
      const stacked = stackedMode && stackBnds && stackable.includes(si);
      const bi = barSeries.indexOf(si);
      const count = stacked ? 1 : barSeries.filter((i) => !(stackedMode && stackable.includes(i))).length || 1;
      se.values.forEach((v, i) => {
        const b = stacked ? stackBnds![stackable.indexOf(si)]![i]! : { lo: Math.min(0, v), hi: Math.max(0, v) };
        const idxInGroup = stacked ? 0 : barSeries.filter((j) => !(stackedMode && stackable.includes(j))).indexOf(si);
        void bi;
        if (horizPlot) {
          const band = plotH / n;
          const gw = band * 0.7;
          const bw = (gw / count) * 0.85;
          const by = top + i * band + (band - gw) / 2 + idxInGroup * (gw / count);
          const x0 = left + ((b.lo - yMin) / (yMax - yMin || 1)) * plotW;
          const x1 = left + ((b.hi - yMin) / (yMax - yMin || 1)) * plotW;
          prims.push({ k: "rect", x: Math.min(x0, x1), y: by, w: Math.max(1, Math.abs(x1 - x0)), h: bw, fill: color, rx: 2 });
        } else {
          const gw = slotW * 0.7;
          const bw = (gw / count) * 0.85;
          const bx = left + i * slotW + (slotW - gw) / 2 + idxInGroup * (gw / count) + (gw / count - bw) / 2;
          const yTop = yp(b.hi);
          const yBot = yp(b.lo);
          prims.push({ k: "rect", x: bx, y: Math.min(yTop, yBot), w: bw, h: Math.max(1, Math.abs(yBot - yTop)), fill: color, rx: 2 });
          if (o.dataLabels) prims.push({ k: "text", x: bx + bw / 2, y: Math.min(yTop, yBot) - 3, text: percent ? `${Math.round((b.hi - b.lo) * 100)} %` : formatAxis(v, o.yFormat, 0), anchor: "middle", cls: "value" });
        }
      });
    } else if (kind === "area") {
      const stacked = stackedMode && stackBnds && stackable.includes(si);
      const bnds = stacked ? stackBnds![stackable.indexOf(si)]! : se.values.map((v) => ({ lo: 0, hi: v }));
      const topPts = bnds.map((b, i) => `${xPos(i).toFixed(1)},${yp(b.hi).toFixed(1)}`);
      const botPts = bnds
        .map((b, i) => `${xPos(i).toFixed(1)},${yp(b.lo).toFixed(1)}`)
        .reverse();
      prims.push({ k: "path", d: `M${topPts.join(" L")} L${botPts.join(" L")} Z`, fill: color, opacity: 0.55 });
      prims.push({ k: "poly", pts: bnds.map((b, i) => [xPos(i), yp(b.hi)] as [number, number]), stroke: color, w: 1.5 });
    } else if (kind === "line") {
      const pts = se.values.map((v, i) => [xPos(i), yp(v)] as [number, number]);
      prims.push({ k: "poly", pts: o.smooth ? smoothPts(pts) : pts, stroke: color, w: 2 });
      pts.forEach(([cx, cy], i) => {
        prims.push({ k: "circle", cx, cy, r: 2.5, fill: color });
        if (o.dataLabels) prims.push({ k: "text", x: cx, y: cy - 5, text: formatAxis(se.values[i]!, o.yFormat, 0), anchor: "middle", cls: "value" });
      });
    } else {
      se.values.forEach((v, i) => {
        const cx = xPos(i);
        const cy = yp(v);
        prims.push({ k: "circle", cx, cy, r: 3.2, fill: color });
        if (o.dataLabels) prims.push({ k: "text", x: cx + 5, y: cy - 4, text: formatAxis(v, o.yFormat, 0), anchor: "start", cls: "value" });
      });
    }
  });

  // courbe de tendance
  if (o.trendline && !horizPlot) {
    const si = Math.min(Math.max(0, o.trendline.series ?? 0), series.length - 1);
    const tp = trendPoints(xs, series[si]!.values, o.trendline);
    if (tp.length >= 2) {
      const yp = onSecondary(si) ? y2Pix : yPix;
      const idxOf = (x: number) => xs.indexOf(x);
      prims.push({
        k: "poly",
        pts: tp.map(([x, y]) => [xIsNumeric ? xPix(x) : xPos(idxOf(x)), yp(y)] as [number, number]),
        stroke: colorOf(si),
        w: 1.5,
        dash: true,
      });
    }
  }

  prims.push({ k: "line", x1: left, y1: bottom, x2: W - right, y2: bottom, cls: "axis" });
  drawLegend();
  return { width: W, height: H, prims, empty: false };
}

/** Lissage simple (Catmull-Rom échantillonné) d'une polyligne. */
function smoothPts(p: [number, number][]): [number, number][] {
  if (p.length < 3) return p;
  const out: [number, number][] = [];
  for (let i = 0; i < p.length - 1; i++) {
    const p0 = p[Math.max(0, i - 1)]!;
    const p1 = p[i]!;
    const p2 = p[i + 1]!;
    const p3 = p[Math.min(p.length - 1, i + 2)]!;
    for (let t = 0; t < 1; t += 0.25) {
      const t2 = t * t;
      const t3 = t2 * t;
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(p[p.length - 1]!);
  return out;
}
