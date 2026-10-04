/**
 * Tableau croisé dynamique PERSISTANT : la feuille de résultat porte sa définition (`SheetData.pivot`) ;
 * on peut le modifier et l'actualiser à tout moment. Ajoute au moteur de pivot.ts le regroupement des
 * dates (année, trimestre, mois, jour) et les champs calculés (formules entre crochets, ex. « =[Ventes]-[Coûts] »).
 * Fonctions pures : la valeur des cellules source est fournie par le moteur de formules du classeur.
 */
import { createCalc, indexToCol, isError, type CellValue } from "./formula";
import { newId, type SheetData, type Workbook } from "./model";
import { tableDefs } from "./tables";
import { computePivot, pivotToSheet, type PivotAgg, type PivotConfig } from "./pivot";

export type DateGroup = "none" | "year" | "quarter" | "month" | "day";
export const DATE_GROUP_LABELS: Record<DateGroup, string> = {
  none: "Aucun",
  year: "Année",
  quarter: "Trimestre",
  month: "Mois",
  day: "Jour",
};

export interface CalcField {
  name: string;
  /** Formule avec champs entre crochets : « [Ventes]-[Coûts] » (le « = » initial est facultatif). */
  formula: string;
}

export interface PivotObject {
  id: string;
  /** Source : feuille + plage dont la première ligne = noms de champs. */
  source: { sheet: string; c0: number; r0: number; c1: number; r1: number };
  rowField: string;
  colField: string | null;
  valueField: string;
  agg: PivotAgg;
  /** Regroupement de dates appliqué au champ ligne ou colonne. */
  rowDateGroup?: DateGroup;
  colDateGroup?: DateGroup;
  calcFields?: CalcField[];
  /** Tri des libellés de lignes. */
  sort?: "none" | "asc" | "desc";
}

const EPOCH = Date.UTC(1899, 11, 30);

/** Libellé de regroupement d'une date (série Excel ou « AAAA-MM-JJ ») ; null si ce n'est pas une date. */
export function dateGroupLabel(v: string | number | boolean | null, by: DateGroup): string | null {
  if (by === "none" || v == null || v === "") return v == null ? "" : String(v);
  let d: Date | null = null;
  if (typeof v === "number") d = new Date(EPOCH + Math.round(v) * 86400000);
  else {
    const s = String(v).trim();
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    else if (/^\d+(\.\d+)?$/.test(s)) d = new Date(EPOCH + Math.round(Number(s)) * 86400000);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const mo = d.getUTCMonth() + 1;
  const p = (n: number) => String(n).padStart(2, "0");
  switch (by) {
    case "year":
      return String(y);
    case "quarter":
      return `${y} T${Math.ceil(mo / 3)}`;
    case "month":
      return `${y}-${p(mo)}`;
    default:
      return `${y}-${p(mo)}-${p(d.getUTCDate())}`;
  }
}

/** Évalue la formule d'un champ calculé pour une ligne ; null si non numérique. */
export function evalCalcField(formula: string, headers: string[], row: (string | number | boolean | null)[]): number | null {
  const body = formula.trim().replace(/^=/, "");
  let bad = false;
  const expr = body.replace(/\[([^\]]+)\]/g, (_m, name: string) => {
    const i = headers.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase());
    if (i < 0) {
      bad = true;
      return "0";
    }
    const v = row[i];
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? `(${n})` : "0";
  });
  if (bad) return null;
  const c = createCalc((ref) => (ref === "A1" ? `=${expr}` : undefined));
  const out = c.valueOf("A1");
  return typeof out === "number" && Number.isFinite(out) ? out : null;
}

/** Champs de la source : en-têtes de la plage (vides → « ColonneN ») puis champs calculés. */
export function sourceHeaders(headers: string[], calc?: CalcField[]): string[] {
  return [...headers.map((h, i) => (h.trim() ? h : `Colonne${i + 1}`)), ...(calc ?? []).map((c) => c.name)];
}

/** Lit la plage source en valeurs calculées (le moteur de formules du classeur). */
export function readSource(wb: Workbook, src: PivotObject["source"]): { headers: string[]; rows: (string | number | boolean | null)[][] } | null {
  const idx = wb.sheets.findIndex((s) => s.name === src.sheet);
  const sheet = wb.sheets[idx];
  if (!sheet) return null;
  const byName: Record<string, SheetData> = Object.fromEntries(wb.sheets.map((s) => [s.name, s]));
  const names = new Map((wb.names ?? []).map((n) => [n.name.toUpperCase(), n.ref]));
  const calc = createCalc(
    (ref) => sheet.cells[ref],
    { getSheetRaw: (n, ref) => byName[n]?.cells[ref], hasSheet: (n) => n in byName },
    names.size ? (n) => names.get(n) : undefined,
    undefined,
    { tables: tableDefs(wb.sheets), sheet: sheet.name },
  );
  const val = (c: number, r: number): string | number | boolean | null => {
    const v: CellValue = calc.valueOf(`${indexToCol(c)}${r + 1}`);
    if (isError(v)) return null;
    return v === "" ? null : v;
  };
  const headers: string[] = [];
  for (let c = src.c0; c <= src.c1; c++) headers.push(String(val(c, src.r0) ?? ""));
  const rows: (string | number | boolean | null)[][] = [];
  for (let r = src.r0 + 1; r <= src.r1; r++) {
    const row: (string | number | boolean | null)[] = [];
    for (let c = src.c0; c <= src.c1; c++) row.push(val(c, r));
    rows.push(row);
  }
  return { headers, rows };
}

export interface PivotBuild {
  sheet: SheetData;
  /** Problèmes à montrer (champ introuvable, formule invalide…). */
  warnings: string[];
}

/** Calcule la feuille de résultat d'un pivot persistant (sans toucher au classeur). */
export function buildPivot(wb: Workbook, p: PivotObject, sheetName: string): PivotBuild | { error: string } {
  const src = readSource(wb, p.source);
  if (!src) return { error: `Feuille source « ${p.source.sheet} » introuvable.` };
  const headers = sourceHeaders(src.headers, p.calcFields);
  const warnings: string[] = [];
  const rows = src.rows.map((r) => {
    const out = r.slice();
    for (const f of p.calcFields ?? []) {
      const v = evalCalcField(f.formula, src.headers, r);
      if (v === null && r.some((x) => x !== null)) warnings.push(`Champ calculé « ${f.name} » : formule invalide ou valeurs non numériques.`);
      out.push(v);
    }
    return out;
  });
  const find = (name: string | null): number => (name === null ? -1 : headers.findIndex((h) => h.trim().toLowerCase() === name.trim().toLowerCase()));
  const ri = find(p.rowField);
  const ci = find(p.colField);
  const vi = find(p.valueField);
  if (ri < 0) return { error: `Champ ligne « ${p.rowField} » introuvable dans la source.` };
  if (vi < 0) return { error: `Champ valeur « ${p.valueField} » introuvable dans la source.` };
  if (p.colField !== null && ci < 0) return { error: `Champ colonne « ${p.colField} » introuvable dans la source.` };
  const grouped = rows.map((r) => {
    const g = r.slice();
    if (p.rowDateGroup && p.rowDateGroup !== "none") g[ri] = dateGroupLabel(r[ri] ?? null, p.rowDateGroup) ?? r[ri] ?? null;
    if (ci >= 0 && p.colDateGroup && p.colDateGroup !== "none") g[ci] = dateGroupLabel(r[ci] ?? null, p.colDateGroup) ?? r[ci] ?? null;
    return g;
  });
  const cfg: PivotConfig = { rowField: ri, colField: ci >= 0 ? ci : null, valueField: vi, agg: p.agg };
  const res = computePivot({ headers, rows: grouped }, cfg);
  if (p.sort && p.sort !== "none") {
    const order = res.rowLabels.map((_, i) => i).sort((a, b) => res.rowLabels[a]!.localeCompare(res.rowLabels[b]!, "fr", { numeric: true }) * (p.sort === "desc" ? -1 : 1));
    res.rowLabels = order.map((i) => res.rowLabels[i]!);
    res.matrix = order.map((i) => res.matrix[i]!);
    res.rowTotals = order.map((i) => res.rowTotals[i]!);
  }
  return { sheet: pivotToSheet(res, sheetName), warnings: [...new Set(warnings)] };
}

/** Nouvelle définition à partir de la sélection (première ligne = en-têtes). */
export function newPivotObject(sheetName: string, rect: { c0: number; r0: number; c1: number; r1: number }, headers: string[], cfg: PivotConfig): PivotObject {
  const h = sourceHeaders(headers);
  return {
    id: newId("pivot"),
    source: { sheet: sheetName, ...rect },
    rowField: h[cfg.rowField] ?? h[0]!,
    colField: cfg.colField !== null ? (h[cfg.colField] ?? null) : null,
    valueField: h[cfg.valueField] ?? h[h.length - 1]!,
    agg: cfg.agg,
    sort: "none",
  };
}

/** Remplace le contenu d'une feuille pivot par un résultat recalculé en gardant la définition et les largeurs de colonnes. */
export function applyPivotResult(old: SheetData, built: SheetData, p: PivotObject): SheetData {
  return { ...old, cells: built.cells, styles: built.styles, rows: Math.max(built.rows, 20), cols: Math.max(built.cols, 8), pivot: p };
}

/** Le résultat actuel de la feuille est-il différent d'un recalcul ? (sert à signaler « à actualiser ») */
export function pivotIsStale(wb: Workbook, sheetIndex: number): boolean {
  const sh = wb.sheets[sheetIndex];
  if (!sh?.pivot) return false;
  const b = buildPivot(wb, sh.pivot, sh.name);
  if ("error" in b) return true;
  return JSON.stringify(b.sheet.cells) !== JSON.stringify(sh.cells);
}
