/**
 * Min/max sans dépliage d'arguments : `Math.min(...tableau)` lève une `RangeError` (« Maximum call
 * stack size exceeded ») dès ~100 000 valeurs. Mêmes résultats que `Math.min/max` (tableau vide :
 * ±Infinity ; NaN propagé).
 */
export function minOf(values: readonly number[]): number {
  let m = Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v < m) m = v;
    else if (v !== v) return NaN;
  }
  return m;
}

export function maxOf(values: readonly number[]): number {
  let m = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (v > m) m = v;
    else if (v !== v) return NaN;
  }
  return m;
}

const FR_NUMBER = /^[+-]?(?:\d+|[1-9]\d{0,2}(?:[   ]\d{3})+)(?:,\d+)?$/;

/**
 * Nombre saisi dans une cellule (non formule) : « 12.5 » comme avant, mais aussi la saisie française
 * « 12,5 » et « 1 234,5 » (espaces fines ou insécables en séparateur de milliers). `null` si ce n'est
 * pas un nombre (la cellule reste du texte).
 */
export function parseCellNumber(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isNaN(n)) return n;
  if (!FR_NUMBER.test(t)) return null;
  const v = Number(t.replace(/[   ]/g, "").replace(",", "."));
  return Number.isNaN(v) ? null : v;
}
