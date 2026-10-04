/**
 * Données de graphique depuis un collage tabulé (copie d'une plage du Tableur) :
 * 1re ligne = noms de séries, 1re colonne = libellés, le reste = nombres.
 * Accepte aussi une plage sans libellés (toutes colonnes numériques) ou sans en-tête.
 */
export interface PastedChart {
  labels: string[];
  series: { label: string; values: number[] }[];
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const t = s.trim().replace(/\s/g, "").replace(",", ".");
  if (t === "" || !/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?%?$/i.test(t)) return null;
  const v = Number(t.replace("%", ""));
  return Number.isFinite(v) ? (t.endsWith("%") ? v / 100 : v) : null;
};

export function parseTsvToChart(text: string): PastedChart | null {
  const rows = text
    .replace(/\r/g, "")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => l.split("\t"));
  if (rows.length < 1 || rows.every((r) => r.length < 1)) return null;
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 2 && rows.length < 2) return null;
  const isNumRow = (r: string[], from: number) => r.slice(from).some((c) => num(c) !== null);
  // en-tête : la première ligne ne contient pas de nombre dans les colonnes de données
  const hasHeader = width > 1 && rows.length > 1 && !isNumRow(rows[0]!, 1);
  const body = hasHeader ? rows.slice(1) : rows;
  // libellés : la première colonne n'est pas numérique
  const labelCol = width > 1 && body.some((r) => num(r[0]) === null) ? 0 : -1;
  const firstData = labelCol === 0 ? 1 : 0;
  if (width <= firstData) {
    // une seule colonne de nombres
    const vals = body.map((r) => num(r[0]));
    if (vals.some((v) => v === null) || !vals.length) return null;
    return { labels: vals.map((_, i) => String(i + 1)), series: [{ label: "Série 1", values: vals as number[] }] };
  }
  const series: PastedChart["series"] = [];
  for (let c = firstData; c < width; c++) {
    const values = body.map((r) => num(r[c]) ?? 0);
    if (!body.some((r) => num(r[c]) !== null)) continue;
    series.push({ label: hasHeader ? (rows[0]![c] ?? "").trim() || `Série ${series.length + 1}` : `Série ${series.length + 1}`, values });
  }
  if (!series.length) return null;
  const labels = body.map((r, i) => (labelCol === 0 ? (r[0] ?? "").trim() || String(i + 1) : String(i + 1)));
  return { labels, series };
}
