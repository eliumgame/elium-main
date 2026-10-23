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
