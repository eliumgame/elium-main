/**
 * Modèle CRDT **plein-modèle** du tableur collaboratif.
 *
 * Jusqu'ici le tableur collaboratif ne partageait que le contenu des cellules
 * (`collab-sheet-crdt.ts`, en `Y.Text`) et un style basique par cellule. Tout le
 * reste du modèle du Tableur local (`../sheet/model` : largeurs de colonnes,
 * volets figés, fusions, filtre de vue, mises en forme conditionnelles,
 * validations de données, graphiques, plages nommées) restait **hors collab** :
 * ces structures n'existaient que dans la version locale mono-utilisateur.
 *
 * Ce module fait le pont, dans les DEUX sens, entre un `Y.Map` de feuille et une
 * `SheetData` complète, en réutilisant la logique métier PURE de `../sheet`
 * (aucune duplication : formules, condformat, validation, fusions, filtre sont
 * partagés avec le Tableur local). Objectif : un tableur **100 % collaboratif**.
 *
 * ── Choix CRDT (fusion sans écrasement) ────────────────────────────────────
 *   • cells / styles           : inchangés (voir collab-sheet-crdt.ts). NE PAS
 *                                toucher : casserait les documents déjà partagés.
 *   • colWidths / rowHeights   : `Y.Map<number>`  clé = index de colonne / ligne.
 *   • notes                    : `Y.Map<string>`  clé = référence "A1" (commentaires de cellule).
 *   • merges                   : `Y.Map<MergeRect>` clé = géométrie (les fusions
 *                                n'ont pas d'id ; deux fusions disjointes posées
 *                                en même temps ont des clés différentes → les
 *                                deux survivent).
 *   • condFormats / validations: `Y.Map<…>` clé = `id` (ajout/suppression
 *   • charts                     concurrents de règles différentes fusionnent).
 *   • freeze / filter          : petit objet de vue posé tel quel (dernier
 *                                écrivain gagne — acceptable pour une préférence
 *                                de vue, pas pour de la donnée).
 *   • names (classeur)         : `Y.Map<string>` racine, nom → référence.
 *
 * ── Compatibilité ascendante ───────────────────────────────────────────────
 * Les sous-`Y.Map` sont créés à la volée par `ensureSheetStructures` : un
 * document créé AVANT ce module (qui n'a que cells/styles) s'ouvre sans perte,
 * et ne gagne les nouvelles structures qu'au premier accès en écriture.
 */
import * as Y from "yjs";
import { cellsSnapshot, cellText, setCellText, type YCells } from "./collab-sheet-crdt";
import { toggleMerge } from "../sheet/merges";
import { insertRow, deleteRow, insertCol, deleteCol } from "../sheet/structural";
import { indexToCol } from "../sheet/formula";
import type {
  CellStyle,
  ChartSpec,
  CondRule,
  DataValidation,
  MergeRect,
  NamedRange,
  SheetData,
  Workbook,
} from "../sheet/model";

export type YSheet = Y.Map<unknown>;
export type YSheets = Y.Array<YSheet>;

/** Clé stable et canonique d'une fusion (les MergeRect n'ont pas d'id). */
export function mergeKey(m: MergeRect): string {
  const c0 = Math.min(m.c0, m.c1),
    c1 = Math.max(m.c0, m.c1);
  const r0 = Math.min(m.r0, m.r1),
    r1 = Math.max(m.r0, m.r1);
  return `${c0}:${r0}:${c1}:${r1}`;
}

/** Une feuille CRDT neuve, entièrement structurée (dans un `transact`). */
export function newYSheet(name: string, rows = 20, cols = 8): YSheet {
  const ys = new Y.Map() as YSheet;
  ys.set("name", name);
  ys.set("rows", rows);
  ys.set("cols", cols);
  ys.set("cells", new Y.Map());
  ys.set("styles", new Y.Map());
  ys.set("colWidths", new Y.Map());
  ys.set("rowHeights", new Y.Map());
  ys.set("notes", new Y.Map());
  ys.set("merges", new Y.Map());
  ys.set("condFormats", new Y.Map());
  ys.set("validations", new Y.Map());
  ys.set("charts", new Y.Map());
  return ys;
}

/**
 * Garantit que toutes les sous-structures existent sur une feuille (documents
 * antérieurs à ce module compris). Idempotent. À appeler dans un `transact`.
 */
export function ensureSheetStructures(ys: YSheet): void {
  if (!(ys.get("cells") instanceof Y.Map)) ys.set("cells", new Y.Map());
  if (!(ys.get("styles") instanceof Y.Map)) ys.set("styles", new Y.Map());
  if (!(ys.get("colWidths") instanceof Y.Map)) ys.set("colWidths", new Y.Map());
  if (!(ys.get("rowHeights") instanceof Y.Map)) ys.set("rowHeights", new Y.Map());
  if (!(ys.get("notes") instanceof Y.Map)) ys.set("notes", new Y.Map());
  if (!(ys.get("merges") instanceof Y.Map)) ys.set("merges", new Y.Map());
  if (!(ys.get("condFormats") instanceof Y.Map)) ys.set("condFormats", new Y.Map());
  if (!(ys.get("validations") instanceof Y.Map)) ys.set("validations", new Y.Map());
  if (!(ys.get("charts") instanceof Y.Map)) ys.set("charts", new Y.Map());
}

const asMap = <V>(ys: YSheet, key: string): Y.Map<V> | undefined => {
  const v = ys.get(key);
  return v instanceof Y.Map ? (v as Y.Map<V>) : undefined;
};

// ── Lecture : Y.Map → SheetData / Workbook ─────────────────────────────────

/** Snapshot immuable et COMPLET d'une feuille CRDT en `SheetData`. */
export function sheetSnapshot(ys: YSheet): SheetData {
  const styles = Object.fromEntries(asMap<CellStyle>(ys, "styles")?.entries() ?? []) as Record<string, CellStyle>;

  const colWidths: Record<number, number> = {};
  for (const [k, w] of asMap<number>(ys, "colWidths")?.entries() ?? []) {
    const n = Number(k);
    if (Number.isFinite(n) && typeof w === "number") colWidths[n] = w;
  }
  const rowHeights: Record<number, number> = {};
  for (const [k, h] of asMap<number>(ys, "rowHeights")?.entries() ?? []) {
    const n = Number(k);
    if (Number.isFinite(n) && typeof h === "number") rowHeights[n] = h;
  }
  const notes = Object.fromEntries(asMap<string>(ys, "notes")?.entries() ?? []) as Record<string, string>;

  const merges = [...(asMap<MergeRect>(ys, "merges")?.values() ?? [])].map((m) => ({ ...m }));
  const condFormats = [...(asMap<CondRule>(ys, "condFormats")?.values() ?? [])].map((r) => ({ ...r }));
  const validations = [...(asMap<DataValidation>(ys, "validations")?.values() ?? [])].map((v) => ({ ...v }));
  const charts = [...(asMap<ChartSpec>(ys, "charts")?.values() ?? [])].map((c) => ({ ...c }));

  const freeze = ys.get("freeze") as { rows: number; cols: number } | undefined;
  const filter = ys.get("filter") as { col: number; query: string } | undefined;

  const out: SheetData = {
    name: String(ys.get("name") ?? "Feuille"),
    rows: Number(ys.get("rows") ?? 20),
    cols: Number(ys.get("cols") ?? 8),
    cells: cellsSnapshot(ys.get("cells") as YCells | undefined),
    styles,
  };
  if (Object.keys(colWidths).length) out.colWidths = colWidths;
  if (Object.keys(rowHeights).length) out.rowHeights = rowHeights;
  if (Object.keys(notes).length) out.notes = notes;
  if (merges.length) out.merges = merges;
  if (condFormats.length) out.condFormats = condFormats;
  if (validations.length) out.validations = validations;
  if (charts.length) out.charts = charts;
  if (freeze && (freeze.rows > 0 || freeze.cols > 0)) out.freeze = { ...freeze };
  if (filter && filter.query) out.filter = { ...filter };
  return out;
}

/** Snapshot complet du classeur (feuilles + plages nommées). */
export function workbookSnapshot(ySheets: YSheets, yNames: Y.Map<string>, active: number): Workbook {
  const sheets = ySheets.toArray().map(sheetSnapshot);
  const names: NamedRange[] = [...yNames.entries()].map(([name, ref]) => ({ name, ref }));
  const wb: Workbook = { sheets, active: Math.max(0, Math.min(active, sheets.length - 1)) };
  if (names.length) wb.names = names;
  return wb;
}

// ── Écriture : mutateurs granulaires (chacun dans son propre transact) ──────
// Chaque mutateur ne touche QUE la structure concernée : deux pairs modifiant
// des choses différentes (une largeur ici, une règle là) fusionnent sans conflit.

export function setColWidth(ydoc: Y.Doc, ys: YSheet, col: number, width: number): void {
  ydoc.transact(() => {
    ensureSheetStructures(ys);
    asMap<number>(ys, "colWidths")!.set(String(col), Math.max(24, Math.round(width)));
  });
}

export function setRowHeight(ydoc: Y.Doc, ys: YSheet, row: number, height: number): void {
  ydoc.transact(() => {
    ensureSheetStructures(ys);
    asMap<number>(ys, "rowHeights")!.set(String(row), Math.max(16, Math.round(height)));
  });
}

export function setFreeze(ydoc: Y.Doc, ys: YSheet, rows: number, cols: number): void {
  ydoc.transact(() => {
    if (rows <= 0 && cols <= 0) ys.delete("freeze");
    else ys.set("freeze", { rows: Math.max(0, rows), cols: Math.max(0, cols) });
  });
}

export function setFilter(ydoc: Y.Doc, ys: YSheet, col: number, query: string): void {
  ydoc.transact(() => {
    if (query.trim() === "") ys.delete("filter");
    else ys.set("filter", { col, query: query.trim() });
  });
}

export function growSheet(ydoc: Y.Doc, ys: YSheet, key: "rows" | "cols", by: number): void {
  ydoc.transact(() => ys.set(key, Math.max(1, Number(ys.get(key) ?? 0) + by)));
}

/**
 * Fusionne / défusionne la sélection, façon Tableur local (`toggleMerge`), mais
 * réconcilié dans le `Y.Map` : on calcule l'état-cible pur puis on n'applique que
 * le delta (ajout des clés apparues, suppression des disparues). Concurrent-safe.
 */
export function toggleMergeY(ydoc: Y.Doc, ys: YSheet, sel: MergeRect): void {
  ydoc.transact(() => {
    ensureSheetStructures(ys);
    const ymerges = asMap<MergeRect>(ys, "merges")!;
    const current = [...ymerges.values()];
    const next = toggleMerge(current, sel);
    const nextKeys = new Set(next.map(mergeKey));
    for (const key of [...ymerges.keys()]) if (!nextKeys.has(key)) ymerges.delete(key);
    for (const m of next) {
      const k = mergeKey(m);
      if (!ymerges.has(k)) ymerges.set(k, { ...m });
    }
  });
}

const upsert = <V>(ydoc: Y.Doc, ys: YSheet, mapKey: string, id: string, value: V): void => {
  ydoc.transact(() => {
    ensureSheetStructures(ys);
    asMap<V>(ys, mapKey)!.set(id, value);
  });
};
const removeById = (ydoc: Y.Doc, ys: YSheet, mapKey: string, id: string): void => {
  ydoc.transact(() => asMap(ys, mapKey)?.delete(id));
};

export const setCondRule = (ydoc: Y.Doc, ys: YSheet, rule: CondRule) =>
  upsert(ydoc, ys, "condFormats", rule.id, { ...rule });
export const removeCondRule = (ydoc: Y.Doc, ys: YSheet, id: string) => removeById(ydoc, ys, "condFormats", id);

export const setValidation = (ydoc: Y.Doc, ys: YSheet, v: DataValidation) =>
  upsert(ydoc, ys, "validations", v.id, { ...v });
export const removeValidation = (ydoc: Y.Doc, ys: YSheet, id: string) => removeById(ydoc, ys, "validations", id);

export const setChart = (ydoc: Y.Doc, ys: YSheet, chart: ChartSpec) =>
  upsert(ydoc, ys, "charts", chart.id, { ...chart });
export const removeChart = (ydoc: Y.Doc, ys: YSheet, id: string) => removeById(ydoc, ys, "charts", id);

// ── Plages nommées (portée classeur) ───────────────────────────────────────

export function setName(ydoc: Y.Doc, yNames: Y.Map<string>, name: string, ref: string): void {
  const clean = name.trim();
  if (!clean) return;
  ydoc.transact(() => yNames.set(clean, ref));
}
export function removeName(ydoc: Y.Doc, yNames: Y.Map<string>, name: string): void {
  ydoc.transact(() => yNames.delete(name));
}

// ── Réconciliation vers une SheetData cible ────────────────────────────────
// Pont universel : n'importe quelle transformation PURE du Tableur local
// (insertion/suppression de lignes-colonnes, tri, import…) se calcule sur le
// snapshot, puis on aligne le CRDT sur le résultat. Seules les vraies
// différences sont écrites, donc les cellules inchangées gardent leur `Y.Text`
// (et la fusion caractère par caractère des éditions concurrentes qui les
// touchent). NB : c'est un remplacement d'état — pour une opération
// STRUCTURELLE, c'est le comportement attendu (comme partout ailleurs).

const a1 = (r: number, c: number) => `${indexToCol(c)}${r + 1}`;

/** Aligne un `Y.Map` sur un ensemble d'entrées cibles (JSON), en ne touchant que les différences. */
function reconcileMap<V>(ymap: Y.Map<V>, target: Map<string, V>): void {
  for (const key of [...ymap.keys()]) if (!target.has(key)) ymap.delete(key);
  for (const [key, val] of target) {
    if (JSON.stringify(ymap.get(key)) !== JSON.stringify(val)) ymap.set(key, val);
  }
}

/** Aligne toute une feuille CRDT sur une `SheetData` cible (une seule transaction). */
export function reconcileSheet(ydoc: Y.Doc, ys: YSheet, target: SheetData): void {
  ydoc.transact(() => {
    ensureSheetStructures(ys);
    ys.set("name", target.name);
    ys.set("rows", target.rows);
    ys.set("cols", target.cols);

    // Cellules : ne réécrire que celles qui changent (préserve les Y.Text intacts).
    const cells = ys.get("cells") as YCells;
    const current = cellsSnapshot(cells);
    for (const ref of Object.keys(current)) if (!(ref in target.cells)) setCellText(cells, ref, "");
    for (const [ref, raw] of Object.entries(target.cells)) {
      if (cellText(cells, ref) !== raw) setCellText(cells, ref, raw);
    }

    reconcileMap(asMap<CellStyle>(ys, "styles")!, new Map(Object.entries(target.styles ?? {})));
    reconcileMap(
      asMap<number>(ys, "colWidths")!,
      new Map(Object.entries(target.colWidths ?? {}).map(([k, v]) => [String(k), v])),
    );
    reconcileMap(
      asMap<number>(ys, "rowHeights")!,
      new Map(Object.entries(target.rowHeights ?? {}).map(([k, v]) => [String(k), v])),
    );
    reconcileMap(asMap<string>(ys, "notes")!, new Map(Object.entries(target.notes ?? {})));
    reconcileMap(asMap<MergeRect>(ys, "merges")!, new Map((target.merges ?? []).map((m) => [mergeKey(m), m])));
    reconcileMap(asMap<CondRule>(ys, "condFormats")!, new Map((target.condFormats ?? []).map((r) => [r.id, r])));
    reconcileMap(asMap<DataValidation>(ys, "validations")!, new Map((target.validations ?? []).map((v) => [v.id, v])));
    reconcileMap(asMap<ChartSpec>(ys, "charts")!, new Map((target.charts ?? []).map((c) => [c.id, c])));

    if (target.freeze && (target.freeze.rows > 0 || target.freeze.cols > 0)) ys.set("freeze", { ...target.freeze });
    else ys.delete("freeze");
    if (target.filter && target.filter.query) ys.set("filter", { ...target.filter });
    else ys.delete("filter");
  });
}

// ── Opérations structurelles (réutilisent la logique pure partagée) ─────────
export const insertRowY = (ydoc: Y.Doc, ys: YSheet, at: number) =>
  reconcileSheet(ydoc, ys, insertRow(sheetSnapshot(ys), at));
export const deleteRowY = (ydoc: Y.Doc, ys: YSheet, at: number) =>
  reconcileSheet(ydoc, ys, deleteRow(sheetSnapshot(ys), at));
export const insertColY = (ydoc: Y.Doc, ys: YSheet, at: number) =>
  reconcileSheet(ydoc, ys, insertCol(sheetSnapshot(ys), at));
export const deleteColY = (ydoc: Y.Doc, ys: YSheet, at: number) =>
  reconcileSheet(ydoc, ys, deleteCol(sheetSnapshot(ys), at));

/**
 * Colle un bloc de valeurs (lignes de cellules) à partir de (r,c). Granulaire :
 * n'écrit que les cellules collées et agrandit la feuille au besoin. Une cellule
 * vide dans le bloc EFFACE la cible (comportement d'un vrai collage tabulaire).
 */
export function pasteBlock(ydoc: Y.Doc, ys: YSheet, atR: number, atC: number, grid: string[][]): void {
  ydoc.transact(() => {
    ensureSheetStructures(ys);
    const cells = ys.get("cells") as YCells;
    let rows = Number(ys.get("rows") ?? 20),
      cols = Number(ys.get("cols") ?? 8);
    grid.forEach((row, ri) =>
      row.forEach((val, ci) => {
        setCellText(cells, a1(atR + ri, atC + ci), val);
        cols = Math.max(cols, atC + ci + 1);
        rows = Math.max(rows, atR + ri + 1);
      }),
    );
    ys.set("rows", rows);
    ys.set("cols", cols);
  });
}

/** Efface un rectangle de cellules (sans toucher aux styles/structures). */
export function clearRangeY(ydoc: Y.Doc, ys: YSheet, r0: number, c0: number, r1: number, c1: number): void {
  ydoc.transact(() => {
    const cells = ys.get("cells") as YCells | undefined;
    if (!cells) return;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) setCellText(cells, a1(r, c), "");
  });
}

/**
 * Charge un classeur complet (import XLSX/CSV) dans le document collaboratif :
 * chaque feuille de `wb` est réconciliée sur la feuille CRDT correspondante, les
 * feuilles en trop retirées, celles qui manquent ajoutées, et les plages nommées
 * alignées. Les cellules identiques gardent leur historique — un ré-import du
 * même fichier est un quasi no-op côté réseau.
 */
/**
 * Ajoute une nouvelle feuille au classeur à partir d'une `SheetData` (ex. le
 * résultat d'un tableau croisé dynamique). Rend l'index de la feuille créée.
 */
export function addSheetFromData(ydoc: Y.Doc, ySheets: YSheets, data: SheetData): number {
  let index = -1;
  ydoc.transact(() => {
    ySheets.push([newYSheet(data.name)]);
    index = ySheets.length - 1;
    reconcileSheet(ydoc, ySheets.get(index), data);
  });
  return index;
}

export function loadWorkbookIntoDoc(ydoc: Y.Doc, ySheets: YSheets, yNames: Y.Map<string>, wb: Workbook): void {
  ydoc.transact(() => {
    while (ySheets.length > wb.sheets.length) ySheets.delete(ySheets.length - 1, 1);
    while (ySheets.length < wb.sheets.length) ySheets.push([newYSheet(wb.sheets[ySheets.length]!.name)]);
    wb.sheets.forEach((s, i) => reconcileSheet(ydoc, ySheets.get(i), s));
    const target = new Map((wb.names ?? []).map((n) => [n.name, n.ref] as [string, string]));
    for (const key of [...yNames.keys()]) if (!target.has(key)) yNames.delete(key);
    for (const [name, ref] of target) if (yNames.get(name) !== ref) yNames.set(name, ref);
  });
}
