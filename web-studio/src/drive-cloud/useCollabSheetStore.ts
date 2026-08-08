/**
 * CollabSheetStore — le backend collaboratif Drive pour le Tableur unifié. Il
 * réalise le contrat SheetStore avec un Y.Doc chiffré de bout en bout (codec
 * plein-modèle `collab-sheet-model` : cellules en Y.Text, plus largeurs, volets,
 * fusions, filtre, mises en forme conditionnelles, validations, graphiques,
 * plages nommées) et la présence en direct. Multi-utilisateur : `active` est un
 * état React par utilisateur (chacun regarde sa propre feuille) et l'annulation
 * passe par un Y.UndoManager (les updates distants ne sont jamais annulés). Rend
 * à travers le MÊME <SheetEditor> que la suite locale — parité garantie.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { EncryptedYjsProvider, type CollabStatus, type CollabUser } from "./collab-provider";
import { setCellText, migrateCells, cellsSnapshot, type YCells } from "./collab-sheet-crdt";
import * as SM from "./collab-sheet-model";
import { sortRange as sortRangePure, fillRange as fillRangePure, type Rect } from "../sheet/structural";
import { renameSheetRefs } from "../sheet/formula";
import type { DriveApi } from "./api";
import type { CellStyle, CondRule, DataValidation, ChartSpec, SheetData, Workbook } from "../sheet/model";
import type { SheetStore, SheetStatus, SheetPeer } from "../sheet/store";

const PALETTE = ["#2563eb", "#16a34a", "#db2777", "#ca8a04", "#7c3aed", "#0ea5e9", "#dc2626", "#0d9488"];
const colorForId = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return PALETTE[h % PALETTE.length]!; };
export const initialsOf = (s: string) => { const p = s.split(/[@\s.]+/).filter(Boolean); return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?"; };

const STATUS_MAP: Record<CollabStatus, SheetStatus> = { connecting: "connecting", open: "open", closed: "closed", revoked: "revoked" };

export interface CollabSheetStoreOpts {
  api: DriveApi;
  nodeId: string;
  nodeKey: Uint8Array;
  user: { id: string; name: string };
  refetchKey?: () => Promise<Uint8Array | null>;
}

export function useCollabSheetStore({ api, nodeId, nodeKey, user, refetchKey }: CollabSheetStoreOpts): SheetStore {
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [canWrite, setCanWrite] = useState(false);
  // Un accès révoqué ferme le document pour de bon — jamais écrivable, même si le
  // dernier `canWrite` connu (d'avant la révocation) valait true.
  const writable = canWrite && status !== "revoked";
  const [wb, setWb] = useState<Workbook>({ sheets: [], active: 0 });
  const [active, setActiveState] = useState(0);
  const [peers, setPeers] = useState<SheetPeer[]>([]);
  const [undoState, setUndoState] = useState({ canUndo: false, canRedo: false });

  const me: CollabUser = useMemo(() => ({ name: user.name, color: colorForId(user.id) }), [user.id, user.name]);
  const [ydoc] = useState(() => new Y.Doc());
  const [provider] = useState(() => new EncryptedYjsProvider(api, nodeId, nodeKey, ydoc, me, { onStatus: setStatus, onReady: setCanWrite, ...(refetchKey ? { refetchKey } : {}) }));
  const ySheets = useMemo(() => ydoc.getArray<SM.YSheet>("sheets") as SM.YSheets, [ydoc]);
  const yNames = useMemo(() => ydoc.getMap<string>("names"), [ydoc]);
  // L'UndoManager ne suit que les transactions d'origine nulle (nos éditions
  // locales) ; les updates distants arrivent avec une autre origine et ne sont
  // donc jamais annulés par erreur.
  const [undoMgr] = useState(() => new Y.UndoManager([ySheets, yNames]));

  const activeRef = useRef(active); activeRef.current = active;
  const canWriteRef = useRef(false);
  useEffect(() => { canWriteRef.current = canWrite; }, [canWrite]);

  const snapshot = (): Workbook => SM.workbookSnapshot(ySheets, yNames, activeRef.current);

  useEffect(() => {
    let alive = true;
    const obs = () => { if (alive) setWb(snapshot()); };
    ySheets.observeDeep(obs);
    yNames.observe(obs);
    provider.connect().then(() => {
      if (!alive) return;
      if (ySheets.length === 0) ydoc.transact(() => ySheets.push([SM.newYSheet("Feuille 1")]));
      // Passe d'ouverture (droit d'écriture requis) : convertit les cellules
      // héritées en Y.Text ET crée les sous-structures manquantes sur les
      // documents antérieurs au modèle plein. Idempotent.
      if (canWriteRef.current) {
        ydoc.transact(() => { for (const ys of ySheets.toArray()) SM.ensureSheetStructures(ys); });
        for (const ys of ySheets.toArray()) { const cells = ys.get("cells") as YCells | undefined; if (cells) migrateCells(ydoc, cells); }
      }
      setWb(snapshot());
    });
    return () => { alive = false; ySheets.unobserveDeep(obs); yNames.unobserve(obs); provider.destroy(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, ySheets, yNames, ydoc]);

  // Recalcule l'instantané quand l'utilisateur change de feuille (wb.active suit).
  useEffect(() => { setWb(snapshot()); }, [active]); // eslint-disable-line react-hooks/exhaustive-deps
  // Ramène `active` dans les bornes si le nombre de feuilles rétrécit.
  useEffect(() => { if (active > wb.sheets.length - 1) setActiveState(Math.max(0, wb.sheets.length - 1)); }, [wb.sheets.length, active]);

  // Présence : collecte la cellule des pairs (la nôtre est publiée par setPresence).
  useEffect(() => {
    const refresh = () => {
      const self = provider.awareness.clientID;
      const list: SheetPeer[] = [];
      provider.awareness.getStates().forEach((st, id) => {
        if (id === self) return;
        const u = (st as { user?: CollabUser }).user;
        const cell = (st as { cell?: { s: number; ref: string } }).cell;
        if (u && cell) list.push({ color: u.color, name: u.name, s: cell.s, ref: cell.ref });
      });
      setPeers(list);
    };
    provider.awareness.on("change", refresh); refresh();
    return () => provider.awareness.off("change", refresh);
  }, [provider]);

  // Réactivité annuler/rétablir : suit la pile de l'UndoManager.
  useEffect(() => {
    const sync = () => setUndoState({ canUndo: undoMgr.canUndo(), canRedo: undoMgr.canRedo() });
    undoMgr.on("stack-item-added", sync);
    undoMgr.on("stack-item-popped", sync);
    undoMgr.on("stack-cleared", sync);
    sync();
    return () => {
      undoMgr.off("stack-item-added", sync);
      undoMgr.off("stack-item-popped", sync);
      undoMgr.off("stack-cleared", sync);
    };
  }, [undoMgr]);

  const sheetAt = (s: number): SM.YSheet | undefined => ySheets.get(s);

  // ── Mutateurs (chacun une transaction Yjs ciblée sur la feuille `s`) ──────
  const setCell = (s: number, ref: string, raw: string) => {
    const ys = sheetAt(s); if (!ys) return;
    ydoc.transact(() => { SM.ensureSheetStructures(ys); setCellText(ys.get("cells") as YCells, ref, raw); });
  };
  const clearRange = (s: number, rect: Rect) => { const ys = sheetAt(s); if (ys) SM.clearRangeY(ydoc, ys, rect.r0, rect.c0, rect.r1, rect.c1); };
  const applyStyle = (s: number, refs: string[], patch: Partial<CellStyle>) => {
    const ys = sheetAt(s); if (!ys) return;
    ydoc.transact(() => {
      SM.ensureSheetStructures(ys);
      const styles = ys.get("styles") as Y.Map<CellStyle>;
      for (const ref of refs) {
        const next: CellStyle = { ...styles.get(ref), ...patch };
        (Object.keys(next) as (keyof CellStyle)[]).forEach((k) => next[k] === undefined && delete next[k]);
        if (Object.keys(next).length === 0) styles.delete(ref);
        else styles.set(ref, next);
      }
    });
  };
  const pasteBlock = (s: number, atR: number, atC: number, grid: string[][]) => { const ys = sheetAt(s); if (ys) SM.pasteBlock(ydoc, ys, atR, atC, grid); };

  const insertRow = (s: number, at: number) => { const ys = sheetAt(s); if (ys) SM.insertRowY(ydoc, ys, at); };
  const deleteRow = (s: number, at: number) => { const ys = sheetAt(s); if (ys) SM.deleteRowY(ydoc, ys, at); };
  const insertCol = (s: number, at: number) => { const ys = sheetAt(s); if (ys) SM.insertColY(ydoc, ys, at); };
  const deleteCol = (s: number, at: number) => { const ys = sheetAt(s); if (ys) SM.deleteColY(ydoc, ys, at); };
  const sortRange = (s: number, key: number, region: Rect, dir: 1 | -1, displayOf: (c: number, r: number) => string) => {
    const ys = sheetAt(s); if (ys) SM.reconcileSheet(ydoc, ys, sortRangePure(SM.sheetSnapshot(ys), key, region, dir, displayOf));
  };
  const fillRange = (s: number, src: Rect, to: { c: number; r: number }) => {
    const ys = sheetAt(s); if (ys) SM.reconcileSheet(ydoc, ys, fillRangePure(SM.sheetSnapshot(ys), src, to));
  };
  const growSheet = (s: number, key: "rows" | "cols", by: number) => { const ys = sheetAt(s); if (ys) SM.growSheet(ydoc, ys, key, by); };

  const setColWidth = (s: number, col: number, w: number) => { const ys = sheetAt(s); if (ys) SM.setColWidth(ydoc, ys, col, w); };
  const setFreeze = (s: number, rows: number, cols: number) => { const ys = sheetAt(s); if (ys) SM.setFreeze(ydoc, ys, rows, cols); };
  const setFilter = (s: number, col: number, query: string) => { const ys = sheetAt(s); if (ys) SM.setFilter(ydoc, ys, col, query); };
  const toggleMerge = (s: number, rect: Rect) => { const ys = sheetAt(s); if (ys) SM.toggleMergeY(ydoc, ys, rect); };

  const setCondRule = (s: number, rule: CondRule) => { const ys = sheetAt(s); if (ys) SM.setCondRule(ydoc, ys, rule); };
  const removeCondRule = (s: number, id: string) => { const ys = sheetAt(s); if (ys) SM.removeCondRule(ydoc, ys, id); };
  const setValidation = (s: number, v: DataValidation) => { const ys = sheetAt(s); if (ys) SM.setValidation(ydoc, ys, v); };
  const removeValidation = (s: number, id: string) => { const ys = sheetAt(s); if (ys) SM.removeValidation(ydoc, ys, id); };
  const setChart = (s: number, chart: ChartSpec) => { const ys = sheetAt(s); if (ys) SM.setChart(ydoc, ys, chart); };
  const removeChart = (s: number, id: string) => { const ys = sheetAt(s); if (ys) SM.removeChart(ydoc, ys, id); };

  const setName = (name: string, ref: string) => SM.setName(ydoc, yNames, name, ref);
  const removeName = (name: string) => SM.removeName(ydoc, yNames, name);

  // ── Feuilles ──────────────────────────────────────────────────────────────
  const setActive = (i: number) => setActiveState(i);
  const addSheet = (name?: string) => {
    ydoc.transact(() => ySheets.push([SM.newYSheet((name ?? "").trim() || `Feuille ${ySheets.length + 1}`)]));
    setActiveState(ySheets.length - 1);
  };
  const renameSheet = (i: number, name: string) => {
    const ys = sheetAt(i); if (!ys) return;
    const cur = String(ys.get("name") ?? "");
    if (!name || name === cur) return;
    // Réécrit toute référence croisée (=Feuille2!A1) du classeur, fusion CRDT préservée.
    ydoc.transact(() => {
      for (const s of ySheets.toArray()) {
        SM.ensureSheetStructures(s);
        const cells = s.get("cells") as YCells;
        for (const [ref, v] of Object.entries(cellsSnapshot(cells))) {
          if (v[0] === "=") { const nv = renameSheetRefs(v, cur, name); if (nv !== v) setCellText(cells, ref, nv); }
        }
      }
      ys.set("name", name);
    });
  };
  const removeSheet = (i: number) => {
    if (ySheets.length <= 1) return;
    ydoc.transact(() => ySheets.delete(i, 1));
    setActiveState((a) => Math.max(0, Math.min(a > i ? a - 1 : a, ySheets.length - 1)));
  };
  const replaceWorkbook = (next: Workbook) => { SM.loadWorkbookIntoDoc(ydoc, ySheets, yNames, next); setActiveState(0); };
  const addSheetFromData = (data: SheetData): number => SM.addSheetFromData(ydoc, ySheets, data);

  const setPresence = useCallback((s: number, ref: string) => {
    provider.awareness.setLocalStateField("cell", { s, ref });
  }, [provider]);

  return {
    wb, active, canWrite: writable, collaborative: true,
    setActive, addSheet, renameSheet, removeSheet, replaceWorkbook, addSheetFromData,
    setCell, clearRange, applyStyle, pasteBlock,
    insertRow, deleteRow, insertCol, deleteCol, sortRange, fillRange, growSheet,
    setColWidth, setFreeze, setFilter, toggleMerge,
    setCondRule, removeCondRule, setValidation, removeValidation, setChart, removeChart,
    setName, removeName,
    beginChange: () => {},
    undo: () => undoMgr.undo(),
    redo: () => undoMgr.redo(),
    canUndo: undoState.canUndo,
    canRedo: undoState.canRedo,
    setPresence,
    presence: { me: { name: me.name, color: me.color }, peers },
    status: STATUS_MAP[status],
  };
}
