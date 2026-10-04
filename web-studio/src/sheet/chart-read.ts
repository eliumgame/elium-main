/** Données (cache ou littéral) d'un graphique DrawingML : libellés de catégories + valeurs par série. */
export interface ReadChartData {
  labels: string[];
  series: { label: string; values: number[] }[];
}

const byTag = (root: Element | Document, name: string): Element[] => Array.from(root.getElementsByTagName(name));

export function readChartData(doc: Document): ReadChartData {
  const pts = (el: Element | undefined): string[] => (el ? byTag(el, "c:pt").map((p) => byTag(p, "c:v")[0]?.textContent ?? "") : []);
  const sers = byTag(doc, "c:ser");
  let labels: string[] = [];
  const series = sers.map((s, i) => {
    const tx = byTag(s, "c:tx")[0];
    const name = tx ? (byTag(tx, "c:v")[0]?.textContent ?? "").trim() : "";
    const catEl = byTag(s, "c:cat")[0] ?? byTag(s, "c:xVal")[0];
    if (!labels.length && catEl) labels = pts(catEl);
    const valEl = byTag(s, "c:val")[0] ?? byTag(s, "c:yVal")[0];
    return { label: name || `Série ${i + 1}`, values: pts(valEl).map((v) => Number(v) || 0) };
  });
  const n = Math.max(0, ...series.map((x) => x.values.length));
  if (labels.length < n) labels = [...labels, ...Array.from({ length: n - labels.length }, (_, i) => String(labels.length + i + 1))];
  return { labels, series };
}
