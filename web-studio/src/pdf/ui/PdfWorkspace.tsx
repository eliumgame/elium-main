import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Command,
  FileText,
  Home,
  Loader2,
  Maximize2,
  PanelLeftClose,
  PanelLeftOpen,
  Search,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { downloadBlob } from "../../export/exporters";
import { useDialogs } from "../../ui/dialogs";
import { useUndoable } from "../../ui/useUndoable";
import { getCustomFont, isCustomFont, registerCustomFont } from "../../ui/fonts";
import type { Quad, Rotation, Size } from "../core/coords";
import { clamp, normRotation, rectOfQuads } from "../core/coords";
import { PdfEngine, PdfPasswordRequired, type Attachment, type LayerInfo } from "../core/engine";
import { releaseThumbnails } from "../core/thumbs";
import { loadViewerLib } from "../core/viewer/lib";
import { fitScale } from "../core/viewer/layout";
import { buildRuns, groupLines, quadsForCharRange, quadsFromSelection, selectionTextIn } from "../core/text";
import { DEFAULT_SEARCH_OPTIONS, search as runSearch, type SearchHit } from "../core/search";
import * as D from "../model/doc";
import type {
  Annot,
  AnnotKind,
  Bookmark,
  ContentEdit,
  FormValue,
  MeasureScale,
  Page,
  PdfState,
  Tool,
} from "../model/types";
import { EMPTY_FILTER, type CommentFilter, type CommentSort } from "../model/doc";
import { DEFAULT_STYLE, emptyState, isTextMarkup, newId, styleForKind, toolIsAnnot } from "../model/types";
import { base64ToBytes, bytesToBase64, deserialize, serialize, type PdfFile } from "../model/persist";
import {
  extractLayout,
  exportImages,
  toDocx,
  toHtml,
  toPlainTextWithMarkers,
  detectTables,
  tablesToCsv,
  zipImages,
} from "../ops/export";
import { comparePages, type ComparisonReport } from "../ops/compare";
import { DEFAULT_BUILD, buildPdf, type BuildOptions } from "../ops/save";
import {
  extractPages,
  mergeDocuments,
  parsePageRange,
  pdfFromImages,
  splitDocument,
  PAGE_SIZES,
} from "../ops/organize";
import { WrongPassword, inspectProtection, removeProtection, type Permissions } from "../ops/security";
// signPdfBytes/verifyPdfSignatures/generateSelfSignedP12 pull in node-forge, a
// heavy dependency only actual signers need — they're loaded dynamically at
// the point of use below (see onP12Pick/signSelfSigned/verifySignatures),
// same pattern as drive-cloud/ui/SignLinkView.tsx. Only the type survives as
// a static import: `import type` is erased at compile time, so it doesn't
// pull pades.ts (or node-forge) into this bundle.
import type { PadesSignOptions } from "../ops/pades";
import { fromFdf, suggestFields, toCsv, toFdf } from "../ops/forms";
import { fromXfdf, toXfdf } from "../ops/xfdf";
import {
  hasImportableAnnots,
  importPageAnnots,
  resolveStampAppearanceImages,
  type RawAnnotation,
} from "../ops/import-annots";
import { recognise, writeOcrLayer, hasLocalModels, type OcrLanguage } from "../ops/ocr";
import type { SavedSignature } from "../ops/sign";
import AnnotLayer from "./AnnotLayer";
import ContentEditLayer from "./ContentEditLayer";
import ContentEditPreview from "./ContentEditPreview";
import FormLayer from "./FormLayer";
import Inspector from "./Inspector";
import Organize from "./Organize";
import PageStack, { type HitMark, type OverlayGeometry, type PageStackHandle } from "./PageStack";
import Ribbon from "./Ribbon";
import Sidebar, { PANEL_ICONS } from "./Sidebar";
import {
  CompareDialog,
  CropDialog,
  ExportImagesDialog,
  HeaderFooterDialog,
  InsertPagesDialog,
  MeasureScaleDialog,
  OcrDialog,
  PageLabelsDialog,
  PasswordPrompt,
  PropertiesDialog,
  ProtectDialog,
  RedactSearchDialog,
  SaveDialog,
  SignatureDialog,
  SplitDialog,
  WatermarkDialog,
} from "./dialogs";
import {
  DEFAULT_SEARCH,
  DEFAULT_VIEW,
  MAX_SCALE,
  MIN_SCALE,
  READING_THEMES,
  TOOL_TAB,
  ZOOM_PRESETS,
  type RibbonTab,
  type SidePanel,
  type Toast,
  type ViewState,
} from "./state";
import "./pdf.css";

type DialogId =
  | null
  | "save"
  | "protect"
  | "watermark"
  | "headerFooter"
  | "properties"
  | "exportImages"
  | "ocr"
  | "signature"
  | "split"
  | "crop"
  | "labels"
  | "measure"
  | "compare"
  | "insert"
  | "redactSearch";

type Mode = "view" | "organise" | "editText" | "form" | "fields";

interface Props {
  onHome: () => void;
  initial?: PdfFile | unknown;
  onExportElium?: (data: PdfFile, title: string) => void;
  author?: string;
}

let toastSeq = 1;

// Shared empty array for the annots-by-page / edits-by-page lookups below —
// a page with none must still get *a* stable reference, not a fresh `[]`
// every render (that alone would defeat AnnotLayer/ContentEditLayer's memo).
// `never[]` is assignable to both `Annot[]` and `ContentEdit[]` (and any
// other array-typed prop) since arrays are covariant in TS.
const EMPTY_ARRAY: never[] = [];

export default function PdfWorkspace({ onHome, initial, onExportElium, author = "Moi" }: Props) {
  const dialogs = useDialogs();

  // --- document -------------------------------------------------------------
  const [engine, setEngine] = useState<PdfEngine | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const passwordRef = useRef<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [pendingPassword, setPendingPassword] = useState<{ bytes: Uint8Array; name: string; wrong: boolean } | null>(
    null,
  );

  const {
    value: state,
    set: setState,
    setQuiet,
    checkpoint,
    undo,
    redo,
    canUndo,
    canRedo,
    reset,
    amend,
  } = useUndoable<PdfState>(emptyState());

  // --- view -----------------------------------------------------------------
  const [view, setView] = useState<ViewState>(DEFAULT_VIEW);
  const [mode, setMode] = useState<Mode>("view");
  const [tab, setTab] = useState<RibbonTab>("home");
  const [panel, setPanel] = useState<SidePanel | null>("thumbnails");
  const [tool, setTool] = useState<Tool>("textSelect");
  const [style, setStyle] = useState(DEFAULT_STYLE);
  const [sticky, setSticky] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedPages, setSelectedPages] = useState<string[]>([]);
  const [inspector, setInspector] = useState(true);

  // --- search ---------------------------------------------------------------
  const [searchState, setSearchState] = useState(DEFAULT_SEARCH);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const pageTextsRef = useRef<string[] | null>(null);
  const [hitQuads, setHitQuads] = useState<Map<number, Quad[][]>>(new Map());

  // --- ancillary ------------------------------------------------------------
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [layers, setLayers] = useState<LayerInfo[]>([]);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [ocConfig, setOcConfig] = useState<unknown>(undefined);
  const [filter, setFilter] = useState<CommentFilter>(EMPTY_FILTER);
  const [sort, setSort] = useState<CommentSort>("page");
  const [signatures, setSignatures] = useState<SavedSignature[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<DialogId>(null);
  const [buildOptions, setBuildOptions] = useState<BuildOptions>({ ...DEFAULT_BUILD, author });
  const [compareReport, setCompareReport] = useState<ComparisonReport | null>(null);
  const [compareBusy, setCompareBusy] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<{ page: number; total: number; stage: string; ratio: number } | null>(
    null,
  );
  const [localModels, setLocalModels] = useState(false);
  const ocrAbort = useRef<AbortController | null>(null);
  const [hasForm, setHasForm] = useState(false);
  const [busy, setBusy] = useState(false);

  const stackRef = useRef<PageStackHandle>(null);
  /** Size of the page viewport (reported by PageStack) — what the fit zooms fit into. */
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  /** Bumped when the engine learns a page's real geometry (sizes start as estimates). */
  const [geometryVersion, setGeometryVersion] = useState(0);
  /** Bumped when the engine's background facts (form, signature) are final. */
  const [, setInfoVersion] = useState(0);
  /** Live text layers by page id, with the slot they sit in (the page's view origin). */
  const textLayers = useRef(new Map<string, { layer: HTMLElement; host: HTMLElement }>());
  const openInput = useRef<HTMLInputElement>(null);
  const mergeInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const dataInput = useRef<HTMLInputElement>(null);
  const p12Input = useRef<HTMLInputElement>(null);
  const compareInput = useRef<HTMLInputElement>(null);
  const pendingImageAt = useRef<{ pageId: string; x: number; y: number } | null>(null);

  const pages = state.pages;
  const pageCount = pages.length;
  // Read by `goTo` below via ref rather than closure so that callback keeps
  // one stable identity across renders that only change the page count —
  // it still always clamps against the *current* count, just without that
  // forcing every PageView's memoized `onLinkActivate` to look "changed".
  const pageCountRef = useRef(pageCount);
  useEffect(() => {
    pageCountRef.current = pageCount;
  }, [pageCount]);

  // Grouped once per render instead of `state.annots.filter(a => a.pageId
  // === page.id)` / `state.contentEdits.filter(...)` re-scanning the full
  // array for every visible page below — and, crucially, each page's list
  // keeps the SAME array reference across renders where it didn't change,
  // which is what lets AnnotLayer/ContentEditLayer's memo actually skip work.
  const annotsByPage = useMemo(() => {
    const map = new Map<string, Annot[]>();
    for (const a of state.annots) {
      const list = map.get(a.pageId);
      if (list) list.push(a);
      else map.set(a.pageId, [a]);
    }
    return map;
  }, [state.annots]);
  const contentEditsByPage = useMemo(() => {
    const map = new Map<string, ContentEdit[]>();
    for (const e of state.contentEdits) {
      const list = map.get(e.pageId);
      if (list) list.push(e);
      else map.set(e.pageId, [e]);
    }
    return map;
  }, [state.contentEdits]);

  // -------------------------------------------------------------------------
  // Toasts
  // -------------------------------------------------------------------------
  const toast = useCallback((tone: Toast["tone"], text: string, detail?: string) => {
    const id = toastSeq++;
    setToasts((v) => [...v.filter((t) => t.tone !== "progress" || tone !== "progress"), { id, tone, text, detail }]);
    if (tone !== "progress") setTimeout(() => setToasts((v) => v.filter((t) => t.id !== id)), 5200);
    return id;
  }, []);
  const dismissToast = (id: number) => setToasts((v) => v.filter((t) => t.id !== id));

  // -------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------
  /** Identifies the document being opened: background work for an older one is dropped. */
  const openGeneration = useRef(0);
  /** Remounts the page surface (fresh scroll position, fresh page views) for each document. */
  const [docKey, setDocKey] = useState(0);

  /**
   * Markup the file already carries becomes editable Elium markup, so a review
   * started in Acrobat continues here instead of being read-only. This used to
   * walk every page (getPage + getAnnotations, one round trip each, in
   * sequence) BEFORE the document appeared — seconds on a long file. It now
   * runs after the first paint, a few pages at a time, and lands in one atomic
   * step: `importedAnnots` flips to true only once every page is imported, so
   * until then pdf.js keeps painting the originals and an export writes them
   * back untouched. The result is folded into the whole undo history
   * (`amend`): it is part of the document, not an edit to undo.
   */
  const importExistingMarkup = useCallback(
    async (next: PdfEngine, sourcePages: readonly Page[], gen: number) => {
      const froms = [...new Set(sourcePages.map((q) => q.from).filter((f): f is number => f != null))];
      const raws = new Map<number, RawAnnotation[]>();
      let cursor = 0;
      const worker = async () => {
        while (cursor < froms.length && gen === openGeneration.current) {
          const from = froms[cursor++];
          const raw = (await next.annotations(from)) as RawAnnotation[];
          if (hasImportableAnnots(raw)) raws.set(from, raw);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, froms.length) }, worker));
      if (gen !== openGeneration.current || !raws.size) return;

      // A Stamp's own picture never comes back from pdf.js's getAnnotations()
      // (only a `hasAppearance` boolean) — resolving it needs a separate walk
      // of the source bytes with pdf-lib, keyed by annotation. That walk parses
      // the whole document, so it only runs when some stamp has a picture.
      const needsPictures = [...raws.values()].some((raw) => raw.some((a) => a.subtype === "Stamp" && a.hasAppearance));
      const appearances = needsPictures
        ? await resolveStampAppearanceImages(next.bytes, next.password).catch(
            () => new Map<number, Map<string, NonNullable<RawAnnotation["appearanceImage"]>>>(),
          )
        : null;
      if (gen !== openGeneration.current) return;

      const byFrom = new Map<number, Annot[]>();
      for (const page of sourcePages) {
        if (page.from == null || byFrom.has(page.from)) continue;
        const raw = raws.get(page.from);
        if (!raw) continue;
        const pageAppearances = appearances?.get(page.from);
        const withImages = pageAppearances?.size
          ? raw.map((a) =>
              a.id && pageAppearances.has(a.id) ? { ...a, appearanceImage: pageAppearances.get(a.id) } : a,
            )
          : raw;
        const info = await next.pageInfo(page.from);
        const origin = { x: info.ox, y: info.oy };
        byFrom.set(page.from, importPageAnnots(withImages, page.id, info.h, author, origin).annots);
      }
      if (gen !== openGeneration.current || !byFrom.size) return;
      const originals = new Map(sourcePages.map((q) => [q.id, q.from]));
      let count = 0;
      for (const list of byFrom.values()) count += list.length;

      amend((s) => {
        if (s.importedAnnots) return s;
        const added: Annot[] = [];
        for (const page of s.pages) {
          const list = page.from != null ? byFrom.get(page.from) : undefined;
          if (!list) continue;
          // The page the import was computed for keeps those annotations; a
          // copy of it made in the meantime gets copies.
          if (originals.get(page.id) === page.from && list[0]?.pageId === page.id) added.push(...list);
          else added.push(...list.map((a) => ({ ...D.cloneAnnot(a), pageId: page.id })));
        }
        return { ...s, annots: [...added, ...s.annots], importedAnnots: true };
      });
      setPanel((p) => (p === "thumbnails" ? "comments" : p));
      toast("info", `${count} annotation(s) importée(s)`, "Le balisage déjà présent est modifiable et répondable.");
    },
    [amend, author, toast],
  );

  const openBytes = useCallback(
    async (raw: Uint8Array, name: string, password?: string, restore?: PdfState) => {
      setLoading(true);
      setLoadError("");
      try {
        // Only the document, page 1 and the metadata are awaited: everything
        // else (page sizes, bookmarks, existing markup, attachments, layers,
        // form/signature facts) is filled in the background.
        const next = await PdfEngine.open(raw, password);
        engine?.destroy();
        const gen = ++openGeneration.current;
        bytesRef.current = raw.slice();
        passwordRef.current = password ?? null;
        const sourcePages = restore?.pages ?? D.pagesFromSource(next.pageCount);
        const base: PdfState = restore ?? {
          ...emptyState(),
          pages: sourcePages,
          annots: [],
          importedAnnots: false,
          bookmarks: null,
          metadata: {
            title: next.info.title,
            author: next.info.author,
            subject: next.info.subject,
            keywords: next.info.keywords,
            language: next.info.language,
          },
        };
        reset(base);
        setDocKey(gen);
        setEngine(next);
        setFileName(name);
        setPendingPassword(null);
        setHasForm(next.info.hasAcroForm);
        pageTextsRef.current = null;
        textLayers.current.clear();
        setHits([]);
        setHitQuads(new Map());
        setSelectedIds([]);
        setSelectedPages([]);
        setAttachments([]);
        setLayers([]);
        setHiddenLayers(new Set());
        setOcConfig(undefined);
        setView((v) => ({ ...v, current: 1 }));
        setMode("view");

        void next
          .outline()
          .then((outline) => {
            if (gen !== openGeneration.current || !outline.length) return;
            const bookmarks: Bookmark[] = outlineToBookmarks(outline);
            amend((s) => (s.bookmarks == null ? { ...s, bookmarks } : s));
          })
          .catch(() => {});
        void next.attachments().then((a) => gen === openGeneration.current && setAttachments(a));
        void next.layers().then((l) => gen === openGeneration.current && setLayers(l));
        if (!restore) {
          // Let the first page paint before competing for the pdf.js worker.
          setTimeout(() => {
            if (gen === openGeneration.current) void importExistingMarkup(next, sourcePages, gen).catch(() => {});
          }, 250);
        }
      } catch (e) {
        if (e instanceof PdfPasswordRequired) {
          setPendingPassword({ bytes: raw, name, wrong: e.wrong });
        } else {
          setLoadError("Impossible d'ouvrir ce PDF : le fichier semble illisible ou endommagé.");
        }
      } finally {
        setLoading(false);
      }
    },
    [engine, reset, amend, importExistingMarkup],
  );

  const openFile = useCallback(
    async (file: File) => {
      await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    },
    [openBytes],
  );

  // Restore a session persisted in an .elium.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !initial) return;
    restored.current = true;
    const loaded = deserialize(initial);
    for (const [name, b64] of Object.entries(loaded.fonts)) registerCustomFont(name, base64ToBytes(b64));
    setSignatures(
      loaded.signatures.map((src, i) => ({
        id: `sig_${i}`,
        kind: "signature",
        src,
        ratio: 3,
        createdAt: new Date().toISOString(),
      })),
    );
    void openBytes(loaded.bytes, loaded.name, loaded.sourcePassword, loaded.state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  useEffect(
    () => () => {
      if (!engine) return;
      releaseThumbnails(engine);
      engine.destroy();
    },
    [engine],
  );
  // Page sizes start as estimates and the form/signature facts are computed in
  // the background: re-render when the engine learns them.
  useEffect(() => {
    if (!engine) return;
    setHasForm(engine.info.hasAcroForm);
    return engine.subscribe((e) => {
      if (e.type === "geometry") setGeometryVersion((v) => v + 1);
      else {
        setHasForm(e.info.hasAcroForm);
        setInfoVersion((v) => v + 1);
      }
    });
  }, [engine]);
  useEffect(() => {
    void hasLocalModels().then(setLocalModels);
    // Fetch the viewer components while the user picks a file.
    void loadViewerLib().catch(() => {});
  }, []);

  // -------------------------------------------------------------------------
  // Geometry helpers
  // -------------------------------------------------------------------------
  const sizeOf = useCallback(
    (page: Page) => {
      if (page.from == null) return page.size ?? { w: PAGE_SIZES.A4[0], h: PAGE_SIZES.A4[1] };
      const info = engine?.pages[page.from];
      if (!info) return { w: PAGE_SIZES.A4[0], h: PAGE_SIZES.A4[1] };
      const crop = page.crop;
      if (!crop) return { w: info.w, h: info.h };
      return { w: Math.max(1, info.w - crop.left - crop.right), h: Math.max(1, info.h - crop.top - crop.bottom) };
    },
    // `engine.pages` entries are replaced as real sizes replace the estimates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, geometryVersion],
  );

  const rotationOf = useCallback(
    (page: Page): Rotation => {
      const own = page.from != null ? (engine?.pages[page.from]?.rotate ?? 0) : 0;
      return normRotation(own + (page.rotate ?? 0) + view.viewRotation);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, view.viewRotation, geometryVersion],
  );

  // `sizeOf` above returns a brand-new `{w,h}` object on every call, even for
  // a page whose size hasn't changed — which would make the `size` prop fed
  // to PageView/AnnotLayer/ContentEditLayer look "different" on every render
  // no matter what, defeating their memo. Cache it per page.id and hand back
  // the same object while w/h are unchanged.
  const pageSizeCache = useRef(new Map<string, Size>());
  const stableSizeOf = useCallback(
    (page: Page): Size => {
      const next = sizeOf(page);
      const prev = pageSizeCache.current.get(page.id);
      if (prev && prev.w === next.w && prev.h === next.h) return prev;
      pageSizeCache.current.set(page.id, next);
      return next;
    },
    [sizeOf],
  );

  // -------------------------------------------------------------------------
  // Zoom & navigation
  // -------------------------------------------------------------------------
  // The page a fit zoom fits is the current one WHEN the fit is asked for (or
  // the window resized) — not re-evaluated on every scroll, or the zoom would
  // jump each time a page of another size scrolls by. The scale depends only
  // on that page and on the viewport, never on the laid-out content (the old
  // "Largeur → 1000 %" runaway: the viewport grew with its own content).
  const fitPageRef = useRef(0);
  useEffect(() => {
    fitPageRef.current = Math.max(0, view.current - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.zoomMode, view.mode, viewport]);
  const applyFit = useCallback(() => {
    if (view.zoomMode === "custom" || viewport.width <= 0 || viewport.height <= 0) return;
    const page = pages[fitPageRef.current] ?? pages[0];
    if (!page) return;
    const size = sizeOf(page);
    const box = rotationOf(page) % 180 === 0 ? size : { w: size.h, h: size.w };
    const twoUp = view.mode === "facing" || view.mode === "facingContinuous";
    const next = clamp(fitScale(view.zoomMode, box, viewport, { twoUp }), MIN_SCALE, MAX_SCALE);
    setView((v) => (v.zoomMode === "custom" || Math.abs(v.scale - next) <= 0.002 ? v : { ...v, scale: next }));
  }, [view.zoomMode, view.mode, viewport, pages, sizeOf, rotationOf]);
  useEffect(() => {
    applyFit();
  }, [applyFit]);

  const setScale = (next: number, mode: ViewState["zoomMode"] = "custom") =>
    setView((v) => ({ ...v, scale: clamp(next, MIN_SCALE, MAX_SCALE), zoomMode: mode }));

  const zoomStep = (dir: 1 | -1) => {
    const presets = ZOOM_PRESETS as readonly number[];
    const i = presets.findIndex((z) => (dir > 0 ? z > view.scale + 0.001 : z >= view.scale - 0.001));
    const next =
      dir > 0 ? presets[i < 0 ? presets.length - 1 : i] : presets[Math.max(0, (i < 0 ? presets.length : i) - 1)];
    setScale(next ?? view.scale * (dir > 0 ? 1.2 : 0.8));
  };

  /** Show 1-based page `page`, `y` points below its top edge. */
  const goTo = useCallback((page: number, y?: number) => {
    const target = clamp(Math.round(page), 1, Math.max(1, pageCountRef.current));
    stackRef.current?.scrollToPage(target - 1, { top: y ? Math.max(0, y) : 0 });
    setView((v) => (v.current === target ? v : { ...v, current: target }));
  }, []);

  const onCurrentChange = useCallback((current: number) => {
    setView((v) => (v.current === current ? v : { ...v, current }));
  }, []);
  // Ctrl+wheel (handled by PageStack, about the pointer) settled on a zoom.
  const onScaleChange = useCallback((scale: number) => {
    setView((v) => ({ ...v, scale: clamp(scale, MIN_SCALE, MAX_SCALE), zoomMode: "custom" }));
  }, []);

  // -------------------------------------------------------------------------
  // Annotations
  // -------------------------------------------------------------------------
  const selection = useMemo(() => state.annots.filter((a) => selectedIds.includes(a.id)), [state.annots, selectedIds]);

  const addAnnot = (a: Annot) => {
    setState((s) => D.addAnnot(s, a));
  };
  const patchAnnot = (id: string, patch: Partial<Annot>, live: boolean) => {
    const now = new Date().toISOString();
    (live ? setQuiet : setState)((s) => D.updateAnnot(s, id, { ...patch, modifiedAt: now }));
  };
  const patchSelection = (patch: Partial<Annot>) => {
    setState((s) => D.updateAnnots(s, selectedIds, { ...patch, modifiedAt: new Date().toISOString() }));
  };
  const deleteAnnots = (ids: string[]) => {
    setState((s) => D.removeAnnots(s, ids));
    setSelectedIds((v) => v.filter((id) => !ids.includes(id)));
  };

  const pickTool = (next: Tool) => {
    setTool(next);
    setEditingId(null);
    if (toolIsAnnot(next)) {
      setStyle((s) => styleForKind(s, next));
      const target = TOOL_TAB[next];
      if (target && target !== tab) setTab(target);
    }
    if (next !== "select") setSelectedIds([]);
  };

  // Read via ref (not the `sticky` closure directly) so `finishTool` keeps a
  // stable identity across renders that only toggle `sticky` — it still
  // always reads the *current* value, just without that alone forcing every
  // AnnotLayer's memoized `onToolDone` to look "changed".
  const stickyRef = useRef(sticky);
  useEffect(() => {
    stickyRef.current = sticky;
  }, [sticky]);
  const finishTool = () => {
    if (!stickyRef.current) setTool("textSelect");
  };

  // --- text-anchored markup from the live selection -------------------------
  const applyMarkupFromSelection = useCallback(
    (kind: AnnotKind) => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) return false;
      const now = new Date().toISOString();
      const made: Annot[] = [];
      const byId = new Map(pages.map((q) => [q.id, q]));
      for (const [pageId, { layer, host }] of textLayers.current) {
        const page = byId.get(pageId);
        if (!page || !layer.isConnected) continue;
        // `host` is the page slot: its top-left is the page's view origin
        // (after an Elium crop), which is what the quads are relative to.
        const quads = quadsFromSelection(sel, host, layer, view.scale, sizeOf(page), rotationOf(page));
        if (!quads.length) continue;
        const text = selectionTextIn(sel, layer);
        made.push({
          id: newId("an"),
          pageId: page.id,
          kind,
          rect: rectOfQuads(quads),
          quads,
          color: style.color,
          fill: null,
          opacity: kind === "highlight" ? style.opacity : 1,
          strokeWidth: kind === "highlight" ? 0 : Math.max(1, style.strokeWidth),
          author,
          createdAt: now,
          modifiedAt: now,
          subject: text.slice(0, 120),
          replies: [],
          status: "none",
        });
      }
      if (!made.length) return false;
      setState((s) => made.reduce((acc, a) => D.addAnnot(acc, a), s));
      sel.removeAllRanges();
      setSelectedIds(made.map((a) => a.id));
      return true;
    },
    [pages, sizeOf, rotationOf, view.scale, style, author, setState],
  );

  // Picking a markup tool while text is selected applies it immediately.
  useEffect(() => {
    if (!isTextMarkup(tool as AnnotKind)) return;
    if (applyMarkupFromSelection(tool as AnnotKind)) finishTool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);

  // Dragging over text with a markup tool armed applies on release.
  useEffect(() => {
    if (!isTextMarkup(tool as AnnotKind)) return;
    const onUp = () => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && applyMarkupFromSelection(tool as AnnotKind)) finishTool();
    };
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [tool, applyMarkupFromSelection]);

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------
  const ensureText = useCallback(async () => {
    if (pageTextsRef.current || !engine) return pageTextsRef.current ?? [];
    setSearchBusy(true);
    const texts = await engine.allText();
    pageTextsRef.current = texts;
    setSearchBusy(false);
    return texts;
  }, [engine]);

  const doSearch = useCallback(
    async (query: string) => {
      if (!engine) return;
      if (!query.trim()) {
        setHits([]);
        setHitQuads(new Map());
        setSearchState((s) => ({ ...s, index: -1 }));
        return;
      }
      const texts = await ensureText();
      const found = runSearch(texts, query, {
        ...DEFAULT_SEARCH_OPTIONS,
        caseSensitive: searchState.caseSensitive,
        wholeWord: searchState.wholeWord,
        regex: searchState.regex,
        ignoreDiacritics: searchState.ignoreDiacritics,
      });
      setHits(found);
      setSearchState((s) => ({ ...s, index: found.length ? 0 : -1 }));
      if (found.length) {
        const target = pages.findIndex((pg) => pg.from === found[0].page);
        goTo((target < 0 ? found[0].page : target) + 1);
      }
    },
    [
      engine,
      ensureText,
      searchState.caseSensitive,
      searchState.wholeWord,
      searchState.regex,
      searchState.ignoreDiacritics,
      pages,
      goTo,
    ],
  );

  // Highlight rectangles are computed lazily, only for pages that have hits.
  useEffect(() => {
    if (!engine || !hits.length) {
      setHitQuads(new Map());
      return;
    }
    let cancelled = false;
    (async () => {
      const wanted = new Set(hits.map((h) => h.page));
      const out = new Map<number, Quad[][]>();
      for (const index of wanted) {
        const page = await engine.page(index);
        const vp = page.getViewport({ scale: 1, rotation: 0 });
        const tc = await engine.text(index);
        if (cancelled) return;
        const runs = buildRuns(tc, vp.transform as unknown as number[]);
        out.set(
          index,
          hits.filter((h) => h.page === index).map((h) => quadsForCharRange(runs, tc.items, h.start, h.end)),
        );
      }
      if (!cancelled) setHitQuads(out);
    })();
    return () => {
      cancelled = true;
    };
  }, [engine, hits]);

  const stepHit = (delta: number) => {
    if (!hits.length) return;
    const next = (searchState.index + delta + hits.length) % hits.length;
    setSearchState((s) => ({ ...s, index: next }));
    goToHit(next);
  };

  /** Scroll hit `i` into view: its page, and the line itself when its quads are known. */
  const goToHit = (i: number) => {
    const hit = hits[i];
    if (!hit) return;
    const target = pages.findIndex((pg) => pg.from === hit.page);
    const k = hits.filter((h) => h.page === hit.page).indexOf(hit);
    const quads = hitQuads.get(hit.page)?.[k];
    const page = target >= 0 ? pages[target] : undefined;
    // Quads are in source page space; only an unrotated, uncropped page maps them 1:1.
    const y =
      quads?.length && page && !page.crop && rotationOf(page) === 0
        ? Math.max(0, rectOfQuads(quads).y - 60)
        : undefined;
    goTo((target < 0 ? hit.page : target) + 1, y);
  };

  // Search results, per source page, in the shape PageStack draws.
  const hitMarks = useMemo(() => {
    const out = new Map<number, HitMark[]>();
    const active = hits[searchState.index];
    for (const [from, list] of hitQuads) {
      const onPage = hits.filter((h) => h.page === from);
      out.set(
        from,
        list.map((quads, i) => ({ quads, active: !!active && onPage[i] === active })),
      );
    }
    return out;
  }, [hitQuads, hits, searchState.index]);
  const hitsOf = useCallback((page: Page) => (page.from != null ? hitMarks.get(page.from) : undefined), [hitMarks]);

  // -------------------------------------------------------------------------
  // Persistence & export
  // -------------------------------------------------------------------------
  const collectFonts = () => {
    const fonts: Record<string, string> = {};
    const scan = (family?: string) => {
      if (family && isCustomFont(family) && !fonts[family]) {
        const bytes = getCustomFont(family);
        if (bytes) fonts[family] = bytesToBase64(bytes);
      }
    };
    for (const a of state.annots) scan(a.fontFamily);
    for (const e of state.contentEdits) scan(e.fontFamily);
    return fonts;
  };

  const exportPdf = async (name: string) => {
    if (!bytesRef.current) return;
    setBusy(true);
    const id = toast("progress", "Export du PDF…");
    try {
      const { bytes, report } = await buildPdf(bytesRef.current, state, {
        ...buildOptions,
        author,
        fileName: name,
        onProgress: (label, ratio) => {
          setToasts((v) => v.map((t) => (t.id === id ? { ...t, text: label, ratio } : t)));
        },
      });
      downloadBlob(name, "application/pdf", bytes);
      dismissToast(id);
      const parts = [
        `${report.pages} page${report.pages > 1 ? "s" : ""}`,
        report.annotsWritten
          ? `${report.annotsWritten} annotation${report.annotsWritten > 1 ? "s" : ""} modifiables`
          : "",
        report.annotsFlattened ? `${report.annotsFlattened} aplatie${report.annotsFlattened > 1 ? "s" : ""}` : "",
        report.redactedGlyphs ? `${report.redactedGlyphs} caractères caviardés` : "",
        report.textBlocksNative ? `${report.textBlocksNative} paragraphe(s) réécrits` : "",
      ].filter(Boolean);
      toast("success", "PDF exporté", parts.join(" · "));
      for (const w of report.warnings) toast("warning", w);
    } catch (e) {
      dismissToast(id);
      toast("danger", "Échec de l'export", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  // --- Signature électronique PAdES (certificat X.509) ---------------------
  // Emplacement VISIBLE de la signature = la dernière signature placée (outil
  // Signature) : Adobe la reconnaît alors comme une signature, à cet endroit,
  // avec le dessin en apparence — au lieu d'une simple image.
  const visibleSigTarget = (): { visible: NonNullable<PadesSignOptions["visible"]>; annotId: string } | undefined => {
    const sig = [...state.annots].reverse().find((a) => a.kind === "signature" && a.src);
    if (!sig) return undefined;
    const page = state.pages.findIndex((p) => p.id === sig.pageId);
    if (page < 0) return undefined;
    let imagePng: Uint8Array | undefined;
    const m = /^data:image\/png;base64,(.+)$/.exec(sig.src ?? "");
    if (m) imagePng = Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0));
    return {
      visible: { page, rect: { x: sig.rect.x, y: sig.rect.y, w: sig.rect.w, h: sig.rect.h }, imagePng },
      annotId: sig.id,
    };
  };

  // Construit le PDF pour signature : si la signature placée devient l'apparence
  // du champ /Sig (imagePng présent), on EXCLUT son annotation-image de l'export
  // — sinon Adobe verrait une image (supprimable) EN PLUS du champ signature. La
  // marque devient ainsi la signature elle-même.
  const buildForSignature = (t: ReturnType<typeof visibleSigTarget>) => {
    const st = t && t.visible.imagePng ? { ...state, annots: state.annots.filter((a) => a.id !== t.annotId) } : state;
    return buildPdf(bytesRef.current!, st, { ...buildOptions, author, fileName });
  };

  const finishSigned = async (signed: Uint8Array, base: string, toastId: number): Promise<void> => {
    downloadBlob(`${base}-signe.pdf`, "application/pdf", signed);
    dismissToast(toastId);
    const { verifyPdfSignatures } = await import("../ops/pades");
    const v = verifyPdfSignatures(signed);
    const ok = v.length > 0 && v.every((x) => x.valid);
    const note = v[0]?.selfSigned
      ? " · auto-signée (identité non vérifiée)"
      : v[0]?.chainVerified
        ? " · chaîne vérifiée"
        : "";
    toast(
      ok ? "success" : "warning",
      "PDF signé (PAdES)",
      v[0] ? `Signataire : ${v[0].signerName}${ok ? " · signature valide" : ""}${note}` : undefined,
    );
  };

  const onP12Pick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !bytesRef.current) return;
    if ((await engine?.infoReady)?.signed && !(await confirmResign())) return;
    const pw = await dialogs.prompt({
      title: "Signer avec un certificat (PAdES)",
      label: `Mot de passe du certificat « ${file.name} »`,
    });
    if (pw === null) return;
    setBusy(true);
    const id = toast("progress", "Signature électronique…");
    try {
      const p12 = new Uint8Array(await file.arrayBuffer());
      const base = fileName.replace(/\.pdf$/i, "") || "document";
      const target = visibleSigTarget();
      const { bytes } = await buildForSignature(target);
      const { signPdfBytes } = await import("../ops/pades");
      const signed = await signPdfBytes(bytes, p12, pw, { reason: "Signé avec Elium", visible: target?.visible });
      await finishSigned(signed, base, id);
    } catch (err) {
      dismissToast(id);
      toast("danger", "Échec de la signature", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  // Signe avec un certificat auto-signé généré dans l'app (zéro certificat à
  // fournir). Adobe : « signé » mais « identité non vérifiée » (pas de CA).
  // Le flux de signature PAdES est MONO-signature (cf. ops/pades.ts) : signer un
  // PDF déjà signé écrase silencieusement le trou /Contents précédent et
  // invalide la signature existante. On avertit explicitement et on demande
  // confirmation avant de continuer.
  const confirmResign = () =>
    dialogs.confirm({
      title: "Document déjà signé",
      message:
        "Ce PDF contient déjà une signature électronique. Elium ne gère qu'une seule signature par document : " +
        "en signer une nouvelle invalidera silencieusement la signature existante. Continuer quand même ?",
      confirmLabel: "Signer quand même",
    });

  const signSelfSigned = async () => {
    if (!bytesRef.current) return;
    const target = visibleSigTarget();
    if (!target) {
      toast(
        "warning",
        "Placez d'abord une signature",
        "Utilisez l'outil Signature pour dessiner/placer votre signature, puis signez numériquement.",
      );
      return;
    }
    if ((await engine?.infoReady)?.signed && !(await confirmResign())) return;
    setBusy(true);
    const id = toast("progress", "Génération du certificat et signature…");
    try {
      // Laisse le toast s'afficher avant la génération RSA (bloquante ~1–3 s).
      await new Promise((r) => setTimeout(r, 30));
      const cn = author?.trim() || "Signature Elium (auto-signée)";
      const pw = "elium-self";
      const { generateSelfSignedP12 } = await import("../ops/self-cert");
      const p12 = generateSelfSignedP12(cn, pw);
      const base = fileName.replace(/\.pdf$/i, "") || "document";
      const { bytes } = await buildForSignature(target);
      const { signPdfBytes } = await import("../ops/pades");
      const signed = await signPdfBytes(bytes, p12, pw, {
        reason: "Signé avec Elium",
        signerName: cn,
        visible: target.visible,
      });
      await finishSigned(signed, base, id);
    } catch (err) {
      dismissToast(id);
      toast("danger", "Échec de la signature", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const verifySignatures = async () => {
    if (!bytesRef.current) return;
    const { verifyPdfSignatures } = await import("../ops/pades");
    const v = verifyPdfSignatures(bytesRef.current);
    if (v.length === 0) {
      toast("warning", "Aucune signature", "Ce PDF ne contient pas de signature électronique (PAdES).");
      return;
    }
    for (const s of v) {
      const trust = s.selfSigned
        ? " · auto-signée (identité non vérifiée)"
        : s.chainVerified
          ? " · chaîne vérifiée"
          : "";
      const invalidReason =
        s.error ||
        (!s.certValidAtSigning
          ? "Certificat hors de sa période de validité"
          : "Invalide ou document modifié après signature");
      toast(
        s.valid ? "success" : "danger",
        `Signature : ${s.signerName || "inconnu"}`,
        s.valid
          ? `Valide${s.coversWholeDocument ? " · couvre tout le document" : " · ne couvre pas tout le document"}${trust}`
          : invalidReason,
      );
    }
  };

  const saveElium = async () => {
    if (!bytesRef.current || !onExportElium) return;
    const base = fileName.replace(/\.pdf$/i, "") || "document";
    const title = await dialogs.prompt({
      title: "Enregistrer en .elium",
      label: "Nom du document",
      defaultValue: base,
    });
    if (title === null) return;
    onExportElium(
      serialize(fileName || "document.pdf", bytesRef.current, state, {
        fonts: collectFonts(),
        signatures: signatures.map((s) => s.src),
        sourcePassword: passwordRef.current ?? undefined,
      }),
      title.trim() || base,
    );
    toast("success", "Document enregistré", "Scellé, chiffrable et re-modifiable.");
  };

  const printDocument = async () => {
    if (!bytesRef.current) return;
    setBusy(true);
    const id = toast("progress", "Préparation de l'impression…");
    try {
      const { bytes } = await buildPdf(bytesRef.current, state, {
        ...buildOptions,
        interactiveAnnots: false,
        flattenForms: true,
        author,
        fileName,
      });
      const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], { type: "application/pdf" }));
      const frame = document.createElement("iframe");
      frame.style.position = "fixed";
      frame.style.right = "0";
      frame.style.bottom = "0";
      frame.style.width = "0";
      frame.style.height = "0";
      frame.style.border = "0";
      frame.src = url;
      frame.onload = () => {
        try {
          frame.contentWindow?.focus();
          frame.contentWindow?.print();
        } catch {
          window.open(url, "_blank");
        }
        setTimeout(() => {
          frame.remove();
          URL.revokeObjectURL(url);
        }, 60_000);
      };
      document.body.appendChild(frame);
      dismissToast(id);
    } catch {
      dismissToast(id);
      toast("danger", "Impression impossible");
    } finally {
      setBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------
  const currentPage = () => pages[view.current - 1];
  const targetPages = () => (selectedPages.length ? selectedPages : ([currentPage()?.id].filter(Boolean) as string[]));

  const insertBlankAfter = (afterId: string | null, count = 1, size: [number, number] = PAGE_SIZES.A4) => {
    setState((s) => {
      const at = afterId ? s.pages.findIndex((q) => q.id === afterId) + 1 : s.pages.length;
      const made = Array.from({ length: count }, () => D.makePage(null, { size: { w: size[0], h: size[1] } }));
      return D.insertPages(s, at, made);
    });
  };

  const command = async (id: string) => {
    switch (id) {
      case "undo":
        undo();
        return;
      case "redo":
        redo();
        return;
      case "save":
        setDialog("save");
        return;
      case "saveElium":
        void saveElium();
        return;
      case "print":
        void printDocument();
        return;
      case "downloadOriginal":
        if (bytesRef.current) downloadBlob(fileName || "document.pdf", "application/pdf", bytesRef.current);
        return;
      case "properties":
        setDialog("properties");
        return;
      case "organise":
        setMode(mode === "organise" ? "view" : "organise");
        return;
      case "editMode":
        setMode(mode === "editText" ? "view" : "editText");
        setTab("edit");
        return;
      case "formMode":
        setMode(mode === "form" ? "view" : "form");
        setTab("forms");
        return;
      case "signature":
        setDialog("signature");
        return;
      case "watermark":
        setDialog("watermark");
        return;
      case "headerFooter":
      case "bates":
        setDialog("headerFooter");
        return;
      case "protect":
        setDialog("protect");
        return;
      case "signPades":
        p12Input.current?.click();
        return;
      case "signSelfSigned":
        void signSelfSigned();
        return;
      case "verifyPades":
        void verifySignatures();
        return;
      case "split":
        setDialog("split");
        return;
      case "crop":
        setDialog("crop");
        return;
      case "pageLabels":
        setDialog("labels");
        return;
      case "measureScale":
        setDialog("measure");
        return;
      case "exportImages":
        setDialog("exportImages");
        return;
      case "ocr":
        setDialog("ocr");
        return;
      case "compare":
        setCompareReport(null);
        setDialog("compare");
        return;
      case "redactSearch":
        setDialog("redactSearch");
        return;
      case "insertBlank":
        setDialog("insert");
        return;
      case "insertFile":
        mergeInput.current?.click();
        return;
      case "insertImage":
        imageInput.current?.click();
        return;
      case "merge":
        mergeInput.current?.click();
        return;
      case "importComments":
      case "importFormData":
        dataInput.current?.click();
        return;

      case "zoomIn":
        zoomStep(1);
        return;
      case "zoomOut":
        zoomStep(-1);
        return;
      case "fitWidth":
        setView((v) => ({ ...v, zoomMode: "fitWidth" }));
        return;
      case "fitPage":
        setView((v) => ({ ...v, zoomMode: "fitPage" }));
        return;
      case "viewSingle":
        setView((v) => ({ ...v, mode: "single" }));
        return;
      case "viewContinuous":
        setView((v) => ({ ...v, mode: "continuous" }));
        return;
      case "viewFacing":
        setView((v) => ({ ...v, mode: v.mode === "facing" ? "facingContinuous" : "facing" }));
        return;
      case "rotateView":
        setView((v) => ({ ...v, viewRotation: normRotation(v.viewRotation + 90) }));
        return;
      case "theme": {
        const i = READING_THEMES.findIndex((t) => t.id === view.theme);
        setView((v) => ({ ...v, theme: READING_THEMES[(i + 1) % READING_THEMES.length].id }));
        return;
      }
      case "fullscreen": {
        const el = document.querySelector(".pdfx");
        if (!document.fullscreenElement) void el?.requestFullscreen?.().catch(() => {});
        else void document.exitFullscreen();
        return;
      }
      case "panelLayers":
        setPanel("layers");
        return;
      case "readAloud": {
        const text = pageTextsRef.current?.[currentPage()?.from ?? 0] ?? "";
        if (!text) {
          await ensureText();
        }
        const body = pageTextsRef.current?.[currentPage()?.from ?? 0] ?? "";
        if (!body) {
          toast("info", "Aucun texte à lire sur cette page.");
          return;
        }
        try {
          speechSynthesis.cancel();
          const utter = new SpeechSynthesisUtterance(body.slice(0, 8000));
          utter.lang = state.metadata.language || "fr-FR";
          speechSynthesis.speak(utter);
          toast("info", "Lecture en cours", "Relancez la commande pour arrêter.");
        } catch {
          toast("warning", "La synthèse vocale n'est pas disponible.");
        }
        return;
      }

      case "rotateLeft":
        setState((s) => D.rotatePages(s, targetPages(), -90));
        return;
      case "rotateRight":
        setState((s) => D.rotatePages(s, targetPages(), 90));
        return;
      case "duplicatePage":
        setState((s) => D.duplicatePages(s, targetPages()));
        return;
      case "deletePage":
        setState((s) => D.deletePages(s, targetPages()));
        return;
      case "reverse":
        setState((s) => D.reversePages(s));
        return;
      case "extract": {
        const ids = targetPages();
        const indices = ids.map((pid) => pages.findIndex((q) => q.id === pid)).filter((i) => i >= 0);
        await extractSelection(indices);
        return;
      }

      case "bookmarkAdd":
        addBookmark(null);
        return;
      case "bookmarksFromHeadings":
        void buildBookmarksFromHeadings();
        return;

      case "exportComments": {
        const heights = new Map(pages.map((pg) => [pg.id, sizeOf(pg).h]));
        const xml = toXfdf(state.annots, pages, heights, fileName || "document.pdf");
        downloadBlob(`${fileName.replace(/\.pdf$/i, "")}-commentaires.xfdf`, "application/vnd.adobe.xfdf", xml);
        toast("success", "Commentaires exportés", `${state.annots.length} élément(s) au format XFDF.`);
        return;
      }
      case "commentsReport": {
        const rows = state.annots.map((a, i) => {
          const page = pages.findIndex((q) => q.id === a.pageId) + 1;
          return `${i + 1}. [p.${page}] ${a.author} — ${a.contents || a.text || "(sans texte)"}`;
        });
        downloadBlob(`${fileName.replace(/\.pdf$/i, "")}-synthese.txt`, "text/plain;charset=utf-8", rows.join("\n"));
        return;
      }

      case "exportFormData":
        downloadBlob(
          `${fileName.replace(/\.pdf$/i, "")}.fdf`,
          "application/vnd.fdf",
          toFdf(state.formValues, fileName),
        );
        return;
      case "exportFormCsv":
        downloadBlob(
          `${fileName.replace(/\.pdf$/i, "")}-donnees.csv`,
          "text/csv;charset=utf-8",
          toCsv(state.formValues),
        );
        return;
      case "formReset":
        setState((s) => D.resetForm(s));
        toast("info", "Formulaire réinitialisé.");
        return;
      case "formFlatten":
        setBuildOptions((o) => ({ ...o, flattenForms: true }));
        setDialog("save");
        return;
      case "detectFields":
        void detectFields();
        return;

      case "redactApply": {
        const marks = state.annots.filter((a) => a.kind === "redact");
        if (!marks.length) {
          toast("info", "Aucune zone marquée.");
          return;
        }
        const ok = await dialogs.confirm({
          title: "Appliquer le caviardage",
          message: `${marks.length} zone(s) seront définitivement supprimées du fichier exporté : texte, images et annotations situés dessous. Cette action est irréversible dans le PDF produit.`,
        });
        if (!ok) return;
        setBuildOptions((o) => ({ ...o, applyRedactions: true }));
        setDialog("save");
        return;
      }
      case "sanitise":
        setBuildOptions((o) => ({ ...o, sanitise: true }));
        setDialog("save");
        return;
      case "optimise":
        setBuildOptions((o) => ({ ...o, optimise: true }));
        setDialog("save");
        return;
      case "inspect":
        void inspectDocument();
        return;
      case "unprotect":
        void unprotect();
        return;

      case "exportDocx":
        void exportAs("docx");
        return;
      case "exportText":
        void exportAs("text");
        return;
      case "exportHtml":
        void exportAs("html");
        return;
      case "exportTables":
        void exportAs("tables");
        return;
      default:
        return;
    }
  };

  // --- command implementations ---------------------------------------------
  const extractSelection = async (indices: number[]) => {
    if (!bytesRef.current || !indices.length) return;
    setBusy(true);
    try {
      const { bytes } = await buildPdf(bytesRef.current, state, { ...buildOptions, author, fileName });
      const out = await extractPages(bytes, indices);
      downloadBlob(`${fileName.replace(/\.pdf$/i, "")}-extrait.pdf`, "application/pdf", out);
      toast("success", `${indices.length} page(s) extraite(s).`);
    } catch {
      toast("danger", "Extraction impossible.");
    } finally {
      setBusy(false);
    }
  };

  const exportAs = async (kind: "docx" | "text" | "html" | "tables") => {
    if (!engine) return;
    setBusy(true);
    const id = toast("progress", "Extraction du contenu…");
    try {
      const layout = await extractLayout(engine, (done, total) => {
        setToasts((v) =>
          v.map((t) => (t.id === id ? { ...t, ratio: done / total, text: `Page ${done}/${total}` } : t)),
        );
      });
      const base = fileName.replace(/\.pdf$/i, "") || "document";
      if (kind === "docx")
        downloadBlob(
          `${base}.docx`,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          toDocx(layout, base),
        );
      if (kind === "text") downloadBlob(`${base}.txt`, "text/plain;charset=utf-8", toPlainTextWithMarkers(layout));
      if (kind === "html") downloadBlob(`${base}.html`, "text/html;charset=utf-8", toHtml(layout, base));
      if (kind === "tables") {
        const tables = detectTables(layout);
        if (!tables.length) {
          dismissToast(id);
          toast("info", "Aucun tableau détecté.");
          return;
        }
        downloadBlob(`${base}-tableaux.csv`, "text/csv;charset=utf-8", tablesToCsv(tables));
      }
      dismissToast(id);
      toast("success", "Export terminé.");
    } catch {
      dismissToast(id);
      toast("danger", "Export impossible.");
    } finally {
      setBusy(false);
    }
  };

  const inspectDocument = async () => {
    if (!engine || !bytesRef.current) return;
    const protection = await inspectProtection(bytesRef.current);
    const lines = [
      `Pages : ${engine.pageCount}`,
      `Formulaire : ${engine.info.isXfa ? "XFA" : engine.info.hasAcroForm ? "AcroForm" : "aucun"}`,
      `Signature : ${engine.info.signed ? "présente" : "aucune"}`,
      `Pièces jointes : ${attachments.length}`,
      `Calques : ${layers.length}`,
      `Chiffrement : ${protection?.encrypted ? protection.scheme : "aucun"}`,
      `Métadonnées : ${[engine.info.title, engine.info.author, engine.info.producer].filter(Boolean).join(" · ") || "aucune"}`,
    ];
    await dialogs.alert({ title: "Inspection du document", message: lines.join("\n") });
  };

  const unprotect = async () => {
    if (!bytesRef.current) return;
    const probe = await inspectProtection(bytesRef.current);
    if (!probe?.encrypted) {
      toast("info", "Ce document n'est pas protégé.");
      return;
    }
    const pw =
      passwordRef.current ??
      (await dialogs.prompt({ title: "Retirer la protection", label: "Mot de passe du document" }));
    if (!pw) return;
    setBusy(true);
    try {
      const result = await removeProtection(bytesRef.current, pw);
      bytesRef.current = result.bytes;
      passwordRef.current = null;
      await openBytes(result.bytes, fileName, undefined, state);
      toast("success", "Protection retirée", `Chiffrement ${result.scheme} supprimé.`);
    } catch (e) {
      toast(
        "danger",
        e instanceof WrongPassword ? "Mot de passe incorrect." : "Ce document ne peut pas être déchiffré ici.",
      );
    } finally {
      setBusy(false);
    }
  };

  const detectFields = async () => {
    if (!engine) return;
    const page = currentPage();
    if (!page || page.from == null) return;
    const proxy = await engine.page(page.from);
    const vp = proxy.getViewport({ scale: 1, rotation: 0 });
    const tc = await engine.text(page.from);
    const lines = groupLines(buildRuns(tc, vp.transform as unknown as number[]), tc.items);
    const suggestions = suggestFields(
      lines.map((l) => ({ text: l.text, rect: l.rect, fontSize: l.fontSize })),
      sizeOf(page).w,
    );
    if (!suggestions.length) {
      toast("info", "Aucun champ détecté sur cette page.");
      return;
    }
    setState((s) =>
      suggestions.reduce(
        (acc, f) =>
          D.addField(acc, {
            id: newId("fd"),
            pageId: page.id,
            name: D.uniqueFieldName(acc, f.name),
            kind: f.kind,
            rect: f.rect,
          }),
        s,
      ),
    );
    setMode("fields");
    setPanel("fields");
    toast("success", `${suggestions.length} champ(s) proposé(s)`, "Ajustez-les puis exportez.");
  };

  const buildBookmarksFromHeadings = async () => {
    if (!engine) return;
    setBusy(true);
    try {
      const layout = await extractLayout(engine);
      const sizes = layout.flatMap((pg) => pg.blocks.map((b) => b.fontSize)).sort((a, b) => a - b);
      const body = sizes[Math.floor(sizes.length / 2)] ?? 11;
      const marks: Bookmark[] = [];
      for (const pg of layout) {
        for (const block of pg.blocks) {
          if (block.fontSize < body * 1.18) continue;
          const title = block.lines
            .map((l) => l.text)
            .join(" ")
            .trim();
          if (title.length < 3 || title.length > 120) continue;
          const outputIndex = pages.findIndex((q) => q.from === pg.page);
          marks.push({
            id: newId("bm"),
            title,
            page: (outputIndex < 0 ? pg.page : outputIndex) + 1,
            y: block.rect.y,
            bold: block.fontSize >= body * 1.6,
            children: [],
          });
        }
      }
      if (!marks.length) {
        toast("info", "Aucun titre détecté.");
        return;
      }
      setState((s) => ({ ...s, bookmarks: marks }));
      setPanel("bookmarks");
      toast("success", `${marks.length} signet(s) créé(s).`);
    } finally {
      setBusy(false);
    }
  };

  const addBookmark = (parentId: string | null) => {
    const node: Bookmark = { id: newId("bm"), title: `Page ${view.current}`, page: view.current, children: [] };
    setState((s) => ({ ...s, bookmarks: D.insertBookmark(s.bookmarks ?? [], parentId, node) }));
    setPanel("bookmarks");
  };

  // -------------------------------------------------------------------------
  // File pickers
  // -------------------------------------------------------------------------
  const onMergePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length || !bytesRef.current) return;
    setBusy(true);
    const id = toast("progress", "Fusion en cours…");
    try {
      const current = await buildPdf(bytesRef.current, state, { ...buildOptions, author, fileName });
      const sources = [
        { name: fileName || "document.pdf", bytes: current.bytes },
        ...(await Promise.all(
          files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
        )),
      ];
      const merged = await mergeDocuments(sources);
      dismissToast(id);
      if (merged.failed.length) toast("warning", `Ignoré : ${merged.failed.join(", ")}`);
      await openBytes(merged.bytes, fileName || "fusion.pdf");
      toast("success", "Documents fusionnés", `${merged.counts.reduce((a, b) => a + b, 0)} pages au total.`);
    } catch {
      dismissToast(id);
      toast("danger", "Fusion impossible.");
    } finally {
      setBusy(false);
    }
  };

  const onImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    const sources = await Promise.all(
      files.map(
        (f) =>
          new Promise<string>((res) => {
            const r = new FileReader();
            r.onload = () => res(r.result as string);
            r.readAsDataURL(f);
          }),
      ),
    );

    // With the image tool armed, drop the picture on the page instead.
    const at = pendingImageAt.current;
    if (at && sources[0]) {
      pendingImageAt.current = null;
      const img = new Image();
      img.onload = () => {
        const ratio = img.height / img.width || 1;
        const w = Math.min(240, sizeOf(pages.find((q) => q.id === at.pageId) ?? pages[0]).w - at.x);
        const now = new Date().toISOString();
        addAnnot({
          id: newId("an"),
          pageId: at.pageId,
          kind: "image",
          rect: { x: at.x, y: at.y, w, h: w * ratio },
          color: style.color,
          opacity: 1,
          strokeWidth: 0,
          src: sources[0],
          author,
          createdAt: now,
          modifiedAt: now,
          replies: [],
        });
      };
      img.src = sources[0];
      return;
    }

    if (!bytesRef.current) {
      const bytes = await pdfFromImages(
        sources.map((src) => ({ src })),
        { pageSize: "fit" },
      );
      await openBytes(bytes, files[0].name.replace(/\.[^.]+$/, ".pdf"));
      return;
    }
    setState((s) =>
      D.insertPages(
        s,
        s.pages.length,
        sources.map((src) => D.makePage(null, { image: src })),
      ),
    );
    toast("success", `${sources.length} page(s) image ajoutée(s).`);
  };

  const onDataPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const text = await file.text();
    if (/\.xfdf$/i.test(file.name) || text.includes("<xfdf")) {
      const heights = new Map(pages.map((pg) => [pg.id, sizeOf(pg).h]));
      const imported = fromXfdf(text, pages, heights, author);
      if (!imported.length) {
        toast("warning", "Aucun commentaire lisible dans ce fichier.");
        return;
      }
      setState((s) => imported.reduce((acc, a) => D.addAnnot(acc, a), s));
      setPanel("comments");
      toast("success", `${imported.length} commentaire(s) importé(s).`);
      return;
    }
    const values = fromFdf(text);
    if (!Object.keys(values).length) {
      toast("warning", "Aucune donnée de formulaire trouvée.");
      return;
    }
    setState((s) => ({ ...s, formValues: { ...s.formValues, ...values } }));
    setMode("form");
    toast("success", `${Object.keys(values).length} champ(s) importé(s).`);
  };

  const onComparePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !engine) return;
    setCompareBusy(true);
    try {
      const other = await PdfEngine.open(new Uint8Array(await file.arrayBuffer()));
      const [mine, theirs] = [await engine.allText(), await other.allText()];
      setCompareReport(comparePages(mine, theirs));
      other.destroy();
    } catch {
      toast("danger", "Comparaison impossible (fichier illisible ou protégé).");
    } finally {
      setCompareBusy(false);
    }
  };

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inField =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;

      if (mod) {
        const k = e.key.toLowerCase();
        if (k === "f") {
          e.preventDefault();
          setSearchState((s) => ({ ...s, open: true }));
          return;
        }
        if (k === "s") {
          e.preventDefault();
          setDialog("save");
          return;
        }
        if (k === "p") {
          e.preventDefault();
          void printDocument();
          return;
        }
        if (k === "o") {
          e.preventDefault();
          openInput.current?.click();
          return;
        }
        if (!inField && k === "a") {
          e.preventDefault();
          setSelectedIds(state.annots.filter((a) => a.pageId === currentPage()?.id).map((a) => a.id));
          return;
        }
        if (!inField && k === "z" && !e.shiftKey) {
          e.preventDefault();
          undo();
          return;
        }
        if (!inField && (k === "y" || (k === "z" && e.shiftKey))) {
          e.preventDefault();
          redo();
          return;
        }
        if (k === "=" || k === "+") {
          e.preventDefault();
          zoomStep(1);
          return;
        }
        if (k === "-") {
          e.preventDefault();
          zoomStep(-1);
          return;
        }
        if (k === "0") {
          e.preventDefault();
          setView((v) => ({ ...v, zoomMode: "fitPage" }));
          return;
        }
        if (e.shiftKey && k === "h") {
          e.preventDefault();
          pickTool("highlight");
          return;
        }
        return;
      }

      if (inField) return;

      switch (e.key) {
        case "Escape":
          if (searchState.open) setSearchState((s) => ({ ...s, open: false }));
          else if (mode !== "view") setMode("view");
          else if (selectedIds.length) setSelectedIds([]);
          else setTool("textSelect");
          return;
        case "Delete":
        case "Backspace":
          if (selectedIds.length) {
            e.preventDefault();
            deleteAnnots(selectedIds);
          }
          return;
        case "PageDown":
          e.preventDefault();
          goTo(view.current + 1);
          return;
        case "PageUp":
          e.preventDefault();
          goTo(view.current - 1);
          return;
        case "Home":
          e.preventDefault();
          goTo(1);
          return;
        case "End":
          e.preventDefault();
          goTo(pageCount);
          return;
        case "F3":
          e.preventDefault();
          stepHit(e.shiftKey ? -1 : 1);
          return;
        case "F11":
          e.preventDefault();
          void command("fullscreen");
          return;
        default:
          break;
      }

      const shortcuts: Record<string, Tool> = {
        v: "select",
        t: "textSelect",
        h: "hand",
        z: "zoomArea",
        g: "highlight",
        u: "underline",
        k: "strikeout",
        n: "note",
        d: "ink",
        r: "square",
        e: "circle",
        l: "line",
        a: "arrow",
        x: "eraser",
      };
      const picked = shortcuts[e.key.toLowerCase()];
      if (picked) {
        e.preventDefault();
        pickTool(picked);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.annots, selectedIds, view.current, pageCount, searchState.open, mode, hits.length, searchState.index]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (!engine) {
    return (
      <div className="pdfx pdfx--empty">
        <header className="pdfx-topbar">
          <button className="pdfx-topbtn" onClick={onHome}>
            <Home size={16} /> Accueil
          </button>
          <span className="pdfx-topbar__brand">
            <FileText size={16} /> PDF
          </span>
        </header>
        <main
          className={`pdfx-dropzone ${dragOver ? "is-over" : ""}`}
          aria-label="Ouvrir un PDF"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void openFile(f);
          }}
        >
          <div className="pdfx-dropzone__card">
            <div className="pdfx-dropzone__icon">
              <FileText size={34} />
            </div>
            <h1>Ouvrir un PDF</h1>
            <p>
              {loading
                ? "Chargement…"
                : loadError ||
                  "Déposez un fichier ici, ou choisissez-le. Vous pourrez le lire, l'annoter, en modifier le texte, le caviarder, le signer et le protéger."}
            </p>
            <div className="pdfx-dropzone__actions">
              <button className="eb eb--primary" onClick={() => openInput.current?.click()} disabled={loading}>
                {loading ? <Loader2 size={16} className="pdfx-spin" /> : <Upload size={16} />} Choisir un PDF
              </button>
              <button className="eb eb--outline" onClick={() => imageInput.current?.click()} disabled={loading}>
                Créer depuis des images
              </button>
            </div>
            <ul className="pdfx-dropzone__hints">
              <li>Annotation complète, fils de commentaires et révision</li>
              <li>Édition réelle du texte et des images de la page</li>
              <li>Caviardage destructif, chiffrement AES-256, OCR</li>
            </ul>
          </div>
        </main>
        <input
          ref={openInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void openFile(f);
          }}
        />
        <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={onImagePick} />
        {pendingPassword && (
          <PasswordPrompt
            wrong={pendingPassword.wrong}
            fileName={pendingPassword.name}
            onConfirm={(pw) => void openBytes(pendingPassword.bytes, pendingPassword.name, pw)}
            onClose={() => setPendingPassword(null)}
          />
        )}
      </div>
    );
  }

  const themeDef = READING_THEMES.find((t) => t.id === view.theme) ?? READING_THEMES[0];

  // Elium's layers for one page, rendered by PageStack inside the page slot
  // (same stacking and coordinates as the old PageView children). `scale` is
  // PageStack's — during a Ctrl+wheel gesture it leads `view.scale`.
  const renderOverlay = (page: Page, _index: number, { size, rotation, scale }: OverlayGeometry) => {
    const pageAnnots = annotsByPage.get(page.id) ?? EMPTY_ARRAY;
    const pageEdits = contentEditsByPage.get(page.id) ?? EMPTY_ARRAY;
    return (
      <>
        {/* Edited paragraphs are painted over the original raster in every
            mode, so a change is visible the instant it is made and stays
            visible after leaving the editor. */}
        <ContentEditPreview
          edits={pageEdits}
          size={size}
          rotation={rotation}
          scale={scale}
          maskColor={themeDef.canvas}
        />
        {mode === "editText" && (
          <ContentEditLayer
            engine={engine}
            from={page.from}
            pageId={page.id}
            size={size}
            rotation={rotation}
            scale={scale}
            edits={pageEdits}
            onBeginChange={checkpoint}
            onCommit={(edit: ContentEdit) => setState((s) => D.upsertContentEdit(s, edit))}
          />
        )}
        {(mode === "form" || mode === "fields") && (
          <FormLayer
            engine={engine}
            from={page.from}
            pageId={page.id}
            size={size}
            rotation={rotation}
            scale={scale}
            values={state.formValues}
            created={state.createdFields}
            highlight
            onBeginChange={checkpoint}
            onChange={(name, value: FormValue) => setQuiet((s) => D.setFormValue(s, name, value))}
            onFields={() => {
              /* fields are read live */
            }}
          />
        )}
        {mode === "view" && (
          <AnnotLayer
            pageId={page.id}
            size={size}
            rotation={rotation}
            scale={scale}
            annots={pageAnnots}
            tool={tool}
            style={style}
            selectedIds={selectedIds}
            editingId={editingId}
            author={author}
            snap={view.showGrid}
            onCreate={(a) => {
              addAnnot(a);
              if (a.kind === "redact") setTab("protect");
            }}
            onUpdate={patchAnnot}
            onSelect={(ids, additive) => setSelectedIds(additive ? [...new Set([...selectedIds, ...ids])] : ids)}
            onEdit={setEditingId}
            onDelete={deleteAnnots}
            onToolDone={finishTool}
            onBeginGesture={checkpoint}
            onContextMenu={(a) => setSelectedIds([a.id])}
            onRequestImage={(at) => {
              pendingImageAt.current = { pageId: page.id, x: at.x, y: at.y };
              imageInput.current?.click();
            }}
            onRequestNoteText={async (a) => {
              const text = await dialogs.prompt({
                title: "Note",
                label: "Commentaire",
                defaultValue: a.contents ?? "",
              });
              if (text !== null) patchAnnot(a.id, { contents: text }, false);
            }}
          />
        )}
      </>
    );
  };

  return (
    <div className={`pdfx pdfx--theme-${view.theme} ${mode !== "view" ? `pdfx--mode-${mode}` : ""}`}>
      <header className="pdfx-topbar">
        <button className="pdfx-topbtn" onClick={onHome} title="Retour à l'accueil">
          <Home size={16} />
        </button>
        <span className="pdfx-topbar__brand">
          <FileText size={15} /> PDF
        </span>
        <span className="pdfx-topbar__file" title={fileName}>
          {fileName}
        </span>
        {engine.info.encrypted && <span className="pdfx-badge pdfx-badge--lock">protégé</span>}
        {engine.info.signed && <span className="pdfx-badge pdfx-badge--seal">signé</span>}
        {engine.info.isXfa && <span className="pdfx-badge pdfx-badge--warn">XFA — lecture seule</span>}

        <span className="pdfx-topbar__spacer" />

        <div className="pdfx-find">
          {searchState.open ? (
            <>
              <Search size={14} />
              <input
                autoFocus
                className="pdfx-find__input"
                placeholder="Rechercher dans le document…"
                value={searchState.query}
                onChange={(e) => {
                  setSearchState((s) => ({ ...s, query: e.target.value }));
                  void doSearch(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    stepHit(e.shiftKey ? -1 : 1);
                  }
                  if (e.key === "Escape") setSearchState((s) => ({ ...s, open: false }));
                }}
              />
              <span className="pdfx-find__count">
                {searchBusy
                  ? "…"
                  : hits.length
                    ? `${searchState.index + 1}/${hits.length}`
                    : searchState.query
                      ? "0"
                      : ""}
              </span>
              <button className="pdfx-topbtn" onClick={() => stepHit(-1)} disabled={!hits.length}>
                <ChevronLeft size={15} />
              </button>
              <button className="pdfx-topbtn" onClick={() => stepHit(1)} disabled={!hits.length}>
                <ChevronRight size={15} />
              </button>
              <button
                className={`pdfx-topbtn ${searchState.caseSensitive ? "is-on" : ""}`}
                onClick={() => {
                  setSearchState((s) => ({ ...s, caseSensitive: !s.caseSensitive }));
                }}
                title="Respecter la casse"
              >
                Aa
              </button>
              <button
                className={`pdfx-topbtn ${searchState.regex ? "is-on" : ""}`}
                onClick={() => {
                  setSearchState((s) => ({ ...s, regex: !s.regex }));
                }}
                title="Expression régulière"
              >
                .*
              </button>
              <button
                className="pdfx-topbtn"
                onClick={() => {
                  setPanel("search");
                  void doSearch(searchState.query);
                }}
                title="Tous les résultats"
              >
                <Command size={14} />
              </button>
              <button className="pdfx-topbtn" onClick={() => setSearchState((s) => ({ ...s, open: false, query: "" }))}>
                <X size={15} />
              </button>
            </>
          ) : (
            <button
              className="pdfx-topbtn"
              onClick={() => setSearchState((s) => ({ ...s, open: true }))}
              title="Rechercher (Ctrl+F)"
            >
              <Search size={16} />
            </button>
          )}
        </div>

        <div className="pdfx-pagenav">
          <button
            className="pdfx-topbtn"
            onClick={() => goTo(view.current - 1)}
            disabled={view.current <= 1}
            title="Page précédente"
            aria-label="Page précédente"
          >
            <ChevronLeft size={16} />
          </button>
          <input
            className="pdfx-pagenav__input"
            value={view.current}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/\D/g, ""));
              if (n) goTo(n);
            }}
            aria-label="Numéro de page"
          />
          <span className="pdfx-pagenav__total">/ {pageCount}</span>
          <button
            className="pdfx-topbtn"
            onClick={() => goTo(view.current + 1)}
            disabled={view.current >= pageCount}
            title="Page suivante"
            aria-label="Page suivante"
          >
            <ChevronRight size={16} />
          </button>
        </div>

        <div className="pdfx-zoombar">
          <button className="pdfx-topbtn" onClick={() => zoomStep(-1)} title="Zoom arrière" aria-label="Zoom arrière">
            <ZoomOut size={16} />
          </button>
          <select
            className="pdfx-zoombar__select"
            aria-label="Niveau de zoom"
            value={view.zoomMode === "custom" ? "custom" : view.zoomMode}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "fitWidth" || v === "fitPage" || v === "fitVisible") setView((s) => ({ ...s, zoomMode: v }));
              else setScale(Number(v));
            }}
          >
            <option value="custom">{Math.round(view.scale * 100)} %</option>
            <option value="fitWidth">Largeur</option>
            <option value="fitPage">Page entière</option>
            <option value="fitVisible">Zone de texte</option>
            {ZOOM_PRESETS.map((z) => (
              <option key={z} value={z}>
                {Math.round(z * 100)} %
              </option>
            ))}
          </select>
          <button className="pdfx-topbtn" onClick={() => zoomStep(1)} title="Zoom avant" aria-label="Zoom avant">
            <ZoomIn size={16} />
          </button>
          <button className="pdfx-topbtn" onClick={() => void command("fullscreen")} title="Plein écran (F11)">
            <Maximize2 size={16} />
          </button>
        </div>
      </header>

      <Ribbon
        tab={tab}
        tool={tool}
        style={style}
        canUndo={canUndo}
        canRedo={canRedo}
        hasSelection={selectedIds.length > 0}
        hasForm={hasForm || state.createdFields.length > 0}
        busy={busy}
        stickyTool={sticky}
        onTab={setTab}
        onTool={pickTool}
        onStyle={(patch) => {
          setStyle((s) => ({ ...s, ...patch }));
          if (selectedIds.length) patchSelection(patch as Partial<Annot>);
        }}
        onCommand={(id) => void command(id)}
        onStickyTool={setSticky}
      />

      <div className="pdfx-main">
        <nav className="pdfx-rail">
          {PANEL_ICONS.map((item) => (
            <button
              key={item.id}
              className={`pdfx-rail__btn ${panel === item.id ? "is-active" : ""}`}
              onClick={() => setPanel(panel === item.id ? null : item.id)}
              title={item.label}
            >
              {item.icon}
              {item.id === "comments" && state.annots.length > 0 && (
                <span className="pdfx-rail__dot">{state.annots.length}</span>
              )}
              {item.id === "search" && hits.length > 0 && <span className="pdfx-rail__dot">{hits.length}</span>}
            </button>
          ))}
          <span className="pdfx-rail__spacer" />
          <button
            className="pdfx-rail__btn"
            onClick={() => setPanel(panel ? null : "thumbnails")}
            title={panel ? "Masquer le panneau" : "Afficher le panneau"}
          >
            {panel ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}
          </button>
        </nav>

        {panel && (
          <aside className="pdfx-side" aria-label="Panneau latéral">
            <Sidebar
              panel={panel}
              engine={engine}
              pages={pages}
              current={view.current}
              selectedPages={selectedPages}
              annots={state.annots}
              bookmarks={state.bookmarks ?? []}
              fields={state.createdFields}
              attachments={attachments}
              layers={layers}
              hiddenLayers={hiddenLayers}
              searchHits={hits}
              searchIndex={searchState.index}
              searchQuery={searchState.query}
              searchBusy={searchBusy}
              filter={filter}
              sort={sort}
              author={author}
              onGoTo={goTo}
              onSelectPages={setSelectedPages}
              onReorderPages={(ids, to) => setState((s) => D.reorderPages(s, ids, to))}
              onPageAction={(action, ids) => {
                const targets = ids.length ? ids : targetPages();
                if (action === "rotate") setState((s) => D.rotatePages(s, targets, 90));
                if (action === "delete") setState((s) => D.deletePages(s, targets));
                if (action === "duplicate") setState((s) => D.duplicatePages(s, targets));
                if (action === "insert") insertBlankAfter(targets[targets.length - 1] ?? null);
              }}
              onSelectAnnot={(id) => {
                setSelectedIds([id]);
                const a = state.annots.find((x) => x.id === id);
                const index = a ? pages.findIndex((q) => q.id === a.pageId) : -1;
                if (index >= 0) goTo(index + 1, Math.max(0, a!.rect.y - 80));
              }}
              onAnnotStatus={(ids, status) =>
                setState((s) => D.setStatus(s, ids, status, author, new Date().toISOString()))
              }
              onAnnotReply={(id, text) =>
                setState((s) => D.addReply(s, id, { author, text, createdAt: new Date().toISOString() }))
              }
              onAnnotDelete={deleteAnnots}
              onAnnotEditContents={(id, text) => patchAnnot(id, { contents: text }, false)}
              onFilterChange={setFilter}
              onSortChange={setSort}
              onBookmarkGoTo={(b) => goTo(b.page, b.y)}
              onBookmarkAdd={addBookmark}
              onBookmarkRename={(id, title) =>
                setState((s) => ({
                  ...s,
                  bookmarks: D.mapBookmarks(s.bookmarks ?? [], (b) => (b.id === id ? { ...b, title } : b)),
                }))
              }
              onBookmarkDelete={(id) => setState((s) => ({ ...s, bookmarks: D.removeBookmark(s.bookmarks ?? [], id) }))}
              onBookmarkToggle={(id) =>
                setQuiet((s) => ({
                  ...s,
                  bookmarks: D.mapBookmarks(s.bookmarks ?? [], (b) => (b.id === id ? { ...b, closed: !b.closed } : b)),
                }))
              }
              onSearchSelect={(index) => {
                setSearchState((s) => ({ ...s, index }));
                goToHit(index);
              }}
              onLayerToggle={async (id) => {
                const next = new Set(hiddenLayers);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                setHiddenLayers(next);
                setOcConfig(await engine.optionalContentConfig(next));
              }}
              onAttachmentOpen={(a) => downloadBlob(a.name, "application/octet-stream", a.bytes)}
              onFieldSelect={(id) => {
                const f = state.createdFields.find((x) => x.id === id);
                const index = f ? pages.findIndex((q) => q.id === f.pageId) : -1;
                if (index >= 0) goTo(index + 1);
              }}
              onFieldDelete={(id) => setState((s) => D.removeField(s, id))}
            />
          </aside>
        )}

        {mode === "organise" ? (
          <Organize
            engine={engine}
            pages={pages}
            selected={selectedPages}
            onSelect={setSelectedPages}
            onReorder={(ids, to) => setState((s) => D.reorderPages(s, ids, to))}
            onRotate={(ids, delta) => setState((s) => D.rotatePages(s, ids, delta))}
            onDelete={(ids) => setState((s) => D.deletePages(s, ids))}
            onDuplicate={(ids) => setState((s) => D.duplicatePages(s, ids))}
            onSkip={(ids, skipped) => setState((s) => D.setPageSkipped(s, ids, skipped))}
            onExtract={(ids) =>
              void extractSelection(ids.map((id) => pages.findIndex((q) => q.id === id)).filter((i) => i >= 0))
            }
            onInsertBlank={(afterId) => insertBlankAfter(afterId)}
            onInsertFile={() => mergeInput.current?.click()}
            onInsertImage={() => imageInput.current?.click()}
            onCrop={() => setDialog("crop")}
            onLabels={() => setDialog("labels")}
            onReverse={() => setState((s) => D.reversePages(s))}
            onClose={() => setMode("view")}
          />
        ) : (
          <PageStack
            ref={stackRef}
            key={docKey}
            engine={engine}
            pages={pages}
            sizeOf={stableSizeOf}
            rotationOf={rotationOf}
            scale={view.scale}
            mode={view.mode}
            cover={view.spreadCover}
            theme={view.theme}
            current={view.current}
            showTextLayer={mode === "view" && tool !== "hand"}
            maskImported={state.importedAnnots}
            optionalContent={ocConfig}
            hitsOf={hitsOf}
            className={`pdfx-canvas--${view.mode} ${tool === "hand" ? "is-hand" : ""}`}
            style={{ background: view.theme === "night" || view.theme === "invert" ? "#0b0e14" : undefined }}
            renderOverlay={renderOverlay}
            onCurrentChange={onCurrentChange}
            onScaleChange={onScaleChange}
            onViewportResize={setViewport}
            onTextLayer={(pageId, layer, host) => {
              if (layer && host) textLayers.current.set(pageId, { layer, host });
              else textLayers.current.delete(pageId);
            }}
            onLinkActivate={(target) => {
              if (target.page) goTo(target.page, target.y);
              else if (target.url)
                void dialogs.confirm({ title: "Ouvrir un lien externe", message: target.url }).then((ok) => {
                  if (ok) window.open(target.url, "_blank", "noopener,noreferrer");
                });
            }}
          />
        )}

        {inspector && selection.length > 0 && mode === "view" && (
          <Inspector
            selection={selection}
            pageCount={pageCount}
            measureScale={state.measureScale}
            onPatch={patchSelection}
            onDelete={() => deleteAnnots(selectedIds)}
            onDuplicate={() => {
              const copies = selection.map((a) => ({
                ...D.cloneAnnot(a),
                rect: { ...a.rect, x: a.rect.x + 12, y: a.rect.y + 12 },
              }));
              setState((s) => copies.reduce((acc, a) => D.addAnnot(acc, a), s));
              setSelectedIds(copies.map((a) => a.id));
            }}
            onOrder={(where) => selectedIds.forEach((id) => setState((s) => D.reorderAnnot(s, id, where)))}
            onMeasureScale={(scale: MeasureScale) => setState((s) => ({ ...s, measureScale: scale }))}
            onClose={() => setInspector(false)}
          />
        )}
      </div>

      <footer className="pdfx-status">
        <span>
          {pageCount} page{pageCount > 1 ? "s" : ""}
        </span>
        <span>·</span>
        <span>
          {state.annots.length} annotation{state.annots.length > 1 ? "s" : ""}
        </span>
        {state.contentEdits.length > 0 && (
          <>
            <span>·</span>
            <span>{state.contentEdits.length} paragraphe(s) modifié(s)</span>
          </>
        )}
        {state.annots.some((a) => a.kind === "redact") && (
          <>
            <span>·</span>
            <span className="pdfx-status__warn">
              {state.annots.filter((a) => a.kind === "redact").length} zone(s) à caviarder
            </span>
          </>
        )}
        <span className="pdfx-status__spacer" />
        <span>{themeDef.label}</span>
        <span>·</span>
        <span>{Math.round(view.scale * 100)} %</span>
        {busy && (
          <>
            <span>·</span>
            <Loader2 size={13} className="pdfx-spin" />
          </>
        )}
      </footer>

      <div className="pdfx-toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`pdfx-toast pdfx-toast--${t.tone}`}>
            <div className="pdfx-toast__body">
              <b>{t.text}</b>
              {t.detail && <small>{t.detail}</small>}
              {t.tone === "progress" && (
                <div className="pdfx-bar">
                  <span style={{ width: `${Math.round((t.ratio ?? 0) * 100)}%` }} />
                </div>
              )}
            </div>
            {t.tone !== "progress" && (
              <button onClick={() => dismissToast(t.id)}>
                <X size={13} />
              </button>
            )}
          </div>
        ))}
      </div>

      {/* hidden inputs */}
      <input
        ref={openInput}
        type="file"
        accept="application/pdf,.pdf"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void openFile(f);
        }}
      />
      <input ref={mergeInput} type="file" accept="application/pdf,.pdf" multiple hidden onChange={onMergePick} />
      <input ref={imageInput} type="file" accept="image/*" multiple hidden onChange={onImagePick} />
      <input ref={dataInput} type="file" accept=".xfdf,.fdf,.xml" hidden onChange={onDataPick} />
      <input ref={compareInput} type="file" accept="application/pdf,.pdf" hidden onChange={onComparePick} />
      <input ref={p12Input} type="file" accept=".p12,.pfx" hidden onChange={onP12Pick} />

      {/* dialogs */}
      {dialog === "save" && (
        <SaveDialog
          fileName={fileName}
          options={buildOptions}
          hasRedactions={state.annots.some((a) => a.kind === "redact")}
          hasForm={hasForm || state.createdFields.length > 0}
          onChange={(patch) => setBuildOptions((o) => ({ ...o, ...patch }))}
          onConfirm={(name) => {
            setDialog(null);
            void exportPdf(name);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "protect" && (
        <ProtectDialog
          onClose={() => setDialog(null)}
          onConfirm={async (v: {
            userPassword: string;
            ownerPassword: string;
            permissions: Permissions;
            encryptMetadata: boolean;
          }) => {
            setDialog(null);
            setBuildOptions((o) => ({ ...o, protect: v }));
            if (!bytesRef.current) return;
            setBusy(true);
            const id = toast("progress", "Chiffrement du document…");
            try {
              const { bytes } = await buildPdf(bytesRef.current, state, {
                ...buildOptions,
                author,
                fileName,
                protect: v,
              });
              downloadBlob(`${fileName.replace(/\.pdf$/i, "")}-protégé.pdf`, "application/pdf", bytes);
              dismissToast(id);
              toast("success", "Document protégé", "Chiffrement AES-256 (révision 6).");
            } catch {
              dismissToast(id);
              toast("danger", "Chiffrement impossible.");
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {dialog === "watermark" && (
        <WatermarkDialog
          value={state.watermark}
          onClose={() => setDialog(null)}
          onChange={(v) => setState((s) => ({ ...s, watermark: v }))}
        />
      )}
      {dialog === "headerFooter" && (
        <HeaderFooterDialog
          header={state.header}
          footer={state.footer}
          bates={state.bates}
          onClose={() => setDialog(null)}
          onChange={(v) => setState((s) => ({ ...s, ...v }))}
        />
      )}
      {dialog === "properties" && (
        <PropertiesDialog
          info={engine.info}
          metadata={state.metadata}
          sizeBytes={bytesRef.current?.length ?? 0}
          onClose={() => setDialog(null)}
          onChange={(v) => setState((s) => ({ ...s, metadata: v }))}
        />
      )}
      {dialog === "exportImages" && (
        <ExportImagesDialog
          pageCount={pageCount}
          onClose={() => setDialog(null)}
          onConfirm={async (v) => {
            setDialog(null);
            setBusy(true);
            const id = toast("progress", "Rendu des pages…");
            try {
              const indices = v.range.trim()
                ? parsePageRange(v.range, pageCount)
                    .map((i) => pages[i]?.from)
                    .filter((n): n is number => n != null)
                : undefined;
              const made = await exportImages(engine, fileName.replace(/\.pdf$/i, ""), {
                format: v.format,
                dpi: v.dpi,
                quality: v.quality,
                pages: indices,
                onProgress: (done, total) =>
                  setToasts((t) =>
                    t.map((x) => (x.id === id ? { ...x, ratio: done / total, text: `Page ${done}/${total}` } : x)),
                  ),
              });
              if (v.zip)
                downloadBlob(`${fileName.replace(/\.pdf$/i, "")}-images.zip`, "application/zip", await zipImages(made));
              else
                for (const img of made)
                  downloadBlob(img.name, `image/${v.format}`, new Uint8Array(await img.blob.arrayBuffer()));
              dismissToast(id);
              toast("success", `${made.length} image(s) exportée(s).`);
            } catch {
              dismissToast(id);
              toast("danger", "Export d'images impossible.");
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {dialog === "ocr" && (
        <OcrDialog
          pageCount={pageCount}
          localModels={localModels}
          running={ocrRunning}
          progress={ocrProgress}
          onCancel={() => {
            ocrAbort.current?.abort();
            setOcrRunning(false);
          }}
          onClose={() => setDialog(null)}
          onConfirm={async (v: {
            languages: OcrLanguage[];
            dpi: number;
            range: string;
            skipPagesWithText: boolean;
          }) => {
            if (!bytesRef.current) return;
            setOcrRunning(true);
            ocrAbort.current = new AbortController();
            try {
              const indices = v.range.trim()
                ? parsePageRange(v.range, pageCount)
                    .map((i) => pages[i]?.from)
                    .filter((n): n is number => n != null)
                : undefined;
              const results = await recognise(engine, {
                languages: v.languages,
                dpi: v.dpi,
                pages: indices,
                skipPagesWithText: v.skipPagesWithText,
                signal: ocrAbort.current.signal,
                onProgress: setOcrProgress,
              });
              const words = results.reduce((n, r) => n + r.words.length, 0);
              if (!words) {
                toast("info", "Aucun texte reconnu.");
                setOcrRunning(false);
                return;
              }

              const { PDFDocument } = await import("pdf-lib");
              const { FontBook } = await import("../ops/fonts");
              const doc = await PDFDocument.load(bytesRef.current, {
                ignoreEncryption: true,
                throwOnInvalidObject: false,
                updateMetadata: false,
              });
              const book = new FontBook(doc);
              const docPages = doc.getPages();
              for (const r of results) {
                const target = docPages[r.page];
                if (target && r.words.length) await writeOcrLayer(doc, target, r.words, book);
              }
              const out = await doc.save();
              await openBytes(out, fileName, undefined, state);
              setOcrRunning(false);
              setDialog(null);
              toast(
                "success",
                "Reconnaissance terminée",
                `${words} mots indexés — le document est désormais cherchable.`,
              );
            } catch {
              setOcrRunning(false);
              toast("danger", "La reconnaissance a échoué.");
            }
          }}
        />
      )}
      {dialog === "signature" && (
        <SignatureDialog
          saved={signatures}
          onClose={() => setDialog(null)}
          onDelete={(id) => setSignatures((v) => v.filter((s) => s.id !== id))}
          onSave={(sig) => setSignatures((v) => [...v, sig])}
          onUse={(sig) => {
            const page = currentPage();
            if (!page) return;
            const size = sizeOf(page);
            const w = Math.min(200, size.w * 0.35);
            const now = new Date().toISOString();
            addAnnot({
              id: newId("an"),
              pageId: page.id,
              kind: "signature",
              rect: { x: size.w - w - 60, y: size.h - w / (sig.ratio || 3) - 90, w, h: w / (sig.ratio || 3) },
              color: "#0f172a",
              opacity: 1,
              strokeWidth: 0,
              src: sig.src,
              author,
              createdAt: now,
              modifiedAt: now,
              replies: [],
            });
            setDialog(null);
            setTool("select");
            toast("info", "Signature placée", "Faites-la glisser à l'endroit voulu.");
          }}
        />
      )}
      {dialog === "split" && (
        <SplitDialog
          pageCount={pageCount}
          hasBookmarks={!!state.bookmarks?.length}
          onClose={() => setDialog(null)}
          onConfirm={async (v) => {
            setDialog(null);
            if (!bytesRef.current) return;
            setBusy(true);
            try {
              const { bytes } = await buildPdf(bytesRef.current, state, { ...buildOptions, author, fileName });
              const base = fileName.replace(/\.pdf$/i, "") || "document";
              const parts = await splitDocument(
                bytes,
                v.mode === "everyN"
                  ? { kind: "everyN", n: v.n }
                  : v.mode === "ranges"
                    ? { kind: "ranges", spec: v.spec }
                    : v.mode === "maxSize"
                      ? { kind: "maxSize", bytes: v.maxMb * 1024 * 1024 }
                      : { kind: "bookmarks", level: 1 },
                base,
                (state.bookmarks ?? []).map((b) => ({ title: b.title, page: b.page })),
              );
              for (const part of parts) downloadBlob(part.name, "application/pdf", part.bytes);
              toast("success", `${parts.length} fichier(s) produit(s).`);
            } catch {
              toast("danger", "Division impossible.");
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {dialog === "crop" && (
        <CropDialog
          current={currentPage()?.crop ?? { top: 0, right: 0, bottom: 0, left: 0 }}
          onClose={() => setDialog(null)}
          onConfirm={({ crop, scope }) => {
            const ids = scope === "all" ? pages.map((q) => q.id) : targetPages();
            const empty = !crop.top && !crop.right && !crop.bottom && !crop.left;
            setState((s) => D.cropPages(s, ids, empty ? null : crop));
            setDialog(null);
          }}
        />
      )}
      {dialog === "labels" && (
        <PageLabelsDialog
          onClose={() => setDialog(null)}
          onConfirm={({ style: labelStyle, prefix, start, scope }) => {
            const ids = scope === "all" ? pages.map((q) => q.id) : targetPages();
            setState((s) => D.labelPages(s, ids, labelStyle, prefix, start));
            setDialog(null);
          }}
        />
      )}
      {dialog === "measure" && (
        <MeasureScaleDialog
          value={state.measureScale}
          onClose={() => setDialog(null)}
          onConfirm={(scale) => {
            setState((s) => ({ ...s, measureScale: scale }));
            setDialog(null);
          }}
        />
      )}
      {dialog === "compare" && (
        <CompareDialog
          report={compareReport}
          busy={compareBusy}
          onPick={() => compareInput.current?.click()}
          onGoTo={(page) => {
            goTo(page);
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "insert" && (
        <InsertPagesDialog
          pageCount={pageCount}
          onClose={() => setDialog(null)}
          onConfirm={({ where, at, count, size }) => {
            const dims =
              size === "same"
                ? ([sizeOf(currentPage() ?? pages[0]).w, sizeOf(currentPage() ?? pages[0]).h] as [number, number])
                : (PAGE_SIZES[size] ?? PAGE_SIZES.A4);
            const anchor = where === "end" ? null : (pages[where === "before" ? at - 2 : at - 1]?.id ?? null);
            insertBlankAfter(anchor, count, dims);
            setDialog(null);
          }}
        />
      )}
      {dialog === "redactSearch" && (
        <RedactSearchDialog
          onClose={() => setDialog(null)}
          onConfirm={async (v) => {
            setDialog(null);
            if (!engine) return;
            setBusy(true);
            try {
              const texts = await ensureText();
              const found = runSearch(texts, v.query, {
                caseSensitive: v.caseSensitive,
                wholeWord: v.wholeWord,
                regex: v.regex,
                ignoreDiacritics: true,
              });
              if (!found.length) {
                toast("info", "Aucune occurrence trouvée.");
                return;
              }
              const made: Annot[] = [];
              const now = new Date().toISOString();
              const byPage = new Map<number, SearchHit[]>();
              for (const h of found) byPage.set(h.page, [...(byPage.get(h.page) ?? []), h]);
              for (const [index, list] of byPage) {
                const proxy = await engine.page(index);
                const vp = proxy.getViewport({ scale: 1, rotation: 0 });
                const tc = await engine.text(index);
                const runs = buildRuns(tc, vp.transform as unknown as number[]);
                const page = pages.find((q) => q.from === index);
                if (!page) continue;
                for (const hit of list) {
                  const quads = quadsForCharRange(runs, tc.items, hit.start, hit.end);
                  for (const quad of quads) {
                    made.push({
                      id: newId("an"),
                      pageId: page.id,
                      kind: "redact",
                      rect: rectOfQuads([quad]),
                      color: "#000000",
                      fill: "#000000",
                      opacity: 1,
                      strokeWidth: 0,
                      author,
                      createdAt: now,
                      modifiedAt: now,
                      replies: [],
                    });
                  }
                }
              }
              setState((s) => made.reduce((acc, a) => D.addAnnot(acc, a), s));
              setTab("protect");
              toast(
                "success",
                `${made.length} zone(s) marquée(s)`,
                "Utilisez « Appliquer » pour supprimer définitivement le contenu.",
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
      {pendingPassword && (
        <PasswordPrompt
          wrong={pendingPassword.wrong}
          fileName={pendingPassword.name}
          onConfirm={(pw) => void openBytes(pendingPassword.bytes, pendingPassword.name, pw)}
          onClose={() => setPendingPassword(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function outlineToBookmarks(
  nodes: {
    title: string;
    page: number | null;
    y?: number;
    bold: boolean;
    italic: boolean;
    color?: string;
    children: unknown[];
  }[],
): Bookmark[] {
  return nodes.map((n) => ({
    id: newId("bm"),
    title: n.title,
    page: n.page ?? 1,
    y: n.y,
    bold: n.bold,
    italic: n.italic,
    color: n.color,
    children: outlineToBookmarks((n.children ?? []) as never),
  }));
}
