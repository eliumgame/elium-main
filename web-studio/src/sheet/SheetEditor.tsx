/**
 * SheetEditor — l'UNIQUE surface d'édition du Tableur, partagée par la suite
 * locale et le Tableur collaboratif Drive. Il rend la grille, la barre de mise en
 * forme, la barre de formule, les onglets de feuilles, les graphiques et les
 * fenêtres de configuration, pilotés UNIQUEMENT par un `SheetStore` (voir
 * store.ts). L'état d'IHM propre à l'utilisateur (sélection/ancre, saisie en
 * cours, menus/fenêtres ouverts, poignée de recopie, redimensionnement de
 * colonne, copier/couper/coller, clavier) vit ici ; les données + mutations
 * vivent dans le store. Le chrome de la coque (page vs. modale, exports,
 * statut/pairs) est injecté via `chrome`. Quand `store.collaborative`, la présence
 * des pairs (surbrillance de cellule) est rendue depuis `store.presence` ; quand
 * `!store.canWrite`, la barre d'outils de mutation est masquée (lecture seule).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Home,
  Plus,
  Minus,
  Upload,
  Table2,
  Bold,
  Italic,
  AlignLeft,
  AlignCenter,
  AlignRight,
  Baseline,
  PaintBucket,
  Sigma,
  BarChart3,
  ArrowUpNarrowWide,
  ArrowDownNarrowWide,
  Filter,
  X,
  Snowflake,
  Palette,
  Undo2,
  Redo2,
  Type,
  Trash2,
  ListChecks,
  Tag,
  Combine,
  TableProperties,
  Grid3x3,
  Eraser,
} from "lucide-react";
import { fontCss, allFontNames, registerCustomFont, DEFAULT_FONT } from "../ui/fonts";
import { useDialogs } from "../ui/dialogs";
import { createCalc, indexToCol, isError, quoteSheetName, FUNCTIONS } from "./formula";
import { formatValue, NUM_FORMATS } from "./format";
import SheetChart from "./SheetChart";
import CondFormatModal from "./CondFormatModal";
import ValidationModal from "./ValidationModal";
import NamedRangesModal from "./NamedRangesModal";
import PivotModal from "./PivotModal";
import { computePivot, pivotToSheet, type PivotConfig, type PivotInput } from "./pivot";
import { buildCondFormatter } from "./condformat";
import { buildValidator, validationAt } from "./validation";
import { isCovered, spanAt } from "./merges";
import { rowVisible as filterRowVisible } from "./filter";
import { importXlsx } from "./xlsx-import";
import { csvToWorkbook } from "./csv";
import {
  newId,
  type CellStyle,
  type BorderSide,
  type NumFmt,
  type ChartSpec,
  type ChartType,
  type CondRule,
  type DataValidation,
} from "./model";
import type { Rect } from "./structural";
import type { SheetStore, SheetEditorChrome } from "./store";

type Pos = { c: number; r: number };
const cellRef = (c: number, r: number) => indexToCol(c) + (r + 1);
const absCell = (c: number, r: number) => `$${indexToCol(c)}$${r + 1}`;
const BORDER_WIDTH: Record<BorderSide["style"], number> = {
  thin: 1,
  medium: 2,
  thick: 3,
  dashed: 1,
  dotted: 1,
  double: 3,
};
const BORDER_LINE: Record<BorderSide["style"], string> = {
  thin: "solid",
  medium: "solid",
  thick: "solid",
  dashed: "dashed",
  dotted: "dotted",
  double: "double",
};
const borderCss = (s?: BorderSide): string | undefined =>
  s ? `${BORDER_WIDTH[s.style]}px ${BORDER_LINE[s.style]} ${s.color ?? "#0f172a"}` : undefined;

const ROWHEAD_W = 44; // largeur de la colonne des numéros de ligne (px)
const HEADER_H = 28; // hauteur de la ligne d'en-tête des colonnes (doit correspondre au CSS)
const ROW_H = 28; // hauteur d'une ligne de données (doit correspondre au CSS)
const DEFAULT_COL_W = 96; // largeur de colonne par défaut (px)

// Le ruban partage le langage visuel de Documents/PDF (`.elx-*`, voir
// src/ui/workspace.css) : chrome sombre et dense au-dessus de la feuille
// claire. `Group`/`Cmd` reprennent les mêmes petits composants locaux que
// editor/Toolbar.tsx et pdf/ui/Ribbon.tsx — pas de composant partagé, chaque
// module cadre ses propres commandes.
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="elx-group">
      <div className="elx-group__items">{children}</div>
      <div className="elx-group__title">{title}</div>
    </div>
  );
}

function Cmd({
  icon,
  label,
  onClick,
  active,
  disabled,
  title,
}: {
  icon: React.ReactNode;
  label?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      type="button"
      className={`elx-cmd ${active ? "is-active" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={active}
    >
      <span className="elx-cmd__icon">{icon}</span>
      {label && <span className="elx-cmd__label">{label}</span>}
    </button>
  );
}

export default function SheetEditor({ store, chrome }: { store: SheetStore; chrome: SheetEditorChrome }) {
  const { wb, active, canWrite, collaborative } = store;
  const dialogs = useDialogs();

  const [sel, setSel] = useState<Pos>({ c: 0, r: 0 });
  const [anchor, setAnchor] = useState<Pos>({ c: 0, r: 0 });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [fxOpen, setFxOpen] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [condOpen, setCondOpen] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [namesOpen, setNamesOpen] = useState(false);
  const [pivotOpen, setPivotOpen] = useState(false);
  const [fontTick, setFontTick] = useState(0);

  const editingRef = useRef(false);
  const dragging = useRef(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);

  // Refs stables pour les écouteurs globaux (évitent les fermetures périmées et
  // le ré-abonnement à chaque rendu ; `store` est un nouvel objet à chaque rendu).
  const storeRef = useRef(store);
  storeRef.current = store;
  const activeIdxRef = useRef(active);
  activeIdxRef.current = active;

  const sheet = wb.sheets[active];
  const peers = collaborative ? (store.presence?.peers ?? []) : [];

  // Moteur de formules (résolution des plages nommées + références croisées).
  const calc = useMemo(() => {
    const byName: Record<string, (typeof wb.sheets)[number]> = {};
    for (const s of wb.sheets) byName[s.name] = s;
    const cur = wb.sheets[active];
    const nameMap = new Map((wb.names ?? []).map((n) => [n.name.toUpperCase(), n.ref]));
    return createCalc(
      (ref) => cur?.cells[ref],
      { getSheetRaw: (name, ref) => byName[name]?.cells[ref], hasSheet: (name) => name in byName },
      nameMap.size ? (name: string) => nameMap.get(name) : undefined,
    );
  }, [wb, active]);

  const activeRef = cellRef(sel.c, sel.r);
  const r0 = Math.min(anchor.r, sel.r),
    r1 = Math.max(anchor.r, sel.r);
  const c0 = Math.min(anchor.c, sel.c),
    c1 = Math.max(anchor.c, sel.c);
  const selRect: Rect = { c0, c1, r0, r1 };
  const inSel = (c: number, r: number) => c >= c0 && c <= c1 && r >= r0 && r <= r1;
  const rectRefs = (): string[] => {
    const refs: string[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) refs.push(cellRef(c, r));
    return refs;
  };

  const cellDisplay = (ref: string): string =>
    sheet?.cells[ref] != null ? formatValue(calc.valueOf(ref), sheet.styles?.[ref]?.fmt, calc.display(ref)) : "";

  // Source unique de vérité pour « cette ligne est-elle visible sous le filtre ? »
  const rowVisible = (r: number) => filterRowVisible(sheet?.filter, (c, rr) => cellDisplay(cellRef(c, rr)), r);

  const condFmt = useMemo(
    () =>
      buildCondFormatter(
        sheet?.condFormats,
        (c, r) => (sheet?.cells[cellRef(c, r)] != null ? calc.valueOf(cellRef(c, r)) : ""),
        (c, r) => cellDisplay(cellRef(c, r)),
      ),
    [sheet, calc], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const validator = useMemo(
    () => buildValidator(sheet?.validations, (c, r) => sheet?.cells[cellRef(c, r)] ?? ""),
    [sheet],
  );

  // --- largeurs de colonnes & volets figés ---------------------------------
  const resizeRef = useRef<{ col: number; startX: number; startW: number; w: number } | null>(null);
  const [resizePreview, setResizePreview] = useState<{ col: number; w: number } | null>(null);
  const colWidth = (c: number) => sheet?.colWidths?.[c] ?? DEFAULT_COL_W;
  const shownWidth = (c: number) => (resizePreview?.col === c ? resizePreview.w : colWidth(c));
  const colLeft = (c: number) => {
    let x = ROWHEAD_W;
    for (let k = 0; k < c; k++) x += shownWidth(k);
    return x;
  };
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

  const startResize = (c: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = { col: c, startX: e.clientX, startW: colWidth(c), w: colWidth(c) };
    document.body.style.cursor = "col-resize";
  };
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const rz = resizeRef.current;
      if (!rz) return;
      const w = Math.max(40, Math.round(rz.startW + (e.clientX - rz.startX)));
      rz.w = w;
      setResizePreview({ col: rz.col, w });
    };
    const up = () => {
      const rz = resizeRef.current;
      if (!rz) return;
      storeRef.current.setColWidth(activeIdxRef.current, rz.col, rz.w);
      resizeRef.current = null;
      setResizePreview(null);
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  // --- poignée de recopie (fill handle) ------------------------------------
  const fillSrcRef = useRef<Rect | null>(null);
  const fillToRef = useRef<Pos | null>(null);
  const [fillTo, setFillTo] = useState<Pos | null>(null);
  const startFill = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fillSrcRef.current = { c0, c1, r0, r1 };
    fillToRef.current = { c: c1, r: r1 };
    setFillTo({ c: c1, r: r1 });
  };
  useEffect(() => {
    const up = () => {
      const src = fillSrcRef.current,
        to = fillToRef.current;
      if (src && to) storeRef.current.fillRange(activeIdxRef.current, src, { c: to.c, r: to.r });
      fillSrcRef.current = null;
      fillToRef.current = null;
      setFillTo(null);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);
  const fillBand = (src: Rect, to: Pos): Rect | null => {
    const overR = to.r > src.r1 ? to.r - src.r1 : to.r < src.r0 ? to.r - src.r0 : 0;
    const overC = to.c > src.c1 ? to.c - src.c1 : to.c < src.c0 ? to.c - src.c0 : 0;
    if (Math.abs(overR) >= Math.abs(overC) && overR !== 0)
      return { c0: src.c0, c1: src.c1, r0: Math.min(src.r0, to.r), r1: Math.max(src.r1, to.r) };
    if (overC !== 0) return { c0: Math.min(src.c0, to.c), c1: Math.max(src.c1, to.c), r0: src.r0, r1: src.r1 };
    return null;
  };
  const fb = fillTo ? fillBand({ c0, c1, r0, r1 }, fillTo) : null;
  const inFill = (c: number, r: number) => !!fb && c >= fb.c0 && c <= fb.c1 && r >= fb.r0 && r <= fb.r1 && !inSel(c, r);

  // --- glissé de sélection --------------------------------------------------
  useEffect(() => {
    const up = () => (dragging.current = false);
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, []);

  // Annuler / rétablir (Ctrl+Z / Ctrl+Y / Ctrl+Maj+Z), sauf si une saisie a le focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const k = e.key.toLowerCase();
      if (k === "z" && !e.shiftKey) {
        e.preventDefault();
        storeRef.current.undo?.();
      } else if (k === "y" || (k === "z" && e.shiftKey)) {
        e.preventDefault();
        storeRef.current.redo?.();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Présence : publie la cellule sélectionnée (backend collab uniquement).
  useEffect(() => {
    storeRef.current.setPresence?.(active, cellRef(sel.c, sel.r));
  }, [active, sel.c, sel.r]);

  // --- édition & sélection --------------------------------------------------
  const commitEdit = () => {
    if (editingRef.current) {
      store.setCell(active, activeRef, draft);
      editingRef.current = false;
    }
    setEditing(false);
  };
  const cancelEdit = () => {
    editingRef.current = false;
    setEditing(false);
  };
  const focusGrid = () => requestAnimationFrame(() => gridRef.current?.focus());

  const selectCell = (c: number, r: number, extend = false) => {
    commitEdit();
    setSel({ c, r });
    if (!extend) setAnchor({ c, r });
  };
  const startEdit = (initialChar?: string) => {
    if (!canWrite) return;
    setDraft(initialChar !== undefined ? initialChar : (sheet?.cells[activeRef] ?? ""));
    setAnchor(sel);
    editingRef.current = true;
    setEditing(true);
  };
  const moveBy = (dc: number, dr: number, extend = false) => {
    if (!sheet) return;
    const c = Math.max(0, Math.min(sheet.cols - 1, sel.c + dc));
    const r = Math.max(0, Math.min(sheet.rows - 1, sel.r + dr));
    selectCell(c, r, extend);
  };

  // --- mise en forme --------------------------------------------------------
  const applyStyle = (patch: Partial<CellStyle>) => store.applyStyle(active, rectRefs(), patch);
  const activeStyle = sheet?.styles?.[activeRef] ?? {};
  const toggle = (key: "bold" | "italic") => applyStyle({ [key]: !activeStyle[key] });
  const THIN_BORDER: BorderSide = { style: "thin", color: "#0f172a" };
  const setBorderAll = () =>
    applyStyle({ border: { top: THIN_BORDER, right: THIN_BORDER, bottom: THIN_BORDER, left: THIN_BORDER } });
  const clearBorder = () => applyStyle({ border: undefined });
  const importFont = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const name = f.name.replace(/\.(ttf|otf)$/i, "");
    registerCustomFont(name, new Uint8Array(await f.arrayBuffer()));
    setFontTick((t) => t + 1);
    applyStyle({ fontFamily: name });
  };
  const clearRange = () => store.clearRange(active, selRect);

  // --- copier / couper / coller --------------------------------------------
  const copyRange = () => {
    if (!sheet) return;
    const lines: string[] = [];
    for (let r = r0; r <= r1; r++) {
      if (!rowVisible(r)) continue; // un vrai AutoFilter ne copie que les lignes visibles
      const row: string[] = [];
      for (let c = c0; c <= c1; c++) row.push(sheet.cells[cellRef(c, r)] ?? "");
      lines.push(row.join("\t"));
    }
    void navigator.clipboard?.writeText(lines.join("\n"));
  };
  const onPaste = (e: React.ClipboardEvent) => {
    if (!canWrite) return;
    const text = e.clipboardData.getData("text");
    if (!text) return;
    if (editing && !text.includes("\t") && !text.includes("\n")) return; // valeur simple dans un champ
    e.preventDefault();
    const rows = text.replace(/\r/g, "").split("\n");
    if (rows.length && rows[rows.length - 1] === "") rows.pop();
    const grid = rows.map((l) => l.split("\t"));
    cancelEdit();
    store.pasteBlock(active, sel.r, sel.c, grid);
  };

  // --- structure : insertion / suppression de lignes & colonnes -------------
  const clampSel = (rows: number, cols: number) => {
    setSel((s) => ({ c: Math.min(s.c, cols - 1), r: Math.min(s.r, rows - 1) }));
    setAnchor((a) => ({ c: Math.min(a.c, cols - 1), r: Math.min(a.r, rows - 1) }));
  };
  const insertRow = () => store.insertRow(active, sel.r);
  const deleteRow = () => {
    store.deleteRow(active, sel.r);
    if (sheet) clampSel(Math.max(1, sheet.rows - 1), sheet.cols);
  };
  const insertCol = () => store.insertCol(active, sel.c);
  const deleteCol = () => {
    store.deleteCol(active, sel.c);
    if (sheet) clampSel(sheet.rows, Math.max(1, sheet.cols - 1));
  };

  // --- clavier (grille, hors édition) --------------------------------------
  const onGridKeyDown = (e: React.KeyboardEvent) => {
    if (editing || !sheet) return;
    const k = e.key;
    if (k === "ArrowUp") {
      moveBy(0, -1, e.shiftKey);
      e.preventDefault();
    } else if (k === "ArrowDown") {
      moveBy(0, 1, e.shiftKey);
      e.preventDefault();
    } else if (k === "ArrowLeft") {
      moveBy(-1, 0, e.shiftKey);
      e.preventDefault();
    } else if (k === "ArrowRight") {
      moveBy(1, 0, e.shiftKey);
      e.preventDefault();
    } else if (k === "Tab") {
      moveBy(1, 0);
      e.preventDefault();
    } else if (k === "Enter") {
      moveBy(0, 1);
      e.preventDefault();
    } else if (k === "F2") {
      startEdit();
      e.preventDefault();
    } else if (k === "Delete" || k === "Backspace") {
      if (canWrite) clearRange();
      e.preventDefault();
    } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "c") {
      copyRange();
    } else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "x") {
      if (canWrite) {
        copyRange();
        clearRange();
      }
    } else if (!e.ctrlKey && !e.metaKey && !e.altKey && k.length === 1) {
      startEdit(k);
      e.preventDefault();
    }
  };
  const onEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitEdit();
      moveBy(0, 1);
      focusGrid();
    } else if (e.key === "Tab") {
      e.preventDefault();
      commitEdit();
      moveBy(1, 0);
      focusGrid();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
      focusGrid();
    }
  };

  // --- feuilles -------------------------------------------------------------
  const switchSheet = (i: number) => {
    commitEdit();
    store.setActive(i);
    setSel({ c: 0, r: 0 });
    setAnchor({ c: 0, r: 0 });
  };
  const addSheetPrompt = async () => {
    const name = await dialogs.prompt({
      title: "Nouvelle feuille",
      label: "Nom de la feuille",
      defaultValue: `Feuille ${wb.sheets.length + 1}`,
    });
    if (name === null) return;
    store.addSheet(name);
    setSel({ c: 0, r: 0 });
    setAnchor({ c: 0, r: 0 });
  };
  const renameSheetPrompt = async (i: number) => {
    const cur = wb.sheets[i]!.name;
    const input = await dialogs.prompt({ title: "Renommer la feuille", label: "Nom de la feuille", defaultValue: cur });
    if (input === null) return;
    const next = input.trim();
    if (!next || next === cur) return;
    if (wb.sheets.some((s, k) => k !== i && s.name === next)) {
      await dialogs.alert({ title: "Nom déjà utilisé", message: `Une feuille nommée « ${next} » existe déjà.` });
      return;
    }
    store.renameSheet(i, next);
  };
  const removeActiveSheet = async () => {
    if (wb.sheets.length <= 1) {
      await dialogs.alert({
        title: "Impossible de supprimer",
        message: "Un classeur doit toujours contenir au moins une feuille.",
      });
      return;
    }
    const name = wb.sheets[active]!.name;
    const ok = await dialogs.confirm({
      title: "Supprimer la feuille",
      message: `Supprimer définitivement la feuille « ${name} » ? Cette action est irréversible.`,
      confirmLabel: "Supprimer",
      danger: true,
    });
    if (!ok) return;
    store.removeSheet(active);
    setSel({ c: 0, r: 0 });
    setAnchor({ c: 0, r: 0 });
  };

  // --- import XLSX / CSV (mutation → dans le document, local comme collab) ---
  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !store.replaceWorkbook) return;
    try {
      const next = file.name.toLowerCase().endsWith(".csv")
        ? csvToWorkbook(await file.text())
        : importXlsx(new Uint8Array(await file.arrayBuffer()));
      store.replaceWorkbook(next);
      setSel({ c: 0, r: 0 });
      setAnchor({ c: 0, r: 0 });
    } catch {
      /* fichier illisible — on n'écrase rien */
    }
  };

  // --- bibliothèque de formules --------------------------------------------
  const insertFn = (name: string) => {
    setDraft(`=${name}(`);
    setAnchor(sel);
    editingRef.current = true;
    setEditing(true);
    setFxOpen(false);
  };

  // --- freeze (4 options, comme la suite locale) ----------------------------
  const setFreeze = (rows: number, cols: number) => {
    store.setFreeze(active, rows, cols);
    setFreezeOpen(false);
  };

  // --- filtre (vue) ---------------------------------------------------------
  const applyFilter = async () => {
    const query = await dialogs.prompt({
      title: "Filtrer",
      label: `Colonne ${indexToCol(sel.c)} contient`,
      hint: "Laisser vide pour retirer le filtre.",
      defaultValue: sheet?.filter?.query ?? "",
    });
    if (query === null) return;
    store.setFilter(active, sel.c, query);
  };
  const clearFilter = () => {
    if (sheet?.filter) store.setFilter(active, sheet.filter.col, "");
  };

  // --- graphiques -----------------------------------------------------------
  // A chart's source rectangle (c0,r0)-(c1,r1): a single column (c0===c1) is one
  // unnamed series with no category axis; a wider rectangle treats column c0 as
  // the shared category axis and EVERY remaining column (c0+1..c1) as its own
  // series — so a 3+ column selection charts all of them, not just the first.
  const chartData = (spec: ChartSpec): { labels: string[]; series: { label: string; values: number[] }[] } => {
    const oneCol = spec.c0 === spec.c1;
    const labels: string[] = [];
    for (let r = spec.r0; r <= spec.r1; r++) {
      if (oneCol) {
        labels.push(String(r - spec.r0 + 1));
      } else {
        const lab = calc.valueOf(cellRef(spec.c0, r));
        labels.push(typeof lab === "number" ? String(lab) : String(lab ?? ""));
      }
    }
    const valCols = oneCol ? [spec.c0] : [];
    if (!oneCol) for (let c = spec.c0 + 1; c <= spec.c1; c++) valCols.push(c);
    const series = valCols.map((col) => ({
      label: oneCol ? "Série 1" : `Colonne ${indexToCol(col)}`,
      values: Array.from({ length: spec.r1 - spec.r0 + 1 }, (_, i) => {
        const v = calc.valueOf(cellRef(col, spec.r0 + i));
        return typeof v === "number" ? v : Number(v) || 0;
      }),
    }));
    return { labels, series };
  };
  const addChart = () => store.setChart(active, { id: newId("chart"), type: "bar", c0, r0, c1, r1 });
  const setChartType = (id: string, type: ChartType) => {
    const existing = sheet?.charts?.find((c) => c.id === id);
    if (existing) store.setChart(active, { ...existing, type });
  };

  // --- tri (colonne active) -------------------------------------------------
  const sortRange = (dir: 1 | -1) => store.sortRange(active, sel.c, selRect, dir, (c, r) => cellDisplay(cellRef(c, r)));

  // --- mise en forme conditionnelle -----------------------------------------
  const addCondRule = (rule: Omit<CondRule, "id" | "c0" | "r0" | "c1" | "r1">) =>
    store.setCondRule(active, { ...rule, id: newId("cf"), c0, r0, c1, r1 });
  const removeCondRule = (id: string) => store.removeCondRule(active, id);

  // --- validation des données -----------------------------------------------
  const addValidation = (v: Omit<DataValidation, "id" | "c0" | "r0" | "c1" | "r1">) =>
    store.setValidation(active, { ...v, id: newId("dv"), c0, r0, c1, r1 });
  const removeValidation = (id: string) => store.removeValidation(active, id);

  // --- plages nommées (portée classeur) -------------------------------------
  const addName = (name: string) => {
    const single = c0 === c1 && r0 === r1;
    const ref = `${quoteSheetName(sheet?.name ?? "Feuille")}!${single ? absCell(c0, r0) : `${absCell(c0, r0)}:${absCell(c1, r1)}`}`;
    store.setName(name, ref);
  };
  const removeName = (name: string) => store.removeName(name);

  // --- tableau croisé dynamique ---------------------------------------------
  const pivotHeaders = (): string[] => {
    const h: string[] = [];
    for (let c = c0; c <= c1; c++) h.push(calc.display(cellRef(c, r0)));
    return h;
  };
  const buildPivotInput = (): PivotInput => {
    const rows: (string | number | boolean | null)[][] = [];
    for (let r = r0 + 1; r <= r1; r++) {
      const row: (string | number | boolean | null)[] = [];
      for (let c = c0; c <= c1; c++) {
        const v = calc.valueOf(cellRef(c, r));
        row.push(isError(v) ? null : (v as string | number | boolean));
      }
      rows.push(row);
    }
    return { headers: pivotHeaders(), rows };
  };
  const uniqueSheetName = (base: string): string => {
    const names = new Set(wb.sheets.map((s) => s.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  };
  const createPivot = (cfg: PivotConfig) => {
    if (!store.addSheetFromData) return;
    const data = pivotToSheet(computePivot(buildPivotInput(), cfg), uniqueSheetName("TCD"));
    const idx = store.addSheetFromData(data);
    setPivotOpen(false);
    store.setActive(idx);
    setSel({ c: 0, r: 0 });
    setAnchor({ c: 0, r: 0 });
  };

  const rangeLabel = `${cellRef(c0, r0)}:${cellRef(c1, r1)}`;

  return (
    <div className={`sheet-app ${chrome.variant === "modal" ? "sheet-app--modal" : ""}`}>
      {/* Barre supérieure */}
      <div className="sheet-bar" role="region" aria-label="Barre de titre du tableur">
        {chrome.onHome && (
          <button className="eb eb--sm eb--ghost" onClick={chrome.onHome} title="Accueil">
            <Home size={16} /> Accueil
          </button>
        )}
        <span className="sheet-bar__title">
          {chrome.titleIcon ?? <Table2 size={16} />} {chrome.title}
        </span>
        <div className="sheet-bar__spacer" />
        {chrome.statusNode}
        {canWrite && store.replaceWorkbook && (
          <>
            <button
              className="eb eb--sm eb--outline"
              onClick={() => fileRef.current?.click()}
              title="Importer un classeur XLSX/CSV"
            >
              <Upload size={14} /> Importer
            </button>
            <input ref={fileRef} type="file" accept=".xlsx,.csv" hidden onChange={onImportFile} />
          </>
        )}
        {chrome.headerActions}
        {chrome.onClose && (
          <button className="icon-btn" title="Fermer" onClick={chrome.onClose}>
            <X size={18} />
          </button>
        )}
      </div>

      {/* Barre de mise en forme (masquée en lecture seule) */}
      {canWrite && (
        <div className="elx-ribbon" role="region" aria-label="Barre de mise en forme">
          <div className="elx-ribbon__body">
            {store.undo && store.redo && (
              <Group title="Édition">
                <Cmd
                  icon={<Undo2 size={15} />}
                  title="Annuler (Ctrl+Z)"
                  onClick={store.undo}
                  disabled={!store.canUndo}
                />
                <Cmd
                  icon={<Redo2 size={15} />}
                  title="Rétablir (Ctrl+Y)"
                  onClick={store.redo}
                  disabled={!store.canRedo}
                />
              </Group>
            )}

            <Group title="Formules">
              <div className="elx-drop">
                <Cmd
                  icon={<Sigma size={15} />}
                  title="Bibliothèque de formules"
                  active={fxOpen}
                  onClick={() => setFxOpen((v) => !v)}
                />
                {fxOpen && (
                  <div className="elx-menu elx-menu--wide">
                    {["Maths", "Statistiques", "Recherche", "Logique", "Texte", "Date"].map((cat) => (
                      <div key={cat}>
                        <div className="elx-menu__title">{cat}</div>
                        {FUNCTIONS.filter((f) => f.cat === cat).map((f) => (
                          <button
                            key={f.name}
                            className="elx-menu__item"
                            onClick={() => insertFn(f.name)}
                            title={f.desc}
                          >
                            <span className="fx-item__body">
                              <span className="fx-item__sig">{f.sig}</span>
                              <span className="fx-item__desc">{f.desc}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </Group>

            <Group title="Police">
              <select
                key={`ff-${fontTick}`}
                className="elx-select elx-select--font"
                title="Police"
                aria-label="Police"
                value={activeStyle.fontFamily ?? DEFAULT_FONT}
                onChange={(e) => applyStyle({ fontFamily: e.target.value })}
              >
                {allFontNames().map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
              <Cmd
                icon={<Type size={15} />}
                title="Importer une police (.ttf/.otf)"
                onClick={() => fontInputRef.current?.click()}
              />
              <input ref={fontInputRef} type="file" accept=".ttf,.otf" hidden onChange={importFont} />
              <select
                className="elx-select elx-select--size"
                title="Taille de police"
                aria-label="Taille de police"
                value={activeStyle.fontSize ?? 13}
                onChange={(e) => applyStyle({ fontSize: Number(e.target.value) })}
              >
                {[8, 9, 10, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </Group>

            <Group title="Caractère">
              <Cmd icon={<Bold size={15} />} title="Gras" active={activeStyle.bold} onClick={() => toggle("bold")} />
              <Cmd
                icon={<Italic size={15} />}
                title="Italique"
                active={activeStyle.italic}
                onClick={() => toggle("italic")}
              />
            </Group>

            <Group title="Alignement">
              <Cmd
                icon={<AlignLeft size={15} />}
                title="Aligner à gauche"
                active={activeStyle.align === "left"}
                onClick={() => applyStyle({ align: "left" })}
              />
              <Cmd
                icon={<AlignCenter size={15} />}
                title="Centrer"
                active={activeStyle.align === "center"}
                onClick={() => applyStyle({ align: "center" })}
              />
              <Cmd
                icon={<AlignRight size={15} />}
                title="Aligner à droite"
                active={activeStyle.align === "right"}
                onClick={() => applyStyle({ align: "right" })}
              />
            </Group>

            <Group title="Couleurs">
              <label className="elx-field" title="Couleur du texte">
                <Baseline size={15} />
                <span className="elx-colorbtn">
                  <input
                    type="color"
                    value={activeStyle.color ?? "#0f172a"}
                    onChange={(e) => applyStyle({ color: e.target.value })}
                  />
                </span>
              </label>
              <label className="elx-field" title="Couleur de remplissage">
                <PaintBucket size={15} />
                <span className="elx-colorbtn">
                  <input
                    type="color"
                    value={activeStyle.fill ?? "#ffffff"}
                    onChange={(e) => applyStyle({ fill: e.target.value })}
                  />
                </span>
              </label>
            </Group>

            <Group title="Nombre">
              <select
                className="elx-select"
                title="Format des nombres"
                aria-label="Format des nombres"
                value={activeStyle.fmt ?? "general"}
                onChange={(e) => applyStyle({ fmt: e.target.value as NumFmt })}
              >
                {NUM_FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </Group>

            <Group title="Lignes & colonnes">
              <Cmd icon={<Plus size={15} />} title="Insérer une ligne" onClick={insertRow} />
              <Cmd icon={<Minus size={15} />} title="Supprimer la ligne" onClick={deleteRow} />
              <Cmd
                icon={<Plus size={15} style={{ transform: "rotate(90deg)" }} />}
                title="Insérer une colonne"
                onClick={insertCol}
              />
              <Cmd
                icon={<Minus size={15} style={{ transform: "rotate(90deg)" }} />}
                title="Supprimer la colonne"
                onClick={deleteCol}
              />
            </Group>

            <Group title="Données">
              <Cmd
                icon={<BarChart3 size={15} />}
                title="Insérer un graphique (depuis la sélection)"
                onClick={addChart}
              />
              <Cmd
                icon={<ArrowUpNarrowWide size={15} />}
                title="Trier croissant (colonne active)"
                onClick={() => sortRange(1)}
              />
              <Cmd
                icon={<ArrowDownNarrowWide size={15} />}
                title="Trier décroissant (colonne active)"
                onClick={() => sortRange(-1)}
              />
              <Cmd
                icon={<Filter size={15} />}
                title="Filtrer (colonne active)"
                active={!!sheet?.filter}
                onClick={applyFilter}
              />
            </Group>

            <Group title="Affichage">
              <div className="elx-drop">
                <Cmd
                  icon={<Snowflake size={15} />}
                  title="Figer les volets"
                  active={!!fz}
                  onClick={() => setFreezeOpen((v) => !v)}
                />
                {freezeOpen && (
                  <div className="elx-menu">
                    <button className="elx-menu__item" onClick={() => setFreeze(sel.r + 1, fz?.cols ?? 0)}>
                      Figer jusqu'à la ligne {sel.r + 1}
                    </button>
                    <button className="elx-menu__item" onClick={() => setFreeze(fz?.rows ?? 0, sel.c + 1)}>
                      Figer jusqu'à la colonne {indexToCol(sel.c)}
                    </button>
                    <button className="elx-menu__item" onClick={() => setFreeze(sel.r + 1, sel.c + 1)}>
                      Figer lignes + colonnes (sélection)
                    </button>
                    <button className="elx-menu__item" onClick={() => setFreeze(0, 0)} disabled={!fz}>
                      Libérer les volets
                    </button>
                  </div>
                )}
              </div>
            </Group>

            <Group title="Règles avancées">
              <Cmd
                icon={<Palette size={15} />}
                title="Mise en forme conditionnelle"
                active={(sheet?.condFormats?.length ?? 0) > 0}
                onClick={() => setCondOpen(true)}
              />
              <Cmd
                icon={<ListChecks size={15} />}
                title="Validation des données"
                active={(sheet?.validations?.length ?? 0) > 0}
                onClick={() => setValidationOpen(true)}
              />
              <Cmd
                icon={<Tag size={15} />}
                title="Plages nommées"
                active={(wb.names?.length ?? 0) > 0}
                onClick={() => setNamesOpen(true)}
              />
              <Cmd
                icon={<TableProperties size={15} />}
                title="Tableau croisé dynamique"
                onClick={() => setPivotOpen(true)}
              />
            </Group>

            <Group title="Cellules">
              <Cmd
                icon={<Combine size={15} />}
                title="Fusionner / annuler la fusion des cellules sélectionnées"
                onClick={() => store.toggleMerge(active, selRect)}
              />
              <Cmd icon={<Grid3x3 size={15} />} title="Quadriller (toutes les bordures)" onClick={setBorderAll} />
              <Cmd icon={<Eraser size={15} />} title="Supprimer les bordures" onClick={clearBorder} />
            </Group>

            {store.growSheet && (
              <Group title="Agrandir">
                <Cmd
                  icon={<Plus size={13} />}
                  label="Lignes"
                  title="Ajouter des lignes"
                  onClick={() => store.growSheet!(active, "rows", 10)}
                />
                <Cmd
                  icon={<Plus size={13} />}
                  label="Colonnes"
                  title="Ajouter des colonnes"
                  onClick={() => store.growSheet!(active, "cols", 4)}
                />
              </Group>
            )}

            {sheet?.filter && (
              <span className="sheet-filter-chip">
                Filtre : {indexToCol(sheet.filter.col)} ⊃ «&nbsp;{sheet.filter.query}&nbsp;»
                <button className="sheet-filter-chip__close" title="Retirer le filtre" onClick={clearFilter}>
                  <X size={13} />
                </button>
              </span>
            )}
          </div>
        </div>
      )}

      {/* Barre de formule */}
      <div className="sheet-formula" role="region" aria-label="Barre de formule">
        <span className="sheet-formula__ref">{activeRef}</span>
        <input
          className="elx-input sheet-formula__input"
          value={editing ? draft : (sheet?.cells[activeRef] ?? "")}
          placeholder="Valeur ou =formule (ex. =SUM(A1:A5))"
          readOnly={!canWrite}
          onChange={(e) => {
            if (!canWrite) return;
            if (!editingRef.current) {
              editingRef.current = true;
              setEditing(true);
            }
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitEdit();
              moveBy(0, 1);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelEdit();
            }
          }}
          onPaste={onPaste}
        />
      </div>

      <div
        className="sheet-grid-wrap"
        ref={gridRef}
        tabIndex={0}
        onKeyDown={onGridKeyDown}
        onPaste={onPaste}
        role="region"
        aria-label="Grille de la feuille de calcul"
      >
        {sheet && (
          <table className="sheet-grid">
            <colgroup>
              <col style={{ width: ROWHEAD_W }} />
              {Array.from({ length: sheet.cols }, (_, c) => (
                <col key={c} style={{ width: shownWidth(c) }} />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th className="sheet-corner" style={fz ? { zIndex: 7 } : undefined}>
                  <span className="sr-only">Angle du quadrillage</span>
                </th>
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
                    <th className={`sheet-rowhead ${r >= r0 && r <= r1 ? "is-hl" : ""}`} style={rowheadStyle(r)}>
                      {r + 1}
                    </th>
                    {Array.from({ length: sheet.cols }, (_, c) => {
                      const ref = cellRef(c, r);
                      if (isCovered(sheet.merges, c, r)) return null; // masquée par une fusion
                      const span = spanAt(sheet.merges, c, r);
                      const st = sheet.styles?.[ref];
                      const isActive = sel.c === c && sel.r === r;
                      if (isActive && editing) {
                        const dv = validationAt(sheet.validations, c, r);
                        const listId = dv?.type === "list" && dv.list?.length ? `dv-list-${c}-${r}` : undefined;
                        return (
                          <td
                            key={c}
                            className="is-selected"
                            style={stickyStyle(c, r)}
                            colSpan={span?.colSpan}
                            rowSpan={span?.rowSpan}
                          >
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
                                {dv!.list!.map((opt) => (
                                  <option key={opt} value={opt} />
                                ))}
                              </datalist>
                            )}
                          </td>
                        );
                      }
                      const val = sheet.cells[ref] != null ? calc.valueOf(ref) : "";
                      const numeric = typeof val === "number";
                      const invalid = validator(c, r);
                      const peer = collaborative ? peers.find((p) => p.s === active && p.ref === ref) : undefined;
                      const cls = [
                        inSel(c, r) ? (isActive ? "is-selected" : "is-range") : "",
                        inFill(c, r) ? "is-fill" : "",
                        isError(val) ? "is-err" : "",
                        numeric && !st?.align ? "is-num" : "",
                        invalid ? "is-invalid" : "",
                      ]
                        .filter(Boolean)
                        .join(" ");
                      const showHandle = canWrite && c === c1 && r === r1 && !editing;
                      const cf = condFmt(c, r);
                      const cellStyle: React.CSSProperties = {
                        fontWeight: cf.fontWeight ?? (st?.bold ? 700 : undefined),
                        fontStyle: st?.italic ? "italic" : undefined,
                        textAlign: st?.align,
                        color: cf.color ?? st?.color,
                        background: cf.background ?? st?.fill,
                        fontFamily: st?.fontFamily ? fontCss(st.fontFamily) : undefined,
                        fontSize: st?.fontSize ? `${st.fontSize}px` : undefined,
                        borderTop: borderCss(st?.border?.top),
                        borderRight: borderCss(st?.border?.right),
                        borderBottom: borderCss(st?.border?.bottom),
                        borderLeft: borderCss(st?.border?.left),
                        ...stickyStyle(c, r),
                      };
                      // Surbrillance du pair par-dessus (préserve la bordure de figeage éventuelle).
                      if (peer)
                        cellStyle.boxShadow = `inset 0 0 0 2px ${peer.color}${cellStyle.boxShadow ? ", " + cellStyle.boxShadow : ""}`;
                      return (
                        <td
                          key={c}
                          className={cls}
                          style={cellStyle}
                          title={invalid ?? (peer ? `${peer.name} est ici` : undefined)}
                          colSpan={span?.colSpan}
                          rowSpan={span?.rowSpan}
                          onMouseDown={(e) => {
                            selectCell(c, r, e.shiftKey);
                            dragging.current = true;
                            gridRef.current?.focus();
                          }}
                          onMouseEnter={() => {
                            if (fillSrcRef.current) {
                              fillToRef.current = { c, r };
                              setFillTo({ c, r });
                            } else if (dragging.current) setSel({ c, r });
                          }}
                          onDoubleClick={() => {
                            selectCell(c, r);
                            startEdit();
                          }}
                        >
                          {cellDisplay(ref)}
                          {showHandle && (
                            <span
                              className="sheet-fill-handle"
                              onMouseDown={startFill}
                              title="Recopier (poignée de remplissage)"
                            />
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
        <div className="sheet-charts">
          {sheet!.charts!.map((ch) => {
            const { labels, series } = chartData(ch);
            return (
              <div key={ch.id} className="sheet-chart">
                <div className="sheet-chart__head">
                  <select
                    className="tool-select tool-select--sm"
                    value={ch.type}
                    disabled={!canWrite}
                    onChange={(e) => setChartType(ch.id, e.target.value as ChartType)}
                  >
                    <option value="bar">Barres</option>
                    <option value="line">Lignes</option>
                    <option value="pie">Secteurs</option>
                  </select>
                  <span className="sheet-chart__range">
                    {cellRef(ch.c0, ch.r0)}:{cellRef(ch.c1, ch.r1)}
                  </span>
                  {canWrite && (
                    <button
                      className="icon-btn icon-btn--danger"
                      title="Supprimer le graphique"
                      onClick={() => store.removeChart(active, ch.id)}
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
                <SheetChart type={ch.type} labels={labels} series={series} />
              </div>
            );
          })}
        </div>
      )}

      <div className="sheet-tabs">
        {wb.sheets.map((s, i) => (
          <button
            key={i}
            className={`sheet-tab ${i === active ? "is-active" : ""}`}
            onClick={() => switchSheet(i)}
            onDoubleClick={() => {
              if (canWrite) void renameSheetPrompt(i);
            }}
            title={canWrite ? "Double-cliquer pour renommer" : undefined}
          >
            {s.name}
          </button>
        ))}
        {canWrite && (
          <button className="sheet-tab sheet-tab--add" onClick={addSheetPrompt} title="Ajouter une feuille">
            <Plus size={14} />
          </button>
        )}
        {canWrite && (
          <button className="sheet-tab sheet-tab--add" onClick={removeActiveSheet} title="Supprimer la feuille">
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {condOpen && (
        <CondFormatModal
          rangeLabel={rangeLabel}
          rules={sheet?.condFormats ?? []}
          onAdd={addCondRule}
          onRemove={removeCondRule}
          onClose={() => setCondOpen(false)}
        />
      )}

      {validationOpen && (
        <ValidationModal
          rangeLabel={rangeLabel}
          validations={sheet?.validations ?? []}
          onAdd={addValidation}
          onRemove={removeValidation}
          onClose={() => setValidationOpen(false)}
        />
      )}

      {namesOpen && (
        <NamedRangesModal
          rangeLabel={`${quoteSheetName(sheet?.name ?? "Feuille")}!${rangeLabel}`}
          names={wb.names ?? []}
          onAdd={addName}
          onRemove={removeName}
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
