/**
 * Tableur collaboratif — **parité plein-modèle** avec le Tableur local.
 *
 * Le contenu des cellules est un CRDT par caractère (`collab-sheet-crdt`), et
 * TOUT le reste du modèle (largeurs de colonnes, volets figés, fusions, filtre,
 * mises en forme conditionnelles, validations, graphiques, plages nommées) passe
 * désormais par le codec plein-modèle (`collab-sheet-model`), si bien que deux
 * personnes qui modifient des choses différentes fusionnent sans s'écraser. La
 * logique métier (moteur de formules, condformat, validation, fusions, filtre)
 * et les fenêtres de configuration sont RÉUTILISÉES telles quelles depuis
 * `../../sheet` — aucune duplication : c'est le même Tableur, rendu collaboratif.
 *
 * Chiffré de bout en bout : le relais ne voit que des updates Yjs chiffrés.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import {
  X, Wifi, WifiOff, Loader, Plus, Bold, Italic, AlignLeft, AlignCenter, AlignRight, Download, Upload,
  Baseline, PaintBucket, Combine, Snowflake, Filter, Palette, ListChecks, Tag, BarChart3, Undo2, Redo2,
  Rows, Columns, Trash2, ArrowUpNarrowWide, ArrowDownNarrowWide, TableProperties,
} from "lucide-react";
import { EncryptedYjsProvider, type CollabStatus, type CollabUser } from "../collab-provider";
import { setCellText, migrateCells, type YCells } from "../collab-sheet-crdt";
import {
  newYSheet, ensureSheetStructures, workbookSnapshot, reconcileSheet, addSheetFromData,
  setColWidth, setFreeze, setFilter, growSheet, toggleMergeY,
  setCondRule, removeCondRule, setValidation, removeValidation,
  setChart, removeChart, setName, removeName,
  insertRowY, deleteRowY, insertColY, deleteColY, pasteBlock, clearRangeY, loadWorkbookIntoDoc,
  type YSheet, type YSheets,
} from "../collab-sheet-model";
import { importXlsx } from "../../sheet/xlsx-import";
import { csvToWorkbook } from "../../sheet/csv";
import { sortRange, fillRange, type Rect } from "../../sheet/structural";
import { computePivot, pivotToSheet, type PivotConfig, type PivotInput } from "../../sheet/pivot";
import PivotModal from "../../sheet/PivotModal";
import type { DriveApi } from "../api";
import { createCalc, indexToCol, quoteSheetName, isError } from "../../sheet/formula";
import { formatValue, NUM_FORMATS } from "../../sheet/format";
import { buildCondFormatter } from "../../sheet/condformat";
import { buildValidator, validationAt } from "../../sheet/validation";
import { isCovered, spanAt } from "../../sheet/merges";
import { rowVisible as filterRowVisible } from "../../sheet/filter";
import type { CellStyle, NumFmt, ChartSpec, ChartType, CondRule, DataValidation, SheetData, Workbook } from "../../sheet/model";
import { newId } from "../../sheet/model";
import SheetChart from "../../sheet/SheetChart";
import CondFormatModal from "../../sheet/CondFormatModal";
import ValidationModal from "../../sheet/ValidationModal";
import NamedRangesModal from "../../sheet/NamedRangesModal";
import { workbookToXlsx } from "../../sheet/xlsx-export";
import { downloadBlob } from "../../export/exporters";

const PALETTE = ["#2563eb", "#16a34a", "#db2777", "#ca8a04", "#7c3aed", "#0ea5e9", "#dc2626", "#0d9488"];
const colorFor = (id: string) => { let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return PALETTE[h % PALETTE.length]!; };
const initials = (s: string) => { const p = s.split(/[@\s.]+/).filter(Boolean); return ((p[0]?.[0] ?? "") + (p[1]?.[0] ?? "")).toUpperCase() || "?"; };

const DEFAULT_COL_W = 96;
const ROWHEAD_W = 40; // doit correspondre à .dc-sheet__rowh en CSS
const HEADER_H = 28;
const ROW_H = 28;

const colLetter = indexToCol;
const a1 = (r: number, c: number) => `${colLetter(c)}${r + 1}`;
const absCell = (c: number, r: number) => `$${colLetter(c)}$${r + 1}`;

export default function CollabSheetEditor({
  api, nodeId, nodeKey, title, user, onClose, refetchKey,
}: {
  api: DriveApi; nodeId: string; nodeKey: Uint8Array; title: string; user: { id: string; name: string }; onClose: () => void;
  refetchKey?: () => Promise<Uint8Array | null>;
}) {
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [canWrite, setCanWrite] = useState(false);
  const writable = canWrite && status !== "revoked";
  const [wb, setWb] = useState<Workbook>({ sheets: [], active: 0 });
  const [active, setActive] = useState(0);
  const [sel, setSel] = useState({ r: 0, c: 0 });
  const [anchor, setAnchor] = useState({ r: 0, c: 0 });
  const [editing, setEditing] = useState<{ ref: string; draft: string } | null>(null);
  const [peerCells, setPeerCells] = useState<{ color: string; name: string; s: number; ref: string }[]>([]);
  const [condOpen, setCondOpen] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [namesOpen, setNamesOpen] = useState(false);
  const [pivotOpen, setPivotOpen] = useState(false);
  const [fillTo, setFillTo] = useState<{ r: number; c: number } | null>(null);

  const me: CollabUser = useMemo(() => ({ name: user.name, color: colorFor(user.id) }), [user.id, user.name]);
  const [ydoc] = useState(() => new Y.Doc());
  const [provider] = useState(() => new EncryptedYjsProvider(api, nodeId, nodeKey, ydoc, me, { onStatus: setStatus, onReady: setCanWrite, ...(refetchKey ? { refetchKey } : {}) }));
  const ySheets = useMemo(() => ydoc.getArray<YSheet>("sheets") as YSheets, [ydoc]);
  const yNames = useMemo(() => ydoc.getMap<string>("names"), [ydoc]);
  // Undo/redo local : l'UndoManager ne suit que les transactions d'origine nulle
  // (nos éditions locales) ; les updates distants arrivent avec l'origine
  // "remote" et ne sont donc jamais annulés par erreur.
  const [undoMgr] = useState(() => new Y.UndoManager([ySheets, yNames]));
  const inputRef = useRef<HTMLInputElement>(null);

  const snapshot = (): Workbook => workbookSnapshot(ySheets, yNames, active);

  useEffect(() => {
    let alive = true;
    const obs = () => { if (alive) setWb(snapshot()); };
    ySheets.observeDeep(obs);
    yNames.observe(obs);
    provider.connect().then(() => {
      if (!alive) return;
      if (ySheets.length === 0) {
        ydoc.transact(() => ySheets.push([newYSheet("Feuille 1")]));
      }
      // Une passe d'ouverture (droit d'écriture requis) : convertit les cellules
      // héritées en Y.Text ET crée les sous-structures manquantes sur les
      // documents antérieurs au modèle plein. Idempotent.
      if (canWriteRef.current) {
        ydoc.transact(() => {
          for (const ys of ySheets.toArray()) ensureSheetStructures(ys);
        });
        for (const ys of ySheets.toArray()) {
          const cells = ys.get("cells") as YCells | undefined;
          if (cells) migrateCells(ydoc, cells);
        }
      }
      setWb(snapshot());
    });
    return () => { alive = false; ySheets.unobserveDeep(obs); yNames.unobserve(obs); provider.destroy(); };
  }, [provider, ySheets, yNames, ydoc]); // eslint-disable-line react-hooks/exhaustive-deps

  // `canWrite` peut arriver après connect() ; on le lit via une ref pour la
  // passe de migration sans relancer l'effet de connexion.
  const canWriteRef = useRef(false);
  useEffect(() => { canWriteRef.current = canWrite; }, [canWrite]);

  // Awareness : diffuse la cellule sélectionnée ; collecte celle des pairs.
  useEffect(() => {
    provider.awareness.setLocalStateField("cell", { s: active, ref: a1(sel.r, sel.c) });
  }, [provider, active, sel]);
  useEffect(() => {
    const refresh = () => {
      const self = provider.awareness.clientID;
      const list: { color: string; name: string; s: number; ref: string }[] = [];
      provider.awareness.getStates().forEach((st, id) => {
        if (id === self) return;
        const u = (st as { user?: CollabUser }).user;
        const cell = (st as { cell?: { s: number; ref: string } }).cell;
        if (u && cell) list.push({ color: u.color, name: u.name, s: cell.s, ref: cell.ref });
      });
      setPeerCells(list);
    };
    provider.awareness.on("change", refresh);
    refresh();
    return () => provider.awareness.off("change", refresh);
  }, [provider]);

  const sheet: SheetData | undefined = wb.sheets[active];
  const yActive = (): YSheet | undefined => ySheets.get(active);

  // Sélection rectangulaire (comme le Tableur local) — nécessaire pour les
  // fusions, la mise en forme conditionnelle, les validations, les plages
  // nommées et l'insertion de graphiques.
  const r0 = Math.min(anchor.r, sel.r), r1 = Math.max(anchor.r, sel.r);
  const c0 = Math.min(anchor.c, sel.c), c1 = Math.max(anchor.c, sel.c);
  const inSel = (c: number, r: number) => c >= c0 && c <= c1 && r >= r0 && r <= r1;
  const rangeLabel = `${a1(r0, c0)}:${a1(r1, c1)}`;

  // Moteur de formules avec résolution des plages nommées (portée classeur).
  const calc = useMemo(() => {
    const byName: Record<string, SheetData> = {};
    for (const s of wb.sheets) byName[s.name] = s;
    const cur = wb.sheets[active];
    const nameMap = new Map((wb.names ?? []).map((n) => [n.name.toUpperCase(), n.ref]));
    return createCalc(
      (ref) => cur?.cells[ref],
      { getSheetRaw: (name, ref) => byName[name]?.cells[ref], hasSheet: (name) => name in byName },
      nameMap.size ? (name: string) => nameMap.get(name) : undefined,
    );
  }, [wb, active]);

  const cellDisplay = (ref: string): string =>
    sheet?.cells[ref] != null ? formatValue(calc.valueOf(ref), sheet.styles?.[ref]?.fmt, calc.display(ref)) : "";

  const rowVisible = (r: number) => filterRowVisible(sheet?.filter, (c, rr) => cellDisplay(a1(rr, c)), r);
  const condFmt = useMemo(
    () => buildCondFormatter(
      sheet?.condFormats,
      (c, r) => (sheet?.cells[a1(r, c)] != null ? calc.valueOf(a1(r, c)) : ""),
      (c, r) => cellDisplay(a1(r, c)),
    ),
    [sheet, calc], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const validator = useMemo(
    () => buildValidator(sheet?.validations, (c, r) => sheet?.cells[a1(r, c)] ?? ""),
    [sheet],
  );

  // Largeurs de colonnes & volets figés (positions calculées, comme le local).
  const colWidth = (c: number) => sheet?.colWidths?.[c] ?? DEFAULT_COL_W;
  const colLeft = (c: number) => { let x = ROWHEAD_W; for (let k = 0; k < c; k++) x += colWidth(k); return x; };
  const fz = sheet?.freeze;
  const stickyStyle = (c: number, r: number): React.CSSProperties => {
    if (!fz) return {};
    const headerRow = r < 0;
    const fcol = c < fz.cols;
    const frow = !headerRow && r < fz.rows;
    if (!fcol && !frow) return {};
    const s: React.CSSProperties = { position: "sticky" };
    if (fcol) s.left = colLeft(c);
    if (frow) s.top = HEADER_H + r * ROW_H;
    s.zIndex = headerRow ? 6 : fcol && frow ? 5 : fcol ? 4 : 3;
    return s;
  };

  // ── Mutateurs (chacun une transaction Yjs ciblée) ────────────────────────
  const setCell = (ref: string, raw: string) => {
    const ys = yActive(); if (!ys) return;
    ydoc.transact(() => { ensureSheetStructures(ys); setCellText(ys.get("cells") as YCells, ref, raw); });
  };
  const rectRefs = (): string[] => {
    const refs: string[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) refs.push(a1(r, c));
    return refs;
  };
  const applyStyle = (patch: Partial<CellStyle>) => {
    const ys = yActive(); if (!ys) return;
    ydoc.transact(() => {
      ensureSheetStructures(ys);
      const styles = ys.get("styles") as Y.Map<CellStyle>;
      for (const ref of rectRefs()) {
        const next: CellStyle = { ...styles.get(ref), ...patch };
        (Object.keys(next) as (keyof CellStyle)[]).forEach((k) => next[k] === undefined && delete next[k]);
        if (Object.keys(next).length === 0) styles.delete(ref);
        else styles.set(ref, next);
      }
    });
  };
  const growth = (key: "rows" | "cols", by: number) => { const ys = yActive(); if (ys) growSheet(ydoc, ys, key, by); };
  const addSheet = () => {
    ydoc.transact(() => ySheets.push([newYSheet(`Feuille ${ySheets.length + 1}`)]));
    setActive(ySheets.length - 1);
  };
  const toggleMergeSel = () => { const ys = yActive(); if (ys) toggleMergeY(ydoc, ys, { c0, r0, c1, r1 }); };
  const toggleFreeze = () => {
    const ys = yActive(); if (!ys) return;
    if (fz) setFreeze(ydoc, ys, 0, 0);
    else setFreeze(ydoc, ys, sel.r, sel.c); // fige au-dessus / à gauche de la sélection
  };
  const promptFilter = () => {
    const ys = yActive(); if (!ys) return;
    const q = window.prompt(`Filtrer la colonne ${colLetter(sel.c)} — afficher les lignes contenant :`, sheet?.filter?.query ?? "");
    if (q === null) return;
    setFilter(ydoc, ys, sel.c, q);
  };
  const insertChart = () => { const ys = yActive(); if (ys) setChart(ydoc, ys, { id: newId("chart"), type: "bar", c0, r0, c1, r1 }); };
  const setChartType = (id: string, type: ChartType) => { const ys = yActive(); if (ys) setChart(ydoc, ys, { id, type, c0, r0, c1, r1 }); };

  // Opérations structurelles (réutilisent la logique pure partagée avec le local).
  const insRow = () => { const ys = yActive(); if (ys) insertRowY(ydoc, ys, sel.r); };
  const delRow = () => { const ys = yActive(); if (ys && sheet && sheet.rows > 1) { deleteRowY(ydoc, ys, sel.r); setSel((s) => ({ ...s, r: Math.max(0, Math.min(s.r, sheet.rows - 2)) })); } };
  const insCol = () => { const ys = yActive(); if (ys) insertColY(ydoc, ys, sel.c); };
  const delCol = () => { const ys = yActive(); if (ys && sheet && sheet.cols > 1) { deleteColY(ydoc, ys, sel.c); setSel((s) => ({ ...s, c: Math.max(0, Math.min(s.c, sheet.cols - 2)) })); } };

  // Import d'un classeur XLSX/CSV directement dans le document collaboratif.
  const fileRef = useRef<HTMLInputElement>(null);
  const importFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const imported = file.name.toLowerCase().endsWith(".csv")
        ? csvToWorkbook(await file.text())
        : importXlsx(new Uint8Array(await file.arrayBuffer()));
      loadWorkbookIntoDoc(ydoc, ySheets, yNames, imported);
      setActive(0); setSel({ r: 0, c: 0 }); setAnchor({ r: 0, c: 0 });
    } catch {
      /* fichier illisible — on n'écrase rien */
    }
  };

  // Copier / couper / coller sur une plage (presse-papiers TSV, comme un tableur).
  const copyRange = () => {
    if (!sheet) return;
    const lines: string[] = [];
    for (let r = r0; r <= r1; r++) {
      const row: string[] = [];
      for (let c = c0; c <= c1; c++) row.push(sheet.cells[a1(r, c)] ?? "");
      lines.push(row.join("\t"));
    }
    void navigator.clipboard?.writeText(lines.join("\n"));
  };
  const cutRange = () => { copyRange(); const ys = yActive(); if (ys) clearRangeY(ydoc, ys, r0, c0, r1, c1); };
  const onPaste = (e: React.ClipboardEvent) => {
    if (!writable || editing) return;
    const text = e.clipboardData.getData("text");
    if (!text) return;
    e.preventDefault();
    const rows = text.replace(/\r/g, "").split("\n");
    if (rows.length && rows[rows.length - 1] === "") rows.pop();
    const grid = rows.map((l) => l.split("\t"));
    const ys = yActive(); if (ys) pasteBlock(ydoc, ys, sel.r, sel.c, grid);
  };

  // Tri des lignes par la colonne active (réutilise le tri PUR partagé, propagé
  // au CRDT par reconcileSheet — les lignes masquées par le filtre ne bougent pas).
  const sortBy = (dir: 1 | -1) => {
    const ys = yActive(); if (!ys || !sheet) return;
    reconcileSheet(ydoc, ys, sortRange(sheet, sel.c, { c0, r0, c1, r1 }, dir, (c, r) => cellDisplay(a1(r, c))));
  };

  // Poignée de recopie : aperçu local pendant le glissé, appliqué au relâché.
  const fillRef = useRef<Rect | null>(null);
  const fillToRef = useRef<{ r: number; c: number } | null>(null);
  const startFill = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    fillRef.current = { c0, c1, r0, r1 };
    fillToRef.current = { r: r1, c: c1 };
    setFillTo({ r: r1, c: c1 });
  };
  useEffect(() => {
    const up = () => {
      const src = fillRef.current, to = fillToRef.current;
      if (src && to && sheet) { const ys = yActive(); if (ys) reconcileSheet(ydoc, ys, fillRange(sheet, src, { c: to.c, r: to.r })); }
      fillRef.current = null; fillToRef.current = null; setFillTo(null);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [sheet, ydoc]); // eslint-disable-line react-hooks/exhaustive-deps
  const fillBand = (): Rect | null => {
    if (!fillTo) return null;
    const overR = fillTo.r > r1 ? fillTo.r - r1 : fillTo.r < r0 ? fillTo.r - r0 : 0;
    const overC = fillTo.c > c1 ? fillTo.c - c1 : fillTo.c < c0 ? fillTo.c - c0 : 0;
    if (Math.abs(overR) >= Math.abs(overC) && overR !== 0) return { c0, c1, r0: Math.min(r0, fillTo.r), r1: Math.max(r1, fillTo.r) };
    if (overC !== 0) return { c0: Math.min(c0, fillTo.c), c1: Math.max(c1, fillTo.c), r0, r1 };
    return null;
  };
  const fb = fillBand();
  const inFill = (c: number, r: number) => !!fb && c >= fb.c0 && c <= fb.c1 && r >= fb.r0 && r <= fb.r1 && !inSel(c, r);

  // Tableau croisé dynamique : champs = première ligne de la sélection ; le
  // résultat crée une nouvelle feuille dans le document collaboratif.
  const pivotHeaders = (): string[] => { const h: string[] = []; for (let c = c0; c <= c1; c++) h.push(calc.display(a1(r0, c))); return h; };
  const buildPivotInput = (): PivotInput => {
    const rows: (string | number | boolean | null)[][] = [];
    for (let r = r0 + 1; r <= r1; r++) {
      const row: (string | number | boolean | null)[] = [];
      for (let c = c0; c <= c1; c++) { const v = calc.valueOf(a1(r, c)); row.push(isError(v) ? null : (v as string | number | boolean)); }
      rows.push(row);
    }
    return { headers: pivotHeaders(), rows };
  };
  const createPivot = (cfg: PivotConfig) => {
    const data = pivotToSheet(computePivot(buildPivotInput(), cfg), `TCD ${ySheets.length + 1}`);
    const idx = addSheetFromData(ydoc, ySheets, data);
    setPivotOpen(false); setActive(idx); setSel({ r: 0, c: 0 }); setAnchor({ r: 0, c: 0 });
  };

  // Colonnes redimensionnables — aperçu local pendant le glissé, validé (une
  // seule transaction Yjs) au relâché pour ne pas inonder le relais.
  const resizeRef = useRef<{ col: number; startX: number; startW: number } | null>(null);
  const [resizePreview, setResizePreview] = useState<{ col: number; w: number } | null>(null);
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const rz = resizeRef.current; if (!rz) return;
      setResizePreview({ col: rz.col, w: Math.max(40, Math.round(rz.startW + (e.clientX - rz.startX))) });
    };
    const up = () => {
      const rz = resizeRef.current; if (!rz) return;
      const ys = yActive();
      if (ys && resizePreview) setColWidth(ydoc, ys, resizePreview.col, resizePreview.w);
      resizeRef.current = null; setResizePreview(null); document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, [resizePreview, ydoc]); // eslint-disable-line react-hooks/exhaustive-deps
  const startResize = (c: number, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    resizeRef.current = { col: c, startX: e.clientX, startW: colWidth(c) };
    document.body.style.cursor = "col-resize";
  };
  const shownWidth = (c: number) => (resizePreview?.col === c ? resizePreview.w : colWidth(c));

  // Condformat / validation / plages nommées : réutilisent les fenêtres du
  // Tableur local ; les callbacks injectent l'id + la plage sélectionnée.
  const addCondRule = (rule: Omit<CondRule, "id" | "c0" | "r0" | "c1" | "r1">) => {
    const ys = yActive(); if (ys) setCondRule(ydoc, ys, { ...rule, id: newId("cf"), c0, r0, c1, r1 });
  };
  const addValidationRule = (v: Omit<DataValidation, "id" | "c0" | "r0" | "c1" | "r1">) => {
    const ys = yActive(); if (ys) setValidation(ydoc, ys, { ...v, id: newId("dv"), c0, r0, c1, r1 });
  };
  const addNamedRange = (name: string) => {
    const single = c0 === c1 && r0 === r1;
    const ref = `${quoteSheetName(sheet?.name ?? "Feuille")}!${single ? absCell(c0, r0) : `${absCell(c0, r0)}:${absCell(c1, r1)}`}`;
    setName(ydoc, yNames, name, ref);
  };

  // ── Édition & navigation ─────────────────────────────────────────────────
  const commitEdit = (move: boolean) => {
    if (editing) { setCell(editing.ref, editing.draft); setEditing(null); }
    if (move && sheet) setSel((s) => ({ r: Math.min(s.r + 1, sheet.rows - 1), c: s.c }));
  };
  const beginEdit = (r: number, c: number, initial?: string) => {
    const ref = a1(r, c);
    setSel({ r, c }); setAnchor({ r, c });
    setEditing({ ref, draft: initial ?? sheet?.cells[ref] ?? "" });
    requestAnimationFrame(() => inputRef.current?.focus());
  };
  const selectCell = (r: number, c: number, extend = false) => {
    commitEdit(false);
    setSel({ r, c });
    if (!extend) setAnchor({ r, c });
  };
  const dragging = useRef(false);
  useEffect(() => { const up = () => (dragging.current = false); window.addEventListener("mouseup", up); return () => window.removeEventListener("mouseup", up); }, []);

  const onGridKey = (e: React.KeyboardEvent) => {
    if (editing || !sheet) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); if (e.shiftKey) undoMgr.redo(); else undoMgr.undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); undoMgr.redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") { e.preventDefault(); copyRange(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "x") { e.preventDefault(); if (writable) cutRange(); return; }
    const ext = e.shiftKey;
    if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => ({ ...s, r: Math.max(0, s.r - 1) })); if (!ext) setAnchor((a) => ({ ...a, r: Math.max(0, sel.r - 1) })); }
    else if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); setSel((s) => ({ ...s, r: Math.min(sheet.rows - 1, s.r + 1) })); if (!ext) setAnchor((a) => ({ ...a, r: Math.min(sheet.rows - 1, sel.r + 1) })); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); setSel((s) => ({ ...s, c: Math.max(0, s.c - 1) })); if (!ext) setAnchor((a) => ({ ...a, c: Math.max(0, sel.c - 1) })); }
    else if (e.key === "ArrowRight" || e.key === "Tab") { e.preventDefault(); setSel((s) => ({ ...s, c: Math.min(sheet.cols - 1, s.c + 1) })); if (!ext) setAnchor((a) => ({ ...a, c: Math.min(sheet.cols - 1, sel.c + 1) })); }
    else if (e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); ydoc.transact(() => { for (const ref of rectRefs()) setCell(ref, ""); }); }
    else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && writable) { beginEdit(sel.r, sel.c, e.key); }
  };

  const exportXlsx = () => {
    if (!wb.sheets.length) return;
    const base = (title || "classeur").replace(/\.[^.]+$/, "");
    downloadBlob(`${base}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", workbookToXlsx(wb));
  };

  const chartData = (spec: ChartSpec) => {
    const oneCol = spec.c0 === spec.c1;
    const labels: string[] = []; const values: number[] = [];
    for (let r = spec.r0; r <= spec.r1; r++) {
      if (oneCol) { const v = calc.valueOf(a1(r, spec.c0)); labels.push(String(r - spec.r0 + 1)); values.push(typeof v === "number" ? v : Number(v) || 0); }
      else { const lab = calc.valueOf(a1(r, spec.c0)); const val = calc.valueOf(a1(r, spec.c0 + 1)); labels.push(typeof lab === "number" ? String(lab) : String(lab ?? "")); values.push(typeof val === "number" ? val : Number(val) || 0); }
    }
    return { labels, values };
  };

  const selRef = a1(sel.r, sel.c);
  const selStyle = sheet?.styles?.[selRef];
  const statusLabel =
    status === "open" ? "Connecté" :
    status === "connecting" ? "Connexion…" :
    status === "revoked" ? "Accès révoqué — document fermé" :
    "Hors ligne";

  return (
    <div className="dc-modal-overlay dc-modal-overlay--full">
      <div className="dc-doc dc-sheet dc-doc--fullscreen">
        <header className="dc-doc__head">
          <span className="dc-doc__title" title={title}>{title}</span>
          <span className={`dc-doc__status dc-doc__status--${status}`}>
            {status === "open" ? <Wifi size={13} /> : status === "connecting" ? <Loader size={13} className="dc-spin" /> : <WifiOff size={13} />} {statusLabel}
          </span>
          <div className="dc-doc__peers">
            <span className="dc-doc-av" style={{ background: me.color }} title={`${me.name} (vous)`}>{initials(me.name)}</span>
            {[...new Map(peerCells.map((p) => [p.name + p.color, p])).values()].map((p, i) => (
              <span key={i} className="dc-doc-av" style={{ background: p.color }} title={p.name}>{initials(p.name)}</span>
            ))}
          </div>
          <div className="dc-doc__spacer" />
          {!canWrite && status === "open" && <span className="badge badge--neutral">Lecture seule</span>}
          <button className="eb eb--sm eb--outline" onClick={exportXlsx} disabled={!wb.sheets.length} title="Exporter en XLSX">
            <Download size={14} /> XLSX
          </button>
          <button className="icon-btn" onClick={onClose} aria-label="Fermer"><X size={18} /></button>
        </header>

        {writable && (
          <div className="dc-doc__toolbar">
            <button className="icon-btn" title="Annuler (Ctrl+Z)" onMouseDown={(e) => { e.preventDefault(); undoMgr.undo(); }} disabled={!undoMgr.canUndo()}><Undo2 size={16} /></button>
            <button className="icon-btn" title="Rétablir (Ctrl+Y)" onMouseDown={(e) => { e.preventDefault(); undoMgr.redo(); }} disabled={!undoMgr.canRedo()}><Redo2 size={16} /></button>
            <span className="dc-doc__tbsep" />
            <button className={`icon-btn ${selStyle?.bold ? "is-active" : ""}`} title="Gras" onMouseDown={(e) => { e.preventDefault(); applyStyle({ bold: !selStyle?.bold }); }}><Bold size={16} /></button>
            <button className={`icon-btn ${selStyle?.italic ? "is-active" : ""}`} title="Italique" onMouseDown={(e) => { e.preventDefault(); applyStyle({ italic: !selStyle?.italic }); }}><Italic size={16} /></button>
            <label className="icon-btn" title="Couleur du texte" style={{ position: "relative" }}>
              <Baseline size={16} />
              <input type="color" value={selStyle?.color ?? "#111111"} onChange={(e) => applyStyle({ color: e.target.value })} style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }} />
            </label>
            <label className="icon-btn" title="Couleur de remplissage" style={{ position: "relative" }}>
              <PaintBucket size={16} />
              <input type="color" value={selStyle?.fill ?? "#ffffff"} onChange={(e) => applyStyle({ fill: e.target.value })} style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }} />
            </label>
            <span className="dc-doc__tbsep" />
            <button className={`icon-btn ${selStyle?.align === "left" ? "is-active" : ""}`} title="Gauche" onMouseDown={(e) => { e.preventDefault(); applyStyle({ align: "left" }); }}><AlignLeft size={16} /></button>
            <button className={`icon-btn ${selStyle?.align === "center" ? "is-active" : ""}`} title="Centrer" onMouseDown={(e) => { e.preventDefault(); applyStyle({ align: "center" }); }}><AlignCenter size={16} /></button>
            <button className={`icon-btn ${selStyle?.align === "right" ? "is-active" : ""}`} title="Droite" onMouseDown={(e) => { e.preventDefault(); applyStyle({ align: "right" }); }}><AlignRight size={16} /></button>
            <select className="tool-select" value={selStyle?.fmt ?? "general"} onChange={(e) => applyStyle({ fmt: e.target.value as NumFmt })} title="Format des nombres">
              {NUM_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            <span className="dc-doc__tbsep" />
            <button className="icon-btn" title="Fusionner / défusionner" onMouseDown={(e) => { e.preventDefault(); toggleMergeSel(); }}><Combine size={16} /></button>
            <button className={`icon-btn ${fz ? "is-active" : ""}`} title="Figer les volets (jusqu'à la sélection)" onMouseDown={(e) => { e.preventDefault(); toggleFreeze(); }}><Snowflake size={16} /></button>
            <button className={`icon-btn ${sheet?.filter ? "is-active" : ""}`} title="Filtrer (colonne active)" onMouseDown={(e) => { e.preventDefault(); promptFilter(); }}><Filter size={16} /></button>
            <button className={`icon-btn ${(sheet?.condFormats?.length ?? 0) > 0 ? "is-active" : ""}`} title="Mise en forme conditionnelle" onClick={() => setCondOpen(true)}><Palette size={16} /></button>
            <button className={`icon-btn ${(sheet?.validations?.length ?? 0) > 0 ? "is-active" : ""}`} title="Validation des données" onClick={() => setValidationOpen(true)}><ListChecks size={16} /></button>
            <button className={`icon-btn ${(wb.names?.length ?? 0) > 0 ? "is-active" : ""}`} title="Plages nommées" onClick={() => setNamesOpen(true)}><Tag size={16} /></button>
            <button className="icon-btn" title="Insérer un graphique (depuis la sélection)" onMouseDown={(e) => { e.preventDefault(); insertChart(); }}><BarChart3 size={16} /></button>
            <button className="icon-btn" title="Tableau croisé dynamique (depuis la sélection)" onClick={() => setPivotOpen(true)}><TableProperties size={16} /></button>
            <span className="dc-doc__tbsep" />
            <button className="icon-btn" title="Trier croissant (colonne active)" onMouseDown={(e) => { e.preventDefault(); sortBy(1); }}><ArrowUpNarrowWide size={16} /></button>
            <button className="icon-btn" title="Trier décroissant (colonne active)" onMouseDown={(e) => { e.preventDefault(); sortBy(-1); }}><ArrowDownNarrowWide size={16} /></button>
            <span className="dc-doc__tbsep" />
            <button className="icon-btn" title="Insérer une ligne au-dessus" onMouseDown={(e) => { e.preventDefault(); insRow(); }}><Rows size={16} /><Plus size={10} /></button>
            <button className="icon-btn" title="Supprimer la ligne" onMouseDown={(e) => { e.preventDefault(); delRow(); }}><Rows size={16} /><Trash2 size={10} /></button>
            <button className="icon-btn" title="Insérer une colonne à gauche" onMouseDown={(e) => { e.preventDefault(); insCol(); }}><Columns size={16} /><Plus size={10} /></button>
            <button className="icon-btn" title="Supprimer la colonne" onMouseDown={(e) => { e.preventDefault(); delCol(); }}><Columns size={16} /><Trash2 size={10} /></button>
            <span className="dc-doc__tbsep" />
            <button className="eb eb--sm eb--ghost" onClick={() => growth("rows", 10)}><Plus size={13} /> Lignes</button>
            <button className="eb eb--sm eb--ghost" onClick={() => growth("cols", 4)}><Plus size={13} /> Colonnes</button>
            <button className="eb eb--sm eb--outline" onClick={() => fileRef.current?.click()} title="Importer un classeur XLSX/CSV"><Upload size={13} /> Importer</button>
            <input ref={fileRef} type="file" accept=".xlsx,.csv" hidden onChange={importFile} />
          </div>
        )}

        {/* Barre de formule */}
        <div className="dc-sheet__fx">
          <span className="dc-sheet__fxref">{selRef}</span>
          <input
            ref={inputRef}
            className="dc-sheet__fxinput"
            value={editing ? editing.draft : (sheet?.cells[selRef] ?? "")}
            readOnly={!writable}
            onFocus={() => { if (writable && !editing) setEditing({ ref: selRef, draft: sheet?.cells[selRef] ?? "" }); }}
            onChange={(e) => setEditing({ ref: selRef, draft: e.target.value })}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commitEdit(true); } else if (e.key === "Escape") setEditing(null); }}
            onBlur={() => commitEdit(false)}
            placeholder="Valeur ou =formule"
          />
        </div>

        {sheet?.filter && (
          <div className="dc-sheet__filterchip">
            Filtre : {colLetter(sheet.filter.col)} ⊃ «&nbsp;{sheet.filter.query}&nbsp;»
            <button className="icon-btn" title="Retirer le filtre" onClick={() => { const ys = yActive(); if (ys) setFilter(ydoc, ys, sheet.filter!.col, ""); }}><X size={13} /></button>
          </div>
        )}

        <div className="dc-doc__body dc-sheet__body" tabIndex={0} onKeyDown={onGridKey} onPaste={onPaste}>
          {sheet && (
            <table className="dc-sheet__grid" style={{ tableLayout: "fixed" }}>
              <thead>
                <tr>
                  <th className="dc-sheet__corner" style={{ width: ROWHEAD_W, ...stickyStyle(-1, -1) }} />
                  {Array.from({ length: sheet.cols }, (_, c) => (
                    <th key={c} className="dc-sheet__colh" style={{ width: shownWidth(c), minWidth: shownWidth(c), position: "relative", ...stickyStyle(c, -1) }}>
                      {colLetter(c)}
                      <span
                        onMouseDown={(e) => startResize(c, e)}
                        title="Redimensionner la colonne"
                        style={{ position: "absolute", top: 0, right: 0, width: 6, height: "100%", cursor: "col-resize" }}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: sheet.rows }, (_, r) => {
                  if (!rowVisible(r)) return null;
                  return (
                    <tr key={r} style={{ height: ROW_H }}>
                      <th className="dc-sheet__rowh" style={{ width: ROWHEAD_W, ...(fz && r < fz.rows ? { position: "sticky", top: HEADER_H + r * ROW_H, zIndex: 5 } : {}) }}>{r + 1}</th>
                      {Array.from({ length: sheet.cols }, (_, c) => {
                        if (isCovered(sheet.merges, c, r)) return null; // masquée par une fusion
                        const span = spanAt(sheet.merges, c, r);
                        const ref = a1(r, c);
                        const st = sheet.styles?.[ref];
                        const isSel = sel.r === r && sel.c === c;
                        const isEditing = editing?.ref === ref;
                        const peer = peerCells.find((p) => p.s === active && p.ref === ref);
                        const cf = condFmt(c, r);
                        const invalid = validator(c, r);
                        const dv = validationAt(sheet.validations, c, r);
                        const listId = isEditing && dv?.type === "list" && dv.list?.length ? `dv-${c}-${r}` : undefined;
                        const style: React.CSSProperties = {
                          width: shownWidth(c),
                          maxWidth: shownWidth(c), // surclasse le max-width CSS par défaut (92px)
                          fontWeight: cf.fontWeight ?? (st?.bold ? 700 : undefined),
                          fontStyle: st?.italic ? "italic" : undefined,
                          textAlign: st?.align,
                          color: cf.color ?? st?.color,
                          background: cf.background ?? st?.fill,
                          boxShadow: peer ? `inset 0 0 0 2px ${peer.color}` : invalid ? "inset 0 0 0 2px #dc2626" : undefined,
                          ...stickyStyle(c, r),
                        };
                        return (
                          <td
                            key={c}
                            className={`dc-sheet__cell ${isSel ? "is-sel" : inSel(c, r) ? "is-range" : ""} ${inFill(c, r) ? "is-fill" : ""}`}
                            style={style}
                            colSpan={span?.colSpan}
                            rowSpan={span?.rowSpan}
                            title={invalid ?? (peer ? `${peer.name} est ici` : undefined)}
                            onMouseDown={(e) => { if (!isEditing) { selectCell(r, c, e.shiftKey); dragging.current = true; } }}
                            onMouseEnter={() => { if (fillRef.current) { fillToRef.current = { r, c }; setFillTo({ r, c }); } else if (dragging.current) setSel({ r, c }); }}
                            onDoubleClick={() => writable && beginEdit(r, c)}
                          >
                            {isEditing ? (
                              <>
                                <input
                                  autoFocus
                                  className="dc-sheet__celledit"
                                  value={editing.draft}
                                  list={listId}
                                  onChange={(e) => setEditing({ ref, draft: e.target.value })}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") { e.preventDefault(); commitEdit(true); }
                                    else if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                                    else if (e.key === "Tab") { e.preventDefault(); commitEdit(false); setSel((s) => ({ ...s, c: Math.min(sheet.cols - 1, s.c + 1) })); }
                                  }}
                                  onBlur={() => commitEdit(false)}
                                />
                                {listId && <datalist id={listId}>{dv!.list!.map((opt) => <option key={opt} value={opt} />)}</datalist>}
                              </>
                            ) : (
                              <>
                                {cellDisplay(ref)}
                                {writable && !editing && sel.r === r && sel.c === c && r === r1 && c === c1 && (
                                  <span className="dc-sheet__fillhandle" onMouseDown={startFill} title="Recopier (poignée de remplissage)" />
                                )}
                              </>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {(sheet?.charts?.length ?? 0) > 0 && (
          <div className="dc-sheet__charts">
            {sheet!.charts!.map((ch) => {
              const { labels, values } = chartData(ch);
              return (
                <div key={ch.id} className="dc-sheet__chart">
                  <div className="dc-sheet__chart-head">
                    <select className="tool-select tool-select--sm" value={ch.type} disabled={!writable} onChange={(e) => setChartType(ch.id, e.target.value as ChartType)}>
                      <option value="bar">Barres</option>
                      <option value="line">Lignes</option>
                      <option value="pie">Secteurs</option>
                    </select>
                    <span className="dc-sheet__chart-range">{a1(ch.r0, ch.c0)}:{a1(ch.r1, ch.c1)}</span>
                    {writable && <button className="icon-btn icon-btn--danger" title="Supprimer le graphique" onClick={() => { const ys = yActive(); if (ys) removeChart(ydoc, ys, ch.id); }}><X size={14} /></button>}
                  </div>
                  <SheetChart type={ch.type} labels={labels} values={values} />
                </div>
              );
            })}
          </div>
        )}

        <div className="dc-sheet__tabs">
          {wb.sheets.map((s, i) => (
            <button key={i} className={`dc-sheet__tab ${i === active ? "is-active" : ""}`} onClick={() => { commitEdit(false); setActive(i); setSel({ r: 0, c: 0 }); setAnchor({ r: 0, c: 0 }); }}>{s.name}</button>
          ))}
          {writable && <button className="icon-btn" title="Ajouter une feuille" onClick={addSheet}><Plus size={15} /></button>}
        </div>
      </div>

      {condOpen && (
        <CondFormatModal
          rangeLabel={rangeLabel}
          rules={sheet?.condFormats ?? []}
          onAdd={addCondRule}
          onRemove={(id) => { const ys = yActive(); if (ys) removeCondRule(ydoc, ys, id); }}
          onClose={() => setCondOpen(false)}
        />
      )}
      {validationOpen && (
        <ValidationModal
          rangeLabel={rangeLabel}
          validations={sheet?.validations ?? []}
          onAdd={addValidationRule}
          onRemove={(id) => { const ys = yActive(); if (ys) removeValidation(ydoc, ys, id); }}
          onClose={() => setValidationOpen(false)}
        />
      )}
      {namesOpen && (
        <NamedRangesModal
          rangeLabel={`${quoteSheetName(sheet?.name ?? "Feuille")}!${rangeLabel}`}
          names={wb.names ?? []}
          onAdd={addNamedRange}
          onRemove={(name) => removeName(ydoc, yNames, name)}
          onClose={() => setNamesOpen(false)}
        />
      )}
      {pivotOpen && (
        <PivotModal
          headers={pivotHeaders()}
          rangeLabel={rangeLabel}
          onCreate={createPivot}
          onClose={() => setPivotOpen(false)}
        />
      )}
    </div>
  );
}
