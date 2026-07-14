/**
 * SlidesEditor — the ONE Présentations editing surface, shared by the local suite
 * and the Drive collaborative editor. It renders every toolbar, the slide rail,
 * the free-canvas stage, speaker notes and the presenter, driven purely by a
 * `DeckStore` (see store.ts). Per-user UI state (selection, presenter, menus)
 * lives here; deck data + mutations live in the store. Shell-specific chrome
 * (page vs. modal, export buttons, connection status/peers) is injected via props.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Home, Plus, Play, Trash2, X, Presentation, Image as ImageIcon, Copy,
  Type, Square, Circle, Triangle, Minus, ArrowRight, Diamond, Star, ChevronRight, ChevronLeft,
  Undo2, Redo2, Bold, Italic, Underline, List, ListOrdered, AlignLeft, AlignCenter, AlignRight,
  BringToFront, SendToBack, LayoutTemplate, Hexagon, RotateCw, Baseline, Sparkles, MonitorPlay, Upload,
  Palette, LayoutGrid, Table as TableIcon, BarChart3, Plus as PlusIcon, Minus as MinusIcon,
  AlignStartVertical, AlignCenterVertical, AlignEndVertical,
  AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal,
} from "lucide-react";
import { allFontNames, DEFAULT_FONT } from "../ui/fonts";
import {
  elementsOf, newElementId, newSlideId, newTextElement, newShapeElement, newImageElement, newTableElement, newChartElement, REF_H,
  type Slide, type SlideElement, type SlideTheme, type SlideTransition, type ShapeKind, type AnimEffect, type ChartKind, type ChartData,
} from "./model";
import { ANIM_EFFECTS, revealAt, maxStep } from "./playback";
import { SLIDE_TEMPLATES, GRADIENT_PRESETS, SOLID_PRESETS, gradientCss } from "./templates";
import { PRESENTER_CHANNEL, type PresenterMsg } from "./presenter-sync";
import { importPptxFile } from "./pptx-import";
import SlideCanvas from "./canvas";
import MorphCanvas from "./MorphCanvas";
import type { DeckStore } from "./store";
import "./slides.css";

const THEMES: { value: SlideTheme; label: string }[] = [
  { value: "light", label: "Clair" }, { value: "dark", label: "Sombre" }, { value: "brand", label: "Marque" },
];
const TRANSITIONS: { value: SlideTransition; label: string }[] = [
  { value: "none", label: "Aucune" }, { value: "fade", label: "Fondu" }, { value: "slide", label: "Glissement" }, { value: "zoom", label: "Zoom" }, { value: "morph", label: "Morph" },
];
const SHAPES: { kind: ShapeKind; icon: ReactNode; label: string }[] = [
  { kind: "rect", icon: <Square size={16} />, label: "Rectangle" },
  { kind: "roundRect", icon: <Square size={16} />, label: "Rectangle arrondi" },
  { kind: "ellipse", icon: <Circle size={16} />, label: "Ellipse" },
  { kind: "triangle", icon: <Triangle size={16} />, label: "Triangle" },
  { kind: "diamond", icon: <Diamond size={16} />, label: "Losange" },
  { kind: "pentagon", icon: <Hexagon size={16} />, label: "Pentagone" },
  { kind: "hexagon", icon: <Hexagon size={16} />, label: "Hexagone" },
  { kind: "star", icon: <Star size={16} />, label: "Étoile" },
  { kind: "chevron", icon: <ChevronRight size={16} />, label: "Chevron" },
  { kind: "line", icon: <Minus size={16} />, label: "Trait" },
  { kind: "arrow", icon: <ArrowRight size={16} />, label: "Flèche" },
];
const TEXT_COLORS = ["#0f172a", "#ffffff", "#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#2563eb", "#7c3aed", "#db2777"];

/** Measures the stage's pixel height → scale factor for font sizing. */
function useScale(): [React.RefObject<HTMLDivElement>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const ro = new ResizeObserver(() => { const h = node.clientHeight; if (h) setScale(h / REF_H); });
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  return [ref, scale];
}

export interface SlidesEditorChrome {
  title: string;
  titleIcon?: ReactNode;
  onHome?: () => void;
  onClose?: () => void;
  /** Extra buttons in the top bar (e.g. export). */
  headerActions?: ReactNode;
  /** Connection status / peers node (collab), placed after the spacer. */
  statusNode?: ReactNode;
  variant?: "page" | "modal";
}

export default function SlidesEditor({ store, chrome }: { store: DeckStore; chrome: SlidesEditorChrome }) {
  const { deck, active: activeIdx, canWrite } = store;
  const [presenting, setPresenting] = useState(false);
  const [presentIdx, setPresentIdx] = useState(0);
  const [presentStep, setPresentStep] = useState(0);
  const [morphFrom, setMorphFrom] = useState<number | null>(null);
  const prevIdxRef = useRef(0);
  const [selId, setSelId] = useState<string | null>(null);
  const [shapeMenu, setShapeMenu] = useState(false);
  const [colorMenu, setColorMenu] = useState(false);
  const [animMenu, setAnimMenu] = useState(false);
  const [bgMenu, setBgMenu] = useState(false);
  const [tplMenu, setTplMenu] = useState(false);
  const [chartInsMenu, setChartInsMenu] = useState(false);
  const [chartMenu, setChartMenu] = useState(false);
  const [bgC1, setBgC1] = useState("#2563eb");
  const [bgC2, setBgC2] = useState("#1e3a8a");
  const [bgAngle, setBgAngle] = useState(160);
  const [stageRef, scale] = useScale();
  const imgRef = useRef<HTMLInputElement>(null);
  const pptxRef = useRef<HTMLInputElement>(null);

  const active = deck.slides[activeIdx];
  const elements = active ? (active.elements ?? elementsOf(active)) : [];
  const sel = elements.find((e) => e.id === selId) ?? null;
  const theme = deck.theme ?? "light";

  useEffect(() => { setSelId(null); }, [activeIdx]);
  useEffect(() => { setAnimMenu(false); setChartMenu(false); }, [selId]);

  // --- composed element helpers on top of the store ---
  const addEl = (elm: SlideElement) => { store.addEl(elm); setSelId(elm.id); };
  const removeEl = (id: string) => { store.removeEl(id); setSelId(null); };
  const duplicateEl = (id: string) => {
    const src = elements.find((e) => e.id === id); if (!src) return;
    const copy: SlideElement = { ...src, id: newElementId(), x: Math.min(src.x + 3, 90), y: Math.min(src.y + 3, 90) };
    store.addEl(copy); setSelId(copy.id);
  };
  const alignSlide = (dir: "l" | "c" | "r" | "t" | "m" | "b") => {
    if (!sel) return; const p: Partial<SlideElement> = {};
    if (dir === "l") p.x = 2; if (dir === "c") p.x = 50 - sel.w / 2; if (dir === "r") p.x = 98 - sel.w;
    if (dir === "t") p.y = 2; if (dir === "m") p.y = 50 - sel.h / 2; if (dir === "b") p.y = 98 - sel.h;
    store.updateEl(sel.id, p, true);
  };
  const onImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = ""; if (!file) return;
    const rd = new FileReader(); rd.onload = () => addEl(newImageElement(rd.result as string)); rd.readAsDataURL(file);
  };
  const onImportPptx = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = ""; if (!file || !store.replaceDeck) return;
    try { store.replaceDeck(await importPptxFile(file)); setSelId(null); }
    catch { /* ignore an unreadable / invalid .pptx */ }
  };
  const cmd = (c: string, v?: string) => { document.execCommand("styleWithCSS", false, "true"); document.execCommand(c, false, v); };

  // --- per-element animations ---
  const animOf = (id: string) => active?.anims?.find((a) => a.elementId === id) ?? null;
  const upsertAnim = (id: string, patch: Partial<import("./model").SlideAnim>) => {
    const list = (active?.anims ?? []).slice();
    const i = list.findIndex((a) => a.elementId === id);
    if (i >= 0) list[i] = { ...list[i]!, ...patch };
    else {
      const maxO = list.reduce((m, a) => Math.max(m, a.order), 0);
      list.push({ elementId: id, effect: "fade", order: maxO + 1, durationMs: 500, ...patch });
    }
    store.patchSlide({ anims: list }, true);
  };
  const removeAnim = (id: string) => store.patchSlide({ anims: (active?.anims ?? []).filter((a) => a.elementId !== id) }, true);

  // --- table + chart element editing ---
  const patchTable = (mut: (cells: string[][], t: NonNullable<SlideElement["table"]>) => { rows: number; cols: number; cells: string[][] }) => {
    if (!sel?.table) return;
    const t = sel.table;
    const next = mut(t.cells.map((r) => r.slice()), t);
    store.updateEl(sel.id, { table: next }, true);
  };
  const addRow = () => patchTable((cells, t) => ({ rows: t.rows + 1, cols: t.cols, cells: [...cells, Array(t.cols).fill("")] }));
  const delRow = () => patchTable((cells, t) => (t.rows <= 1 ? t : { rows: t.rows - 1, cols: t.cols, cells: cells.slice(0, -1) }));
  const addCol = () => patchTable((cells, t) => ({ rows: t.rows, cols: t.cols + 1, cells: cells.map((r) => [...r, ""]) }));
  const delCol = () => patchTable((cells, t) => (t.cols <= 1 ? t : { rows: t.rows, cols: t.cols - 1, cells: cells.map((r) => r.slice(0, -1)) }));

  const setChart = (patch: Partial<ChartData>) => { if (!sel?.chart) return; store.updateEl(sel.id, { chart: { ...sel.chart, ...patch } }, true); };
  const setPoint = (i: number, label: string, value: number) => {
    if (!sel?.chart) return;
    const labels = sel.chart.labels.slice(); const values = sel.chart.values.slice();
    labels[i] = label; values[i] = value;
    setChart({ labels, values });
  };
  const addPoint = () => { if (!sel?.chart) return; setChart({ labels: [...sel.chart.labels, "?"], values: [...sel.chart.values, 0] }); };
  const delPoint = (i: number) => { if (!sel?.chart) return; setChart({ labels: sel.chart.labels.filter((_, k) => k !== i), values: sel.chart.values.filter((_, k) => k !== i) }); };

  // --- slide background + templates ---
  const applyBg = (css: string | undefined) => store.patchSlide({ background: css }, true);
  const addTemplate = (tpl: (typeof SLIDE_TEMPLATES)[number]) =>
    store.insertSlide({ id: newSlideId(), title: "", body: "", bodyHtml: "", layout: "blank", elements: tpl.build(), ...(tpl.background ? { background: tpl.background } : {}) } as Slide);

  // --- presenter step navigation (reveals element animations, then advances) ---
  const stepsOf = (i: number) => maxStep(deck.slides[i]?.anims);
  const goNext = () => {
    if (presentStep < stepsOf(presentIdx)) setPresentStep(presentStep + 1);
    else if (presentIdx < deck.slides.length - 1) { setPresentIdx(presentIdx + 1); setPresentStep(0); }
  };
  const goPrev = () => {
    if (presentStep > 0) setPresentStep(presentStep - 1);
    else if (presentIdx > 0) { const p = presentIdx - 1; setPresentIdx(p); setPresentStep(stepsOf(p)); }
  };
  const startPresent = () => { prevIdxRef.current = activeIdx; setMorphFrom(null); setPresentIdx(activeIdx); setPresentStep(0); setPresenting(true); };

  // --- 2nd-screen presenter window, synced over a BroadcastChannel ---
  const chanRef = useRef<BroadcastChannel | null>(null);
  const winRef = useRef<Window | null>(null);
  const startedAtRef = useRef(0);
  const [presenterOn, setPresenterOn] = useState(false);
  const navRef = useRef<{ next: () => void; prev: () => void }>({ next: () => {}, prev: () => {} });
  navRef.current = { next: goNext, prev: goPrev };

  const bcDeck = () => chanRef.current?.postMessage({ type: "deck", slides: deck.slides, theme, title: chrome.title } as PresenterMsg);
  const bcPos = (present: boolean) => chanRef.current?.postMessage({ type: "pos", idx: presentIdx, step: presentStep, startedAt: startedAtRef.current, presenting: present } as PresenterMsg);

  const openPresenter = () => {
    startedAtRef.current = Date.now();
    prevIdxRef.current = activeIdx; setMorphFrom(null);
    winRef.current = window.open(`${window.location.pathname}?presenter=1`, "elium-presenter", "width=1200,height=800");
    setPresentIdx(activeIdx); setPresentStep(0); setPresenting(true); setPresenterOn(true);
  };
  const stopPresent = () => {
    setPresenting(false);
    try { chanRef.current?.postMessage({ type: "end" } as PresenterMsg); } catch { /* ignore */ }
    try { winRef.current?.close(); } catch { /* ignore */ }
    winRef.current = null;
    setPresenterOn(false);
  };

  useEffect(() => {
    if (!presenterOn || typeof BroadcastChannel === "undefined") return;
    const ch = new BroadcastChannel(PRESENTER_CHANNEL);
    chanRef.current = ch;
    ch.onmessage = (e: MessageEvent) => {
      const m = e.data as PresenterMsg;
      if (m.type === "ready") { bcDeck(); bcPos(true); }
      else if (m.type === "nav") { if (m.dir === "next") navRef.current.next(); else navRef.current.prev(); }
    };
    bcDeck(); bcPos(true);
    return () => { try { ch.close(); } catch { /* ignore */ } chanRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presenterOn]);
  useEffect(() => { if (presenterOn) bcDeck(); }, [presenterOn, deck.slides, theme]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (presenterOn) bcPos(presenting); }, [presenterOn, presentIdx, presentStep, presenting]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { try { winRef.current?.close(); } catch { /* ignore */ } }, []);

  // keyboard: undo/redo + delete
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (presenting) return;
      const t = e.target as HTMLElement;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if ((e.ctrlKey || e.metaKey) && !typing && store.undo && store.redo) {
        const k = e.key.toLowerCase();
        if (k === "z" && !e.shiftKey) { e.preventDefault(); store.undo(); }
        else if (k === "y" || (k === "z" && e.shiftKey)) { e.preventDefault(); store.redo(); }
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selId && !typing && canWrite) { e.preventDefault(); removeEl(selId); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store, presenting, selId, canWrite]); // eslint-disable-line react-hooks/exhaustive-deps

  // presenter nav (step through element animations, then between slides)
  useEffect(() => {
    if (!presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") { e.preventDefault(); goNext(); }
      else if (e.key === "ArrowLeft" || e.key === "PageUp") { e.preventDefault(); goPrev(); }
      else if (e.key === "Escape") stopPresent();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [presenting, presentIdx, presentStep, deck.slides]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trigger a real Morph transition when the presented slide index changes.
  useEffect(() => {
    const from = prevIdxRef.current;
    prevIdxRef.current = presentIdx;
    if (!presenting || from === presentIdx) return;
    const trans = deck.slides[presentIdx]?.transition ?? deck.transition ?? "none";
    setMorphFrom(trans === "morph" && deck.slides[from] ? from : null);
  }, [presentIdx, presenting]); // eslint-disable-line react-hooks/exhaustive-deps

  const isText = sel?.type === "text";
  const isShape = sel?.type === "shape";
  const isTable = sel?.type === "table";
  const isChart = sel?.type === "chart";
  const peers = store.presence?.peers;

  return (
    <div className={`slides-app ${chrome.variant === "modal" ? "slides-app--modal" : ""}`}>
      {/* Top bar */}
      <div className="sheet-bar">
        {chrome.onHome && <button className="eb eb--sm eb--ghost" onClick={chrome.onHome}><Home size={16} /> Accueil</button>}
        <span className="sheet-bar__title">{chrome.titleIcon ?? <Presentation size={16} />} {chrome.title}</span>
        {store.undo && store.redo && (
          <>
            <button className="icon-btn" title="Annuler (Ctrl+Z)" onClick={store.undo} disabled={!store.canUndo}><Undo2 size={16} /></button>
            <button className="icon-btn" title="Rétablir (Ctrl+Y)" onClick={store.redo} disabled={!store.canRedo}><Redo2 size={16} /></button>
          </>
        )}
        <div className="sheet-bar__spacer" />
        {chrome.statusNode}
        {canWrite && (
          <>
            <select className="tool-select" title="Thème" value={theme} onChange={(e) => store.setDeckField({ theme: e.target.value as SlideTheme })}>
              {THEMES.map((t) => <option key={t.value} value={t.value}>Thème : {t.label}</option>)}
            </select>
            <select className="tool-select" title="Transition" value={deck.transition ?? "fade"} onChange={(e) => store.setDeckField({ transition: e.target.value as SlideTransition })}>
              {TRANSITIONS.map((t) => <option key={t.value} value={t.value}>Transition : {t.label}</option>)}
            </select>
            <div className="sv-menu">
              <button className={`icon-btn ${active?.background ? "is-active" : ""}`} title="Fond de la diapo" onClick={() => setBgMenu((v) => !v)}><Palette size={16} /></button>
              {bgMenu && (
                <div className="sv-menu__pop sv-bg-pop sv-bg-pop--right" onMouseLeave={() => setBgMenu(false)}>
                  <div className="sv-anim-hint">Fond de la diapo</div>
                  <button className="eb eb--sm eb--ghost" onClick={() => applyBg(undefined)}>Aucun (thème)</button>
                  <div className="sv-bg-label">Couleur unie</div>
                  <div className="sv-bg-swatches">
                    {SOLID_PRESETS.map((c) => <button key={c} className="sv-swatch" style={{ background: c }} onClick={() => applyBg(c)} />)}
                    <label className="sv-swatch sv-swatch--pick" title="Couleur personnalisée"><input type="color" onChange={(e) => applyBg(e.target.value)} /></label>
                  </div>
                  <div className="sv-bg-label">Dégradé</div>
                  <div className="sv-bg-swatches">
                    {GRADIENT_PRESETS.map((g) => <button key={g} className="sv-swatch sv-swatch--grad" style={{ backgroundImage: g }} onClick={() => applyBg(g)} />)}
                  </div>
                  <div className="sv-bg-grad">
                    <input type="color" title="Couleur 1" value={bgC1} onChange={(e) => setBgC1(e.target.value)} />
                    <input type="color" title="Couleur 2" value={bgC2} onChange={(e) => setBgC2(e.target.value)} />
                    <input className="input sv-num" type="number" min={0} max={360} title="Angle" value={bgAngle} onChange={(e) => setBgAngle(Number(e.target.value))} />
                    <button className="eb eb--sm eb--outline" onClick={() => applyBg(gradientCss(bgC1, bgC2, bgAngle))}>Dégradé</button>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
        {canWrite && store.replaceDeck && (
          <>
            <button className="eb eb--sm eb--outline" title="Importer un PowerPoint (.pptx)" onClick={() => pptxRef.current?.click()}><Upload size={14} /> Importer</button>
            <input ref={pptxRef} type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" hidden onChange={onImportPptx} />
          </>
        )}
        {chrome.headerActions}
        <button className="icon-btn" title="Vue présentateur (2ᵉ écran : notes + minuteur + aperçu)" onClick={openPresenter}><MonitorPlay size={16} /></button>
        <button className="eb eb--sm eb--primary" onClick={startPresent}><Play size={14} /> Présenter</button>
        {chrome.onClose && <button className="icon-btn" title="Fermer" onClick={chrome.onClose}><X size={18} /></button>}
      </div>

      {/* Insert / element toolbar */}
      {canWrite && (
        <div className="sv-toolbar">
          <button className="eb eb--sm eb--ghost" onClick={() => addEl(newTextElement())}><Type size={15} /> Texte</button>
          <div className="sv-menu">
            <button className="eb eb--sm eb--ghost" onClick={() => setShapeMenu((v) => !v)}><Square size={15} /> Forme ▾</button>
            {shapeMenu && (
              <div className="sv-menu__pop" onMouseLeave={() => setShapeMenu(false)}>
                {SHAPES.map((s) => (
                  <button key={s.kind} className="sv-menu__item" onClick={() => { addEl(newShapeElement(s.kind)); setShapeMenu(false); }}>{s.icon} {s.label}</button>
                ))}
              </div>
            )}
          </div>
          <button className="eb eb--sm eb--ghost" onClick={() => imgRef.current?.click()}><ImageIcon size={15} /> Image</button>
          <input ref={imgRef} type="file" accept="image/*" hidden onChange={onImage} />
          <button className="eb eb--sm eb--ghost" onClick={() => addEl(newTableElement())}><TableIcon size={15} /> Tableau</button>
          <div className="sv-menu">
            <button className="eb eb--sm eb--ghost" onClick={() => setChartInsMenu((v) => !v)}><BarChart3 size={15} /> Graphique ▾</button>
            {chartInsMenu && (
              <div className="sv-menu__pop" onMouseLeave={() => setChartInsMenu(false)}>
                {([["bar", "Barres"], ["line", "Courbe"], ["pie", "Camembert"]] as [ChartKind, string][]).map(([k, label]) => (
                  <button key={k} className="sv-menu__item" onClick={() => { addEl(newChartElement(k)); setChartInsMenu(false); }}>{label}</button>
                ))}
              </div>
            )}
          </div>
          <span className="sv-sep" />

          {/* Text formatting (act on the focused contentEditable) */}
          {isText && (
            <>
              <select className="tool-select" title="Police" value={sel!.fontFamily ?? DEFAULT_FONT} onChange={(e) => store.updateEl(sel!.id, { fontFamily: e.target.value })} style={{ maxWidth: 130 }}>
                {allFontNames().map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <input className="input sv-num" type="number" min={6} max={200} title="Taille" value={Math.round(sel!.fontSize ?? 24)} onChange={(e) => store.updateEl(sel!.id, { fontSize: Number(e.target.value) })} />
              <button className="icon-btn" title="Gras" onMouseDown={(e) => { e.preventDefault(); cmd("bold"); }}><Bold size={15} /></button>
              <button className="icon-btn" title="Italique" onMouseDown={(e) => { e.preventDefault(); cmd("italic"); }}><Italic size={15} /></button>
              <button className="icon-btn" title="Souligné" onMouseDown={(e) => { e.preventDefault(); cmd("underline"); }}><Underline size={15} /></button>
              <button className="icon-btn" title="Liste à puces" onMouseDown={(e) => { e.preventDefault(); cmd("insertUnorderedList"); }}><List size={15} /></button>
              <button className="icon-btn" title="Liste numérotée" onMouseDown={(e) => { e.preventDefault(); cmd("insertOrderedList"); }}><ListOrdered size={15} /></button>
              <div className="sv-menu">
                <button className="icon-btn" title="Couleur du texte" onClick={() => setColorMenu((v) => !v)}><Baseline size={15} /></button>
                {colorMenu && (
                  <div className="sv-menu__pop sv-colors" onMouseLeave={() => setColorMenu(false)}>
                    {TEXT_COLORS.map((c) => <button key={c} className="sv-swatch" style={{ background: c }} onClick={() => { store.updateEl(sel!.id, { color: c }); setColorMenu(false); }} />)}
                  </div>
                )}
              </div>
              <button className="icon-btn" title="Aligner à gauche" onClick={() => store.updateEl(sel!.id, { align: "left" })}><AlignLeft size={15} /></button>
              <button className="icon-btn" title="Centrer" onClick={() => store.updateEl(sel!.id, { align: "center" })}><AlignCenter size={15} /></button>
              <button className="icon-btn" title="Aligner à droite" onClick={() => store.updateEl(sel!.id, { align: "right" })}><AlignRight size={15} /></button>
            </>
          )}
          {isShape && (
            <>
              <label className="tool-color" title="Remplissage"><span>Fond</span><input type="color" value={sel!.fill === "transparent" ? "#ffffff" : (sel!.fill ?? "#bfdbfe")} onChange={(e) => store.updateEl(sel!.id, { fill: e.target.value })} /></label>
              <button className="eb eb--sm eb--ghost" onClick={() => store.updateEl(sel!.id, { fill: "transparent" })}>Sans fond</button>
              <label className="tool-color" title="Contour"><span>Trait</span><input type="color" value={sel!.stroke ?? "#2563eb"} onChange={(e) => store.updateEl(sel!.id, { stroke: e.target.value })} /></label>
              <input className="input sv-num" type="number" min={0} max={20} title="Épaisseur" value={sel!.strokeWidth ?? 2} onChange={(e) => store.updateEl(sel!.id, { strokeWidth: Number(e.target.value) })} />
              <input className="input sv-shape-text" placeholder="Texte" value={sel!.text ?? ""} onChange={(e) => store.updateEl(sel!.id, { text: e.target.value })} />
            </>
          )}
          {isTable && (
            <>
              <button className="eb eb--sm eb--ghost" title="Ajouter une ligne" onClick={addRow}><PlusIcon size={13} /> Ligne</button>
              <button className="eb eb--sm eb--ghost" title="Supprimer la dernière ligne" onClick={delRow}><MinusIcon size={13} /> Ligne</button>
              <button className="eb eb--sm eb--ghost" title="Ajouter une colonne" onClick={addCol}><PlusIcon size={13} /> Col.</button>
              <button className="eb eb--sm eb--ghost" title="Supprimer la dernière colonne" onClick={delCol}><MinusIcon size={13} /> Col.</button>
              <span className="sv-anim-hint">Double-cliquez une cellule pour l'éditer</span>
            </>
          )}
          {isChart && sel!.chart && (
            <div className="sv-menu">
              <button className="eb eb--sm eb--ghost" onClick={() => setChartMenu((v) => !v)}><BarChart3 size={14} /> Données ▾</button>
              {chartMenu && (
                <div className="sv-menu__pop sv-chart-pop" onMouseLeave={() => setChartMenu(false)}>
                  <label className="sv-anim-row"><span>Type</span>
                    <select className="input" value={sel!.chart.kind} onChange={(e) => setChart({ kind: e.target.value as ChartKind })}>
                      <option value="bar">Barres</option><option value="line">Courbe</option><option value="pie">Camembert</option>
                    </select>
                  </label>
                  <div className="sv-chart-points">
                    {sel!.chart.labels.map((lb, i) => (
                      <div key={i} className="sv-chart-row">
                        <input className="input" value={lb} placeholder="Libellé" onChange={(e) => setPoint(i, e.target.value, sel!.chart!.values[i] ?? 0)} />
                        <input className="input sv-num" type="number" value={sel!.chart!.values[i] ?? 0} onChange={(e) => setPoint(i, sel!.chart!.labels[i] ?? "", Number(e.target.value))} />
                        <button className="icon-btn icon-btn--danger" title="Retirer le point" onClick={() => delPoint(i)}><Trash2 size={13} /></button>
                      </div>
                    ))}
                  </div>
                  <button className="eb eb--sm eb--outline" onClick={addPoint}><PlusIcon size={13} /> Point</button>
                </div>
              )}
            </div>
          )}

          {sel && (
            <>
              <span className="sv-sep" />
              <button className="icon-btn" title="Aligner à gauche de la diapo" onClick={() => alignSlide("l")}><AlignStartVertical size={15} /></button>
              <button className="icon-btn" title="Centrer horizontalement" onClick={() => alignSlide("c")}><AlignCenterVertical size={15} /></button>
              <button className="icon-btn" title="Aligner à droite de la diapo" onClick={() => alignSlide("r")}><AlignEndVertical size={15} /></button>
              <button className="icon-btn" title="Aligner en haut" onClick={() => alignSlide("t")}><AlignStartHorizontal size={15} /></button>
              <button className="icon-btn" title="Centrer verticalement" onClick={() => alignSlide("m")}><AlignCenterHorizontal size={15} /></button>
              <button className="icon-btn" title="Aligner en bas" onClick={() => alignSlide("b")}><AlignEndHorizontal size={15} /></button>
              <span className="sv-sep" />
              <button className="icon-btn" title="Pivoter (+15°)" onClick={() => store.updateEl(sel.id, { rotation: ((sel.rotation ?? 0) + 15) % 360 })}><RotateCw size={15} /></button>
              <button className="icon-btn" title="Premier plan" onClick={() => store.reorderEl(sel.id, "front")}><BringToFront size={15} /></button>
              <button className="icon-btn" title="Arrière-plan" onClick={() => store.reorderEl(sel.id, "back")}><SendToBack size={15} /></button>
              <span className="sv-sep" />
              <div className="sv-menu">
                <button className={`icon-btn ${animOf(sel.id) ? "is-active" : ""}`} title="Animation d'entrée" onClick={() => setAnimMenu((v) => !v)}><Sparkles size={15} /></button>
                {animMenu && (
                  <div className="sv-menu__pop sv-anim-pop" onMouseLeave={() => setAnimMenu(false)}>
                    {(() => {
                      const a = animOf(sel.id);
                      if (!a) return <button className="eb eb--sm eb--outline" onClick={() => upsertAnim(sel.id, {})}><Sparkles size={13} /> Ajouter une animation</button>;
                      return (
                        <>
                          <label className="sv-anim-row"><span>Effet</span>
                            <select className="input" value={a.effect} onChange={(e) => upsertAnim(sel.id, { effect: e.target.value as AnimEffect })}>
                              {ANIM_EFFECTS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                            </select>
                          </label>
                          <label className="sv-anim-row"><span>Ordre au clic</span>
                            <input className="input" type="number" min={0} max={50} value={a.order} onChange={(e) => upsertAnim(sel.id, { order: Number(e.target.value) })} />
                          </label>
                          <label className="sv-anim-row"><span>Durée (ms)</span>
                            <input className="input" type="number" min={100} max={5000} step={50} value={a.durationMs ?? 500} onChange={(e) => upsertAnim(sel.id, { durationMs: Number(e.target.value) })} />
                          </label>
                          <div className="sv-anim-hint">0 = avec la diapo · 1, 2… = clics successifs</div>
                          <button className="eb eb--sm eb--ghost" onClick={() => { removeAnim(sel.id); setAnimMenu(false); }}><Trash2 size={13} /> Retirer l'animation</button>
                        </>
                      );
                    })()}
                  </div>
                )}
              </div>
              <button className="icon-btn" title="Dupliquer" onClick={() => duplicateEl(sel.id)}><Copy size={15} /></button>
              <button className="icon-btn icon-btn--danger" title="Supprimer" onClick={() => removeEl(sel.id)}><Trash2 size={15} /></button>
            </>
          )}
        </div>
      )}

      <div className="slides-body">
        {/* Rail */}
        <aside className="slides-rail">
          {deck.slides.map((s, i) => {
            const here = peers?.filter((p) => p.slide === i) ?? [];
            return (
              <div key={s.id} className={`slide-thumb ${i === activeIdx ? "is-active" : ""}`}>
                <button className="slide-thumb__preview sv-thumb" onClick={() => store.setActive(i)}>
                  <span className="slide-thumb__num">{i + 1}</span>
                  <span className="sv-thumb__canvas"><SlideCanvas slide={s} elements={s.elements ?? elementsOf(s)} theme={theme} scale={90 / REF_H} /></span>
                  {here.map((p, k) => <span key={k} className="dc-slides__peerdot" style={{ background: p.color }} title={p.name} />)}
                </button>
                {canWrite && (
                  <div className="slide-thumb__actions">
                    <button className="icon-btn" title="Monter" onClick={() => store.moveSlide(i, -1)} disabled={i === 0}>▲</button>
                    <button className="icon-btn" title="Descendre" onClick={() => store.moveSlide(i, 1)} disabled={i === deck.slides.length - 1}>▼</button>
                    <button className="icon-btn" title="Dupliquer" onClick={() => store.duplicateSlide(i)}><Copy size={13} /></button>
                    <button className="icon-btn icon-btn--danger" title="Supprimer" onClick={() => store.removeSlide(i)} disabled={deck.slides.length <= 1}><Trash2 size={13} /></button>
                  </div>
                )}
              </div>
            );
          })}
          {canWrite && (
            <div className="sv-add-row">
              <button className="eb eb--sm eb--outline" onClick={() => store.addSlide(false)}><Plus size={13} /> Diapo</button>
              <button className="eb eb--sm eb--ghost" onClick={() => store.addSlide(true)}><LayoutTemplate size={13} /> Vierge</button>
              <div className="sv-menu">
                <button className="eb eb--sm eb--ghost" onClick={() => setTplMenu((v) => !v)}><LayoutGrid size={13} /> Modèles ▾</button>
                {tplMenu && (
                  <div className="sv-menu__pop sv-tpl-pop" onMouseLeave={() => setTplMenu(false)}>
                    {SLIDE_TEMPLATES.map((tpl) => (
                      <button key={tpl.id} className="sv-tpl-item" onClick={() => { addTemplate(tpl); setTplMenu(false); }}>
                        <span className="sv-tpl-preview" style={tpl.background ? { backgroundImage: tpl.background.startsWith("linear") ? tpl.background : undefined, background: tpl.background.startsWith("linear") ? undefined : tpl.background } : undefined} />
                        {tpl.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </aside>

        {/* Stage */}
        <main className="sv-stage">
          <div className="sv-canvas-wrap" ref={stageRef}>
            {active && (
              <SlideCanvas
                slide={active}
                elements={elements}
                theme={theme}
                scale={scale}
                editable={canWrite}
                selectedId={selId}
                onSelect={setSelId}
                onChange={(id, patch, commit) => store.updateEl(id, patch, commit)}
                onBeginChange={store.beginChange}
              />
            )}
          </div>
          <div className="sv-hint">Cliquez pour sélectionner · double-cliquez un texte pour l'éditer · glissez pour déplacer · poignées pour redimensionner/pivoter</div>
          <textarea
            className="input sv-notes"
            rows={2}
            placeholder="Notes de l'orateur (privées — visibles seulement par vous)"
            value={active?.notes ?? ""}
            readOnly={!canWrite}
            onFocus={store.beginChange}
            onChange={(e) => store.patchSlide({ notes: e.target.value })}
          />
        </main>
      </div>

      {presenting && (() => {
        const cur = deck.slides[presentIdx];
        const curEls = cur ? (cur.elements ?? elementsOf(cur)) : [];
        const steps = maxStep(cur?.anims);
        const reveal = revealAt(curEls, cur?.anims, presentStep);
        const trans = cur ? (cur.transition ?? deck.transition ?? "none") : "none";
        const atStart = presentIdx === 0 && presentStep === 0;
        const atEnd = presentIdx === deck.slides.length - 1 && presentStep >= steps;
        const presentScale = (typeof window !== "undefined" ? Math.min(window.innerWidth * 0.9, 1100) * 9 / 16 : 620) / REF_H;
        const morphing = morphFrom != null && !!deck.slides[morphFrom];
        return (
          <div className="present-overlay">
            <button className="present-close icon-btn" title="Quitter (Échap)" onClick={stopPresent}><X size={22} /></button>
            <button className="present-arrow present-arrow--prev icon-btn" onClick={goPrev} disabled={atStart}><ChevronLeft size={28} /></button>
            <div className="present-stage" onClick={goNext}>
              {cur && (
                <div key={morphing ? `m${presentIdx}` : presentIdx} className={`present-anim sv-present-canvas ${trans !== "none" && trans !== "morph" ? `pt-${trans}` : ""}`}>
                  {morphing
                    ? <MorphCanvas prev={deck.slides[morphFrom]!} next={cur} theme={theme} scale={presentScale} onDone={() => setMorphFrom(null)} />
                    : <SlideCanvas slide={cur} elements={curEls} theme={theme} reveal={reveal} scale={presentScale} />}
                </div>
              )}
            </div>
            <button className="present-arrow present-arrow--next icon-btn" onClick={goNext} disabled={atEnd}><ChevronRight size={28} /></button>
            <div className="present-nav">{presentIdx + 1} / {deck.slides.length}{steps > 0 ? ` · ${presentStep}/${steps}` : ""}</div>
          </div>
        );
      })()}
    </div>
  );
}
