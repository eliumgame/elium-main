/**
 * Logique pure de l'éditeur de données de graphique des Présentations
 * (testable sous Node, sans React). Le modèle `ChartData` stocke la 1re série
 * dans `values`/`seriesName` et les suivantes dans `series` ; ces helpers
 * présentent le tout comme un tableau « étiquettes × séries » et gardent
 * toujours toutes les séries alignées sur les étiquettes.
 */
import { MAX_CHART_POINTS, MAX_CHART_SERIES, type ChartData, type ChartKind, type ChartSeries } from "./model";

/** Une colonne du tableau : nom (vide = nom par défaut « Série n ») + valeurs. */
export interface ChartColumn {
  name: string;
  values: number[];
}

/** Lecture tolérante d'un nombre saisi (virgule française, espaces). `null` = invalide. */
export function parseChartNumber(raw: string): number | null {
  const s = raw
    .replace(/[\s  ]/g, "")
    .replace(/,/g, ".")
    .replace(/^\+/, "");
  if (!s || !/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Toutes les séries sous forme de colonnes (la 1re = `values`). */
export function chartColumns(c: ChartData): ChartColumn[] {
  const extra = Array.isArray(c.series) ? c.series : [];
  return [
    { name: c.seriesName ?? "", values: Array.isArray(c.values) ? c.values : [] },
    ...extra.map((s) => ({ name: s.name ?? "", values: Array.isArray(s.values) ? s.values : [] })),
  ];
}

/** Nom affiché d'une colonne (nom par défaut « Série n »). */
export function columnLabel(col: ChartColumn, index: number): string {
  return col.name || `Série ${index + 1}`;
}

/** Reconstruit un ChartData à partir de colonnes, en réalignant sur les étiquettes. */
export function withColumns(c: ChartData, labels: string[], cols: ChartColumn[]): ChartData {
  const cleaned = cols.length ? cols : [{ name: "", values: [] }];
  const aligned = cleaned.map((col) => ({
    name: col.name,
    values: Array.from({ length: labels.length }, (_, i) => {
      const v = col.values[i];
      return typeof v === "number" && Number.isFinite(v) ? v : 0;
    }),
  }));
  const [first, ...rest] = aligned;
  const { seriesName: _sn, series: _s, ...base } = c;
  void _sn;
  void _s;
  const out: ChartData = { ...base, labels: labels.slice(), values: first!.values };
  if (first!.name) out.seriesName = first!.name;
  if (rest.length)
    out.series = rest.map<ChartSeries>((s, i) => ({ name: s.name || `Série ${i + 2}`, values: s.values }));
  return out;
}

/** Réaligne toutes les séries sur les étiquettes (pad avec 0 / tronque). */
export function alignChart(c: ChartData): ChartData {
  return withColumns(c, c.labels ?? [], chartColumns(c));
}

export function setLabel(c: ChartData, i: number, label: string): ChartData {
  if (i < 0 || i >= c.labels.length) return c;
  const labels = c.labels.slice();
  labels[i] = label;
  return withColumns(c, labels, chartColumns(c));
}

export function setValue(c: ChartData, s: number, i: number, v: number): ChartData {
  const cols = chartColumns(c);
  if (s < 0 || s >= cols.length || i < 0 || i >= c.labels.length || !Number.isFinite(v)) return c;
  const col = cols[s]!;
  const values = Array.from({ length: c.labels.length }, (_, k) => col.values[k] ?? 0);
  values[i] = v;
  cols[s] = { ...col, values };
  return withColumns(c, c.labels, cols);
}

export function renameSeries(c: ChartData, s: number, name: string): ChartData {
  const cols = chartColumns(c);
  if (s < 0 || s >= cols.length) return c;
  cols[s] = { ...cols[s]!, name: name.trim() };
  return withColumns(c, c.labels, cols);
}

/** Ajoute une série vide (zéros). `null` si le plafond est atteint. */
export function addSeries(c: ChartData): ChartData | null {
  const cols = chartColumns(c);
  if (cols.length >= MAX_CHART_SERIES) return null;
  cols.push({ name: `Série ${cols.length + 1}`, values: c.labels.map(() => 0) });
  return withColumns(c, c.labels, cols);
}

/** Supprime une série ; la dernière série restante ne peut pas être supprimée. */
export function removeSeries(c: ChartData, s: number): ChartData | null {
  const cols = chartColumns(c);
  if (cols.length <= 1 || s < 0 || s >= cols.length) return null;
  cols.splice(s, 1);
  return withColumns(c, c.labels, cols);
}

/** Duplique une série (insérée juste après). `null` si le plafond est atteint. */
export function duplicateSeries(c: ChartData, s: number): ChartData | null {
  const cols = chartColumns(c);
  if (cols.length >= MAX_CHART_SERIES || s < 0 || s >= cols.length) return null;
  const src = cols[s]!;
  cols.splice(s + 1, 0, { name: `${columnLabel(src, s)} (copie)`, values: src.values.slice() });
  return withColumns(c, c.labels, cols);
}

/** Déplace une série de `dir` rangs (-1 = vers la gauche). */
export function moveSeries(c: ChartData, s: number, dir: -1 | 1): ChartData | null {
  const cols = chartColumns(c);
  const t = s + dir;
  if (s < 0 || s >= cols.length || t < 0 || t >= cols.length) return null;
  [cols[s], cols[t]] = [cols[t]!, cols[s]!];
  return withColumns(c, c.labels, cols);
}

/** Ajoute un point (étiquette + 0 dans chaque série). `null` si le plafond est atteint. */
export function addPoint(c: ChartData, label = "?"): ChartData | null {
  if (c.labels.length >= MAX_CHART_POINTS) return null;
  return withColumns(c, [...c.labels, label], chartColumns(c));
}

/** Supprime un point de toutes les séries ; au moins un point est conservé. */
export function removePoint(c: ChartData, i: number): ChartData | null {
  if (c.labels.length <= 1 || i < 0 || i >= c.labels.length) return null;
  const cols = chartColumns(c).map((col) => ({ ...col, values: col.values.filter((_, k) => k !== i) }));
  return withColumns(
    c,
    c.labels.filter((_, k) => k !== i),
    cols,
  );
}

/**
 * Change le type sans toucher aux données (les séries excédentaires restent
 * dans le modèle pour pouvoir revenir à barres/courbes). Renvoie un
 * avertissement quand des séries ne seront pas utilisées.
 */
export function changeKind(c: ChartData, kind: ChartKind): { chart: ChartData; warning?: string } {
  const chart: ChartData = { ...c, kind };
  const n = chartColumns(c).length;
  if (kind === "pie" && n > 1)
    return {
      chart,
      warning: `Le camembert n'utilise que la première série : les ${n - 1} autre${n - 1 > 1 ? "s" : ""} série${n - 1 > 1 ? "s sont conservées" : " est conservée"} mais n'${n - 1 > 1 ? "apparaissent" : "apparaît"} ni à l'écran ni à l'export. Repassez en barres ou courbes pour les retrouver.`,
    };
  return { chart };
}

/** Séries réellement utilisées par le rendu / l'export pour un type donné. */
export function usedColumns(c: ChartData): ChartColumn[] {
  const cols = chartColumns(c);
  return c.kind === "pie" ? cols.slice(0, 1) : cols;
}

export function setStacked(c: ChartData, stacked: boolean): ChartData {
  const { stacked: _old, ...rest } = c;
  void _old;
  return stacked ? { ...rest, stacked: true } : rest;
}
