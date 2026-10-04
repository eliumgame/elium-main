/**
 * DrawingML (`c:chartSpace`) des graphiques riches — partagé par l'export XLSX
 * (séries liées à des plages), l'export DOCX (données littérales) et, au
 * besoin, PPTX. Le lecteur (`readChartOptions`) fait le chemin inverse pour
 * l'import XLSX : type, groupement, légende, titres d'axes, bornes, format,
 * étiquettes, tendance, combiné/axe secondaire.
 */
import type { ChartAxisFormat, ChartOptions, ChartType } from "./model";

export const C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart";
export const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const xe = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface OoxmlSeries {
  name?: string;
  /** Catégories : référence de plage OU valeurs littérales. */
  catRef?: string;
  cats?: string[];
  /** Valeurs : référence de plage OU valeurs littérales. */
  valRef?: string;
  vals?: number[];
  /** Nuage de points : abscisses (référence ou littéral). */
  xRef?: string;
  xvals?: number[];
}

export interface ChartXmlInput {
  type: ChartType;
  title?: string;
  opts?: ChartOptions;
  series: OoxmlSeries[];
  /** Pour un secteur : une seule série est tracée. */
}

const FMT_CODE: Record<Exclude<ChartAxisFormat, "general">, string> = {
  int: "0",
  decimal: "0.00",
  percent: "0%",
  currency: '#,##0.00\\ "€"',
};

const PLOT_IDS = { cat: 111111111, val: 222222222, cat2: 333333333, val2: 444444444 };

const strData = (ref: string | undefined, lits: string[] | undefined): string => {
  if (ref) return `<c:strRef><c:f>${xe(ref)}</c:f></c:strRef>`;
  const a = lits ?? [];
  return `<c:strLit><c:ptCount val="${a.length}"/>${a.map((v, i) => `<c:pt idx="${i}"><c:v>${xe(v)}</c:v></c:pt>`).join("")}</c:strLit>`;
};
const numData = (ref: string | undefined, lits: number[] | undefined): string => {
  if (ref) return `<c:numRef><c:f>${xe(ref)}</c:f></c:numRef>`;
  const a = lits ?? [];
  return `<c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${a.length}"/>${a
    .map((v, i) => `<c:pt idx="${i}"><c:v>${Number.isFinite(v) ? v : 0}</c:v></c:pt>`)
    .join("")}</c:numLit>`;
};

const dLbls = (on: boolean): string =>
  on
    ? `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`
    : "";

const richTitle = (t: string, rot?: number): string =>
  `<c:title><c:tx><c:rich><a:bodyPr${rot !== undefined ? ` rot="${rot}" vert="horz"` : ""}/><a:lstStyle/><a:p><a:r><a:t>${xe(t)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title>`;

/** Écrit le XML d'un graphique (`c:chartSpace`). */
export function chartSpaceXml(inp: ChartXmlInput): string {
  const o = inp.opts ?? {};
  const series = inp.series;
  const type = inp.type;
  const kindOf = (i: number): "bar" | "line" | "area" | "scatter" =>
    type === "combo" ? (o.seriesTypes?.[i] ?? (i === 0 ? "bar" : "line")) : type === "bar" ? "bar" : type === "area" ? "area" : type === "scatter" ? "scatter" : "line";
  const secondary = (i: number) => type === "combo" && !!o.secondary?.includes(i);
  const grouping = o.grouping === "stacked" ? "stacked" : o.grouping === "percent" ? "percentStacked" : "clustered";
  const trend = o.trendline;
  const trendXml = (i: number): string => {
    if (!trend || (trend.series ?? 0) !== i) return "";
    const tt = trend.type === "avg" ? "movingAvg" : trend.type;
    return (
      `<c:trendline><c:trendlineType val="${tt}"/>` +
      (trend.type === "poly" ? `<c:order val="${Math.max(2, Math.min(6, trend.order ?? 2))}"/>` : "") +
      (trend.type === "avg" ? `<c:period val="${Math.max(2, trend.period ?? 3)}"/>` : "") +
      `<c:dispRSqr val="0"/><c:dispEq val="0"/></c:trendline>`
    );
  };
  const tx = (s: OoxmlSeries) => (s.name ? `<c:tx><c:v>${xe(s.name)}</c:v></c:tx>` : "");

  const serXml = (s: OoxmlSeries, i: number, kind: "bar" | "line" | "area" | "scatter" | "pie"): string => {
    const head = `<c:idx val="${i}"/><c:order val="${i}"/>${tx(s)}`;
    const cat = s.catRef || s.cats ? `<c:cat>${strData(s.catRef, s.cats)}</c:cat>` : "";
    const val = `<c:val>${numData(s.valRef, s.vals)}</c:val>`;
    switch (kind) {
      case "bar":
        return `<c:ser>${head}<c:invertIfNegative val="0"/>${trendXml(i)}${cat}${val}</c:ser>`;
      case "line":
        return `<c:ser>${head}<c:marker><c:symbol val="circle"/></c:marker>${trendXml(i)}${cat}${val}<c:smooth val="${o.smooth ? 1 : 0}"/></c:ser>`;
      case "area":
        return `<c:ser>${head}${trendXml(i)}${cat}${val}</c:ser>`;
      case "scatter":
        return (
          `<c:ser>${head}<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>${trendXml(i)}` +
          `<c:xVal>${s.xRef || s.xvals ? numData(s.xRef, s.xvals) : strData(s.catRef, s.cats)}</c:xVal><c:yVal>${numData(s.valRef, s.vals)}</c:yVal><c:smooth val="0"/></c:ser>`
        );
      default:
        return `<c:ser>${head}${cat}${val}</c:ser>`;
    }
  };

  let plot = "";
  let axes = "";
  const horizontal = !!o.horizontal && (type === "bar" || type === "combo");
  const fmt = o.yFormat && o.yFormat !== "general" ? `<c:numFmt formatCode="${xe(FMT_CODE[o.yFormat])}" sourceLinked="0"/>` : "";
  const scaling = `<c:scaling><c:orientation val="minMax"/>${o.yMax !== undefined ? `<c:max val="${o.yMax}"/>` : ""}${o.yMin !== undefined ? `<c:min val="${o.yMin}"/>` : ""}</c:scaling>`;
  const grid = `<c:majorGridlines/>`;

  if (type === "pie") {
    plot = `<c:pieChart><c:varyColors val="1"/>${series[0] ? serXml(series[0], 0, "pie") : ""}${dLbls(!!o.dataLabels)}<c:firstSliceAng val="0"/></c:pieChart>`;
  } else if (type === "scatter") {
    plot =
      `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${series.map((s, i) => serXml(s, i, "scatter")).join("")}${dLbls(!!o.dataLabels)}` +
      `<c:axId val="${PLOT_IDS.cat}"/><c:axId val="${PLOT_IDS.val}"/></c:scatterChart>`;
    axes =
      `<c:valAx><c:axId val="${PLOT_IDS.cat}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/>${o.xTitle ? richTitle(o.xTitle) : ""}<c:numFmt formatCode="General" sourceLinked="1"/><c:crossAx val="${PLOT_IDS.val}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>` +
      `<c:valAx><c:axId val="${PLOT_IDS.val}"/>${scaling}<c:delete val="0"/><c:axPos val="l"/>${grid}${o.yTitle ? richTitle(o.yTitle, -5400000) : ""}${fmt}<c:crossAx val="${PLOT_IDS.cat}"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>`;
  } else {
    // groupes : une balise par genre de série (barres / aires / courbes), primaire puis secondaire
    const groups: { kind: "bar" | "line" | "area"; sec: boolean; idx: number[] }[] = [];
    series.forEach((_, i) => {
      const kind = kindOf(i) as "bar" | "line" | "area";
      const sec = secondary(i);
      let g = groups.find((x) => x.kind === kind && x.sec === sec);
      if (!g) groups.push((g = { kind, sec, idx: [] }));
      g.idx.push(i);
    });
    plot = groups
      .map((g) => {
        const ax = g.sec ? [PLOT_IDS.cat2, PLOT_IDS.val2] : [PLOT_IDS.cat, PLOT_IDS.val];
        const sers = g.idx.map((i) => serXml(series[i]!, i, g.kind)).join("");
        const axIds = `<c:axId val="${ax[0]}"/><c:axId val="${ax[1]}"/>`;
        if (g.kind === "bar")
          return `<c:barChart><c:barDir val="${horizontal ? "bar" : "col"}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${sers}${dLbls(!!o.dataLabels)}<c:gapWidth val="150"/>${grouping !== "clustered" ? '<c:overlap val="100"/>' : ""}${axIds}</c:barChart>`;
        if (g.kind === "area") return `<c:areaChart><c:grouping val="${grouping === "clustered" ? "standard" : grouping}"/><c:varyColors val="0"/>${sers}${dLbls(!!o.dataLabels)}${axIds}</c:areaChart>`;
        return `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${sers}${dLbls(!!o.dataLabels)}<c:marker val="1"/>${axIds}</c:lineChart>`;
      })
      .join("");
    const hasSec = groups.some((g) => g.sec);
    axes =
      `<c:catAx><c:axId val="${PLOT_IDS.cat}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? "l" : "b"}"/>${o.xTitle ? richTitle(o.xTitle, horizontal ? -5400000 : undefined) : ""}<c:crossAx val="${PLOT_IDS.val}"/></c:catAx>` +
      `<c:valAx><c:axId val="${PLOT_IDS.val}"/>${scaling}<c:delete val="0"/><c:axPos val="${horizontal ? "b" : "l"}"/>${grid}${o.yTitle ? richTitle(o.yTitle, horizontal ? undefined : -5400000) : ""}${o.grouping === "percent" ? '<c:numFmt formatCode="0%" sourceLinked="0"/>' : fmt}<c:crossAx val="${PLOT_IDS.cat}"/><c:crossBetween val="between"/></c:valAx>` +
      (hasSec
        ? `<c:catAx><c:axId val="${PLOT_IDS.cat2}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="1"/><c:axPos val="b"/><c:crossAx val="${PLOT_IDS.val2}"/></c:catAx>` +
          `<c:valAx><c:axId val="${PLOT_IDS.val2}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="r"/>${o.y2Title ? richTitle(o.y2Title, 5400000) : ""}<c:crossAx val="${PLOT_IDS.cat2}"/><c:crosses val="max"/><c:crossBetween val="between"/></c:valAx>`
        : "");
  }

  const legendPos = o.legend ?? (type === "pie" || series.length > 1 ? "bottom" : "none");
  const legend = legendPos === "none" ? "" : `<c:legend><c:legendPos val="${legendPos === "top" ? "t" : legendPos === "right" ? "r" : "b"}"/><c:overlay val="0"/></c:legend>`;
  const title = inp.title
    ? `${richTitle(inp.title)}<c:autoTitleDeleted val="0"/>`
    : `<c:autoTitleDeleted val="1"/>`;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="${C_NS}" xmlns:a="${A_NS}" xmlns:r="${R_NS}">` +
    `<c:chart>${title}<c:plotArea><c:layout/>${plot}${axes}</c:plotArea>${legend}` +
    `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`
  );
}

// --- Lecture ----------------------------------------------------------------

export interface ReadChart {
  type: ChartType;
  title?: string;
  opts?: ChartOptions;
  seriesCount: number;
}

const byTag = (root: Element | Document, name: string): Element[] => Array.from(root.getElementsByTagName(name));
const attrVal = (el: Element | null | undefined): string | null => el?.getAttribute("val") ?? null;

function titleText(el: Element | null | undefined): string | undefined {
  if (!el) return undefined;
  const t = byTag(el, "a:t")
    .map((x) => x.textContent ?? "")
    .join("");
  return t.trim() || undefined;
}

function formatFromCode(code: string | null): ChartAxisFormat | undefined {
  if (!code) return undefined;
  if (code.includes("%")) return "percent";
  if (code.includes("€")) return "currency";
  if (/^0\.0+$/.test(code) || /^#,##0\.0+$/.test(code)) return "decimal";
  if (code === "0" || code === "#,##0") return "int";
  return undefined;
}

/** Relit type et options d'un graphique DrawingML (document déjà parsé). */
export function readChartOptions(doc: Document): ReadChart {
  const has = (t: string) => doc.getElementsByTagName(t).length > 0;
  const chart = byTag(doc, "c:chart")[0];
  const plot = byTag(doc, "c:plotArea")[0];
  const sers = byTag(doc, "c:ser");
  const barEl = byTag(doc, "c:barChart")[0] ?? byTag(doc, "c:bar3DChart")[0];
  const lineEl = byTag(doc, "c:lineChart")[0] ?? byTag(doc, "c:line3DChart")[0];
  const areaEl = byTag(doc, "c:areaChart")[0] ?? byTag(doc, "c:area3DChart")[0];
  const o: ChartOptions = {};

  let type: ChartType = "bar";
  if (has("c:pieChart") || has("c:pie3DChart") || has("c:doughnutChart")) type = "pie";
  else if (has("c:scatterChart")) type = "scatter";
  else if (barEl && lineEl) type = "combo";
  else if (areaEl && !barEl) type = "area";
  else if (lineEl && !barEl) type = "line";

  // groupement / orientation
  const grp = attrVal(byTag(doc, "c:grouping")[0]);
  if (grp === "stacked") o.grouping = "stacked";
  else if (grp === "percentStacked") o.grouping = "percent";
  if (attrVal(byTag(doc, "c:barDir")[0]) === "bar") o.horizontal = true;

  // combiné : type par série (ordre des séries), axe secondaire = groupe dont les axId diffèrent du premier
  if (type === "combo" && plot) {
    const groups = Array.from(plot.children).filter((c) => /^c:(bar|line|area)Chart$/.test(c.tagName));
    const firstAx = byTag(groups[0]!, "c:axId").map((a) => a.getAttribute("val")).join(",");
    const types: ("bar" | "line")[] = [];
    const sec: number[] = [];
    let idx = 0;
    for (const g of groups) {
      const kind = g.tagName === "c:barChart" ? "bar" : "line";
      const isSec = byTag(g, "c:axId").map((a) => a.getAttribute("val")).join(",") !== firstAx;
      for (let k = 0; k < byTag(g, "c:ser").length; k++) {
        types[idx] = kind;
        if (isSec) sec.push(idx);
        idx++;
      }
    }
    o.seriesTypes = types;
    if (sec.length) o.secondary = sec;
  }

  // légende
  const legend = byTag(doc, "c:legend")[0];
  const lp = attrVal(legend ? byTag(legend, "c:legendPos")[0] : null);
  o.legend = !legend ? "none" : lp === "t" ? "top" : lp === "r" || lp === "l" ? "right" : "bottom";

  // étiquettes de données
  if (byTag(doc, "c:dLbls").some((d) => attrVal(byTag(d, "c:showVal")[0]) === "1")) o.dataLabels = true;

  // axes
  const catAxes = byTag(doc, "c:catAx");
  const valAxes = byTag(doc, "c:valAx");
  const primaryVal = type === "scatter" ? valAxes.find((a) => attrVal(byTag(a, "c:axPos")[0]) === "l") ?? valAxes[1] : valAxes[0];
  const xAxis = type === "scatter" ? valAxes.find((a) => attrVal(byTag(a, "c:axPos")[0]) === "b") ?? valAxes[0] : catAxes[0];
  const xt = titleText(xAxis ? byTag(xAxis, "c:title")[0] : null);
  if (xt) o.xTitle = xt;
  const yt = titleText(primaryVal ? byTag(primaryVal, "c:title")[0] : null);
  if (yt) o.yTitle = yt;
  if (type === "combo" && valAxes[1]) {
    const y2 = titleText(byTag(valAxes[1], "c:title")[0]);
    if (y2) o.y2Title = y2;
  }
  if (primaryVal) {
    const mx = attrVal(byTag(byTag(primaryVal, "c:scaling")[0] ?? primaryVal, "c:max")[0]);
    const mn = attrVal(byTag(byTag(primaryVal, "c:scaling")[0] ?? primaryVal, "c:min")[0]);
    if (mx !== null && Number.isFinite(Number(mx))) o.yMax = Number(mx);
    if (mn !== null && Number.isFinite(Number(mn))) o.yMin = Number(mn);
    const f = formatFromCode(byTag(primaryVal, "c:numFmt")[0]?.getAttribute("formatCode") ?? null);
    if (f && o.grouping !== "percent") o.yFormat = f;
  }

  // tendance (la première rencontrée)
  sers.forEach((s, i) => {
    if (o.trendline) return;
    const t = byTag(s, "c:trendline")[0];
    if (!t) return;
    const tt = attrVal(byTag(t, "c:trendlineType")[0]);
    const kind = tt === "poly" ? "poly" : tt === "movingAvg" ? "avg" : tt === "linear" ? "linear" : null;
    if (!kind) return;
    o.trendline = {
      type: kind,
      ...(kind === "poly" ? { order: Number(attrVal(byTag(t, "c:order")[0]) ?? 2) } : {}),
      ...(kind === "avg" ? { period: Number(attrVal(byTag(t, "c:period")[0]) ?? 3) } : {}),
      ...(i > 0 ? { series: i } : {}),
    };
  });
  if (byTag(doc, "c:smooth").some((x) => attrVal(x) === "1")) o.smooth = true;

  const clean: ChartOptions = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== false) (clean as Record<string, unknown>)[k] = v;
  // légende « bas » = défaut pour plusieurs séries ; « aucune » = défaut pour une seule : on n'écrit que l'écart.
  const defLegend = type === "pie" || sers.length > 1 ? "bottom" : "none";
  if (clean.legend === defLegend) delete clean.legend;
  void chart;
  return { type, title: titleText(byTag(doc, "c:title").find((t) => t.parentElement?.tagName === "c:chart") ?? null), opts: Object.keys(clean).length ? clean : undefined, seriesCount: sers.length };
}
