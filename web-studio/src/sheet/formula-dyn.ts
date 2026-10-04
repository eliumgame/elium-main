/**
 * Fonctions « tableaux dynamiques » du moteur de formules (SEQUENCE, FILTER,
 * SORT, UNIQUE, TEXTSPLIT, TAKE/DROP, VSTACK/HSTACK, WRAPROWS…). Ce module est
 * pur : il manipule des matrices de CellValue et ne connaît ni le parseur ni
 * la grille ; formula.ts l'appelle avec des arguments déjà évalués.
 *
 * Import circulaire volontaire avec formula.ts : seuls des identifiants
 * utilisés À L'EXÉCUTION (jamais au chargement du module) sont partagés.
 */
import { FormulaError, cmpVals, looseEq, truthy, toNumber, isError, type CellValue } from "./formula";

/** Valeur tableau : lignes de cellules (jamais vide : au moins 1×1). */
export interface Matrix {
  m: CellValue[][];
}
export const isMat = (v: unknown): v is Matrix => typeof v === "object" && v !== null && "m" in v;
export const mat = (m: CellValue[][]): Matrix => ({ m });
export const toMat = (v: CellValue | Matrix): Matrix => (isMat(v) ? v : { m: [[v]] });
export const rowsOf = (a: Matrix): number => a.m.length;
export const colsOf = (a: Matrix): number => a.m[0]?.length ?? 0;
const NA: CellValue = { error: "#N/A" };

/** Noms des fonctions de ce module (retournent un tableau ou en consomment un en bloc). */
export const DYN_FUNCS = new Set([
  "SEQUENCE",
  "RANDARRAY",
  "UNIQUE",
  "SORT",
  "SORTBY",
  "FILTER",
  "TRANSPOSE",
  "TEXTSPLIT",
  "CHOOSECOLS",
  "CHOOSEROWS",
  "TAKE",
  "DROP",
  "VSTACK",
  "HSTACK",
  "WRAPROWS",
  "WRAPCOLS",
  "TOCOL",
  "TOROW",
  "EXPAND",
  "XMATCH",
  "SUMPRODUCT",
  "ROWS",
  "COLUMNS",
  "MMULT",
]);

/** Fonctions dont le résultat peut être un tableau (déclenche la détection de débordement). */
export const ARRAY_RETURNING = new Set(
  [...DYN_FUNCS].filter((n) => !["XMATCH", "SUMPRODUCT", "ROWS", "COLUMNS"].includes(n)),
);

function num(v: CellValue | Matrix | undefined, dflt: number): number {
  if (v === undefined) return dflt;
  const s = isMat(v) ? v.m[0][0] : v;
  if (s === "") return dflt;
  return toNumber(s);
}
function int(v: CellValue | Matrix | undefined, dflt: number): number {
  return Math.trunc(num(v, dflt));
}
function bool(v: CellValue | Matrix | undefined, dflt: boolean): boolean {
  if (v === undefined) return dflt;
  const s = isMat(v) ? v.m[0][0] : v;
  if (s === "") return dflt;
  return truthy(s);
}
const MAX_CELLS = 1_000_000;
function guardSize(r: number, c: number): void {
  if (r < 1 || c < 1) throw new FormulaError("#CALC");
  if (r * c > MAX_CELLS) throw new FormulaError("#NUM");
}

function grid(r: number, c: number, fill: (i: number, j: number) => CellValue): Matrix {
  guardSize(r, c);
  const m: CellValue[][] = [];
  for (let i = 0; i < r; i++) {
    const row: CellValue[] = [];
    for (let j = 0; j < c; j++) row.push(fill(i, j));
    m.push(row);
  }
  return { m };
}

export function transpose(a: Matrix): Matrix {
  return grid(colsOf(a), rowsOf(a), (i, j) => a.m[j][i]);
}

const rowKey = (row: CellValue[]): string =>
  row
    .map((v) => (isError(v) ? `e:${v.error}` : typeof v === "number" ? `n:${v}` : `s:${String(v).toLowerCase()}`))
    .join("\u0001");

function uniqueRows(a: Matrix, exactlyOnce: boolean): CellValue[][] {
  const counts = new Map<string, number>();
  const first = new Map<string, CellValue[]>();
  const order: string[] = [];
  for (const row of a.m) {
    const k = rowKey(row);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (!first.has(k)) {
      first.set(k, row);
      order.push(k);
    }
  }
  return order.filter((k) => !exactlyOnce || counts.get(k) === 1).map((k) => first.get(k)!);
}

export function unique(a: Matrix, byCol: boolean, exactlyOnce: boolean): Matrix {
  const src = byCol ? transpose(a) : a;
  const rows = uniqueRows(src, exactlyOnce);
  if (!rows.length) throw new FormulaError("#CALC");
  const out = { m: rows };
  return byCol ? transpose(out) : out;
}

/** Tri stable par colonnes de clés (déjà extraites) : `keys[k][i]` = clé k de la ligne i. */
function orderIndices(n: number, keys: CellValue[][], orders: number[]): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((x, y) => {
    for (let k = 0; k < keys.length; k++) {
      const c = cmpVals(keys[k][x], keys[k][y]);
      if (c !== 0) return c * (orders[k] ?? 1);
    }
    return x - y;
  });
  return idx;
}

export function sort(a: Matrix, sortIndex: number, order: number, byCol: boolean): Matrix {
  const src = byCol ? transpose(a) : a;
  if (sortIndex < 1 || sortIndex > colsOf(src)) throw new FormulaError("#VALUE");
  const keys = [src.m.map((r) => r[sortIndex - 1])];
  const idx = orderIndices(rowsOf(src), keys, [order === -1 ? -1 : 1]);
  const out = { m: idx.map((i) => src.m[i]) };
  return byCol ? transpose(out) : out;
}

export function sortBy(a: Matrix, pairs: { by: Matrix; order: number }[]): Matrix {
  const n = rowsOf(a);
  const byRows = pairs.every((p) => rowsOf(p.by) === n && colsOf(p.by) === 1);
  const n2 = colsOf(a);
  const byCols = pairs.every((p) => colsOf(p.by) === n2 && rowsOf(p.by) === 1);
  if (byRows) {
    const idx = orderIndices(
      n,
      pairs.map((p) => p.by.m.map((r) => r[0])),
      pairs.map((p) => (p.order === -1 ? -1 : 1)),
    );
    return { m: idx.map((i) => a.m[i]) };
  }
  if (byCols) {
    const idx = orderIndices(
      n2,
      pairs.map((p) => p.by.m[0]),
      pairs.map((p) => (p.order === -1 ? -1 : 1)),
    );
    return grid(n, n2, (i, j) => a.m[i][idx[j]]);
  }
  throw new FormulaError("#VALUE");
}

export function filter(a: Matrix, include: Matrix, ifEmpty: CellValue | undefined): Matrix {
  const rows = rowsOf(a);
  const cols = colsOf(a);
  let out: CellValue[][];
  if (colsOf(include) === 1 && rowsOf(include) === rows) {
    out = a.m.filter((_, i) => truthy(include.m[i][0]));
  } else if (rowsOf(include) === 1 && colsOf(include) === cols) {
    const keep = include.m[0].map(truthy);
    out = a.m.map((r) => r.filter((_, j) => keep[j]));
    if (!out[0]?.length) out = [];
  } else throw new FormulaError("#VALUE");
  if (!out.length) {
    if (ifEmpty !== undefined) return { m: [[ifEmpty]] };
    throw new FormulaError("#CALC");
  }
  return { m: out };
}

/** TEXTSPLIT(texte, sép_col, [sép_ligne], [ignorer_vide], [mode_casse], [remplir]). */
export function textSplit(
  text: string,
  colDelim: string[],
  rowDelim: string[],
  ignoreEmpty: boolean,
  insensitive: boolean,
  pad: CellValue,
): Matrix {
  const splitBy = (s: string, delims: string[]): string[] => {
    const ds = delims.filter((d) => d !== "");
    if (!ds.length) return [s];
    const esc = ds.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const parts = s.split(new RegExp(esc, insensitive ? "i" : ""));
    return ignoreEmpty ? parts.filter((p) => p !== "") : parts;
  };
  const rowsTxt = splitBy(text, rowDelim);
  const rows = rowsTxt.map((r) => splitBy(r, colDelim));
  const width = Math.max(1, ...rows.map((r) => r.length));
  return grid(rows.length || 1, width, (i, j) => {
    const cell = rows[i]?.[j];
    if (cell === undefined) return pad;
    const n = Number(cell);
    return cell.trim() !== "" && !Number.isNaN(n) && /^\s*-?\d+(\.\d+)?\s*$/.test(cell) ? n : cell;
  });
}

function idxList(v: (CellValue | Matrix)[], size: number): number[] {
  const out: number[] = [];
  for (const a of v) {
    for (const cell of toMat(a).m.flat()) {
      let k = Math.trunc(toNumber(cell));
      if (k < 0) k = size + k + 1;
      if (k < 1 || k > size) throw new FormulaError("#VALUE");
      out.push(k - 1);
    }
  }
  if (!out.length) throw new FormulaError("#VALUE");
  return out;
}
export function chooseCols(a: Matrix, cols: (CellValue | Matrix)[]): Matrix {
  const idx = idxList(cols, colsOf(a));
  return grid(rowsOf(a), idx.length, (i, j) => a.m[i][idx[j]]);
}
export function chooseRows(a: Matrix, rows: (CellValue | Matrix)[]): Matrix {
  const idx = idxList(rows, rowsOf(a));
  return grid(idx.length, colsOf(a), (i, j) => a.m[idx[i]][j]);
}

/** TAKE / DROP : un compte négatif prend / retire depuis la fin. */
export function take(a: Matrix, r: number | undefined, c: number | undefined): Matrix {
  const R = rowsOf(a);
  const C = colsOf(a);
  const [r0, r1] = r === undefined ? [0, R] : r >= 0 ? [0, Math.min(r, R)] : [Math.max(0, R + r), R];
  const [c0, c1] = c === undefined ? [0, C] : c >= 0 ? [0, Math.min(c, C)] : [Math.max(0, C + c), C];
  if (r1 - r0 < 1 || c1 - c0 < 1) throw new FormulaError("#CALC");
  return grid(r1 - r0, c1 - c0, (i, j) => a.m[r0 + i][c0 + j]);
}
export function drop(a: Matrix, r: number | undefined, c: number | undefined): Matrix {
  const R = rowsOf(a);
  const C = colsOf(a);
  const [r0, r1] = r === undefined ? [0, R] : r >= 0 ? [Math.min(r, R), R] : [0, Math.max(0, R + r)];
  const [c0, c1] = c === undefined ? [0, C] : c >= 0 ? [Math.min(c, C), C] : [0, Math.max(0, C + c)];
  if (r1 - r0 < 1 || c1 - c0 < 1) throw new FormulaError("#CALC");
  return grid(r1 - r0, c1 - c0, (i, j) => a.m[r0 + i][c0 + j]);
}

export function vstack(parts: Matrix[]): Matrix {
  const w = Math.max(...parts.map(colsOf));
  const rows: CellValue[][] = [];
  for (const p of parts)
    for (const r of p.m) rows.push(Array.from({ length: w }, (_, j) => (j < r.length ? r[j] : NA)));
  guardSize(rows.length, w);
  return { m: rows };
}
export function hstack(parts: Matrix[]): Matrix {
  const h = Math.max(...parts.map(rowsOf));
  const rows: CellValue[][] = Array.from({ length: h }, () => []);
  for (const p of parts) {
    const w = colsOf(p);
    for (let i = 0; i < h; i++) for (let j = 0; j < w; j++) rows[i].push(i < rowsOf(p) ? p.m[i][j] : NA);
  }
  guardSize(h, rows[0].length);
  return { m: rows };
}

export function toCol(a: Matrix, ignore: number, byCol: boolean): Matrix {
  const src = byCol ? transpose(a) : a;
  let flat = src.m.flat();
  if (ignore === 1 || ignore === 3) flat = flat.filter((v) => v !== "");
  if (ignore === 2 || ignore === 3) flat = flat.filter((v) => !isError(v));
  if (!flat.length) throw new FormulaError("#CALC");
  return { m: flat.map((v) => [v]) };
}

export function wrapRows(a: Matrix, count: number, pad: CellValue): Matrix {
  const flat = a.m.flat();
  if (count < 1) throw new FormulaError("#NUM");
  const rows = Math.ceil(flat.length / count);
  return grid(rows, Math.min(count, flat.length) || 1, (i, j) =>
    i * count + j < flat.length ? flat[i * count + j] : pad,
  );
}
export function wrapCols(a: Matrix, count: number, pad: CellValue): Matrix {
  return transpose(wrapRows(a, count, pad));
}

export function expand(a: Matrix, r: number, c: number, pad: CellValue): Matrix {
  if (r < rowsOf(a) || c < colsOf(a)) throw new FormulaError("#VALUE");
  return grid(r, c, (i, j) => (i < rowsOf(a) && j < colsOf(a) ? a.m[i][j] : pad));
}

export function sequence(r: number, c: number, start: number, step: number): Matrix {
  return grid(r, c, (i, j) => start + (i * c + j) * step);
}

export function randArray(r: number, c: number, min: number, max: number, whole: boolean): Matrix {
  if (min > max) throw new FormulaError("#VALUE");
  return grid(r, c, () =>
    whole
      ? Math.floor(Math.random() * (Math.floor(max) - Math.ceil(min) + 1)) + Math.ceil(min)
      : min + Math.random() * (max - min),
  );
}

/** XMATCH(valeur, tableau, [mode_corresp], [mode_recherche]). */
export function xmatch(key: CellValue, a: Matrix, matchMode: number, searchMode: number): number {
  const flat = a.m.flat();
  const idx = flat.map((_, i) => i);
  if (searchMode === -1) idx.reverse();
  const isWild = matchMode === 2;
  const wildRe =
    isWild && typeof key === "string"
      ? new RegExp(
          "^" +
            key
              .replace(/[.+^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, ".*")
              .replace(/\?/g, ".") +
            "$",
          "i",
        )
      : null;
  if (searchMode === 2 || searchMode === -2) {
    // recherche binaire : tableau supposé trié (croissant pour 2, décroissant pour -2)
    let lo = 0;
    let hi = flat.length - 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = cmpVals(flat[mid], key) * (searchMode === 2 ? 1 : -1);
      if (c === 0) return mid + 1;
      if (c < 0) {
        if (matchMode === -1) best = mid;
        lo = mid + 1;
      } else {
        if (matchMode === 1) best = mid;
        hi = mid - 1;
      }
    }
    if (best >= 0 && matchMode !== 0) return best + 1;
    throw new FormulaError("#N/A");
  }
  for (const i of idx) {
    if (wildRe ? wildRe.test(String(flat[i])) : looseEq(flat[i], key)) return i + 1;
  }
  if (matchMode === -1 || matchMode === 1) {
    // plus petite valeur >= clé (1) / plus grande valeur <= clé (-1)
    let best = -1;
    for (const i of idx) {
      const v = flat[i];
      if (v === "" || isError(v)) continue;
      const c = cmpVals(v, key);
      if (matchMode === -1 && c < 0 && (best < 0 || cmpVals(v, flat[best]) > 0)) best = i;
      if (matchMode === 1 && c > 0 && (best < 0 || cmpVals(v, flat[best]) < 0)) best = i;
    }
    if (best >= 0) return best + 1;
  }
  throw new FormulaError("#N/A");
}

export function mmult(a: Matrix, b: Matrix): Matrix {
  if (colsOf(a) !== rowsOf(b)) throw new FormulaError("#VALUE");
  return grid(rowsOf(a), colsOf(b), (i, j) => {
    let s = 0;
    for (let k = 0; k < colsOf(a); k++) s += toNumber(a.m[i][k]) * toNumber(b.m[k][j]);
    return s;
  });
}

const delims = (v: CellValue | Matrix | undefined): string[] =>
  v === undefined
    ? []
    : toMat(v)
        .m.flat()
        .map((x) => (isError(x) ? "" : String(x)));

/** Point d'entrée : args déjà évalués (scalaires ou matrices). */
export function dynFunction(name: string, a: (CellValue | Matrix)[]): CellValue | Matrix {
  const arr = (i: number): Matrix => {
    if (a[i] === undefined) throw new FormulaError("#VALUE");
    const m = toMat(a[i]);
    for (const row of m.m) for (const v of row) if (isError(v)) throw new FormulaError(v.error);
    return m;
  };
  const scalar = (i: number): CellValue | undefined => (a[i] === undefined ? undefined : toMat(a[i]).m[0][0]);
  switch (name) {
    case "SEQUENCE":
      return sequence(int(a[0], 1), int(a[1], 1), num(a[2], 1), num(a[3], 1));
    case "RANDARRAY":
      return randArray(int(a[0], 1), int(a[1], 1), num(a[2], 0), num(a[3], 1), bool(a[4], false));
    case "UNIQUE":
      return unique(arr(0), bool(a[1], false), bool(a[2], false));
    case "SORT":
      return sort(arr(0), int(a[1], 1), int(a[2], 1), bool(a[3], false));
    case "SORTBY": {
      const pairs: { by: Matrix; order: number }[] = [];
      for (let i = 1; i < a.length; i += 2) pairs.push({ by: arr(i), order: int(a[i + 1], 1) });
      if (!pairs.length) throw new FormulaError("#VALUE");
      return sortBy(arr(0), pairs);
    }
    case "FILTER":
      return filter(arr(0), arr(1), scalar(2));
    case "TRANSPOSE":
      return transpose(arr(0));
    case "TEXTSPLIT": {
      const t = scalar(0);
      if (t === undefined || isError(t))
        throw new FormulaError(isError(t as CellValue) ? (t as { error: string }).error : "#VALUE");
      return textSplit(String(t), delims(a[1]), delims(a[2]), bool(a[3], false), int(a[4], 0) === 1, scalar(5) ?? NA);
    }
    case "CHOOSECOLS":
      return chooseCols(arr(0), a.slice(1));
    case "CHOOSEROWS":
      return chooseRows(arr(0), a.slice(1));
    case "TAKE":
      return take(
        arr(0),
        a[1] === undefined || scalar(1) === "" ? undefined : int(a[1], 0),
        a[2] === undefined ? undefined : int(a[2], 0),
      );
    case "DROP":
      return drop(
        arr(0),
        a[1] === undefined || scalar(1) === "" ? undefined : int(a[1], 0),
        a[2] === undefined ? undefined : int(a[2], 0),
      );
    case "VSTACK":
      return vstack(a.map((_, i) => arr(i)));
    case "HSTACK":
      return hstack(a.map((_, i) => arr(i)));
    case "WRAPROWS":
      return wrapRows(arr(0), int(a[1], 1), scalar(2) ?? NA);
    case "WRAPCOLS":
      return wrapCols(arr(0), int(a[1], 1), scalar(2) ?? NA);
    case "TOCOL":
      return toCol(arr(0), int(a[1], 0), bool(a[2], false));
    case "TOROW":
      return transpose(toCol(arr(0), int(a[1], 0), bool(a[2], false)));
    case "EXPAND":
      return expand(arr(0), int(a[1], rowsOf(arr(0))), int(a[2], colsOf(arr(0))), scalar(3) ?? NA);
    case "XMATCH": {
      const key = scalar(0);
      if (key === undefined) throw new FormulaError("#VALUE");
      return xmatch(key, arr(1), int(a[2], 0), int(a[3], 1));
    }
    case "SUMPRODUCT": {
      const ms = a.map((_, i) => toMat(a[i]));
      const r = rowsOf(ms[0]);
      const c = colsOf(ms[0]);
      if (ms.some((x) => rowsOf(x) !== r || colsOf(x) !== c)) throw new FormulaError("#VALUE");
      let total = 0;
      for (let i = 0; i < r; i++)
        for (let j = 0; j < c; j++) {
          let p = 1;
          for (const x of ms) {
            const v = x.m[i][j];
            if (isError(v)) throw new FormulaError(v.error);
            p *=
              typeof v === "number"
                ? v
                : typeof v === "boolean"
                  ? v
                    ? 1
                    : 0
                  : Number.isNaN(Number(v)) || v === ""
                    ? 0
                    : Number(v);
          }
          total += p;
        }
      return total;
    }
    case "ROWS":
      return rowsOf(toMat(a[0] ?? ""));
    case "COLUMNS":
      return colsOf(toMat(a[0] ?? ""));
    case "MMULT":
      return mmult(arr(0), arr(1));
  }
  throw new FormulaError("#NAME");
}
