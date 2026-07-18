import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import { TextLayer } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { spanMatches, findMatches, type PdfMatch } from "./search";
import {
  Home, Upload, Download, Save, ZoomIn, ZoomOut, Maximize2, ChevronLeft, ChevronRight, Search, X,
  FileText, FileType, MousePointer2, Type, Highlighter, Pencil, Square, Circle, Minus,
  Image as ImageIcon, Eraser, Trash2, Copy, ArrowUp, ArrowDown, FilePlus, Undo2, Redo2, ShieldCheck, RotateCw,
  Bold, Italic, Underline, TextCursorInput, FormInput, Combine, Scissors,
} from "lucide-react";
import { downloadBlob } from "../export/exporters";
import { useUndoable } from "../ui/useUndoable";
import { useDialogs } from "../ui/dialogs";
import PageEditLayer, { type Draft } from "./PageEditLayer";
import TextEditLayer from "./TextEditLayer";
import FormLayer from "./FormLayer";
import { buildEditedPdf } from "./pdf-save";
import { hasFormFields, type RawWidget } from "./forms";
import { mergePdfs, extractPages, parsePageRange } from "./merge-split";
import { type Anno, type PageRef, type PdfDoc, type EditedText, type FormValue, type Tool, newId, TOOL_DEFAULTS, base64ToBytes, bytesToBase64, serializePdfDoc } from "./model";
import { allFontNames, registerCustomFont, getCustomFont, isCustomFont, DEFAULT_FONT } from "../ui/fonts";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MIN_SCALE = 0.3, MAX_SCALE = 4;
const A4 = { w: 595.28, h: 841.89 };

const TOOLS: { tool: Tool; icon: React.ReactNode; label: string }[] = [
  { tool: "select", icon: <MousePointer2 size={16} />, label: "Sélection" },
  { tool: "text", icon: <Type size={16} />, label: "Texte" },
  { tool: "highlight", icon: <Highlighter size={16} />, label: "Surligner" },
  { tool: "draw", icon: <Pencil size={16} />, label: "Dessin libre" },
  { tool: "rect", icon: <Square size={16} />, label: "Rectangle" },
  { tool: "ellipse", icon: <Circle size={16} />, label: "Ellipse" },
  { tool: "line", icon: <Minus size={16} />, label: "Trait" },
  { tool: "image", icon: <ImageIcon size={16} />, label: "Image" },
  { tool: "whiteout", icon: <Eraser size={16} />, label: "Effacer (blanc)" },
];

/** One rendered page (source or inserted blank), rasterised lazily; children overlay it. */
function PdfPage({ doc, from, dims, scale, rotate = 0, index, children, onText, highlight }: {
  doc: PDFDocumentProxy; from: number | null; dims: { w: number; h: number }; scale: number; rotate?: number; index: number; children: React.ReactNode;
  onText?: (index: number, text: string) => void; highlight?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const done = useRef<string | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) setVisible(true); }, { rootMargin: "600px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const key = `${scale}:${rotate}`;
    if (!visible || done.current === key) return;
    let cancelled = false;
    (async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      canvas.width = Math.floor(dims.w * scale);
      canvas.height = Math.floor(dims.h * scale);
      if (from == null) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        done.current = key;
        return;
      }
      const page = await doc.getPage(from + 1);
      if (cancelled) return;
      // pdf.js applies the rotation itself (content stays upright/correct).
      const vp = page.getViewport({ scale, rotation: (page.rotate + rotate) % 360 });
      const task = page.render({ canvas, canvasContext: ctx, viewport: vp });
      try { await task.promise; done.current = key; } catch { /* cancelled */ }

      // Selectable/searchable text layer, laid OVER the canvas (additive — the
      // page still renders even if the text layer fails). pdf.js needs
      // --scale-factor to position the transparent spans.
      const textDiv = textRef.current;
      if (textDiv && !cancelled) {
        try {
          textDiv.replaceChildren();
          textDiv.style.setProperty("--scale-factor", String(scale));
          const tc = await page.getTextContent();
          if (cancelled) return;
          await new TextLayer({ textContentSource: tc, container: textDiv, viewport: vp }).render();
          onText?.(index, tc.items.map((it) => ("str" in it ? it.str : "")).join(" "));
        } catch { /* text layer is best-effort */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, scale, rotate, doc, from, dims.w, dims.h]);

  // Coarse search highlight: mark spans that contain the query.
  useEffect(() => {
    const textDiv = textRef.current;
    if (!textDiv) return;
    for (const span of textDiv.querySelectorAll("span")) {
      span.classList.toggle("pdf-hit", !!highlight && spanMatches(span.textContent ?? "", highlight));
    }
  }, [highlight, visible, scale]);

  return (
    <div ref={wrapRef} className="pdf-page" data-page={index + 1} style={{ width: dims.w * scale, height: dims.h * scale }}>
      <canvas ref={canvasRef} />
      <div ref={textRef} className="pdf-textlayer" aria-hidden />
      {children}
    </div>
  );
}

function PdfThumb({ doc, from, active, label, onClick }: {
  doc: PDFDocumentProxy; from: number | null; active: boolean; label: number; onClick: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLButtonElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const io = new IntersectionObserver(async ([e]) => {
      if (!e.isIntersecting || done.current) return;
      done.current = true;
      const canvas = ref.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      if (from == null) { canvas.width = 80; canvas.height = 104; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, 80, 104); return; }
      const page = await doc.getPage(from + 1);
      const vp = page.getViewport({ scale: 0.18 });
      canvas.width = Math.floor(vp.width); canvas.height = Math.floor(vp.height);
      try { await page.render({ canvas, canvasContext: ctx, viewport: vp }).promise; } catch { /* ignore */ }
    }, { rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [doc, from]);
  return (
    <button ref={wrapRef} className={`pdf-thumb ${active ? "is-active" : ""}`} onClick={onClick} title={`Page ${label}`}>
      <canvas ref={ref} />
      <span className="pdf-thumb__num">{label}</span>
    </button>
  );
}

/**
 * Elium PDF — a PDF reader AND editor built on pdf.js (render) + pdf-lib (write).
 * Open a .pdf, annotate (text, highlight, freehand, shapes, image, white-out),
 * reorganise pages (reorder / delete / duplicate / insert blank), then export a
 * real edited .pdf. Lazy-loaded so the libraries stay out of the main bundle.
 */
export default function PdfView({ onHome, initial, onExportElium }: {
  onHome: () => void;
  initial?: PdfDoc;
  onExportElium?: (data: PdfDoc, title: string) => void;
}) {
  const dialogs = useDialogs();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  // pages + annotations + form values share one undo/redo history.
  const { value: docState, set: setDocState, setQuiet: setDocQuiet, checkpoint, undo, redo, canUndo, canRedo, reset: resetDoc } =
    useUndoable<{ pages: PageRef[]; annos: Record<string, Anno[]>; textEdits: Record<string, EditedText[]>; formValues: Record<string, FormValue> }>({ pages: [], annos: {}, textEdits: {}, formValues: {} });
  const pages = docState.pages;
  const annos = docState.annos;
  const textEdits = docState.textEdits ?? {};
  const formValues = docState.formValues ?? {};
  const [textMode, setTextMode] = useState(false); // Adobe-style "edit existing text" mode
  const [formMode, setFormMode] = useState(false);  // fill AcroForm fields
  const [formCount, setFormCount] = useState(0);     // detected fillable fields (gates the toggle)
  const [flattenForm, setFlattenForm] = useState(true); // bake fields into content on export
  const setPageEdits = (pageId: string, next: EditedText[]) =>
    setDocQuiet((s) => ({ ...s, textEdits: { ...(s.textEdits ?? {}), [pageId]: next } }));
  const setFormValue = (name: string, value: FormValue) =>
    setDocQuiet((s) => ({ ...s, formValues: { ...(s.formValues ?? {}), [name]: value } }));
  const [pageDims, setPageDims] = useState<{ w: number; h: number }[]>([]);
  const [scale, setScale] = useState(1.3);
  const [cur, setCur] = useState(1);
  const [pageInput, setPageInput] = useState("1");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [tool, setTool] = useState<Tool>("select");
  const [draft, setDraft] = useState<Draft>({ ...TOOL_DEFAULTS, fontFamily: DEFAULT_FONT });
  const [sel, setSel] = useState<{ pageId: string; id: string } | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [fontTick, setFontTick] = useState(0); // bump to refresh the font list after an import

  const fileRef = useRef<HTMLInputElement>(null);
  const fontInputRef = useRef<HTMLInputElement>(null);
  const mergeInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const taskRef = useRef<ReturnType<typeof pdfjs.getDocument> | null>(null);

  // In-reader text search (selectable text layer + Ctrl+F).
  const pageTexts = useRef<string[]>([]);
  const [search, setSearch] = useState<{ open: boolean; query: string; matches: PdfMatch[]; idx: number }>({ open: false, query: "", matches: [], idx: 0 });
  const runSearch = (query: string) => {
    const matches = findMatches(pageTexts.current, query);
    setSearch((s) => ({ ...s, query, matches, idx: 0 }));
    if (matches[0]) goTo(matches[0].page + 1);
  };
  const stepSearch = (delta: number) => {
    setSearch((s) => {
      if (!s.matches.length) return s;
      const idx = (s.idx + delta + s.matches.length) % s.matches.length;
      goTo(s.matches[idx]!.page + 1);
      return { ...s, idx };
    });
  };

  // Load PDF bytes into the viewer. `restore` reuses a persisted page order +
  // annotations (re-opening an .elium); otherwise pages map 1:1 to the source.
  const loadBytes = useCallback(async (buf: Uint8Array, fileName: string, restore?: { pages: PageRef[]; annos: Record<string, Anno[]>; textEdits: Record<string, EditedText[]>; formValues: Record<string, FormValue> }) => {
    setBusy(true); setErr("");
    try {
      bytesRef.current = buf.slice();
      void taskRef.current?.destroy();
      const task = pdfjs.getDocument({ data: buf });
      taskRef.current = task;
      const d = await task.promise;
      const dims: { w: number; h: number }[] = [];
      let formFields = 0;
      for (let i = 1; i <= d.numPages; i++) {
        const page = await d.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        dims.push({ w: vp.width, h: vp.height });
        try { if (hasFormFields((await page.getAnnotations()) as RawWidget[])) formFields++; } catch { /* annotations best-effort */ }
      }
      setDoc(d);
      setPageDims(dims);
      setFormCount(formFields);
      setFormMode(false);
      resetDoc(restore ?? { pages: Array.from({ length: d.numPages }, (_, i) => ({ id: newId("pg"), from: i })), annos: {}, textEdits: {}, formValues: {} });
      setName(fileName);
      setCur(1); setPageInput("1"); setSel(null); setEditId(null);
    } catch {
      setErr("Impossible d'ouvrir ce PDF (fichier illisible ou protégé).");
    } finally {
      setBusy(false);
    }
  }, [resetDoc]);

  const openFile = useCallback(async (file: File) => loadBytes(new Uint8Array(await file.arrayBuffer()), file.name), [loadBytes]);

  // Re-open a PDF persisted in an .elium (decode base64, restore pages+annos).
  const initedRef = useRef(false);
  useEffect(() => {
    if (initedRef.current || !initial) return;
    initedRef.current = true;
    // Re-register imported fonts so text annotations render + re-embed correctly.
    if (initial.fonts) for (const [n, b64] of Object.entries(initial.fonts)) registerCustomFont(n, base64ToBytes(b64));
    void loadBytes(base64ToBytes(initial.pdf), initial.name || "document.pdf", { pages: initial.pages, annos: initial.annos, textEdits: initial.textEdits ?? {}, formValues: initial.formValues ?? {} });
  }, [initial, loadBytes]);

  useEffect(() => () => { void taskRef.current?.destroy(); }, []);

  const dimsFor = (pr: PageRef) => {
    const base = (pr.from != null ? pageDims[pr.from] : pageDims[0]) ?? A4;
    return (pr.rotate ?? 0) % 180 === 90 ? { w: base.h, h: base.w } : base; // 90/270 swaps width/height
  };

  // --- annotations (recorded = discrete; Quiet = live drag/resize/typing) --
  const setAnnosIn = (m: Record<string, Anno[]>, pageId: string, list: Anno[]) => ({ ...m, [pageId]: list });
  const addAnno = (pageId: string, a: Anno) =>
    setDocState((s) => ({ ...s, annos: setAnnosIn(s.annos, pageId, [...(s.annos[pageId] ?? []), a]) }));
  const updateAnno = (pageId: string, id: string, patch: Partial<Anno>) =>
    setDocState((s) => ({ ...s, annos: setAnnosIn(s.annos, pageId, (s.annos[pageId] ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a))) }));
  const updateAnnoQuiet = (pageId: string, id: string, patch: Partial<Anno>) =>
    setDocQuiet((s) => ({ ...s, annos: setAnnosIn(s.annos, pageId, (s.annos[pageId] ?? []).map((a) => (a.id === id ? { ...a, ...patch } : a))) }));
  const removeAnno = (pageId: string, id: string) =>
    setDocState((s) => ({ ...s, annos: setAnnosIn(s.annos, pageId, (s.annos[pageId] ?? []).filter((a) => a.id !== id)) }));

  // Keyboard: Suppr removes the selected annotation; Ctrl+Z/Y undo/redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey)) {
        const k = e.key.toLowerCase();
        if (k === "f") { e.preventDefault(); setSearch((s) => ({ ...s, open: true })); return; }
        if (!inField && k === "z" && !e.shiftKey) { e.preventDefault(); undo(); return; }
        if (!inField && (k === "y" || (k === "z" && e.shiftKey))) { e.preventDefault(); redo(); return; }
      }
      if (e.key === "Escape" && search.open) { setSearch((s) => ({ ...s, open: false })); return; }
      if (editId) return;
      if ((e.key === "Delete" || e.key === "Backspace") && sel && !inField) {
        removeAnno(sel.pageId, sel.id); setSel(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sel, editId, undo, redo, search.open]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- page operations (all recorded) --------------------------------------
  const move = (i: number, dir: -1 | 1) => setDocState((s) => {
    const j = i + dir; if (j < 0 || j >= s.pages.length) return s;
    const n = s.pages.slice(); [n[i], n[j]] = [n[j], n[i]]; return { ...s, pages: n };
  });
  const removePage = (i: number) => setDocState((s) => (s.pages.length <= 1 ? s : { ...s, pages: s.pages.filter((_, k) => k !== i) }));
  const duplicatePage = (i: number) => setDocState((s) => {
    const src = s.pages[i]; const id = newId("pg");
    const annos = { ...s.annos, [id]: (s.annos[src.id] ?? []).map((a) => ({ ...a, id: newId("an"), points: a.points ? a.points.map((q) => ({ ...q })) : undefined })) };
    const n = s.pages.slice(); n.splice(i + 1, 0, { id, from: src.from });
    return { ...s, pages: n, annos };
  });
  const insertBlank = (i: number) => setDocState((s) => {
    const n = s.pages.slice(); n.splice(i + 1, 0, { id: newId("pg"), from: null });
    return { ...s, pages: n };
  });
  const rotatePage = (i: number) => setDocState((s) => {
    const n = s.pages.slice(); n[i] = { ...n[i], rotate: ((n[i].rotate ?? 0) + 90) % 360 };
    return { ...s, pages: n };
  });

  // --- navigation / zoom ---------------------------------------------------
  const onScroll = useCallback(() => {
    const sc = scrollRef.current; if (!sc) return;
    const midY = sc.getBoundingClientRect().top + sc.clientHeight / 2;
    let best = cur, bestD = Infinity;
    sc.querySelectorAll<HTMLElement>(".pdf-page").forEach((el) => {
      const r = el.getBoundingClientRect();
      const d = Math.abs(r.top + r.height / 2 - midY);
      if (d < bestD) { bestD = d; best = Number(el.dataset.page); }
    });
    if (best !== cur) { setCur(best); setPageInput(String(best)); }
  }, [cur]);

  const goTo = useCallback((n: number) => {
    const t = Math.max(1, Math.min(pages.length, n));
    scrollRef.current?.querySelector(`[data-page="${t}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    setCur(t); setPageInput(String(t));
  }, [pages.length]);

  const zoom = (d: number) => setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round((s + d) * 10) / 10)));
  const fitWidth = () => {
    const sc = scrollRef.current; const pr = pages[cur - 1];
    if (!sc || !pr) return;
    const avail = sc.clientWidth - (200 + 56); // rail + padding
    setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, avail / dimsFor(pr).w)));
  };

  // --- save / download -----------------------------------------------------
  const savePdf = async () => {
    if (!bytesRef.current) return;
    setSaving(true);
    try {
      const out = await buildEditedPdf(bytesRef.current, pages, annos, textEdits, { formValues, flattenForm });
      const base = (name || "document.pdf").replace(/\.pdf$/i, "");
      downloadBlob(`${base}-modifié.pdf`, "application/pdf", out);
    } catch {
      setErr("Échec de l'enregistrement du PDF.");
    } finally {
      setSaving(false);
    }
  };
  const downloadOriginal = () => { if (bytesRef.current) downloadBlob(name || "document.pdf", "application/pdf", bytesRef.current); };

  // --- merge / split -------------------------------------------------------
  // Append one or more PDFs to the current document. Merging at the source level
  // keeps the current pages (and their edits) at the front — copyPages preserves
  // order — so we just extend the page list with the appended pages.
  const onMergePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length || !bytesRef.current || !doc) return;
    setBusy(true); setErr("");
    try {
      const prevCount = doc.numPages;
      const picked = await Promise.all(files.map(async (f) => new Uint8Array(await f.arrayBuffer())));
      const merged = await mergePdfs([bytesRef.current, ...picked]);
      const appended: PageRef[] = Array.from({ length: merged.pageCount - prevCount }, (_, k) => ({ id: newId("pg"), from: prevCount + k }));
      await loadBytes(merged.bytes, name, { pages: [...pages, ...appended], annos, textEdits, formValues });
    } catch {
      setErr("Échec de la fusion (fichier illisible ou protégé ?).");
      setBusy(false);
    }
  };

  // Extract a page range (in the current, edited order) into a new PDF download.
  const extractRange = async () => {
    if (!bytesRef.current) return;
    const spec = await dialogs.prompt({ title: "Extraire des pages", label: `Plage de pages (1–${pages.length}), ex. « 1-3, 5 »`, defaultValue: `1-${pages.length}` });
    if (spec === null) return;
    const idxs = parsePageRange(spec, pages.length);
    if (!idxs.length) { setErr("Plage de pages invalide."); return; }
    setSaving(true); setErr("");
    try {
      const full = await buildEditedPdf(bytesRef.current, pages, annos, textEdits, { formValues, flattenForm });
      const extracted = await extractPages(full, idxs);
      const base = (name || "document.pdf").replace(/\.pdf$/i, "");
      downloadBlob(`${base}-pages.pdf`, "application/pdf", extracted);
    } catch {
      setErr("Échec de l'extraction.");
    } finally {
      setSaving(false);
    }
  };

  // Save as a sealed/encrypted .elium (durable, re-editable, signable).
  const saveElium = async () => {
    if (!bytesRef.current || !onExportElium) return;
    const base = (name || "document").replace(/\.pdf$/i, "");
    const title = await dialogs.prompt({ title: "Enregistrer en .elium", label: "Nom du document", defaultValue: base });
    if (title === null) return;
    // Persist any imported fonts actually used, so the doc stays re-editable.
    const fonts: Record<string, string> = {};
    const scanFont = (fam?: string) => {
      if (fam && isCustomFont(fam) && !fonts[fam]) {
        const bytes = getCustomFont(fam);
        if (bytes) fonts[fam] = bytesToBase64(bytes);
      }
    };
    for (const list of Object.values(annos)) for (const a of list) if (a.type === "text") scanFont(a.fontFamily);
    for (const list of Object.values(textEdits)) for (const e of list) scanFont(e.fontFamily);
    onExportElium(serializePdfDoc(name || "document.pdf", bytesRef.current, pages, annos, textEdits, fonts, formValues), title.trim() || base);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void openFile(f); };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f && (f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf"))) void openFile(f);
  };

  const needStroke = ["rect", "ellipse", "line", "draw"].includes(tool);

  // --- rich text controls (font / size / B-I-U) ----------------------------
  const selAnno = sel ? (annos[sel.pageId] ?? []).find((a) => a.id === sel.id) ?? null : null;
  const showText = tool === "text" || selAnno?.type === "text";
  const curText = (selAnno?.type === "text" ? selAnno : draft) as { fontFamily?: string; fontSize: number; bold?: boolean; italic?: boolean; underline?: boolean; color: string };
  const fontNames = useMemo(() => allFontNames(), [fontTick]);
  const applyText = (patch: Partial<Pick<Anno, "fontFamily" | "bold" | "italic" | "underline" | "fontSize" | "color">>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if (selAnno?.type === "text" && sel) updateAnno(sel.pageId, sel.id, patch);
  };
  const importFont = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    registerCustomFont(f.name.replace(/\.(ttf|otf)$/i, ""), new Uint8Array(await f.arrayBuffer()));
    setFontTick((t) => t + 1);
    applyText({ fontFamily: f.name.replace(/\.(ttf|otf)$/i, "") });
  };

  return (
    <div className="pdf-app">
      <div className="sheet-bar">
        <button className="eb eb--sm eb--ghost" onClick={onHome} title="Accueil"><Home size={16} /> Accueil</button>
        <span className="sheet-bar__title"><FileType size={16} /> PDF</span>
        <div className="sheet-bar__spacer" />
        {doc && (
          <>
            <div className="pdf-nav">
              <button className="icon-btn" title="Page précédente" onClick={() => goTo(cur - 1)} disabled={cur <= 1}><ChevronLeft size={16} /></button>
              <input
                className="pdf-page-input" value={pageInput}
                onChange={(e) => setPageInput(e.target.value.replace(/[^\d]/g, ""))}
                onKeyDown={(e) => { if (e.key === "Enter") goTo(Number(pageInput) || 1); }}
                onBlur={() => goTo(Number(pageInput) || cur)}
                aria-label="Numéro de page"
              />
              <span className="pdf-nav__total">/ {pages.length}</span>
              <button className="icon-btn" title="Page suivante" onClick={() => goTo(cur + 1)} disabled={cur >= pages.length}><ChevronRight size={16} /></button>
            </div>
            <div className="pdf-search">
              {search.open ? (
                <>
                  <Search size={14} />
                  <input
                    className="pdf-search__input" autoFocus placeholder="Rechercher dans le document…" value={search.query}
                    onChange={(e) => runSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); stepSearch(e.shiftKey ? -1 : 1); } if (e.key === "Escape") setSearch((s) => ({ ...s, open: false })); }}
                    aria-label="Rechercher dans le PDF"
                  />
                  <span className="pdf-search__count">{search.matches.length ? `${search.idx + 1}/${search.matches.length}` : search.query ? "0" : ""}</span>
                  <button className="icon-btn" title="Précédent (Maj+Entrée)" onClick={() => stepSearch(-1)} disabled={!search.matches.length}><ChevronLeft size={16} /></button>
                  <button className="icon-btn" title="Suivant (Entrée)" onClick={() => stepSearch(1)} disabled={!search.matches.length}><ChevronRight size={16} /></button>
                  <button className="icon-btn" title="Fermer (Échap)" onClick={() => setSearch((s) => ({ ...s, open: false, query: "" }))}><X size={16} /></button>
                </>
              ) : (
                <button className="icon-btn" title="Rechercher (Ctrl+F)" onClick={() => setSearch((s) => ({ ...s, open: true }))}><Search size={16} /></button>
              )}
            </div>
            <div className="pdf-zoom">
              <button className="icon-btn" title="Dézoomer" onClick={() => zoom(-0.2)}><ZoomOut size={16} /></button>
              <span className="pdf-zoom__val">{Math.round(scale * 100)} %</span>
              <button className="icon-btn" title="Zoomer" onClick={() => zoom(0.2)}><ZoomIn size={16} /></button>
              <button className="icon-btn" title="Ajuster à la largeur" onClick={fitWidth}><Maximize2 size={16} /></button>
            </div>
            {onExportElium && (
              <button className="eb eb--sm eb--primary" onClick={saveElium} title="Enregistrer comme .elium (scellé, re-modifiable)">
                <ShieldCheck size={14} /> .elium
              </button>
            )}
            <button className="eb eb--sm eb--outline" onClick={savePdf} disabled={saving} title="Exporter le PDF modifié">
              <Save size={14} /> {saving ? "…" : "PDF"}
            </button>
          </>
        )}
        <button className="eb eb--sm eb--outline" onClick={() => fileRef.current?.click()}><Upload size={14} /> Ouvrir</button>
        {doc && <button className="eb eb--sm eb--outline" onClick={downloadOriginal} title="Télécharger l'original"><Download size={14} /></button>}
        <input ref={fileRef} type="file" accept="application/pdf,.pdf" hidden onChange={onPick} />
        <input ref={fontInputRef} type="file" accept=".ttf,.otf" hidden onChange={importFont} />
        <input ref={mergeInputRef} type="file" accept="application/pdf,.pdf" multiple hidden onChange={onMergePick} />
      </div>

      {doc && (
        <div className="pdf-tools">
          <button className="icon-btn" title="Annuler (Ctrl+Z)" onClick={undo} disabled={!canUndo}><Undo2 size={16} /></button>
          <button className="icon-btn" title="Rétablir (Ctrl+Y)" onClick={redo} disabled={!canRedo}><Redo2 size={16} /></button>
          <span className="pdf-tools__sep" />
          <button className="eb eb--sm eb--outline" title="Fusionner d'autres PDF à la suite" onClick={() => mergeInputRef.current?.click()}>
            <Combine size={14} /> Fusionner
          </button>
          <button className="eb eb--sm eb--outline" title="Extraire une plage de pages dans un nouveau PDF" onClick={extractRange} disabled={saving}>
            <Scissors size={14} /> Extraire
          </button>
          <span className="pdf-tools__sep" />
          <button
            className={`eb eb--sm ${textMode ? "eb--primary" : "eb--outline"}`}
            title="Modifier le texte existant du PDF (zones éditables)"
            onClick={() => { setTextMode((v) => !v); setFormMode(false); setSel(null); setEditId(null); setTool("select"); }}
          >
            <TextCursorInput size={14} /> Modifier le texte
          </button>
          {formCount > 0 && (
            <button
              className={`eb eb--sm ${formMode ? "eb--primary" : "eb--outline"}`}
              title="Remplir les champs de formulaire (AcroForm)"
              onClick={() => { setFormMode((v) => !v); setTextMode(false); setSel(null); setEditId(null); setTool("select"); }}
            >
              <FormInput size={14} /> Formulaire
            </button>
          )}
          {formMode ? (
            <>
              <span className="pdf-tools__hint">Remplissez les champs détectés, puis exportez.</span>
              <span className="pdf-tools__sep" />
              <label className="pdf-flatten" title="Aplatir : les champs deviennent du contenu figé (rendu identique partout, non re-modifiable).">
                <input type="checkbox" checked={flattenForm} onChange={(e) => setFlattenForm(e.target.checked)} />
                Aplatir à l'export
              </label>
            </>
          ) : textMode ? (
            <span className="pdf-tools__hint">Cliquez une ligne de texte pour la modifier, puis réenregistrez.</span>
          ) : (
            <>
              <span className="pdf-tools__sep" />
              {TOOLS.map((t) => (
                <button key={t.tool} className={`icon-btn ${tool === t.tool ? "is-active" : ""}`} title={t.label} onClick={() => { setTool(t.tool); setSel(null); setEditId(null); }}>{t.icon}</button>
              ))}
              <span className="pdf-tools__sep" />
              <label className="tool-color" title="Couleur"><input type="color" value={draft.color} onFocus={() => { if (sel) checkpoint(); }} onChange={(e) => { setDraft((d) => ({ ...d, color: e.target.value })); if (sel) updateAnnoQuiet(sel.pageId, sel.id, { color: e.target.value }); }} /></label>
              {needStroke && (
                <label className="pdf-stroke" title="Épaisseur du trait">
                  <input type="range" min={1} max={12} value={draft.strokeWidth} onMouseDown={() => { if (sel) checkpoint(); }} onChange={(e) => { const v = Number(e.target.value); setDraft((d) => ({ ...d, strokeWidth: v })); if (sel) updateAnnoQuiet(sel.pageId, sel.id, { strokeWidth: v }); }} />
                </label>
              )}
              {showText && (
                <>
                  <select className="tool-select" title="Police" value={curText.fontFamily ?? DEFAULT_FONT} onChange={(e) => applyText({ fontFamily: e.target.value })}>
                    {fontNames.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                  <button className="icon-btn" title="Importer une police (.ttf/.otf)" onClick={() => fontInputRef.current?.click()}><Type size={15} /></button>
                  <select className="tool-select" title="Taille du texte" value={curText.fontSize} onChange={(e) => applyText({ fontSize: Number(e.target.value) })}>
                    {[8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <button className={`icon-btn ${curText.bold ? "is-active" : ""}`} title="Gras" onClick={() => applyText({ bold: !curText.bold })}><Bold size={15} /></button>
                  <button className={`icon-btn ${curText.italic ? "is-active" : ""}`} title="Italique" onClick={() => applyText({ italic: !curText.italic })}><Italic size={15} /></button>
                  <button className={`icon-btn ${curText.underline ? "is-active" : ""}`} title="Souligné" onClick={() => applyText({ underline: !curText.underline })}><Underline size={15} /></button>
                </>
              )}
              {sel && <button className="icon-btn icon-btn--danger" title="Supprimer l'élément (Suppr)" onClick={() => { removeAnno(sel.pageId, sel.id); setSel(null); }}><Trash2 size={15} /></button>}
              <span className="pdf-tools__hint">{tool === "select" ? "Cliquez un élément pour le déplacer." : "Dessinez sur la page."}</span>
            </>
          )}
        </div>
      )}

      {!doc ? (
        <div
          className={`pdf-empty ${dragOver ? "is-drag" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
        >
          <FileText size={48} />
          <h2>Ouvrir un PDF</h2>
          <p>{busy ? "Chargement…" : err || "Glissez-déposez un .pdf ici, ou cliquez pour le sélectionner. Vous pourrez ensuite l'annoter et le modifier."}</p>
          <button className="eb eb--primary" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={16} /> Choisir un PDF</button>
        </div>
      ) : (
        <div className="pdf-body">
          <aside className="pdf-rail">
            {pages.map((pr, i) => (
              <div key={pr.id} className="pdf-rail__item">
                <PdfThumb doc={doc} from={pr.from} active={cur === i + 1} label={i + 1} onClick={() => goTo(i + 1)} />
                <div className="pdf-rail__ops">
                  <button className="icon-btn" title="Monter" onClick={() => move(i, -1)} disabled={i === 0}><ArrowUp size={12} /></button>
                  <button className="icon-btn" title="Descendre" onClick={() => move(i, 1)} disabled={i === pages.length - 1}><ArrowDown size={12} /></button>
                  <button className="icon-btn" title="Dupliquer" onClick={() => duplicatePage(i)}><Copy size={12} /></button>
                  <button
                    className="icon-btn"
                    title={(annos[pr.id]?.length ?? 0) > 0 ? "Retirez les annotations pour pivoter la page" : "Pivoter 90°"}
                    onClick={() => rotatePage(i)}
                    disabled={(annos[pr.id]?.length ?? 0) > 0}
                  >
                    <RotateCw size={12} />
                  </button>
                  <button className="icon-btn" title="Page blanche après" onClick={() => insertBlank(i)}><FilePlus size={12} /></button>
                  <button className="icon-btn icon-btn--danger" title="Supprimer" onClick={() => removePage(i)} disabled={pages.length <= 1}><Trash2 size={12} /></button>
                </div>
              </div>
            ))}
          </aside>
          <div className="pdf-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="pdf-pages">
              {pages.map((pr, i) => {
                const dims = dimsFor(pr);
                const rot = pr.rotate ?? 0;
                return (
                  <PdfPage key={pr.id} doc={doc} from={pr.from} dims={dims} scale={scale} rotate={rot} index={i}
                    onText={(idx, text) => { pageTexts.current[idx] = text; }}
                    highlight={search.open ? search.query : ""}>
                    {rot !== 0 ? null : formMode ? (
                      pr.from != null ? (
                        <FormLayer
                          doc={doc}
                          from={pr.from}
                          scale={scale}
                          values={formValues}
                          onChange={setFormValue}
                          onBeginChange={checkpoint}
                        />
                      ) : null
                    ) : textMode ? (
                      pr.from != null ? (
                        <TextEditLayer
                          doc={doc}
                          from={pr.from}
                          scale={scale}
                          edits={textEdits[pr.id] ?? []}
                          onChange={(next) => setPageEdits(pr.id, next)}
                          onBeginChange={checkpoint}
                        />
                      ) : null
                    ) : (
                      <PageEditLayer
                        pageId={pr.id}
                        w={dims.w} h={dims.h} scale={scale}
                        annos={annos[pr.id] ?? []}
                        tool={tool}
                        selId={sel?.pageId === pr.id ? sel.id : null}
                        editingId={editId}
                        draft={draft}
                        onAdd={(a) => addAnno(pr.id, a)}
                        onUpdate={(id, patch) => updateAnnoQuiet(pr.id, id, patch)}
                        onBeginChange={checkpoint}
                        onSelect={(id) => setSel(id ? { pageId: pr.id, id } : null)}
                        onEdit={setEditId}
                        onToolDone={() => setTool("select")}
                      />
                    )}
                  </PdfPage>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
