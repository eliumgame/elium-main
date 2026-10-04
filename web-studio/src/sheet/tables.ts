/**
 * Tableaux nommés et références structurées (`Tableau1[Ventes]`, `Tableau1[@Prix]`,
 * `Tableau1[[#Headers],[Nom]]`, `Tableau1[#All]`…). Fonctions PURES : les
 * références structurées sont ré-écrites en plages A1 avant l'évaluation, donc
 * le moteur de formules n'a rien de nouveau à comprendre.
 */
import { indexToCol } from "./formula";
import { newId, type SheetData, type SheetTable } from "./model";

export interface TableDef extends SheetTable {
  /** Nom de la feuille qui porte le tableau. */
  sheet: string;
  /** Noms de colonnes (valeurs de la ligne d'en-têtes). */
  headers: string[];
}

const a1 = (c: number, r: number) => `$${indexToCol(c)}$${r + 1}`;

/** Définitions résolues (avec en-têtes lus dans les cellules) pour tout le classeur. */
export function tableDefs(sheets: SheetData[]): TableDef[] {
  const out: TableDef[] = [];
  for (const sh of sheets)
    for (const t of sh.tables ?? []) {
      const headers: string[] = [];
      for (let c = t.c0; c <= t.c1; c++) {
        const raw = sh.cells[`${indexToCol(c)}${t.r0 + 1}`];
        headers.push(raw && !raw.startsWith("=") ? raw : (raw ?? `Colonne${c - t.c0 + 1}`));
      }
      out.push({ ...t, sheet: sh.name, headers });
    }
  return out;
}

const dataRows = (t: TableDef): { r0: number; r1: number } => ({ r0: t.r0 + 1, r1: t.totals ? t.r1 - 1 : t.r1 });

function colIndex(t: TableDef, name: string): number {
  const n = name.trim().toLowerCase();
  const i = t.headers.findIndex((h) => h.trim().toLowerCase() === n);
  return i < 0 ? -1 : t.c0 + i;
}

/** Sépare le contenu d'un crochet en éléments `[a],[b]` ou simple `a`. */
function items(inner: string): string[] {
  const s = inner.trim();
  if (!s) return [];
  if (!s.includes("[")) return [s];
  const out: string[] = [];
  const re = /\[((?:[^[\]']|'.)*)\]|(:)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(m[2] ? ":" : m[1]!.replace(/'([[\]#'])/g, "$1"));
  return out;
}

/** Résout le contenu d'un crochet en plage A1 absolue ; null si une colonne/spécificateur est inconnu. */
export function resolveStructured(t: TableDef, inner: string, row: number | null): string | null {
  const its = items(inner);
  const specs: string[] = [];
  const cols: string[] = [];
  let range = false;
  for (let i = 0; i < its.length; i++) {
    const it = its[i]!;
    if (it === ":") {
      range = true;
      continue;
    }
    if (it.startsWith("#")) specs.push(it.toLowerCase());
    else if (it.startsWith("@")) {
      specs.push("#this row");
      if (it.length > 1) cols.push(it.slice(1));
    } else cols.push(it);
  }
  const { r0: d0, r1: d1 } = dataRows(t);
  let c0 = t.c0;
  let c1 = t.c1;
  if (cols.length) {
    const ci = cols.map((c) => colIndex(t, c));
    if (ci.some((x) => x < 0)) return null;
    c0 = Math.min(...ci);
    c1 = range ? Math.max(...ci) : c0;
    if (!range && cols.length > 1) c1 = Math.max(...ci);
  }
  let r0 = d0;
  let r1 = d1;
  const sp = specs[0] ?? "";
  if (specs.includes("#this row")) {
    if (row === null) return null;
    r0 = r1 = row;
  } else if (sp === "#headers") {
    r0 = r1 = t.r0;
  } else if (sp === "#all") {
    r0 = t.r0;
    r1 = t.r1;
  } else if (sp === "#totals") {
    if (!t.totals) return null;
    r0 = r1 = t.r1;
  } else if (specs.length === 2 && specs.includes("#headers") && specs.includes("#data")) {
    r0 = t.r0;
    r1 = d1;
  } else if (sp && sp !== "#data") return null;
  const left = a1(c0, r0);
  const right = a1(c1, r1);
  return left === right ? left : `${left}:${right}`;
}

/**
 * Remplace toutes les références structurées d'une formule. `currentSheet` = nom de la feuille
 * où s'évalue la formule (les tableaux d'une autre feuille sont qualifiés `'Feuille'!`),
 * `row` = ligne (0-based) de la cellule, pour `[@Col]` / `[#This Row]`.
 */
export function expandStructuredRefs(
  formula: string,
  tables: TableDef[],
  currentSheet: string,
  row: number | null,
): string {
  if (
    !tables.length ||
    (!formula.includes("[") && !tables.some((t) => formula.toLowerCase().includes(t.name.toLowerCase())))
  )
    return formula;
  const byName = new Map(tables.map((t) => [t.name.toLowerCase(), t]));
  const qual = (t: TableDef, ref: string) =>
    t.sheet === currentSheet
      ? ref
      : `${/^[A-Za-z0-9_]+$/.test(t.sheet) ? t.sheet : `'${t.sheet.replace(/'/g, "''")}'`}!${ref}`;
  let out = "";
  let i = 0;
  while (i < formula.length) {
    const ch = formula[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < formula.length && formula[j] !== '"') j++;
      out += formula.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && (i === 0 || !/[A-Za-z0-9_.!$']/.test(formula[i - 1]!))) {
      let j = i + 1;
      while (j < formula.length && /[A-Za-z0-9_.]/.test(formula[j]!)) j++;
      const word = formula.slice(i, j);
      const t = byName.get(word.toLowerCase());
      if (t) {
        if (formula[j] === "[") {
          // trouve le crochet fermant correspondant (les crochets imbriqués sont autorisés)
          let depth = 0;
          let k = j;
          for (; k < formula.length; k++) {
            const x = formula[k]!;
            if (x === "'" && k + 1 < formula.length) {
              k++;
              continue;
            }
            if (x === "[") depth++;
            else if (x === "]" && --depth === 0) break;
          }
          if (depth === 0 && k < formula.length) {
            const res = resolveStructured(t, formula.slice(j + 1, k), row);
            if (res) {
              out += qual(t, res);
              i = k + 1;
              continue;
            }
            out += "#REF!";
            i = k + 1;
            continue;
          }
        } else if (formula[j] !== "(" && formula[j] !== "!") {
          // `Tableau1` seul = corps de données
          const res = resolveStructured(t, "", row);
          if (res) {
            out += qual(t, res);
            i = j;
            continue;
          }
        }
      }
      out += word;
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Les formules écrites dans un fichier Excel désignent « cette ligne » par `[#This Row]`, jamais par `@`. */
export function structuredForFile(formula: string): string {
  return formula.replace(/\[@\[([^\]]+)\]\]/g, "[[#This Row],[$1]]").replace(/\[@([^[\]]+)\]/g, "[[#This Row],[$1]]");
}

// --- Gestion des tableaux ---------------------------------------------------

const NAME_RE = /^[A-Za-z_\\][A-Za-z0-9_.]*$/;
export function validTableName(name: string, existing: string[], self?: string): string | null {
  if (!name.trim()) return "Le nom du tableau est obligatoire.";
  if (!NAME_RE.test(name))
    return "Le nom doit commencer par une lettre et ne contenir que lettres, chiffres, « _ » et « . ».";
  if (/^[A-Za-z]{1,3}\d+$/.test(name) || /^[rc]$/i.test(name)) return "Ce nom ressemble à une référence de cellule.";
  if (existing.some((n) => n.toLowerCase() === name.toLowerCase() && n.toLowerCase() !== (self ?? "").toLowerCase()))
    return "Un tableau porte déjà ce nom.";
  return null;
}

/** Nom libre « Tableau1 », « Tableau2 »… */
export function nextTableName(existing: string[]): string {
  for (let i = 1; ; i++) if (!existing.some((n) => n.toLowerCase() === `tableau${i}`)) return `Tableau${i}`;
}

/** Crée un tableau sur une plage (la première ligne = en-têtes) ; les en-têtes vides reçoivent « ColonneN ». */
export function addTable(
  sheet: SheetData,
  rect: { c0: number; r0: number; c1: number; r1: number },
  allNames: string[],
  name?: string,
): SheetData {
  if (rect.r1 <= rect.r0) return sheet;
  const cells = { ...sheet.cells };
  const seen = new Set<string>();
  for (let c = rect.c0; c <= rect.c1; c++) {
    const key = `${indexToCol(c)}${rect.r0 + 1}`;
    let v = (cells[key] ?? "").trim();
    if (!v || v.startsWith("=")) v = `Colonne${c - rect.c0 + 1}`;
    let u = v;
    for (let n = 2; seen.has(u.toLowerCase()); n++) u = `${v}${n}`;
    seen.add(u.toLowerCase());
    cells[key] = u;
  }
  const t: SheetTable = { id: newId("tbl"), name: name ?? nextTableName(allNames), ...rect, banded: true };
  return { ...sheet, cells, tables: [...(sheet.tables ?? []), t] };
}

export function removeTable(sheet: SheetData, id: string): SheetData {
  const tables = (sheet.tables ?? []).filter((t) => t.id !== id);
  return { ...sheet, ...(tables.length ? { tables } : { tables: undefined }) };
}

/** Style visuel d'une cellule d'un tableau : en-tête et lignes alternées (null = hors tableau). */
export function tableCellLook(
  sheet: SheetData,
  c: number,
  r: number,
): { header?: boolean; band?: boolean; color: string } | null {
  for (const t of sheet.tables ?? []) {
    if (c < t.c0 || c > t.c1 || r < t.r0 || r > t.r1) continue;
    const color = t.color ?? "#2563eb";
    if (r === t.r0) return { header: true, color };
    if (t.totals && r === t.r1) return { header: true, color };
    return { band: !!t.banded && (r - t.r0) % 2 === 0, color };
  }
  return null;
}
