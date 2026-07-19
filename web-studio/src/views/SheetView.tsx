import { useEffect, useMemo, useRef, useState } from "react";
import {
  Home, Plus, Minus, Download, Upload, Save, Table2, FileSpreadsheet,
  Bold, Italic, AlignLeft, AlignCenter, AlignRight, Baseline, PaintBucket, Sigma,
  BarChart3, ArrowUpNarrowWide, ArrowDownNarrowWide, Filter, X, Snowflake, Palette, Undo2, Redo2, Type, Trash2, ListChecks, Tag, Combine,
} from "lucide-react";
import { useUndoable } from "../ui/useUndoable";
import { fontCss, allFontNames, registerCustomFont, DEFAULT_FONT } from "../ui/fonts";
import { useDialogs } from "../ui/dialogs";
import { createCalc, indexToCol, parseRef, isError, rewriteRefs, renameSheetRefs, quoteSheetName, FUNCTIONS, type RefMap } from "../sheet/formula";
import { formatValue, NUM_FORMATS } from "../sheet/format";
import SheetChart from "../sheet/SheetChart";
import CondFormatModal from "../sheet/CondFormatModal";
import ValidationModal from "../sheet/ValidationModal";
import NamedRangesModal from "../sheet/NamedRangesModal";
import { buildCondFormatter } from "../sheet/condformat";
import { buildValidator, validationAt } from "../sheet/validation";
import { isCovered, spanAt, toggleMerge } from "../sheet/merges";
import { emptyWorkbook, emptySheet, removeSheet, newId, type Workbook, type SheetData, type CellStyle, type NumFmt, type ChartSpec, type ChartType, type CondRule, type DataValidation } from "../sheet/model";
import { loadWorkbook, saveWorkbook } from "../sheet/sheet-store";
import { importXlsx } from "../sheet/xlsx-import";
import { csvToWorkbook } from "../sheet/csv";
import { workbookToXlsx } from "../sheet/xlsx-export";
import { rowVisible as filterRowVisible, visibleRowsInRange } from "../sheet/filter";
import { downloadBlob } from "../export/exporters";

type Pos = { c: number; r: number };
const cellRef = (c: number, r: number) => indexToCol(c) + (r + 1);

const ROWHEAD_W = 44; // width of the row-number column (px)
const HEADER_H = 28; // column-header row height (must match CSS)
const ROW_H = 28; // data-row height (must match CSS .sheet-grid td)
const DEFAULT_COL_W = 96; // default column width (px)

/**
 * Elium Tableur — full spreadsheet: range selection (click/drag/shift), keyboard
 * navigation, the formula engine (refs/ranges/functions), cell formatting
 * (bold/italic/align/colors) and number formats (€/%/date/decimals), insert &
 * delete rows/columns, copy/cut/paste, multi-sheet, XLSX/CSV import, CSV export,
 * and save to a sealed/encrypted .elium. Autosaves locally.
 */
export default function SheetView({
  onHome,
  initial,
  onExportElium,
}: {
  onHome: () => void;
  initial?: Workbook;
  onExportElium: (data: Workbook, title: string) => void;
}) {
  const dialogs = useDialogs();
  const { value: wb, set: setWb, setQuiet: setWbQuiet, checkpoint, undo, redo, canUndo, canRedo, reset: resetWb } = useUndoable<Workbook>(initial ?? emptyWorkbook());
  const [sel, setSel] = useState<Pos>({ c: 0, r: 0 });
  const [anchor, setAnchor] = useState<Pos>({ c: 0, r: 0 });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [fxOpen, setFxOpen] = useState(false);
  const dragging = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (initial) return;
    loadWorkbook().then((w) => w && resetWb(w)).catch(() => {});
  }, [initial]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist (debounced) whenever the workbook changes — replaces the per-mutation save.
  useEffect(() => {
    if (initial) return;
    const t = setTimeout(() => void saveWorkbook(wb), 300);
    return () => clearTimeout(t);
  }, [wb, initial]);

  // Undo / redo (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z), unless a native input has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  const sheet = wb.sheets[wb.active];
  // Cross-sheet resolver (Feuille2!A1): the engine reads any sheet by name.
  const crossSheets = useMemo(
    () => ({
      getSheetRaw: (name: string, ref: string) => wb.sheets.find((s) => s.name === name)?.cells[ref],
      hasSheet: (name: string) => wb.sheets.some((s) => s.name === name),
    }),
    [wb],
  );
  // Workbook-scoped defined names (resolved before every formula evaluation).
  const nameResolver = useMemo(() => {
    const map = new Map((wb.names ?? []).map((n) => [n.name.toUpperCase(), n.ref]));
    return map.size ? (name: string) => map.get(name) : undefined;
  }, [wb.names]);
  const calc = useMemo(() => createCalc((ref) => sheet.cells[ref], crossSheets, nameResolver), [sheet, crossSheets, nameResolver]);
  const activeRef = cellRef(sel.c, sel.r);

  const r0 = Math.min(anchor.r, sel.r), r1 = Math.max(anchor.r, sel.r);
  const c0 = Math.min(anchor.c, sel.c), c1 = Math.max(anchor.c, sel.c);
  const inSel = (c: number, r: number) => c >= c0 && c <= c1 && r >= r0 && r <= r1;
  const rectRefs = (): string[] => {
    const refs: string[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) refs.push(cellRef(c, r));
    return refs;
  };

  const update = (mut: (wb: Workbook) => Workbook) => setWb(mut); // records history; persistence via effect

  const patchSheet = (fn: (sh: SheetData) => SheetData) =>
    update((w) => {
      const sheets = w.sheets.slice();
      sheets[w.active] = fn({ ...sheets[w.active] });
      return { ...w, sheets };
    });

  const writeCellAt = (ref: string, value: string) =>
    patchSheet((sh) => {
      const cells = { ...sh.cells };
      if (value.trim() === "") delete cells[ref];
      else cells[ref] = value;
      return { ...sh, cells };
    });

  // --- column widths & frozen panes ----------------------------------------
  const fz = sheet.freeze;
  const colWidth = (c: number) => sheet.colWidths?.[c] ?? DEFAULT_COL_W;
  const colLeft = (c: number) => {
    let x = ROWHEAD_W;
    for (let k = 0; k < c; k++) x += colWidth(k);
    return x;
  };

  // Drag-to-resize a column. Width updates live (no persist) during the drag,
  // then we persist once on release to avoid hammering IndexedDB.
  const resizeRef = useRef<{ col: number; startX: number; startW: number } | null>(null);
  const startResize = (c: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    checkpoint(); // one undo step for the whole resize
    resizeRef.current = { col: c, startX: e.clientX, startW: colWidth(c) };
    document.body.style.cursor = "col-resize";
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const rz = resizeRef.current;
      if (!rz) return;
      const w = Math.max(40, Math.round(rz.startW + (e.clientX - rz.startX)));
      setWbQuiet((prev) => {
        const sheets = prev.sheets.slice();
        const sh = { ...sheets[prev.active] };
        sh.colWidths = { ...(sh.colWidths ?? {}), [rz.col]: w };
        sheets[prev.active] = sh;
        return { ...prev, sheets };
      });
    };
    const up = () => {
      if (!resizeRef.current) return;
      resizeRef.current = null;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- fill handle (poignée de remplissage) --------------------------------
  type Rect = { c0: number; c1: number; r0: number; r1: number };
  const fillRef = useRef<Rect | null>(null);
  const fillToRef = useRef<Pos | null>(null);
  const [fillTo, setFillTo] = useState<Pos | null>(null);

  const fillBand = (src: Rect, to: Pos): Rect | null => {
    const overR = to.r > src.r1 ? to.r - src.r1 : to.r < src.r0 ? to.r - src.r0 : 0;
    const overC = to.c > src.c1 ? to.c - src.c1 : to.c < src.c0 ? to.c - src.c0 : 0;
    if (Math.abs(overR) >= Math.abs(overC) && overR !== 0) return { c0: src.c0, c1: src.c1, r0: Math.min(src.r0, to.r), r1: Math.max(src.r1, to.r) };
    if (overC !== 0) return { c0: Math.min(src.c0, to.c), c1: Math.max(src.c1, to.c), r0: src.r0, r1: src.r1 };
    return null;
  };

  const startFill = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fillRef.current = { c0, c1, r0, r1 };
    fillToRef.current = { c: c1, r: r1 };
    setFillTo({ c: c1, r: r1 });
  };

  const performFill = (src: Rect, to: Pos) =>
    patchSheet((sh) => {
      const cells = { ...sh.cells };
      const styles = { ...(sh.styles ?? {}) };
      const num = (raw?: string) => { if (raw == null || raw === "") return null; const n = Number(raw); return Number.isNaN(n) ? null : n; };
      const put = (c: number, r: number, raw: string | undefined, st: CellStyle | undefined, offC: number, offR: number) => {
        const ref = cellRef(c, r);
        let v = raw;
        if (v != null && v[0] === "=" && (offC || offR)) v = rewriteRefs(v, (cc, rr) => ({ col: cc + offC, row: rr + offR }), true);
        if (v == null || v === "") delete cells[ref]; else cells[ref] = v;
        if (st) styles[ref] = st; else delete styles[ref];
      };
      const arithStep = (vals: (string | undefined)[]) => {
        const nums = vals.map(num);
        if (vals.some((v) => v && v[0] === "=") || nums.some((n) => n === null) || nums.length < 2) return null;
        const step = nums[1]! - nums[0]!;
        return nums.slice(1).every((n, i) => Math.abs((n! - nums[i]!) - step) < 1e-9) ? step : null;
      };
      const overR = to.r > src.r1 ? to.r - src.r1 : to.r < src.r0 ? to.r - src.r0 : 0;
      const overC = to.c > src.c1 ? to.c - src.c1 : to.c < src.c0 ? to.c - src.c0 : 0;
      const vertical = Math.abs(overR) >= Math.abs(overC);

      if (vertical && overR !== 0) {
        const dir = overR > 0 ? 1 : -1, count = Math.abs(overR), h = src.r1 - src.r0 + 1;
        for (let c = src.c0; c <= src.c1; c++) {
          const vals: (string | undefined)[] = [];
          for (let r = src.r0; r <= src.r1; r++) vals.push(sh.cells[cellRef(c, r)]);
          const step = arithStep(vals);
          for (let k = 1; k <= count; k++) {
            const destR = dir > 0 ? src.r1 + k : src.r0 - k;
            if (step != null) {
              const base = dir > 0 ? num(vals[h - 1])! : num(vals[0])!;
              put(c, destR, String(base + step * (dir > 0 ? k : -k)), sh.styles?.[cellRef(c, dir > 0 ? src.r1 : src.r0)], 0, 0);
            } else {
              const srcR = src.r0 + (((destR - src.r0) % h) + h) % h;
              put(c, destR, sh.cells[cellRef(c, srcR)], sh.styles?.[cellRef(c, srcR)], 0, destR - srcR);
            }
          }
        }
      } else if (overC !== 0) {
        const dir = overC > 0 ? 1 : -1, count = Math.abs(overC), w = src.c1 - src.c0 + 1;
        for (let r = src.r0; r <= src.r1; r++) {
          const vals: (string | undefined)[] = [];
          for (let c = src.c0; c <= src.c1; c++) vals.push(sh.cells[cellRef(c, r)]);
          const step = arithStep(vals);
          for (let k = 1; k <= count; k++) {
            const destC = dir > 0 ? src.c1 + k : src.c0 - k;
            if (step != null) {
              const base = dir > 0 ? num(vals[w - 1])! : num(vals[0])!;
              put(destC, r, String(base + step * (dir > 0 ? k : -k)), sh.styles?.[cellRef(dir > 0 ? src.c1 : src.c0, r)], 0, 0);
            } else {
              const srcC = src.c0 + (((destC - src.c0) % w) + w) % w;
              put(destC, r, sh.cells[cellRef(srcC, r)], sh.styles?.[cellRef(srcC, r)], destC - srcC, 0);
            }
          }
        }
      }
      return { ...sh, cells, styles, cols: Math.max(sh.cols, to.c + 1), rows: Math.max(sh.rows, to.r + 1) };
    });

  useEffect(() => {
    const up = () => {
      if (fillRef.current && fillToRef.current) performFill(fillRef.current, fillToRef.current);
      fillRef.current = null;
      fillToRef.current = null;
      setFillTo(null);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fb = fillTo ? fillBand({ c0, c1, r0, r1 }, fillTo) : null;
  const inFill = (c: number, r: number) => !!fb && c >= fb.c0 && c <= fb.c1 && r >= fb.r0 && r <= fb.r1 && !(c >= c0 && c <= c1 && r >= r0 && r <= r1);

  const [freezeOpen, setFreezeOpen] = useState(false);
  const [condOpen, setCondOpen] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [namesOpen, setNamesOpen] = useState(false);
  const setFreeze = (rows: number, cols: number) => {
    patchSheet((sh) => (rows === 0 && cols === 0 ? { ...sh, freeze: undefined } : { ...sh, freeze: { rows, cols } }));
    setFreezeOpen(false);
  };

  // Sticky positioning for frozen cells. r = -1 denotes the column-header row.
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
    const sh: string[] = [];
    if (fcol && c === fz.cols - 1) sh.push("2px 0 0 var(--border-strong)");
    if (frow && r === fz.rows - 1) sh.push("0 2px 0 var(--border-strong)");
    if (sh.length) s.boxShadow = sh.join(", ");
    return s;
  };
  const rowheadStyle = (r: number): React.CSSProperties => {
    if (!fz || r >= fz.rows) return {};
    const s: React.CSSProperties = { position: "sticky", top: HEADER_H + r * ROW_H, zIndex: 5 };
    if (r === fz.rows - 1) s.boxShadow = "0 2px 0 var(--border-strong)";
    return s;
  };

  // --- selection & editing -------------------------------------------------
  // editingRef mirrors `editing` synchronously so commitEdit can't write twice
  // (Enter calls commitEdit then moveBy→selectCell→commitEdit in the same tick;
  // the stale `editing` closure used to write — and now record history — twice).
  const editingRef = useRef(false);
  const commitEdit = () => {
    if (editingRef.current) { writeCellAt(activeRef, draft); editingRef.current = false; }
    setEditing(false);
  };
  const cancelEdit = () => { editingRef.current = false; setEditing(false); };
  const focusGrid = () => requestAnimationFrame(() => gridRef.current?.focus());

  const selectCell = (c: number, r: number, extend = false) => {
    commitEdit();
    setSel({ c, r });
    if (!extend) setAnchor({ c, r });
  };

  const startEdit = (initialChar?: string) => {
    setDraft(initialChar !== undefined ? initialChar : sheet.cells[activeRef] ?? "");
    setAnchor(sel);
    editingRef.current = true;
    setEditing(true);
  };

  const moveBy = (dc: number, dr: number, extend = false) => {
    const c = Math.max(0, Math.min(sheet.cols - 1, sel.c + dc));
    const r = Math.max(0, Math.min(sheet.rows - 1, sel.r + dr));
    selectCell(c, r, extend);
  };

  // --- formatting ----------------------------------------------------------
  const applyStyle = (patch: Partial<CellStyle>) =>
    patchSheet((sh) => {
      const styles = { ...(sh.styles ?? {}) };
      for (const ref of rectRefs()) {
        const next: CellStyle = { ...styles[ref], ...patch };
        Object.keys(next).forEach((k) => next[k as keyof CellStyle] === undefined && delete next[k as keyof CellStyle]);
        if (Object.keys(next).length === 0) delete styles[ref];
        else styles[ref] = next;
      }
      return { ...sh, styles };
    });
  const activeStyle = sheet.styles?.[activeRef] ?? {};
  const toggle = (key: "bold" | "italic") => applyStyle({ [key]: !activeStyle[key] });
  const fontInputRef = useRef<HTMLInputElement>(null);
  const [fontTick, setFontTick] = useState(0);
  const importFont = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const name = f.name.replace(/\.(ttf|otf)$/i, "");
    registerCustomFont(name, new Uint8Array(await f.arrayBuffer()));
    setFontTick((t) => t + 1);
    applyStyle({ fontFamily: name });
  };

  const clearRange = () =>
    patchSheet((sh) => {
      const cells = { ...sh.cells };
      for (const ref of rectRefs()) delete cells[ref];
      return { ...sh, cells };
    });

  const copyRange = () => {
    const lines: string[] = [];
    for (let r = r0; r <= r1; r++) {
      if (!rowVisible(r)) continue; // a real AutoFilter copies visible rows only
      const row: string[] = [];
      for (let c = c0; c <= c1; c++) row.push(sheet.cells[cellRef(c, r)] ?? "");
      lines.push(row.join("\t"));
    }
    void navigator.clipboard?.writeText(lines.join("\n"));
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const text = e.clipboardData.getData("text");
    if (!text) return;
    if (editing && !text.includes("\t") && !text.includes("\n")) return; // single value in an input
    e.preventDefault();
    const rows = text.replace(/\r/g, "").split("\n");
    if (rows.length && rows[rows.length - 1] === "") rows.pop();
    const grid = rows.map((l) => l.split("\t"));
    cancelEdit();
    patchSheet((sh) => {
      const cells = { ...sh.cells };
      let cols = sh.cols, rws = sh.rows;
      grid.forEach((row, ri) =>
        row.forEach((val, ci) => {
          const ref = cellRef(sel.c + ci, sel.r + ri);
          if (val === "") delete cells[ref];
          else cells[ref] = val;
          cols = Math.max(cols, sel.c + ci + 1);
          rws = Math.max(rws, sel.r + ri + 1);
        }),
      );
      return { ...sh, cells, cols, rows: rws };
    });
  };

  // --- structural: insert / delete rows & columns --------------------------
  const reindex = (
    map: Record<string, string> | Record<string, CellStyle> | undefined,
    fn: (c: number, r: number) => Pos | null,
    transform?: (v: string) => string,
  ) => {
    const out: Record<string, string & CellStyle> = {} as Record<string, never>;
    if (!map) return out;
    for (const [ref, v] of Object.entries(map)) {
      const p = parseRef(ref);
      if (!p) continue;
      const np = fn(p.col, p.row);
      if (np) (out as Record<string, unknown>)[cellRef(np.c, np.r)] = transform && typeof v === "string" ? transform(v) : v;
    }
    return out;
  };
  const structural = (fn: (c: number, r: number) => Pos | null, dCols: number, dRows: number) =>
    patchSheet((sh) => {
      // The same position map that relocates cells also rewrites the references
      // inside surviving formulas, so =SUM(A1:A5) follows inserted/deleted rows.
      const refMap: RefMap = (col, row) => {
        const np = fn(col, row);
        return np ? { col: np.c, row: np.r } : null;
      };
      const rewrite = (v: string) => (v[0] === "=" ? rewriteRefs(v, refMap) : v);
      // Column widths are keyed by index, so they must shift with the columns.
      let colWidths: Record<number, number> | undefined;
      if (sh.colWidths) {
        colWidths = {};
        for (const [k, w] of Object.entries(sh.colWidths)) {
          const np = fn(Number(k), 0);
          if (np) colWidths[np.c] = w;
        }
      }
      return {
        ...sh,
        cols: Math.max(1, sh.cols + dCols),
        rows: Math.max(1, sh.rows + dRows),
        cells: reindex(sh.cells, fn, rewrite) as Record<string, string>,
        styles: reindex(sh.styles, fn) as Record<string, CellStyle>,
        colWidths,
      };
    });
  // After a structural op, keep the selection within the new bounds (deletes shrink the grid).
  const clampSel = (rows: number, cols: number) => {
    setSel((s) => ({ c: Math.min(s.c, cols - 1), r: Math.min(s.r, rows - 1) }));
    setAnchor((a) => ({ c: Math.min(a.c, cols - 1), r: Math.min(a.r, rows - 1) }));
  };
  const insertRow = () => structural((c, r) => ({ c, r: r >= sel.r ? r + 1 : r }), 0, 1);
  const deleteRow = () => { structural((c, r) => (r === sel.r ? null : { c, r: r > sel.r ? r - 1 : r }), 0, -1); clampSel(Math.max(1, sheet.rows - 1), sheet.cols); };
  const insertCol = () => structural((c, r) => ({ c: c >= sel.c ? c + 1 : c, r }), 1, 0);
  const deleteCol = () => { structural((c, r) => (c === sel.c ? null : { c: c > sel.c ? c - 1 : c, r }), -1, 0); clampSel(sheet.rows, Math.max(1, sheet.cols - 1)); };

  // --- keyboard (grid, not editing) ----------------------------------------
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (editing) return;
    const k = e.key;
    if (k === "ArrowUp") { moveBy(0, -1, e.shiftKey); e.preventDefault(); }
    else if (k === "ArrowDown") { moveBy(0, 1, e.shiftKey); e.preventDefault(); }
    else if (k === "ArrowLeft") { moveBy(-1, 0, e.shiftKey); e.preventDefault(); }
    else if (k === "ArrowRight") { moveBy(1, 0, e.shiftKey); e.preventDefault(); }
    else if (k === "Tab") { moveBy(1, 0); e.preventDefault(); }
    else if (k === "Enter") { moveBy(0, 1); e.preventDefault(); }
    else if (k === "F2") { startEdit(); e.preventDefault(); }
    else if (k === "Delete" || k === "Backspace") { clearRange(); e.preventDefault(); }
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "c") { copyRange(); }
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "x") { copyRange(); clearRange(); }
    else if (!e.ctrlKey && !e.metaKey && !e.altKey && k.length === 1) { startEdit(k); e.preventDefault(); }
  };

  const onEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); commitEdit(); moveBy(0, 1); focusGrid(); }
    else if (e.key === "Tab") { e.preventDefault(); commitEdit(); moveBy(1, 0); focusGrid(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); focusGrid(); }
  };

  // --- sheets, import/export ----------------------------------------------
  const addSheet = async () => {
    const name = await dialogs.prompt({ title: "Nouvelle feuille", label: "Nom de la feuille", defaultValue: `Feuille ${wb.sheets.length + 1}` });
    if (name === null) return;
    update((w) => ({ ...w, sheets: [...w.sheets, emptySheet(name.trim() || `Feuille ${w.sheets.length + 1}`)], active: w.sheets.length }));
    setSel({ c: 0, r: 0 });
    setAnchor({ c: 0, r: 0 });
  };
  const switchSheet = (i: number) => {
    commitEdit();
    update((w) => ({ ...w, active: i }));
    setSel({ c: 0, r: 0 });
    setAnchor({ c: 0, r: 0 });
  };
  // Rename a sheet (double-click its tab) and update every cross-sheet ref
  // (=Feuille2!A1) across the whole workbook so formulas keep resolving.
  const renameSheet = async (i: number) => {
    const cur = wb.sheets[i].name;
    const input = await dialogs.prompt({ title: "Renommer la feuille", label: "Nom de la feuille", defaultValue: cur });
    if (input === null) return;
    const next = input.trim();
    if (!next || next === cur) return;
    if (wb.sheets.some((s, k) => k !== i && s.name === next)) {
      await dialogs.alert({ title: "Nom déjà utilisé", message: `Une feuille nommée « ${next} » existe déjà.` });
      return;
    }
    update((w) => {
      const sheets = w.sheets.map((s) => {
        const cells: Record<string, string> = {};
        for (const [ref, v] of Object.entries(s.cells)) cells[ref] = v[0] === "=" ? renameSheetRefs(v, cur, next) : v;
        return { ...s, cells };
      });
      sheets[i] = { ...sheets[i], name: next };
      return { ...w, sheets };
    });
  };
  // Delete the active sheet, with a confirmation prompt (matches the
  // DialogsProvider pattern already used by renameSheet/applyFilter above).
  // A workbook must always keep at least one sheet — attempting to remove
  // the last one shows a clear error instead of silently doing nothing.
  const removeActiveSheet = async () => {
    if (wb.sheets.length <= 1) {
      await dialogs.alert({
        title: "Impossible de supprimer",
        message: "Un classeur doit toujours contenir au moins une feuille.",
      });
      return;
    }
    const name = wb.sheets[wb.active].name;
    const ok = await dialogs.confirm({
      title: "Supprimer la feuille",
      message: `Supprimer définitivement la feuille « ${name} » ? Cette action est irréversible.`,
      confirmLabel: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    update((w) => removeSheet(w, w.active) ?? w);
    setSel({ c: 0, r: 0 });
    setAnchor({ c: 0, r: 0 });
  };

  const exportCsv = () => {
    const c = createCalc((ref) => sheet.cells[ref], crossSheets, nameResolver);
    const lines: string[] = [];
    for (let r = 0; r < sheet.rows; r++) {
      if (!rowVisible(r)) continue; // export only the rows the filter shows
      const row: string[] = [];
      for (let col = 0; col < sheet.cols; col++) {
        const ref = cellRef(col, r);
        const disp = sheet.cells[ref] != null ? formatValue(c.valueOf(ref), sheet.styles?.[ref]?.fmt, c.display(ref)) : "";
        row.push(/[",\n]/.test(disp) ? `"${disp.replace(/"/g, '""')}"` : disp);
      }
      lines.push(row.join(","));
    }
    downloadBlob(`${sheet.name || "feuille"}.csv`, "text/csv;charset=utf-8", new TextEncoder().encode(lines.join("\r\n")));
  };
  const exportXlsx = () => {
    downloadBlob(
      "classeur.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      workbookToXlsx(wb),
    );
  };
  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const next = file.name.toLowerCase().endsWith(".csv") ? csvToWorkbook(await file.text()) : importXlsx(new Uint8Array(await file.arrayBuffer()));
      update(() => next);
      setSel({ c: 0, r: 0 });
      setAnchor({ c: 0, r: 0 });
    } catch {
      /* fichier illisible */
    }
  };
  const saveElium = async () => {
    const title = await dialogs.prompt({ title: "Enregistrer en .elium", label: "Nom du classeur", defaultValue: "Classeur" });
    if (title === null) return;
    onExportElium(wb, title);
  };

  const insertFn = (name: string) => {
    setDraft(`=${name}(`);
    setAnchor(sel);
    setEditing(true);
    setFxOpen(false);
  };

  // --- charts ---
  const chartData = (spec: ChartSpec) => {
    const oneCol = spec.c0 === spec.c1;
    const labels: string[] = [];
    const values: number[] = [];
    for (let r = spec.r0; r <= spec.r1; r++) {
      if (oneCol) {
        const v = calc.valueOf(cellRef(spec.c0, r));
        labels.push(String(r - spec.r0 + 1));
        values.push(typeof v === "number" ? v : Number(v) || 0);
      } else {
        const lab = calc.valueOf(cellRef(spec.c0, r));
        const val = calc.valueOf(cellRef(spec.c0 + 1, r));
        labels.push(typeof lab === "number" ? String(lab) : String(lab ?? ""));
        values.push(typeof val === "number" ? val : Number(val) || 0);
      }
    }
    return { labels, values };
  };
  const addChart = () => patchSheet((sh) => ({ ...sh, charts: [...(sh.charts ?? []), { id: newId("chart"), type: "bar", c0, r0, c1, r1 }] }));
  const removeChart = (id: string) => patchSheet((sh) => ({ ...sh, charts: (sh.charts ?? []).filter((c) => c.id !== id) }));
  const setChartType = (id: string, type: ChartType) => patchSheet((sh) => ({ ...sh, charts: (sh.charts ?? []).map((c) => (c.id === id ? { ...c, type } : c)) }));

  // --- sort: reorder rows by the active column (non-destructive) ---
  const sortRange = (dir: 1 | -1) =>
    patchSheet((sh) => {
      const has = (c: number, r: number) => (sh.cells[cellRef(c, r)] ?? "") !== "";
      // A single-cell selection sorts the whole contiguous block (so adjacent
      // columns travel with the keys and can't be desynchronised). An explicit
      // multi-cell selection is respected as-is.
      let C0 = c0, C1 = c1, R0 = r0, R1 = r1;
      if (c0 === c1 && r0 === r1) {
        let grew = true;
        while (grew) {
          grew = false;
          const colData = (c: number) => { for (let r = R0; r <= R1; r++) if (has(c, r)) return true; return false; };
          const rowData = (r: number) => { for (let c = C0; c <= C1; c++) if (has(c, r)) return true; return false; };
          if (C0 > 0 && colData(C0 - 1)) { C0--; grew = true; }
          if (C1 < sh.cols - 1 && colData(C1 + 1)) { C1++; grew = true; }
          if (R0 > 0 && rowData(R0 - 1)) { R0--; grew = true; }
          if (R1 < sh.rows - 1 && rowData(R1 + 1)) { R1++; grew = true; }
        }
      }
      // Skip a header row (non-numeric label above numeric data in the key column).
      let start = R0;
      const isNum = (x: string) => x !== "" && !Number.isNaN(Number(x));
      if (R1 > R0) {
        const k0 = sh.cells[cellRef(sel.c, R0)] ?? "";
        if (k0 !== "" && !isNum(k0) && isNum(sh.cells[cellRef(sel.c, R0 + 1)] ?? "")) start = R0 + 1;
      }
      const cells = { ...sh.cells };
      const styles = { ...(sh.styles ?? {}) };
      // Sort only the rows the filter shows (Excel behavior): hidden rows keep
      // their position. With no filter this is simply every row in [start, R1].
      const rowsIdx = visibleRowsInRange(sh.filter, (c, rr) => cellDisplay(cellRef(c, rr)), start, R1);
      const snap = rowsIdx.map((r) => {
        const row: Record<number, string | undefined> = {};
        const st: Record<number, CellStyle | undefined> = {};
        for (let c = C0; c <= C1; c++) { row[c] = sh.cells[cellRef(c, r)]; st[c] = sh.styles?.[cellRef(c, r)]; }
        return { key: sh.cells[cellRef(sel.c, r)] ?? "", row, st };
      });
      snap.sort((a, b) => {
        const an = Number(a.key), bn = Number(b.key);
        const bothNum = a.key !== "" && b.key !== "" && !Number.isNaN(an) && !Number.isNaN(bn);
        return (bothNum ? an - bn : a.key.localeCompare(b.key, "fr")) * dir;
      });
      // Reorder cells AND their per-cell styles together so formatting follows the data.
      rowsIdx.forEach((r, i) => {
        for (let c = C0; c <= C1; c++) {
          const ref = cellRef(c, r);
          const v = snap[i].row[c];
          if (v === undefined || v === "") delete cells[ref];
          else cells[ref] = v;
          const s = snap[i].st[c];
          if (s) styles[ref] = s;
          else delete styles[ref];
        }
      });
      return { ...sh, cells, styles };
    });

  // --- filter (view): hide rows whose active-column value doesn't match ---
  const applyFilter = async () => {
    const query = await dialogs.prompt({
      title: "Filtrer", label: `Colonne ${indexToCol(sel.c)} contient`, hint: "Laisser vide pour retirer le filtre.",
      defaultValue: sheet.filter?.query ?? "",
    });
    if (query === null) return;
    patchSheet((sh) => (query.trim() === "" ? { ...sh, filter: undefined } : { ...sh, filter: { col: sel.c, query: query.trim() } }));
  };
  const clearFilter = () => patchSheet((sh) => ({ ...sh, filter: undefined }));

  const cellDisplay = (ref: string) =>
    sheet.cells[ref] != null ? formatValue(calc.valueOf(ref), sheet.styles?.[ref]?.fmt, calc.display(ref)) : "";

  // Single source of truth for "is this row shown under the active filter?" —
  // reused by rendering, copy, CSV export and sort so the AutoFilter is real.
  const rowVisible = (r: number) => filterRowVisible(sheet.filter, (c, rr) => cellDisplay(cellRef(c, rr)), r);

  // --- conditional formatting ---
  const condFmt = useMemo(
    () => buildCondFormatter(
      sheet.condFormats,
      (c, r) => (sheet.cells[cellRef(c, r)] != null ? calc.valueOf(cellRef(c, r)) : ""),
      (c, r) => cellDisplay(cellRef(c, r)),
    ),
    [sheet, calc], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const addCondRule = (rule: Omit<CondRule, "id" | "c0" | "r0" | "c1" | "r1">) =>
    patchSheet((sh) => ({ ...sh, condFormats: [...(sh.condFormats ?? []), { ...rule, id: newId("cf"), c0, r0, c1, r1 }] }));
  const removeCondRule = (id: string) =>
    patchSheet((sh) => ({ ...sh, condFormats: (sh.condFormats ?? []).filter((r) => r.id !== id) }));

  // --- data validation (soft: invalid cells are flagged, not refused) ---
  const validator = useMemo(
    () => buildValidator(sheet.validations, (c, r) => sheet.cells[cellRef(c, r)] ?? ""),
    [sheet],
  );
  const addValidation = (v: Omit<DataValidation, "id" | "c0" | "r0" | "c1" | "r1">) =>
    patchSheet((sh) => ({ ...sh, validations: [...(sh.validations ?? []), { ...v, id: newId("dv"), c0, r0, c1, r1 }] }));
  const removeValidation = (id: string) =>
    patchSheet((sh) => ({ ...sh, validations: (sh.validations ?? []).filter((v) => v.id !== id) }));

  // --- named ranges (workbook-scoped) ---
  const absCell = (c: number, r: number) => `$${indexToCol(c)}$${r + 1}`;
  const addName = (name: string) => {
    const clean = name.trim();
    const single = c0 === c1 && r0 === r1;
    const ref = `${quoteSheetName(sheet.name)}!${single ? absCell(c0, r0) : `${absCell(c0, r0)}:${absCell(c1, r1)}`}`;
    update((w) => ({ ...w, names: [...(w.names ?? []).filter((n) => n.name.toUpperCase() !== clean.toUpperCase()), { name: clean, ref }] }));
  };
  const removeName = (name: string) =>
    update((w) => ({ ...w, names: (w.names ?? []).filter((n) => n.name !== name) }));

  return (
    <div className="sheet-app">
      <div className="sheet-bar">
        <button className="eb eb--sm eb--ghost" onClick={onHome} title="Accueil"><Home size={16} /> Accueil</button>
        <div className="brand brand--sm" aria-hidden><FileSpreadsheet size={18} /></div>
        <span className="sheet-bar__title"><Table2 size={16} /> Tableur</span>
        <div className="sheet-bar__spacer" />
        <button className="eb eb--sm eb--outline" onClick={() => fileRef.current?.click()}><Upload size={14} /> Importer</button>
        <button className="eb eb--sm eb--outline" onClick={exportCsv}><Download size={14} /> CSV</button>
        <button className="eb eb--sm eb--outline" onClick={exportXlsx}><Download size={14} /> XLSX</button>
        <button className="eb eb--sm eb--primary" onClick={saveElium}><Save size={14} /> .elium</button>
        <input ref={fileRef} type="file" accept=".xlsx,.csv" hidden onChange={onImportFile} />
      </div>

      <div className="sheet-format">
        <div className="tool-group">
          <button className="icon-btn" title="Annuler (Ctrl+Z)" onClick={undo} disabled={!canUndo}><Undo2 size={15} /></button>
          <button className="icon-btn" title="Rétablir (Ctrl+Y)" onClick={redo} disabled={!canRedo}><Redo2 size={15} /></button>
        </div>
        <div className="tool-group" style={{ position: "relative" }}>
          <button className={`icon-btn ${fxOpen ? "is-active" : ""}`} title="Bibliothèque de formules" onClick={() => setFxOpen((v) => !v)}><Sigma size={15} /></button>
          {fxOpen && (
            <div className="fx-panel">
              {["Maths", "Statistiques", "Recherche", "Logique", "Texte", "Date"].map((cat) => (
                <div key={cat} className="fx-cat">
                  <div className="fx-cat__title">{cat}</div>
                  {FUNCTIONS.filter((f) => f.cat === cat).map((f) => (
                    <button key={f.name} className="fx-item" onClick={() => insertFn(f.name)} title={f.desc}>
                      <span className="fx-item__sig">{f.sig}</span>
                      <span className="fx-item__desc">{f.desc}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="tool-group">
          <select key={`ff-${fontTick}`} className="tool-select" title="Police" value={activeStyle.fontFamily ?? DEFAULT_FONT} onChange={(e) => applyStyle({ fontFamily: e.target.value })}>
            {allFontNames().map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button className="icon-btn" title="Importer une police (.ttf/.otf)" onClick={() => fontInputRef.current?.click()}><Type size={15} /></button>
          <input ref={fontInputRef} type="file" accept=".ttf,.otf" hidden onChange={importFont} />
          <select className="tool-select tool-select--sm" title="Taille de police" value={activeStyle.fontSize ?? 13} onChange={(e) => applyStyle({ fontSize: Number(e.target.value) })}>
            {[8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div className="tool-group">
          <button className={`icon-btn ${activeStyle.bold ? "is-active" : ""}`} title="Gras" onClick={() => toggle("bold")}><Bold size={15} /></button>
          <button className={`icon-btn ${activeStyle.italic ? "is-active" : ""}`} title="Italique" onClick={() => toggle("italic")}><Italic size={15} /></button>
        </div>
        <div className="tool-group">
          <button className={`icon-btn ${activeStyle.align === "left" ? "is-active" : ""}`} title="Aligner à gauche" onClick={() => applyStyle({ align: "left" })}><AlignLeft size={15} /></button>
          <button className={`icon-btn ${activeStyle.align === "center" ? "is-active" : ""}`} title="Centrer" onClick={() => applyStyle({ align: "center" })}><AlignCenter size={15} /></button>
          <button className={`icon-btn ${activeStyle.align === "right" ? "is-active" : ""}`} title="Aligner à droite" onClick={() => applyStyle({ align: "right" })}><AlignRight size={15} /></button>
        </div>
        <div className="tool-group">
          <label className="tool-color" title="Couleur du texte"><Baseline size={15} /><input type="color" value={activeStyle.color ?? "#0f172a"} onChange={(e) => applyStyle({ color: e.target.value })} /></label>
          <label className="tool-color" title="Couleur de remplissage"><PaintBucket size={15} /><input type="color" value={activeStyle.fill ?? "#ffffff"} onChange={(e) => applyStyle({ fill: e.target.value })} /></label>
        </div>
        <div className="tool-group">
          <select className="tool-select" title="Format des nombres" value={activeStyle.fmt ?? "general"} onChange={(e) => applyStyle({ fmt: e.target.value as NumFmt })}>
            {NUM_FORMATS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </div>
        <div className="tool-group">
          <button className="icon-btn" title="Insérer une ligne" onClick={insertRow}><Plus size={15} /></button>
          <button className="icon-btn" title="Supprimer la ligne" onClick={deleteRow}><Minus size={15} /></button>
          <button className="icon-btn" title="Insérer une colonne" onClick={insertCol}><Plus size={15} style={{ transform: "rotate(90deg)" }} /></button>
          <button className="icon-btn" title="Supprimer la colonne" onClick={deleteCol}><Minus size={15} style={{ transform: "rotate(90deg)" }} /></button>
        </div>
        <div className="tool-group">
          <button className="icon-btn" title="Insérer un graphique (depuis la sélection)" onClick={addChart}><BarChart3 size={15} /></button>
          <button className="icon-btn" title="Trier croissant (colonne active)" onClick={() => sortRange(1)}><ArrowUpNarrowWide size={15} /></button>
          <button className="icon-btn" title="Trier décroissant (colonne active)" onClick={() => sortRange(-1)}><ArrowDownNarrowWide size={15} /></button>
          <button className={`icon-btn ${sheet.filter ? "is-active" : ""}`} title="Filtrer (colonne active)" onClick={applyFilter}><Filter size={15} /></button>
        </div>
        <div className="tool-group" style={{ position: "relative" }}>
          <button className={`icon-btn ${fz ? "is-active" : ""}`} title="Figer les volets" onClick={() => setFreezeOpen((v) => !v)}><Snowflake size={15} /></button>
          {freezeOpen && (
            <div className="fx-panel fx-panel--menu">
              <button className="fx-menu-item" onClick={() => setFreeze(sel.r + 1, fz?.cols ?? 0)}>Figer jusqu'à la ligne {sel.r + 1}</button>
              <button className="fx-menu-item" onClick={() => setFreeze(fz?.rows ?? 0, sel.c + 1)}>Figer jusqu'à la colonne {indexToCol(sel.c)}</button>
              <button className="fx-menu-item" onClick={() => setFreeze(sel.r + 1, sel.c + 1)}>Figer lignes + colonnes (sélection)</button>
              <button className="fx-menu-item" onClick={() => setFreeze(0, 0)} disabled={!fz}>Libérer les volets</button>
            </div>
          )}
        </div>
        <div className="tool-group">
          <button className={`icon-btn ${(sheet.condFormats?.length ?? 0) > 0 ? "is-active" : ""}`} title="Mise en forme conditionnelle" onClick={() => setCondOpen(true)}><Palette size={15} /></button>
          <button className={`icon-btn ${(sheet.validations?.length ?? 0) > 0 ? "is-active" : ""}`} title="Validation des données" onClick={() => setValidationOpen(true)}><ListChecks size={15} /></button>
          <button className={`icon-btn ${(wb.names?.length ?? 0) > 0 ? "is-active" : ""}`} title="Plages nommées" onClick={() => setNamesOpen(true)}><Tag size={15} /></button>
          <button
            className="icon-btn"
            title="Fusionner / annuler la fusion des cellules sélectionnées"
            onClick={() => patchSheet((sh) => ({ ...sh, merges: toggleMerge(sh.merges, { c0, r0, c1, r1 }) }))}
          >
            <Combine size={15} />
          </button>
        </div>
        {sheet.filter && (
          <span className="sheet-filter-chip">
            Filtre : {indexToCol(sheet.filter.col)} ⊃ «&nbsp;{sheet.filter.query}&nbsp;»
            <button className="icon-btn" title="Retirer le filtre" onClick={clearFilter}><X size={13} /></button>
          </span>
        )}
      </div>

      <div className="sheet-formula">
        <span className="sheet-formula__ref">{activeRef}</span>
        <input
          className="sheet-formula__input"
          value={editing ? draft : sheet.cells[activeRef] ?? ""}
          placeholder="Valeur ou =formule (ex. =SUM(A1:A5))"
          onChange={(e) => { if (!editing) { editingRef.current = true; setEditing(true); } setDraft(e.target.value); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); commitEdit(); moveBy(0, 1); }
            else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
          }}
          onPaste={onPaste}
        />
      </div>

      <div className="sheet-grid-wrap" ref={gridRef} tabIndex={0} onKeyDown={onGridKeyDown} onPaste={onPaste}>
        <table className="sheet-grid">
          <colgroup>
            <col style={{ width: ROWHEAD_W }} />
            {Array.from({ length: sheet.cols }, (_, c) => <col key={c} style={{ width: colWidth(c) }} />)}
          </colgroup>
          <thead>
            <tr>
              <th className="sheet-corner" style={fz ? { zIndex: 7 } : undefined} />
              {Array.from({ length: sheet.cols }, (_, c) => (
                <th key={c} className={c >= c0 && c <= c1 ? "is-hl" : ""} style={stickyStyle(c, -1)}>
                  {indexToCol(c)}
                  <span className="col-resize" onMouseDown={(e) => startResize(c, e)} title="Redimensionner" />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: sheet.rows }, (_, r) => {
              const hidden = !rowVisible(r);
              return (
              <tr key={r} style={hidden ? { display: "none" } : undefined}>
                <th className={`sheet-rowhead ${r >= r0 && r <= r1 ? "is-hl" : ""}`} style={rowheadStyle(r)}>{r + 1}</th>
                {Array.from({ length: sheet.cols }, (_, c) => {
                  const ref = cellRef(c, r);
                  if (isCovered(sheet.merges, c, r)) return null; // hidden by a merge (origin cell spans it)
                  const span = spanAt(sheet.merges, c, r);
                  const st = sheet.styles?.[ref];
                  const active = sel.c === c && sel.r === r;
                  if (active && editing) {
                    const dv = validationAt(sheet.validations, c, r);
                    const listId = dv?.type === "list" && dv.list?.length ? `dv-list-${c}-${r}` : undefined;
                    return (
                      <td key={c} className="is-selected" style={stickyStyle(c, r)} colSpan={span?.colSpan} rowSpan={span?.rowSpan}>
                        <input
                          className="sheet-cell-input"
                          autoFocus
                          value={draft}
                          list={listId}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={onEditKeyDown}
                          onFocus={(e) => e.target.select()}
                          onBlur={commitEdit}
                          onPaste={onPaste}
                        />
                        {listId && (
                          <datalist id={listId}>
                            {dv!.list!.map((opt) => <option key={opt} value={opt} />)}
                          </datalist>
                        )}
                      </td>
                    );
                  }
                  const val = sheet.cells[ref] != null ? calc.valueOf(ref) : "";
                  const numeric = typeof val === "number";
                  const invalid = validator(c, r);
                  const cls = [
                    inSel(c, r) ? (active ? "is-selected" : "is-range") : "",
                    inFill(c, r) ? "is-fill" : "",
                    isError(val) ? "is-err" : "",
                    numeric && !st?.align ? "is-num" : "",
                    invalid ? "is-invalid" : "",
                  ].filter(Boolean).join(" ");
                  const showHandle = c === c1 && r === r1 && !editing;
                  const cf = condFmt(c, r);
                  const cellStyle: React.CSSProperties = {
                    fontWeight: cf.fontWeight ?? (st?.bold ? 700 : undefined),
                    fontStyle: st?.italic ? "italic" : undefined,
                    textAlign: st?.align,
                    color: cf.color ?? st?.color,
                    background: cf.background ?? st?.fill,
                    fontFamily: st?.fontFamily ? fontCss(st.fontFamily) : undefined,
                    fontSize: st?.fontSize ? `${st.fontSize}px` : undefined,
                    ...stickyStyle(c, r),
                  };
                  return (
                    <td
                      key={c}
                      className={cls}
                      style={cellStyle}
                      title={invalid ?? undefined}
                      colSpan={span?.colSpan}
                      rowSpan={span?.rowSpan}
                      onMouseDown={(e) => { selectCell(c, r, e.shiftKey); dragging.current = true; gridRef.current?.focus(); }}
                      onMouseEnter={() => { if (fillRef.current) { fillToRef.current = { c, r }; setFillTo({ c, r }); } else if (dragging.current) setSel({ c, r }); }}
                      onDoubleClick={() => { selectCell(c, r); startEdit(); }}
                    >
                      {cellDisplay(ref)}
                      {showHandle && <span className="sheet-fill-handle" onMouseDown={startFill} title="Recopier (poignée de remplissage)" />}
                    </td>
                  );
                })}
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {(sheet.charts?.length ?? 0) > 0 && (
        <div className="sheet-charts">
          {sheet.charts!.map((ch) => {
            const { labels, values } = chartData(ch);
            return (
              <div key={ch.id} className="sheet-chart">
                <div className="sheet-chart__head">
                  <select className="tool-select tool-select--sm" value={ch.type} onChange={(e) => setChartType(ch.id, e.target.value as ChartType)}>
                    <option value="bar">Barres</option>
                    <option value="line">Lignes</option>
                    <option value="pie">Secteurs</option>
                  </select>
                  <span className="sheet-chart__range">{cellRef(ch.c0, ch.r0)}:{cellRef(ch.c1, ch.r1)}</span>
                  <button className="icon-btn icon-btn--danger" title="Supprimer le graphique" onClick={() => removeChart(ch.id)}><X size={14} /></button>
                </div>
                <SheetChart type={ch.type} labels={labels} values={values} />
              </div>
            );
          })}
        </div>
      )}

      <div className="sheet-tabs">
        {wb.sheets.map((s, i) => (
          <button
            key={i}
            className={`sheet-tab ${i === wb.active ? "is-active" : ""}`}
            onClick={() => switchSheet(i)}
            onDoubleClick={() => renameSheet(i)}
            title="Double-cliquer pour renommer"
          >
            {s.name}
          </button>
        ))}
        <button className="sheet-tab sheet-tab--add" onClick={addSheet} title="Ajouter une feuille"><Plus size={14} /></button>
        <button className="sheet-tab sheet-tab--add" onClick={removeActiveSheet} title="Supprimer la feuille"><Trash2 size={14} /></button>
      </div>

      {condOpen && (
        <CondFormatModal
          rangeLabel={`${cellRef(c0, r0)}:${cellRef(c1, r1)}`}
          rules={sheet.condFormats ?? []}
          onAdd={addCondRule}
          onRemove={removeCondRule}
          onClose={() => setCondOpen(false)}
        />
      )}

      {validationOpen && (
        <ValidationModal
          rangeLabel={`${cellRef(c0, r0)}:${cellRef(c1, r1)}`}
          validations={sheet.validations ?? []}
          onAdd={addValidation}
          onRemove={removeValidation}
          onClose={() => setValidationOpen(false)}
        />
      )}

      {namesOpen && (
        <NamedRangesModal
          rangeLabel={`${quoteSheetName(sheet.name)}!${cellRef(c0, r0)}:${cellRef(c1, r1)}`}
          names={wb.names ?? []}
          onAdd={addName}
          onRemove={removeName}
          onClose={() => setNamesOpen(false)}
        />
      )}
    </div>
  );
}
