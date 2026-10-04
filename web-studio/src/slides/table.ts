/**
 * Tableaux de diapositives (logique PURE) : fusion/séparation de cellules, cellules couvertes,
 * ajout/retrait de lignes et colonnes en gardant les fusions cohérentes, styles (lignes alternées,
 * quadrillage, accentué), import d'une plage copiée depuis le Tableur (TSV).
 */
import type { TableData, TableMerge, TableStyleName } from "./model";

export const TABLE_STYLES: { value: TableStyleName; label: string }[] = [
  { value: "banded", label: "Lignes alternées" },
  { value: "grid", label: "Quadrillage" },
  { value: "accent", label: "En-tête coloré" },
  { value: "plain", label: "Sans style" },
];

export interface Cell {
  r: number;
  c: number;
}

/** Fusion dont la cellule d'ancrage est (r,c). */
export const mergeAt = (t: TableData, r: number, c: number): TableMerge | undefined =>
  t.merges?.find((m) => m.r === r && m.c === c);

/** La cellule (r,c) est-elle masquée par une fusion qui démarre ailleurs ? */
export function isCovered(t: TableData, r: number, c: number): boolean {
  return !!t.merges?.some((m) => (m.r !== r || m.c !== c) && r >= m.r && r < m.r + m.rs && c >= m.c && c < m.c + m.cs);
}

/** Fusion contenant (r,c) (ancre ou couverte). */
export function mergeContaining(t: TableData, r: number, c: number): TableMerge | undefined {
  return t.merges?.find((m) => r >= m.r && r < m.r + m.rs && c >= m.c && c < m.c + m.cs);
}

const overlaps = (a: TableMerge, b: TableMerge): boolean =>
  a.r < b.r + b.rs && b.r < a.r + a.rs && a.c < b.c + b.cs && b.c < a.c + a.cs;

/**
 * Fusionne le rectangle (de r0,c0 à r1,c1, inclus). Le texte des cellules couvertes est ajouté à l'ancre
 * (séparé par un espace) puis vidé. Les fusions existantes qui chevauchent le rectangle sont absorbées.
 * Retourne le tableau inchangé si le rectangle se réduit à une cellule ou sort du tableau.
 */
export function mergeCells(t: TableData, a: Cell, b: Cell): TableData {
  const r0 = Math.min(a.r, b.r);
  const r1 = Math.max(a.r, b.r);
  const c0 = Math.min(a.c, b.c);
  const c1 = Math.max(a.c, b.c);
  if (r0 < 0 || c0 < 0 || r1 >= t.rows || c1 >= t.cols || (r0 === r1 && c0 === c1)) return t;
  const rect: TableMerge = { r: r0, c: c0, rs: r1 - r0 + 1, cs: c1 - c0 + 1 };
  // étend le rectangle pour contenir entièrement les fusions qu'il touche
  let grown = rect;
  for (let again = true; again;) {
    again = false;
    for (const m of t.merges ?? []) {
      if (!overlaps(grown, m)) continue;
      const nr0 = Math.min(grown.r, m.r);
      const nc0 = Math.min(grown.c, m.c);
      const nr1 = Math.max(grown.r + grown.rs, m.r + m.rs);
      const nc1 = Math.max(grown.c + grown.cs, m.c + m.cs);
      const next = { r: nr0, c: nc0, rs: nr1 - nr0, cs: nc1 - nc0 };
      if (next.r !== grown.r || next.c !== grown.c || next.rs !== grown.rs || next.cs !== grown.cs) {
        grown = next;
        again = true;
      }
    }
  }
  const cells = t.cells.map((row) => row.slice());
  const texts: string[] = [];
  for (let r = grown.r; r < grown.r + grown.rs; r++)
    for (let c = grown.c; c < grown.c + grown.cs; c++) {
      const v = (cells[r]?.[c] ?? "").trim();
      if (v) texts.push(v);
      if (cells[r]) cells[r]![c] = "";
    }
  cells[grown.r]![grown.c] = texts.join(" ");
  const merges = [...(t.merges ?? []).filter((m) => !overlaps(grown, m)), grown];
  return { ...t, cells, merges };
}

/** Sépare la fusion qui contient (r,c). */
export function unmergeAt(t: TableData, r: number, c: number): TableData {
  const m = mergeContaining(t, r, c);
  if (!m) return t;
  const merges = (t.merges ?? []).filter((x) => x !== m);
  return { ...t, ...(merges.length ? { merges } : { merges: undefined }) };
}

const clip = (merges: TableMerge[]): TableMerge[] => merges.filter((m) => m.rs > 1 || m.cs > 1);

export function insertRow(t: TableData, at: number): TableData {
  const i = Math.max(0, Math.min(t.rows, at));
  const cells = t.cells.map((r) => r.slice());
  cells.splice(
    i,
    0,
    Array.from({ length: t.cols }, () => ""),
  );
  const merges = clip(
    (t.merges ?? []).map((m) =>
      m.r >= i ? { ...m, r: m.r + 1 } : m.r < i && i < m.r + m.rs ? { ...m, rs: m.rs + 1 } : m,
    ),
  );
  return { ...t, rows: t.rows + 1, cells, ...(merges.length ? { merges } : { merges: undefined }) };
}
export function deleteRow(t: TableData, at: number): TableData {
  if (t.rows <= 1 || at < 0 || at >= t.rows) return t;
  const cells = t.cells.filter((_, r) => r !== at).map((r) => r.slice());
  const merges = clip(
    (t.merges ?? [])
      .map((m) => {
        if (at < m.r) return { ...m, r: m.r - 1 };
        if (at >= m.r + m.rs) return m;
        // la ligne supprimée est dans la fusion
        if (m.rs === 1) return null;
        return at === m.r && m.rs > 1 ? { ...m, rs: m.rs - 1 } : { ...m, rs: m.rs - 1 };
      })
      .filter((m): m is TableMerge => m !== null),
  );
  return { ...t, rows: t.rows - 1, cells, ...(merges.length ? { merges } : { merges: undefined }) };
}
export function insertCol(t: TableData, at: number): TableData {
  const i = Math.max(0, Math.min(t.cols, at));
  const cells = t.cells.map((row) => {
    const r = row.slice();
    r.splice(i, 0, "");
    return r;
  });
  const merges = clip(
    (t.merges ?? []).map((m) =>
      m.c >= i ? { ...m, c: m.c + 1 } : m.c < i && i < m.c + m.cs ? { ...m, cs: m.cs + 1 } : m,
    ),
  );
  return { ...t, cols: t.cols + 1, cells, ...(merges.length ? { merges } : { merges: undefined }) };
}
export function deleteCol(t: TableData, at: number): TableData {
  if (t.cols <= 1 || at < 0 || at >= t.cols) return t;
  const cells = t.cells.map((row) => row.filter((_, c) => c !== at));
  const merges = clip(
    (t.merges ?? [])
      .map((m) => {
        if (at < m.c) return { ...m, c: m.c - 1 };
        if (at >= m.c + m.cs) return m;
        if (m.cs === 1) return null;
        return { ...m, cs: m.cs - 1 };
      })
      .filter((m): m is TableMerge => m !== null),
  );
  return { ...t, cols: t.cols - 1, cells, ...(merges.length ? { merges } : { merges: undefined }) };
}

/** Tableau depuis un texte tabulé (copie d'une plage du Tableur). null si le texte est vide. */
export function tableFromTsv(text: string): TableData | null {
  const rows = text
    .replace(/\r/g, "")
    .split("\n")
    .filter((l, i, a) => l !== "" || i < a.length - 1)
    .map((l) => l.split("\t").map((c) => c.replace(/^"(.*)"$/s, "$1").replace(/""/g, '"')));
  while (rows.length && rows[rows.length - 1]!.every((c) => c === "")) rows.pop();
  if (!rows.length) return null;
  const cols = Math.max(...rows.map((r) => r.length));
  if (cols === 0) return null;
  const cells = rows.map((r) => Array.from({ length: cols }, (_, c) => r[c] ?? ""));
  return { rows: rows.length, cols, cells, style: "banded", headerRow: true };
}

/** Classe CSS et indicateurs d'une cellule selon le style du tableau. */
export function cellClass(t: TableData, r: number, c: number): string {
  const style = t.style ?? "banded";
  const out: string[] = [];
  const header = t.headerRow !== false && r === 0;
  if (header) out.push("ce-td--head");
  if (t.firstCol && c === 0 && !header) out.push("ce-td--firstcol");
  if (style === "banded" && !header && (r - (t.headerRow !== false ? 1 : 0)) % 2 === 1) out.push("ce-td--band");
  if (style === "grid") out.push("ce-td--grid");
  if (style === "accent") out.push("ce-td--accent");
  return out.join(" ");
}

/** Contrôle d'intégrité (tests, import) : fusions dans les bornes et sans chevauchement. */
export function validMerges(t: TableData): boolean {
  const ms = t.merges ?? [];
  for (let i = 0; i < ms.length; i++) {
    const m = ms[i]!;
    if (m.r < 0 || m.c < 0 || m.r + m.rs > t.rows || m.c + m.cs > t.cols || m.rs < 1 || m.cs < 1) return false;
    for (let j = i + 1; j < ms.length; j++) if (overlaps(m, ms[j]!)) return false;
  }
  return true;
}
