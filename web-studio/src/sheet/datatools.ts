/**
 * Outils de données du Tableur (fonctions PURES sur SheetData / Workbook) :
 * suppression des doublons, texte en colonnes, rechercher/remplacer (regex,
 * toutes feuilles). Branchés au store via `transformSheet` / `transformWorkbook`,
 * donc identiques en local et en collaboratif.
 */
import { indexToCol, parseRef } from "./formula";
import type { SheetData, Workbook } from "./model";

export interface Rect {
  c0: number;
  r0: number;
  c1: number;
  r1: number;
}
const ref = (c: number, r: number) => indexToCol(c) + (r + 1);

// --- Doublons ---------------------------------------------------------------

export interface DedupeOptions {
  /** La première ligne de la plage est un en-tête (jamais supprimée). */
  hasHeader: boolean;
  /** Colonnes (index absolus) qui définissent un doublon ; défaut : toutes celles de la plage. */
  cols?: number[];
  caseSensitive?: boolean;
}

/** Supprime les lignes en double d'une plage (les suivantes disparaissent, la plage se referme vers le haut). */
export function removeDuplicates(
  sheet: SheetData,
  rect: Rect,
  opts: DedupeOptions,
): { sheet: SheetData; removed: number } {
  const keyCols = opts.cols?.length ? opts.cols : Array.from({ length: rect.c1 - rect.c0 + 1 }, (_, i) => rect.c0 + i);
  const first = rect.r0 + (opts.hasHeader ? 1 : 0);
  const norm = (v: string | undefined): string => (opts.caseSensitive ? (v ?? "") : (v ?? "").toLowerCase()).trim();
  const seen = new Set<string>();
  const keep: number[] = [];
  for (let r = first; r <= rect.r1; r++) {
    const key = keyCols.map((c) => norm(sheet.cells[ref(c, r)])).join("\u0001");
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(r);
  }
  const removed = rect.r1 - first + 1 - keep.length;
  if (removed <= 0) return { sheet, removed: 0 };
  const cells = { ...sheet.cells };
  const styles = sheet.styles ? { ...sheet.styles } : undefined;
  // Les lignes conservées remontent ; la fin de la plage est vidée (comme Excel).
  keep.forEach((srcR, i) => {
    const dstR = first + i;
    if (srcR === dstR) return;
    for (let c = rect.c0; c <= rect.c1; c++) {
      const v = sheet.cells[ref(c, srcR)];
      if (v === undefined) delete cells[ref(c, dstR)];
      else cells[ref(c, dstR)] = v;
      if (styles) {
        const st = sheet.styles?.[ref(c, srcR)];
        if (st) styles[ref(c, dstR)] = st;
        else delete styles[ref(c, dstR)];
      }
    }
  });
  for (let r = first + keep.length; r <= rect.r1; r++)
    for (let c = rect.c0; c <= rect.c1; c++) {
      delete cells[ref(c, r)];
      if (styles) delete styles[ref(c, r)];
    }
  return { sheet: { ...sheet, cells, ...(styles ? { styles } : {}) }, removed };
}

// --- Texte en colonnes --------------------------------------------------------

export interface SplitOptions {
  /** Séparateurs (caractères ou chaînes) ; ignoré si `widths` est fourni. */
  delimiters?: string[];
  /** Largeurs fixes (en caractères) : « 4,10 » coupe après 4 puis 10 caractères. */
  widths?: number[];
  /** Plusieurs séparateurs consécutifs comptent pour un seul. */
  mergeConsecutive?: boolean;
  /** Délimiteur de texte (« " » par défaut) : un séparateur entre guillemets ne coupe pas. */
  qualifier?: string;
  trim?: boolean;
}

/** Découpe une chaîne selon les options ; pure et testable seule. */
export function splitText(text: string, o: SplitOptions): string[] {
  const trim = o.trim !== false;
  const clean = (s: string) => (trim ? s.trim() : s);
  if (o.widths?.length) {
    const out: string[] = [];
    let pos = 0;
    for (const w of o.widths) {
      out.push(clean(text.slice(pos, pos + w)));
      pos += w;
    }
    out.push(clean(text.slice(pos)));
    return out;
  }
  const delims = (o.delimiters ?? []).filter((d) => d !== "");
  if (!delims.length) return [clean(text)];
  const q = o.qualifier ?? '"';
  const parts: string[] = [];
  let cur = "";
  let inQ = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (q && ch === q) {
      if (inQ && text[i + 1] === q) {
        cur += q; // guillemet doublé = guillemet littéral
        i += 2;
        continue;
      }
      inQ = !inQ;
      i++;
      continue;
    }
    if (!inQ) {
      const d = delims.find((x) => text.startsWith(x, i));
      if (d) {
        parts.push(cur);
        cur = "";
        i += d.length;
        if (o.mergeConsecutive)
          while (delims.some((x) => text.startsWith(x, i))) i += delims.find((x) => text.startsWith(x, i))!.length;
        continue;
      }
    }
    cur += ch;
    i++;
  }
  parts.push(cur);
  return parts.map(clean);
}

/** Répartit une colonne sur les colonnes suivantes (écrase les cellules de droite, agrandit la feuille). */
export function textToColumns(sheet: SheetData, rect: Rect, o: SplitOptions): { sheet: SheetData; maxParts: number } {
  const c = rect.c0;
  const cells = { ...sheet.cells };
  let maxParts = 1;
  const rows: { r: number; parts: string[] }[] = [];
  for (let r = rect.r0; r <= rect.r1; r++) {
    const raw = sheet.cells[ref(c, r)];
    if (raw === undefined || raw === "" || raw.startsWith("=")) continue;
    const parts = splitText(raw, o);
    maxParts = Math.max(maxParts, parts.length);
    rows.push({ r, parts });
  }
  for (const { r, parts } of rows) {
    for (let k = 0; k < maxParts; k++) {
      const v = parts[k];
      if (v === undefined || v === "") delete cells[ref(c + k, r)];
      else cells[ref(c + k, r)] = v;
    }
  }
  return { sheet: { ...sheet, cells, cols: Math.max(sheet.cols, c + maxParts) }, maxParts };
}

// --- Rechercher / remplacer ---------------------------------------------------

export interface FindOptions {
  find: string;
  replace?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeCell?: boolean;
  /** Chercher aussi dans les formules (sinon seulement les valeurs saisies). */
  inFormulas?: boolean;
  /** Indice d'une feuille, ou null/absent = toutes. */
  sheet?: number | null;
}
export interface FindMatch {
  sheet: number;
  ref: string;
  text: string;
}

/** Construit le motif ; renvoie un message d'erreur français si l'expression régulière est invalide. */
export function buildPattern(o: FindOptions): { re: RegExp } | { error: string } {
  if (!o.find) return { error: "Saisissez un texte à rechercher." };
  const src = o.regex ? o.find : o.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const body = o.wholeCell ? `^(?:${src})$` : src;
    return { re: new RegExp(body, o.caseSensitive ? "g" : "gi") };
  } catch (e) {
    return { error: `Expression régulière invalide : ${e instanceof Error ? e.message : String(e)}` };
  }
}

function eachCell(wb: Workbook, o: FindOptions, fn: (s: number, r: string, raw: string) => void): void {
  wb.sheets.forEach((sh, s) => {
    if (o.sheet !== undefined && o.sheet !== null && o.sheet !== s) return;
    for (const [r, raw] of Object.entries(sh.cells)) {
      if (!o.inFormulas && raw.startsWith("=")) continue;
      fn(s, r, raw);
    }
  });
}
const byPos = (a: FindMatch, b: FindMatch): number => {
  const pa = parseRef(a.ref)!;
  const pb = parseRef(b.ref)!;
  return a.sheet - b.sheet || pa.row - pb.row || pa.col - pb.col;
};

export function findAll(wb: Workbook, o: FindOptions): { matches: FindMatch[] } | { error: string } {
  const p = buildPattern(o);
  if ("error" in p) return p;
  const matches: FindMatch[] = [];
  eachCell(wb, o, (s, r, raw) => {
    p.re.lastIndex = 0;
    if (p.re.test(raw)) matches.push({ sheet: s, ref: r, text: raw });
  });
  return { matches: matches.sort(byPos) };
}

/** Remplace partout ; `$1`… dans `replace` désignent les groupes en mode regex. */
export function replaceAll(wb: Workbook, o: FindOptions): { wb: Workbook; count: number } | { error: string } {
  const p = buildPattern(o);
  if ("error" in p) return p;
  const repl = o.replace ?? "";
  let count = 0;
  const next = wb.sheets.map((sh) => ({ ...sh, cells: { ...sh.cells } }));
  eachCell(wb, o, (s, r, raw) => {
    p.re.lastIndex = 0;
    const out = raw.replace(p.re, (...args) => {
      count++;
      if (!o.regex) return repl;
      // Remplacement avec groupes : $1, $&, $$
      const groups = args.slice(1, -2).map((g) => (typeof g === "string" ? g : ""));
      return repl.replace(/\$(\d+|&|\$)/g, (_m, t: string) =>
        t === "$" ? "$" : t === "&" ? String(args[0]) : (groups[Number(t) - 1] ?? ""),
      );
    });
    if (out !== raw) next[s]!.cells[r] = out;
  });
  return { wb: { ...wb, sheets: next }, count };
}
