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
 *   • colWidths                : `Y.Map<number>`  clé = index de colonne.
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
import { cellsSnapshot, type YCells } from "./collab-sheet-crdt";
import { toggleMerge } from "../sheet/merges";
import type {
  CellStyle, ChartSpec, CondRule, DataValidation, MergeRect, NamedRange, SheetData, Workbook,
} from "../sheet/model";

export type YSheet = Y.Map<unknown>;
export type YSheets = Y.Array<YSheet>;

/** Clé stable et canonique d'une fusion (les MergeRect n'ont pas d'id). */
export function mergeKey(m: MergeRect): string {
  const c0 = Math.min(m.c0, m.c1), c1 = Math.max(m.c0, m.c1);
  const r0 = Math.min(m.r0, m.r1), r1 = Math.max(m.r0, m.r1);
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
  if (!(ys.get("merges") instanceof Y.Map)) ys.set("merges", new Y.Map());
  if (!(ys.get("condFormats") instanceof Y.Map)) ys.set("condFormats", new Y.Map());
  if (!(ys.get("validations") instanceof Y.Map)) ys.set("validations", new Y.Map());
  if (!(ys.get("charts") instanceof Y.Map)) ys.set("charts", new Y.Map());
}

const asMap = <V,>(ys: YSheet, key: string): Y.Map<V> | undefined => {
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
    for (const m of next) { const k = mergeKey(m); if (!ymerges.has(k)) ymerges.set(k, { ...m }); }
  });
}

const upsert = <V,>(ydoc: Y.Doc, ys: YSheet, mapKey: string, id: string, value: V): void => {
  ydoc.transact(() => {
    ensureSheetStructures(ys);
    asMap<V>(ys, mapKey)!.set(id, value);
  });
};
const removeById = (ydoc: Y.Doc, ys: YSheet, mapKey: string, id: string): void => {
  ydoc.transact(() => asMap(ys, mapKey)?.delete(id));
};

export const setCondRule = (ydoc: Y.Doc, ys: YSheet, rule: CondRule) => upsert(ydoc, ys, "condFormats", rule.id, { ...rule });
export const removeCondRule = (ydoc: Y.Doc, ys: YSheet, id: string) => removeById(ydoc, ys, "condFormats", id);

export const setValidation = (ydoc: Y.Doc, ys: YSheet, v: DataValidation) => upsert(ydoc, ys, "validations", v.id, { ...v });
export const removeValidation = (ydoc: Y.Doc, ys: YSheet, id: string) => removeById(ydoc, ys, "validations", id);

export const setChart = (ydoc: Y.Doc, ys: YSheet, chart: ChartSpec) => upsert(ydoc, ys, "charts", chart.id, { ...chart });
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
