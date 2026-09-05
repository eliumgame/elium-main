/**
 * LocalSheetStore — le backend de la suite locale pour le Tableur unifié. Il
 * réalise le contrat SheetStore avec useUndoable (annuler/rétablir en mémoire) et
 * le stockage IndexedDB (sheet-store : autosauvegarde/restauration). Mono-
 * utilisateur : `active` vit donc dans le classeur et il n'y a pas de présence.
 *
 * Les opérations structurelles (insertion/suppression de lignes-colonnes, tri,
 * recopie) délèguent aux fonctions PURES de `./structural`, partagées avec le
 * Tableur collaboratif — un seul comportement, testé une seule fois.
 */
import { useEffect, useRef } from "react";
import { useUndoable } from "../ui/useUndoable";
import {
  emptyWorkbook,
  emptySheet,
  removeSheet as removeSheetPure,
  type Workbook,
  type SheetData,
  type CellStyle,
  type CondRule,
  type DataValidation,
  type ChartSpec,
} from "./model";
import {
  insertRow as insertRowPure,
  deleteRow as deleteRowPure,
  insertCol as insertColPure,
  deleteCol as deleteColPure,
  sortRange as sortRangePure,
  fillRange as fillRangePure,
  type Rect,
} from "./structural";
import { toggleMerge as toggleMergePure } from "./merges";
import { renameSheetRefs, indexToCol } from "./formula";
import { loadWorkbook, saveWorkbook } from "./sheet-store";
import type { SheetStore } from "./store";

const cellRef = (c: number, r: number) => indexToCol(c) + (r + 1);

export interface LocalSheetStore extends SheetStore {
  /** Référence vive du classeur (pour les handlers d'export qui lisent la dernière valeur). */
  wb: Workbook;
}

export function useLocalSheetStore(initial?: Workbook): LocalSheetStore {
  const {
    value: wb,
    set,
    checkpoint,
    undo,
    redo,
    canUndo,
    canRedo,
    reset,
  } = useUndoable<Workbook>(initial ?? emptyWorkbook());

  // Charge le classeur persisté au montage (sauf ouverture explicite d'un .elium).
  useEffect(() => {
    if (initial) return;
    loadWorkbook()
      .then((w) => w && reset(w))
      .catch(() => {});
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  // Autosauvegarde débouncée à chaque changement du classeur.
  useEffect(() => {
    if (initial) return;
    const t = setTimeout(() => void saveWorkbook(wb), 300);
    return () => clearTimeout(t);
  }, [wb, initial]);

  const wbRef = useRef(wb);
  wbRef.current = wb;

  // --- helper : muter une feuille par index (enregistre l'historique) ---
  const patchSheet = (s: number, fn: (sh: SheetData) => SheetData) =>
    set((w) => {
      const sheets = w.sheets.slice();
      sheets[s] = fn(sheets[s]!);
      return { ...w, sheets };
    });

  // --- cellules & mise en forme ---
  const setCell = (s: number, ref: string, raw: string) =>
    patchSheet(s, (sh) => {
      const cells = { ...sh.cells };
      if (raw.trim() === "") delete cells[ref];
      else cells[ref] = raw;
      return { ...sh, cells };
    });

  const clearRange = (s: number, rect: Rect) =>
    patchSheet(s, (sh) => {
      const cells = { ...sh.cells };
      for (let r = rect.r0; r <= rect.r1; r++) for (let c = rect.c0; c <= rect.c1; c++) delete cells[cellRef(c, r)];
      return { ...sh, cells };
    });

  const applyStyle = (s: number, refs: string[], patch: Partial<CellStyle>) =>
    patchSheet(s, (sh) => {
      const styles = { ...(sh.styles ?? {}) };
      for (const ref of refs) {
        const next: CellStyle = { ...styles[ref], ...patch };
        (Object.keys(next) as (keyof CellStyle)[]).forEach((k) => next[k] === undefined && delete next[k]);
        if (Object.keys(next).length === 0) delete styles[ref];
        else styles[ref] = next;
      }
      return { ...sh, styles };
    });

  const pasteBlock = (s: number, atR: number, atC: number, grid: string[][]) =>
    patchSheet(s, (sh) => {
      const cells = { ...sh.cells };
      let cols = sh.cols,
        rows = sh.rows;
      grid.forEach((row, ri) =>
        row.forEach((val, ci) => {
          const ref = cellRef(atC + ci, atR + ri);
          if (val === "") delete cells[ref];
          else cells[ref] = val;
          cols = Math.max(cols, atC + ci + 1);
          rows = Math.max(rows, atR + ri + 1);
        }),
      );
      return { ...sh, cells, cols, rows };
    });

  // --- structure : lignes / colonnes (fonctions pures partagées) ---
  const insertRow = (s: number, at: number) => patchSheet(s, (sh) => insertRowPure(sh, at));
  const deleteRow = (s: number, at: number) => patchSheet(s, (sh) => deleteRowPure(sh, at));
  const insertCol = (s: number, at: number) => patchSheet(s, (sh) => insertColPure(sh, at));
  const deleteCol = (s: number, at: number) => patchSheet(s, (sh) => deleteColPure(sh, at));
  const sortRange = (s: number, key: number, region: Rect, dir: 1 | -1, displayOf: (c: number, r: number) => string) =>
    patchSheet(s, (sh) => sortRangePure(sh, key, region, dir, displayOf));
  const fillRange = (s: number, src: Rect, to: { c: number; r: number }) =>
    patchSheet(s, (sh) => fillRangePure(sh, src, to));

  // --- géométrie & vue ---
  const setColWidth = (s: number, col: number, w: number) =>
    patchSheet(s, (sh) => ({ ...sh, colWidths: { ...(sh.colWidths ?? {}), [col]: Math.max(24, Math.round(w)) } }));
  const setRowHeight = (s: number, row: number, h: number) =>
    patchSheet(s, (sh) => ({ ...sh, rowHeights: { ...(sh.rowHeights ?? {}), [row]: Math.max(16, Math.round(h)) } }));
  const setFreeze = (s: number, rows: number, cols: number) =>
    patchSheet(s, (sh) => (rows <= 0 && cols <= 0 ? { ...sh, freeze: undefined } : { ...sh, freeze: { rows, cols } }));
  const setFilter = (s: number, col: number, query: string) =>
    patchSheet(s, (sh) =>
      query.trim() === "" ? { ...sh, filter: undefined } : { ...sh, filter: { col, query: query.trim() } },
    );
  const toggleMerge = (s: number, rect: Rect) =>
    patchSheet(s, (sh) => ({ ...sh, merges: toggleMergePure(sh.merges, rect) }));

  // --- mise en forme conditionnelle / validation / graphiques (upsert par id) ---
  const setCondRule = (s: number, rule: CondRule) =>
    patchSheet(s, (sh) => {
      const list = (sh.condFormats ?? []).slice();
      const i = list.findIndex((r) => r.id === rule.id);
      if (i >= 0) list[i] = rule;
      else list.push(rule);
      return { ...sh, condFormats: list };
    });
  const removeCondRule = (s: number, id: string) =>
    patchSheet(s, (sh) => ({ ...sh, condFormats: (sh.condFormats ?? []).filter((r) => r.id !== id) }));
  const setValidation = (s: number, v: DataValidation) =>
    patchSheet(s, (sh) => {
      const list = (sh.validations ?? []).slice();
      const i = list.findIndex((x) => x.id === v.id);
      if (i >= 0) list[i] = v;
      else list.push(v);
      return { ...sh, validations: list };
    });
  const removeValidation = (s: number, id: string) =>
    patchSheet(s, (sh) => ({ ...sh, validations: (sh.validations ?? []).filter((v) => v.id !== id) }));
  const setChart = (s: number, chart: ChartSpec) =>
    patchSheet(s, (sh) => {
      const list = (sh.charts ?? []).slice();
      const i = list.findIndex((c) => c.id === chart.id);
      if (i >= 0) list[i] = chart;
      else list.push(chart);
      return { ...sh, charts: list };
    });
  const removeChart = (s: number, id: string) =>
    patchSheet(s, (sh) => ({ ...sh, charts: (sh.charts ?? []).filter((c) => c.id !== id) }));

  // --- plages nommées (portée classeur) ---
  const setName = (name: string, ref: string) => {
    const clean = name.trim();
    if (!clean) return;
    set((w) => ({
      ...w,
      names: [...(w.names ?? []).filter((n) => n.name.toUpperCase() !== clean.toUpperCase()), { name: clean, ref }],
    }));
  };
  const removeName = (name: string) => set((w) => ({ ...w, names: (w.names ?? []).filter((n) => n.name !== name) }));

  // --- feuilles ---
  const setActive = (i: number) => set((w) => ({ ...w, active: i }));
  const addSheet = (name?: string) =>
    set((w) => ({
      ...w,
      sheets: [...w.sheets, emptySheet((name ?? "").trim() || `Feuille ${w.sheets.length + 1}`)],
      active: w.sheets.length,
    }));
  const renameSheet = (i: number, name: string) =>
    set((w) => {
      const cur = w.sheets[i]!.name;
      // Réécrit toute référence croisée (=Feuille2!A1) du classeur pour que les formules résolvent encore.
      const sheets = w.sheets.map((s) => {
        const cells: Record<string, string> = {};
        for (const [ref, v] of Object.entries(s.cells)) cells[ref] = v[0] === "=" ? renameSheetRefs(v, cur, name) : v;
        return { ...s, cells };
      });
      sheets[i] = { ...sheets[i]!, name };
      return { ...w, sheets };
    });
  const removeSheet = (i: number) => set((w) => removeSheetPure(w, i) ?? w);
  // Whole-document replacement (file import): must clear undo history like
  // `reset()` on load, not push the prior state via `set()` — otherwise a
  // single Ctrl+Z right after importing reverts straight back to whatever
  // was present before (often the blank placeholder of a just-created
  // sheet), discarding the import. Mirrors replaceDeck() in
  // useLocalDeckStore.ts, which already uses `reset()` for the same reason.
  const replaceWorkbook = (next: Workbook) => reset(next);
  const addSheetFromData = (data: SheetData): number => {
    const index = wbRef.current.sheets.length;
    set((w) => ({ ...w, sheets: [...w.sheets, data], active: w.sheets.length }));
    return index;
  };

  return {
    wb,
    active: wb.active,
    canWrite: true,
    collaborative: false,
    setActive,
    addSheet,
    renameSheet,
    removeSheet,
    replaceWorkbook,
    addSheetFromData,
    setCell,
    clearRange,
    applyStyle,
    pasteBlock,
    insertRow,
    deleteRow,
    insertCol,
    deleteCol,
    sortRange,
    fillRange,
    setColWidth,
    setRowHeight,
    setFreeze,
    setFilter,
    toggleMerge,
    setCondRule,
    removeCondRule,
    setValidation,
    removeValidation,
    setChart,
    removeChart,
    setName,
    removeName,
    beginChange: checkpoint,
    undo,
    redo,
    canUndo,
    canRedo,
  };
}
