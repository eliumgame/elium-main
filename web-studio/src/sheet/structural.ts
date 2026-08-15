/**
 * Opérations structurelles PURES sur une feuille : insertion / suppression de
 * lignes et de colonnes. Aucune dépendance à React ni au stockage — la même
 * fonction sert au Tableur local (mono-utilisateur) et au Tableur collaboratif
 * (réconcilié dans le CRDT), donc un seul comportement, testé une seule fois.
 *
 * Le même plan de relocalisation qui déplace les cellules réécrit AUSSI les
 * références dans les formules survivantes : `=SOMME(A1:A5)` suit les lignes
 * insérées/supprimées. Les largeurs de colonnes suivent leur colonne. (Comme le
 * Tableur local historique, les plages des fusions / mises en forme
 * conditionnelles / validations ne sont pas redécalées — comportement conservé
 * à l'identique pour la parité.)
 */
import { indexToCol, parseRef, rewriteRefs, type RefMap } from "./formula";
import { visibleRowsInRange } from "./filter";
import type { CellStyle, SheetData } from "./model";

type Pos = { c: number; r: number };
export type Rect = { c0: number; c1: number; r0: number; r1: number };
const cellRef = (c: number, r: number) => indexToCol(c) + (r + 1);

function reindexCells(
  cells: Record<string, string>,
  fn: (c: number, r: number) => Pos | null,
  rewrite: (v: string) => string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [ref, v] of Object.entries(cells)) {
    const p = parseRef(ref);
    if (!p) continue;
    const np = fn(p.col, p.row);
    if (np) out[cellRef(np.c, np.r)] = rewrite(v);
  }
  return out;
}

function reindexStyles(
  styles: Record<string, CellStyle> | undefined,
  fn: (c: number, r: number) => Pos | null,
): Record<string, CellStyle> | undefined {
  if (!styles) return undefined;
  const out: Record<string, CellStyle> = {};
  for (const [ref, v] of Object.entries(styles)) {
    const p = parseRef(ref);
    if (!p) continue;
    const np = fn(p.col, p.row);
    if (np) out[cellRef(np.c, np.r)] = v;
  }
  return out;
}

/** Applique un plan de relocalisation `fn` (et le décalage de taille) à la feuille. */
function structural(
  sheet: SheetData,
  fn: (c: number, r: number) => Pos | null,
  dCols: number,
  dRows: number,
): SheetData {
  const refMap: RefMap = (col, row) => {
    const np = fn(col, row);
    return np ? { col: np.c, row: np.r } : null;
  };
  const rewrite = (v: string) => (v[0] === "=" ? rewriteRefs(v, refMap) : v);

  let colWidths: Record<number, number> | undefined;
  if (sheet.colWidths) {
    colWidths = {};
    for (const [k, w] of Object.entries(sheet.colWidths)) {
      const np = fn(Number(k), 0);
      if (np) colWidths[np.c] = w;
    }
  }

  const next: SheetData = {
    ...sheet,
    cols: Math.max(1, sheet.cols + dCols),
    rows: Math.max(1, sheet.rows + dRows),
    cells: reindexCells(sheet.cells, fn, rewrite),
  };
  const styles = reindexStyles(sheet.styles, fn);
  if (styles) next.styles = styles;
  else delete next.styles;
  if (colWidths) next.colWidths = colWidths;
  else delete next.colWidths;
  return next;
}

export function insertRow(sheet: SheetData, at: number): SheetData {
  return structural(sheet, (c, r) => ({ c, r: r >= at ? r + 1 : r }), 0, 1);
}
export function deleteRow(sheet: SheetData, at: number): SheetData {
  return structural(sheet, (c, r) => (r === at ? null : { c, r: r > at ? r - 1 : r }), 0, -1);
}
export function insertCol(sheet: SheetData, at: number): SheetData {
  return structural(sheet, (c, r) => ({ c: c >= at ? c + 1 : c, r }), 1, 0);
}
export function deleteCol(sheet: SheetData, at: number): SheetData {
  return structural(sheet, (c, r) => (c === at ? null : { c: c > at ? c - 1 : c, r }), -1, 0);
}

/**
 * Trie les lignes de la sélection par la colonne `key`, direction `dir`
 * (1 asc / -1 desc). Une sélection d'UNE cellule étend au bloc contigu (les
 * colonnes adjacentes voyagent avec la clé). Ne réordonne QUE les lignes
 * visibles sous le filtre (comportement Excel), via `displayOf` pour tester la
 * visibilité. Le style par cellule suit la donnée. Fonction pure.
 */
export function sortRange(
  sheet: SheetData,
  key: number,
  region: Rect,
  dir: 1 | -1,
  displayOf: (c: number, r: number) => string,
): SheetData {
  const has = (c: number, r: number) => (sheet.cells[cellRef(c, r)] ?? "") !== "";
  let { c0: C0, c1: C1, r0: R0, r1: R1 } = region;
  if (region.c0 === region.c1 && region.r0 === region.r1) {
    let grew = true;
    while (grew) {
      grew = false;
      const colData = (c: number) => {
        for (let r = R0; r <= R1; r++) if (has(c, r)) return true;
        return false;
      };
      const rowData = (r: number) => {
        for (let c = C0; c <= C1; c++) if (has(c, r)) return true;
        return false;
      };
      if (C0 > 0 && colData(C0 - 1)) {
        C0--;
        grew = true;
      }
      if (C1 < sheet.cols - 1 && colData(C1 + 1)) {
        C1++;
        grew = true;
      }
      if (R0 > 0 && rowData(R0 - 1)) {
        R0--;
        grew = true;
      }
      if (R1 < sheet.rows - 1 && rowData(R1 + 1)) {
        R1++;
        grew = true;
      }
    }
  }
  // Sauter une ligne d'en-tête (libellé non numérique au-dessus de données numériques).
  let start = R0;
  const isNum = (x: string) => x !== "" && !Number.isNaN(Number(x));
  if (R1 > R0) {
    const k0 = sheet.cells[cellRef(key, R0)] ?? "";
    if (k0 !== "" && !isNum(k0) && isNum(sheet.cells[cellRef(key, R0 + 1)] ?? "")) start = R0 + 1;
  }
  const cells = { ...sheet.cells };
  const styles = { ...(sheet.styles ?? {}) };
  const rowsIdx = visibleRowsInRange(sheet.filter, displayOf, start, R1);
  const snap = rowsIdx.map((r) => {
    const row: Record<number, string | undefined> = {};
    const st: Record<number, CellStyle | undefined> = {};
    for (let c = C0; c <= C1; c++) {
      row[c] = sheet.cells[cellRef(c, r)];
      st[c] = sheet.styles?.[cellRef(c, r)];
    }
    return { key: sheet.cells[cellRef(key, r)] ?? "", row, st };
  });
  snap.sort((a, b) => {
    const an = Number(a.key),
      bn = Number(b.key);
    const bothNum = a.key !== "" && b.key !== "" && !Number.isNaN(an) && !Number.isNaN(bn);
    return (bothNum ? an - bn : a.key.localeCompare(b.key, "fr")) * dir;
  });
  rowsIdx.forEach((r, i) => {
    for (let c = C0; c <= C1; c++) {
      const ref = cellRef(c, r);
      const v = snap[i]!.row[c];
      if (v === undefined || v === "") delete cells[ref];
      else cells[ref] = v;
      const s = snap[i]!.st[c];
      if (s) styles[ref] = s;
      else delete styles[ref];
    }
  });
  const out: SheetData = { ...sheet, cells };
  if (Object.keys(styles).length) out.styles = styles;
  else delete out.styles;
  return out;
}

/**
 * Poignée de recopie : étend le contenu (et le style) de la plage source `src`
 * jusqu'à la cellule `to`. Détecte une progression arithmétique (incrément
 * régulier) et l'extrapole ; sinon recopie cycliquement. Les références des
 * formules recopiées sont décalées (comme dans un vrai tableur). Fonction pure.
 */
export function fillRange(sheet: SheetData, src: Rect, to: Pos): SheetData {
  const cells = { ...sheet.cells };
  const styles = { ...(sheet.styles ?? {}) };
  const num = (raw?: string): number | null => {
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isNaN(n) ? null : n;
  };
  const put = (
    c: number,
    r: number,
    raw: string | undefined,
    st: CellStyle | undefined,
    offC: number,
    offR: number,
  ) => {
    const ref = cellRef(c, r);
    let v = raw;
    if (v != null && v[0] === "=" && (offC || offR))
      v = rewriteRefs(v, (cc, rr) => ({ col: cc + offC, row: rr + offR }), true);
    if (v == null || v === "") delete cells[ref];
    else cells[ref] = v;
    if (st) styles[ref] = st;
    else delete styles[ref];
  };
  const arithStep = (vals: (string | undefined)[]): number | null => {
    const nums = vals.map(num);
    if (vals.some((v) => v && v[0] === "=") || nums.some((n) => n === null) || nums.length < 2) return null;
    const step = nums[1]! - nums[0]!;
    return nums.slice(1).every((n, i) => Math.abs(n! - nums[i]! - step) < 1e-9) ? step : null;
  };
  const overR = to.r > src.r1 ? to.r - src.r1 : to.r < src.r0 ? to.r - src.r0 : 0;
  const overC = to.c > src.c1 ? to.c - src.c1 : to.c < src.c0 ? to.c - src.c0 : 0;
  const vertical = Math.abs(overR) >= Math.abs(overC);

  if (vertical && overR !== 0) {
    const dir = overR > 0 ? 1 : -1,
      count = Math.abs(overR),
      h = src.r1 - src.r0 + 1;
    for (let c = src.c0; c <= src.c1; c++) {
      const vals: (string | undefined)[] = [];
      for (let r = src.r0; r <= src.r1; r++) vals.push(sheet.cells[cellRef(c, r)]);
      const step = arithStep(vals);
      for (let k = 1; k <= count; k++) {
        const destR = dir > 0 ? src.r1 + k : src.r0 - k;
        if (step != null) {
          const bval = dir > 0 ? num(vals[h - 1])! : num(vals[0])!;
          put(
            c,
            destR,
            String(bval + step * (dir > 0 ? k : -k)),
            sheet.styles?.[cellRef(c, dir > 0 ? src.r1 : src.r0)],
            0,
            0,
          );
        } else {
          const srcR = src.r0 + ((((destR - src.r0) % h) + h) % h);
          put(c, destR, sheet.cells[cellRef(c, srcR)], sheet.styles?.[cellRef(c, srcR)], 0, destR - srcR);
        }
      }
    }
  } else if (overC !== 0) {
    const dir = overC > 0 ? 1 : -1,
      count = Math.abs(overC),
      w = src.c1 - src.c0 + 1;
    for (let r = src.r0; r <= src.r1; r++) {
      const vals: (string | undefined)[] = [];
      for (let c = src.c0; c <= src.c1; c++) vals.push(sheet.cells[cellRef(c, r)]);
      const step = arithStep(vals);
      for (let k = 1; k <= count; k++) {
        const destC = dir > 0 ? src.c1 + k : src.c0 - k;
        if (step != null) {
          const bval = dir > 0 ? num(vals[w - 1])! : num(vals[0])!;
          put(
            destC,
            r,
            String(bval + step * (dir > 0 ? k : -k)),
            sheet.styles?.[cellRef(dir > 0 ? src.c1 : src.c0, r)],
            0,
            0,
          );
        } else {
          const srcC = src.c0 + ((((destC - src.c0) % w) + w) % w);
          put(destC, r, sheet.cells[cellRef(srcC, r)], sheet.styles?.[cellRef(srcC, r)], destC - srcC, 0);
        }
      }
    }
  }
  const out: SheetData = {
    ...sheet,
    cells,
    cols: Math.max(sheet.cols, to.c + 1),
    rows: Math.max(sheet.rows, to.r + 1),
  };
  if (Object.keys(styles).length) out.styles = styles;
  else delete out.styles;
  return out;
}
