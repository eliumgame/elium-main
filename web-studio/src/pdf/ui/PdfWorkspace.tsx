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
  PenSquare,
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
import type { Quad, Rect, Rotation, Size } from "../core/coords";
import { clamp, normRotation, rectOfQuads } from "../core/coords";
import { PdfEngine, PdfPasswordRequired, type Attachment, type LayerInfo } from "../core/engine";
import { warmUpPdfWorker } from "../core/assets";
import { releaseThumbnails } from "../core/thumbs";
import { FormSession } from "../core/forms/session";
import { isEmptyValue, sameFormValue } from "../core/forms/values";
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
  FieldKind,
  FieldProps,
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
import {
  DEFAULT_BUILD,
  buildPdf,
  fullRewriteReasons,
  readDiskState,
  savePdf,
  type BuildOptions,
  type BuildReport,
  type DiskState,
  type SecurityChange,
} from "../ops/save";
import {
  canWriteFiles,
  downloadDestination,
  droppedHandle,
  fileDestination,
  pdfName,
  pickPdfToOpen,
  pickSaveTarget,
  type FsFileHandle,
  type SaveDestination,
} from "../core/destination";
import {
  buildPdfDraft,
  buildPdfSource,
  deletePdfDraft,
  findPdfDraft,
  listPdfDrafts,
  loadPdfDraftSource,
  putPdfDraft,
  putPdfSource,
  resolvePdfDraft,
  sourceKey,
  type DerivedSession,
  type PdfDraftEntry,
} from "../model/recovery";
import { sameValue } from "../model/same";
import type { VaultSecret } from "../../crypto/local-vault";
import {
  appendPdfPages,
  extractPages,
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
import { suggestFields } from "../ops/forms";
import {
  exportEntries,
  matchImported,
  parseFdf,
  parseTabText,
  parseXfdfFields,
  toCsv,
  toFdf,
  toTabText,
  toXfdfFields,
  type RawDataValue,
} from "../ops/formdata";
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
import { PDFDocument } from "pdf-lib";
import { formOf } from "../ops/pdfform";
import { PreparePage } from "./PrepareLayer";
import FieldPropertiesDialog, { propsFromPdfjs, type PdfjsWidgetData } from "./FieldProperties";
import Inspector from "./Inspector";
import Organize from "./Organize";
import PageStack, { type HitMark, type OverlayGeometry, type PageStackHandle } from "./PageStack";
import Ribbon from "./Ribbon";
import Sidebar, { PANEL_ICONS } from "./Sidebar";
import { CurrentPage, useCurrentPage } from "./currentPage";
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
  isCopyOptions,
  type SaveAsOptions,
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
  ZOOM_UNIT,
  presetScale,
  zoomPercent,
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
  /** Resolves true once the .elium is written (false: cancelled or failed). */
  onExportElium?: (data: PdfFile, title: string) => Promise<boolean>;
  author?: string;
  /** Secret of the unlocked local vault: recovery drafts are encrypted with it. */
  vaultSecret?: VaultSecret;
}

let toastSeq = 1;

// Shared empty array for the annots-by-page / edits-by-page lookups below —
// a page with none must still get *a* stable reference, not a fresh `[]`
// every render (that alone would defeat AnnotLayer/ContentEditLayer's memo).
// `never[]` is assignable to both `Annot[]` and `ContentEdit[]` (and any
// other array-typed prop) since arrays are covariant in TS.
const EMPTY_ARRAY: never[] = [];

/** How a document being opened relates to the session (see `openBytes`). */
interface OpenExtra {
  /** Recovery of a session whose destination file (`disk`) no longer holds the source as such. */
  recovered?: { disk: Uint8Array; derived?: DerivedSession };
  /** The session continues on the file its save just rewrote entirely (redaction, protection, pages removed…). */
  rebased?: { disk: DiskState; dest: SaveDestination };
  /**
   * The same session continuing on a recomposed source (pages inserted from
   * another PDF, OCR text layer): destination, protection and unsaved state
   * carry over. `disk`: what the destination holds now, when it was not
   * described yet; `signedKept`: the recomposed source still starts with the
   * signed revision (incremental recomposition).
   */
  derived?: { session: DerivedSession; disk?: DiskState | null; diskKey?: string | null; signedKept: boolean };
  /** A new document that exists nowhere yet (built from pictures…). */
  unsaved?: boolean;
}

/** Outline nodes get fresh ids each time they are read from the file. */
const IGNORE_IDS: ReadonlySet<string> = new Set(["id"]);

function startsWithBytes(whole: Uint8Array, prefix: Uint8Array): boolean {
  if (whole.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (whole[i] !== prefix[i]) return false;
  return true;
}

export default function PdfWorkspace({ onHome, initial, onExportElium, author = "Moi", vaultSecret }: Props) {
  const dialogs = useDialogs();

  // --- document -------------------------------------------------------------
  const [engine, setEngine] = useState<PdfEngine | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const passwordRef = useRef<string | null>(null);
  const [fileName, setFileName] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [pendingPassword, setPendingPassword] = useState<{
    bytes: Uint8Array;
    name: string;
    wrong: boolean;
    handle?: FsFileHandle | null;
  } | null>(null);

  // --- saving ---------------------------------------------------------------
  /** The destination file as it is now (what the next incremental save appends to). */
  const diskRef = useRef<DiskState | null>(null);
  /** Where « Enregistrer » writes: the opened file's handle, or the file chosen with « Enregistrer sous ». */
  const destRef = useRef<SaveDestination | null>(null);
  /** Handle of the file as opened (kept with recovery drafts, to reopen it). */
  const openHandleRef = useRef<FsFileHandle | null>(null);
  /** Imported annotations / bookmarks as read from the file: left untouched in it while unchanged. */
  const pristineAnnotsRef = useRef<Set<Annot>>(new Set());
  const pristineBookmarksRef = useRef<Bookmark[] | null>(null);
  /** Protection change relative to the source file (applied by the next save). */
  const securityRef = useRef<SecurityChange | null>(null);
  const [securityDirty, setSecurityDirtyState] = useState(false);
  // Read by the save itself (which may run from a closure older than the change).
  const securityDirtyRef = useRef(false);
  const setSecurityDirty = useCallback((v: boolean) => {
    securityDirtyRef.current = v;
    setSecurityDirtyState(v);
  }, []);
  /** Stamp of the state last saved (or opened): `version !== savedVersion` = modified. */
  const [savedVersion, setSavedVersion] = useState(0);
  const markClean = useRef(false);
  const [everSaved, setEverSaved] = useState(false);
  const sourceKeyRef = useRef<string | null>(null);
  /**
   * SHA-256 of the destination file when it no longer holds the source as
   * such — saved into, or the session was recomposed (recovery finds the
   * session by it).
   */
  const diskKeyRef = useRef<string | null>(null);
  /** The source is the destination file, or its first bytes (saves only appended). False once recomposed. */
  const sourceOnDiskRef = useRef(true);
  /** The session continues on a recomposed source (pages inserted, OCR) not yet saved into its file. */
  const derivedRef = useRef<DerivedSession | null>(null);
  /** Source key whose bytes the recovery store holds (recomposed sessions only). */
  const sourceStoredRef = useRef<string | null>(null);
  /** Whether the source / the destination file carry an intact digital signature (a full rewrite destroys it). */
  const sourceSignedRef = useRef(false);
  const diskSignedRef = useRef(false);
  const [docSigned, setDocSigned] = useState<boolean | null>(null);
  /** Stamp of the state last written to an .elium: safe there, though the PDF file may lack it. */
  const [eliumVersion, setEliumVersion] = useState<number | null>(null);
  /** Restored session (draft, .elium): the file's own annotations as imported, to recognise the untouched ones. */
  const snapshotRef = useRef<Map<string, Annot> | null>(null);
  const saving = useRef(false);
  const redactConfirmed = useRef(false);
  const [drafts, setDrafts] = useState<PdfDraftEntry[]>([]);
  /** Options pre-set when « Enregistrer sous » is opened by a command (optimise, sanitise…). */
  const [saveAsPreset, setSaveAsPreset] = useState<Partial<SaveAsOptions>>({});

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
    version,
  } = useUndoable<PdfState>(emptyState());
  /** The PDF file (destination) lacks the current state. */
  const pdfDirty = version !== savedVersion || securityDirty;
  /** Work that closing would lose: neither in the PDF file nor in an .elium. */
  const dirty = securityDirty || (version !== savedVersion && version !== eliumVersion);
  // The first render after an open/restore carries the fresh state's stamp.
  useEffect(() => {
    if (!markClean.current) return;
    markClean.current = false;
    setSavedVersion(version);
  }, [version]);

  // --- view -----------------------------------------------------------------
  const [view, setView] = useState<ViewState>(DEFAULT_VIEW);
  /** The page being read — outside React state, see `currentPage.ts`. */
  const [currentStore] = useState(() => new CurrentPage(1));
  const [mode, setMode] = useState<Mode>("view");
  /** « Préparer un formulaire » : selected field boxes (« c:<id> » created, « w:<widget> » file). */
  const [prepSelected, setPrepSelected] = useState<string[]>([]);
  const previousMode = useRef<string | null>(null);
  /** « Propriétés du champ » open on this field. */
  const [prepProps, setPrepProps] = useState<{
    key: string;
    /** Original name of a file field (its edits are keyed by it). */
    fieldName?: string;
    kind: FieldKind;
    name: string;
    initial: FieldProps;
  } | null>(null);
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
  const [buildOptions] = useState<BuildOptions>({ ...DEFAULT_BUILD, author });
  const [compareReport, setCompareReport] = useState<ComparisonReport | null>(null);
  const [compareBusy, setCompareBusy] = useState(false);
  const [ocrRunning, setOcrRunning] = useState(false);
  const [ocrProgress, setOcrProgress] = useState<{ page: number; total: number; stage: string; ratio: number } | null>(
    null,
  );
  const [localModels, setLocalModels] = useState(false);
  const ocrAbort = useRef<AbortController | null>(null);
  const [hasForm, setHasForm] = useState(false);
  /** Tint the form fields (Acrobat's « Surligner les champs »), remembered per browser. */
  const [fieldHighlight, setFieldHighlight] = useState(() => {
    try {
      return localStorage.getItem("elium.pdf.fieldHighlight") !== "0";
    } catch {
      return true;
    }
  });
  const [formBarHidden, setFormBarHidden] = useState(false);
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
  /** Bumped by every open request: only the latest one may replace the document. */
  const openGeneration = useRef(0);
  /** The generation of the document on screen: background work for an older one is dropped. */
  const shownGeneration = useRef(0);
  /** Remounts the page surface (fresh scroll position, fresh page views) for each document. */
  const [docKey, setDocKey] = useState(0);
  /**
   * False once the workspace is unmounted: a document still opening then is
   * destroyed as soon as it arrives instead of leaking its worker-side copy.
   * (A flag set in the effect itself, not a generation bump in the cleanup:
   * StrictMode's rehearsal unmount would void the restore open started on mount.)
   */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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
  const collectMarkup = useCallback(
    async (next: PdfEngine, sourcePages: readonly Page[], gen: number): Promise<Map<number, Annot[]> | null> => {
      const froms = [...new Set(sourcePages.map((q) => q.from).filter((f): f is number => f != null))];
      const raws = new Map<number, RawAnnotation[]>();
      let cursor = 0;
      const worker = async () => {
        while (cursor < froms.length && gen === shownGeneration.current) {
          const from = froms[cursor++];
          const raw = (await next.annotations(from)) as RawAnnotation[];
          if (hasImportableAnnots(raw)) raws.set(from, raw);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, froms.length) }, worker));
      if (gen !== shownGeneration.current || !raws.size) return null;

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
      if (gen !== shownGeneration.current) return null;

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
      return gen === shownGeneration.current && byFrom.size ? byFrom : null;
    },
    [author],
  );

  const importExistingMarkup = useCallback(
    async (next: PdfEngine, sourcePages: readonly Page[], gen: number) => {
      const byFrom = await collectMarkup(next, sourcePages, gen);
      if (!byFrom || gen !== shownGeneration.current) return;
      const originals = new Map(sourcePages.map((q) => [q.id, q.from]));
      let count = 0;
      for (const list of byFrom.values()) {
        count += list.length;
        // Exactly as read from the file: saved back untouched while unchanged.
        for (const a of list) pristineAnnotsRef.current.add(a);
      }

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
    [amend, collectMarkup, toast],
  );

  /**
   * A restored session (draft, .elium) holds its own copies of the file's
   * annotations: remember them as the file has them, so the untouched ones are
   * recognised (structurally) and left in the file instead of rewritten.
   */
  const snapshotMarkup = useCallback(
    async (next: PdfEngine, pages: readonly Page[], gen: number) => {
      const byFrom = await collectMarkup(next, pages, gen);
      if (gen !== shownGeneration.current) return;
      const map = new Map<string, Annot>();
      for (const list of byFrom?.values() ?? []) for (const a of list) map.set(a.id, a);
      snapshotRef.current = map;
    },
    [collectMarkup],
  );

  const openBytes = useCallback(
    async (
      raw: Uint8Array,
      name: string,
      password?: string,
      restore?: PdfState,
      handle?: FsFileHandle | null,
      extra: OpenExtra = {},
    ) => {
      const { recovered, rebased, derived, unsaved } = extra;
      // Taken BEFORE the (slow) open: when a second file is picked while the
      // first one is still opening, only the last choice may be shown, whichever
      // finishes first. The engine being replaced is destroyed by the `engine`
      // effect below once the new one is committed.
      const gen = ++openGeneration.current;
      setLoading(true);
      setLoadError("");
      try {
        // Only the document, page 1 and the metadata are awaited: everything
        // else (page sizes, bookmarks, existing markup, attachments, layers,
        // form/signature facts) is filled in the background.
        const next = await PdfEngine.open(raw, password);
        if (gen !== openGeneration.current || !mounted.current) {
          next.destroy();
          return;
        }
        shownGeneration.current = gen;
        const previousSourceKey = sourceKeyRef.current;
        // The engine keeps its own private copy of the file; share it rather
        // than holding a second one (a 5 MB file used to cost 10 MB of heap).
        // Nothing mutates or transfers these bytes: every pdf.js consumer is
        // handed a copy (`core/assets.ts::documentParams`).
        bytesRef.current = next.bytes;
        passwordRef.current = password ?? null;
        if (derived) {
          // The same session on a recomposed source: its file, its protection
          // change and its saves so far carry over; the destination still
          // lacks the recomposition (`derived.disk`: what it holds now).
          diskRef.current = derived.disk ?? diskRef.current;
          if (!diskKeyRef.current && derived.diskKey) diskKeyRef.current = derived.diskKey;
          sourceOnDiskRef.current = false;
          derivedRef.current = {
            changes: [...(derivedRef.current?.changes ?? []), ...derived.session.changes],
            forceFull: [...new Set([...(derivedRef.current?.forceFull ?? []), ...derived.session.forceFull])],
          };
          sourceSignedRef.current = derived.signedKept && sourceSignedRef.current;
          // Its drafts are filed under the new source: the old one goes.
          if (previousSourceKey) void deletePdfDraft(previousSourceKey).catch(() => {});
        } else {
          // A new document: its own destination, nothing saved yet — or the
          // file just rewritten by a save, which the session now continues on.
          diskRef.current = rebased?.disk ?? null;
          destRef.current = rebased?.dest ?? (handle ? fileDestination(handle) : null);
          openHandleRef.current = handle ?? null;
          securityRef.current = null;
          setSecurityDirty(false);
          setEverSaved(!!rebased);
          setEliumVersion(null);
          diskKeyRef.current = null;
          sourceOnDiskRef.current = true;
          derivedRef.current = recovered?.derived ?? null;
          sourceSignedRef.current = false;
          diskSignedRef.current = false;
        }
        sourceStoredRef.current = null;
        if (!(derived && restore)) {
          pristineAnnotsRef.current = new Set();
          pristineBookmarksRef.current = null;
        }
        // (A recomposition that keeps the state — OCR — keeps what recognises its untouched markup.)
        if (!(derived && restore)) snapshotRef.current = null;
        redactConfirmed.current = false;
        sourceKeyRef.current = null;
        setDocSigned(rebased ? false : derived ? sourceSignedRef.current : null);
        // Freshly opened, rebased on the file just saved, or restored from an
        // .elium (which holds the session): nothing is unsaved yet. A recovered
        // or recomposed session, or a new document, is unsaved work.
        const clean = !recovered && !derived && !unsaved;
        markClean.current = clean;
        if (!clean) setSavedVersion(-1);
        if (recovered) {
          sourceOnDiskRef.current = startsWithBytes(recovered.disk, next.bytes);
          void readDiskState(recovered.disk, password)
            .then((d) => {
              if (gen === shownGeneration.current) diskRef.current = d;
            })
            .catch(() => {});
          void sourceKey(recovered.disk).then((k) => {
            if (gen === shownGeneration.current) diskKeyRef.current = k;
          });
        }
        if (!rebased && !derived) {
          // Signature facts are computed in the background (see PdfEngine.infoReady).
          void next.infoReady.then((info) => {
            if (gen !== shownGeneration.current) return;
            sourceSignedRef.current = info.signed;
            diskSignedRef.current = info.signed;
          });
        }
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
        currentStore.set(1);
        setMode("view");

        void next
          .outline()
          .then((outline) => {
            if (gen !== shownGeneration.current || !outline.length) return;
            const bookmarks: Bookmark[] = outlineToBookmarks(outline);
            if (!(derived && restore)) pristineBookmarksRef.current = bookmarks;
            amend((s) => (s.bookmarks == null ? { ...s, bookmarks } : s));
          })
          .catch(() => {});
        void next.attachments().then((a) => gen === shownGeneration.current && setAttachments(a));
        void next.layers().then((l) => gen === shownGeneration.current && setLayers(l));
        // Let the first page paint before competing for the pdf.js worker.
        setTimeout(() => {
          if (gen !== shownGeneration.current) return;
          if (!restore) void importExistingMarkup(next, sourcePages, gen).catch(() => {});
          else if (!derived) void snapshotMarkup(next, sourcePages, gen).catch(() => {});
        }, 250);
        // Unsaved edits of this very file from an earlier session (crash,
        // closed window) are offered back.
        void sourceKey(next.bytes)
          .then(async (key) => {
            if (gen !== shownGeneration.current) return;
            sourceKeyRef.current = key;
            if (restore || rebased || derived) return;
            const draft = await findPdfDraft(key).catch(() => undefined);
            if (!draft || gen !== shownGeneration.current) return;
            const when = new Date(draft.updatedAt).toLocaleString("fr-FR");
            const ok = await dialogs.confirm({
              title: "Modifications non enregistrées",
              message: `Des modifications de « ${draft.name} » faites le ${when} n'ont pas été enregistrées dans le fichier. Les restaurer ?`,
              confirmLabel: "Restaurer",
              cancelLabel: "Ignorer",
            });
            if (gen !== shownGeneration.current) return;
            if (!ok) {
              await deletePdfDraft(draft.id).catch(() => {});
              return;
            }
            try {
              const recoveredState = await resolvePdfDraft(draft, vaultSecret);
              if (draft.id === key) {
                reset(recoveredState);
                markClean.current = false;
                setSavedVersion(-1);
                void snapshotMarkup(next, recoveredState.pages, gen).catch(() => {});
              } else {
                // This file was saved into by the session (or the session was
                // recomposed): rebuild it on the source it applies to, with
                // this file as its destination.
                const source = await loadPdfDraftSource(draft, next.bytes, vaultSecret);
                if (!source) throw new Error("Le fichier d'origine de ces modifications n'a pas été conservé.");
                await openBytes(source, name, password, recoveredState, handle, {
                  recovered: { disk: next.bytes, derived: draft.derived },
                });
              }
              toast("success", "Modifications restaurées", "Enregistrez (Ctrl+S) pour les écrire dans le fichier.");
            } catch (err) {
              toast("danger", "Restauration impossible", err instanceof Error ? err.message : undefined);
            }
          })
          .catch(() => {});
      } catch (e) {
        // A newer file was picked meanwhile: this one's failure is moot.
        if (gen !== openGeneration.current) return;
        if (e instanceof PdfPasswordRequired) {
          setPendingPassword({ bytes: raw, name, wrong: e.wrong, handle });
        } else {
          // The message stays generic for the user; the cause goes to the console for diagnosis.
          console.warn("[pdf] ouverture impossible :", e);
          setLoadError("Impossible d'ouvrir ce PDF : le fichier semble illisible ou endommagé.");
        }
      } finally {
        if (gen === openGeneration.current) setLoading(false);
      }
    },
    [reset, amend, importExistingMarkup, snapshotMarkup, currentStore, dialogs, toast, vaultSecret, setSecurityDirty],
  );

  const openFile = useCallback(
    async (file: File, handle?: FsFileHandle | null) => {
      await openBytes(new Uint8Array(await file.arrayBuffer()), file.name, undefined, undefined, handle);
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
      FormSession.peek(engine)?.destroy();
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
  // --- form filling (pdf.js form layer ⇄ state.formValues) -----------------
  const formSession = useMemo(() => (engine ? FormSession.for(engine) : null), [engine]);
  useEffect(() => {
    if (formSession) formSession.fileName = fileName || "document.pdf";
  }, [formSession, fileName]);
  useEffect(() => {
    if (!formSession) return;
    const off = formSession.onChange((changes, meta) => {
      const apply = (s: PdfState) => ({ ...s, formValues: { ...s.formValues, ...changes } });
      // One undo step per field visit (typing) or per click (boxes, lists);
      // what the form's scripts compute joins the step that caused it.
      if (meta.newStep) setState(apply);
      else setQuiet(apply);
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formSession]);
  useEffect(() => {
    formSession?.sync(state.formValues);
  }, [formSession, state.formValues]);
  useEffect(() => {
    setFormBarHidden(false);
  }, [engine]);
  useEffect(() => {
    try {
      localStorage.setItem("elium.pdf.fieldHighlight", fieldHighlight ? "1" : "0");
    } catch {
      /* preference only */
    }
  }, [fieldHighlight]);

  useEffect(() => {
    void hasLocalModels().then(setLocalModels);
    // Fetch the viewer components and start the pdf.js worker (fetch + compile
    // ≈ 1 MB) while the user picks a file.
    void loadViewerLib().catch(() => {});
    warmUpPdfWorker();
  }, []);

  // -------------------------------------------------------------------------
  // Unsaved changes: title, closing guard, recovery drafts
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!engine) return;
    const previous = document.title;
    document.title = `${dirty ? "● " : ""}${fileName || "PDF"} — Elium PDF`;
    return () => {
      document.title = previous;
    };
  }, [engine, dirty, fileName]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  // Snapshot the editing state while it is unsaved (debounced). A protected
  // PDF's edits are only stored encrypted (vault unlocked), never in clear —
  // "protected" meaning the source, the file saved into, or a protection
  // about to be applied. The PDF itself is not copied (see model/recovery.ts):
  // only a recomposed source, which exists nowhere else, is kept — once.
  useEffect(() => {
    if (!engine || !dirty) return;
    const timer = setTimeout(() => {
      const key = sourceKeyRef.current;
      const source = bytesRef.current;
      if (!key || !source) return;
      const sourceProtected = engine.info.encrypted || !!diskRef.current?.crypt || !!securityRef.current;
      void buildPdfDraft({
        id: key,
        name: fileName || "document.pdf",
        size: source.length,
        state,
        sourceProtected,
        secret: vaultSecret,
        handle: destRef.current?.handle ?? openHandleRef.current ?? undefined,
        diskKey: diskKeyRef.current ?? undefined,
        derived: derivedRef.current ?? undefined,
      })
        .then(async (draft) => {
          if (!draft) return;
          if (!sourceOnDiskRef.current && sourceStoredRef.current !== key) {
            const rec = await buildPdfSource({ id: key, bytes: source, sourceProtected, secret: vaultSecret });
            if (!rec) return;
            await putPdfSource(rec);
            sourceStoredRef.current = key;
          }
          await putPdfDraft(draft);
        })
        .catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [engine, dirty, state, fileName, vaultSecret]);

  // Recoverable sessions, listed on the start screen.
  useEffect(() => {
    if (engine) return;
    let alive = true;
    void listPdfDrafts()
      .then((list) => alive && setDrafts(list))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [engine]);

  const reopenDraft = async (d: PdfDraftEntry) => {
    const handle = d.handle;
    if (!handle) return;
    try {
      const mode = { mode: "read" as const };
      if (handle.queryPermission && (await handle.queryPermission(mode)) !== "granted") {
        if (!handle.requestPermission || (await handle.requestPermission(mode)) !== "granted") return;
      }
      await openFile(await handle.getFile(), handle);
    } catch {
      toast(
        "danger",
        "Fichier introuvable",
        `« ${d.name} » a été déplacé ou supprimé : rouvrez-le depuis son nouvel emplacement.`,
      );
    }
  };

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
  // Tracked by page id: inserting, deleting or moving other pages keeps
  // fitting the same page (the zoom does not jump).
  const fitPageId = useRef<string | null>(null);
  /** Bumped by an explicit fit request, so asking again for the same fit re-fits the page now current. */
  const [fitNonce, setFitNonce] = useState(0);
  useEffect(() => {
    fitPageId.current = pages[currentStore.get() - 1]?.id ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.zoomMode, view.mode, viewport, fitNonce]);
  /** « Largeur » / « Page entière » / « Zone de texte »: fit the page now current. */
  const requestFit = (zoomMode: Exclude<ViewState["zoomMode"], "custom">) => {
    setView((v) => ({ ...v, zoomMode }));
    setFitNonce((n) => n + 1);
  };
  const applyFit = useCallback(() => {
    if (view.zoomMode === "custom" || viewport.width <= 0 || viewport.height <= 0) return;
    const page = pages.find((q) => q.id === fitPageId.current) ?? pages[0];
    if (!page) return;
    const size = sizeOf(page);
    const box = rotationOf(page) % 180 === 0 ? size : { w: size.h, h: size.w };
    const twoUp = view.mode === "facing" || view.mode === "facingContinuous";
    const next = clamp(fitScale(view.zoomMode, box, viewport, { twoUp }), MIN_SCALE, MAX_SCALE);
    setView((v) => (v.zoomMode === "custom" || Math.abs(v.scale - next) <= 0.002 ? v : { ...v, scale: next }));
    // `fitNonce`: an explicit request re-fits even when the mode is unchanged.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.zoomMode, view.mode, viewport, pages, sizeOf, rotationOf, fitNonce]);
  useEffect(() => {
    applyFit();
  }, [applyFit]);

  const setScale = (next: number, mode: ViewState["zoomMode"] = "custom") =>
    setView((v) => ({ ...v, scale: clamp(next, MIN_SCALE, MAX_SCALE), zoomMode: mode }));

  const zoomStep = (dir: 1 | -1) => {
    const presets = ZOOM_PRESETS.map(presetScale);
    const i = presets.findIndex((z) => (dir > 0 ? z > view.scale + 0.001 : z >= view.scale - 0.001));
    const next =
      dir > 0 ? presets[i < 0 ? presets.length - 1 : i] : presets[Math.max(0, (i < 0 ? presets.length : i) - 1)];
    setScale(next ?? view.scale * (dir > 0 ? 1.2 : 0.8));
  };

  /** Show 1-based page `page`, `y` points below its top edge. */
  const goTo = useCallback(
    (page: number, y?: number) => {
      const target = clamp(Math.round(page), 1, Math.max(1, pageCountRef.current));
      stackRef.current?.scrollToPage(target - 1, { top: y ? Math.max(0, y) : 0 });
      currentStore.set(target);
    },
    [currentStore],
  );

  const onCurrentChange = useCallback((current: number) => currentStore.set(current), [currentStore]);
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
    // A field tool works in « Préparer un formulaire »; a markup tool leaves it.
    if (next.startsWith("field:")) {
      setMode("fields");
      setSelectedIds([]);
    } else if (toolIsAnnot(next) && mode === "fields") setMode("view");
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

  // -------------------------------------------------------------------------
  // Saving
  // -------------------------------------------------------------------------
  /** Options of a plain « Enregistrer »: the document itself, markup kept editable. */
  const saveOptions = (st: PdfState = state): Partial<BuildOptions> => ({
    interactiveAnnots: true,
    flattenForms: false,
    applyRedactions: true,
    sanitise: false,
    optimise: false,
    author,
    fileName,
    password: passwordRef.current ?? "",
    ...pristineOptions(st),
  });

  /**
   * The file's own annotations and outline the state still holds unchanged —
   * left in the file as they are. Recognised by identity in the session that
   * imported them, structurally in a restored one (draft, .elium).
   */
  const pristineOptions = (st: PdfState): Pick<BuildOptions, "pristineAnnots" | "pristineBookmarks"> => {
    const snapshot = snapshotRef.current;
    const identity = pristineAnnotsRef.current;
    const kept = new Set<Annot>();
    for (const a of st.annots) {
      if (identity.has(a)) kept.add(a);
      else if (snapshot) {
        const original = snapshot.get(a.id);
        if (original && sameValue(a, original)) kept.add(a);
      }
    }
    const fileOutline = pristineBookmarksRef.current;
    const sameOutline = !!st.bookmarks && !!fileOutline && sameValue(st.bookmarks, fileOutline, IGNORE_IDS);
    return { pristineAnnots: kept, pristineBookmarks: sameOutline ? st.bookmarks : fileOutline };
  };

  /** A complete derived copy (print, extraction, split, signing): no protection, pdf-lib readable. */
  const buildDerived = (st: PdfState = state, extra: Partial<BuildOptions> = {}) =>
    buildPdf(bytesRef.current!, st, {
      ...buildOptions,
      author,
      fileName,
      password: passwordRef.current ?? "",
      encryption: "remove",
      ...pristineOptions(st),
      ...extra,
    });

  /** Edits that Acrobat reports as changes to a signed document's content. */
  const contentChanges = (st: PdfState): string[] => {
    const out: string[] = [...(derivedRef.current?.changes ?? [])];
    if (st.contentEdits.length) out.push("texte modifié");
    if (st.imageEdits.length) out.push("images modifiées");
    if (st.pages.some((p, i) => p.from !== i || p.rotate || p.crop || p.skipped || p.label)) out.push("pages");
    if (st.watermark.enabled || st.header.enabled || st.footer.enabled || st.bates.enabled) {
      out.push("filigrane / en-têtes");
    }
    if (st.createdFields.length) out.push("champs ajoutés");
    if (st.fieldEdits.length) out.push("champs du formulaire modifiés");
    return out;
  };

  /** Comments added, edited or deleted relative to the file. */
  const annotationChanges = (st: PdfState): boolean => {
    const kept = pristineOptions(st).pristineAnnots!.size;
    const originals = snapshotRef.current?.size ?? pristineAnnotsRef.current.size;
    return kept !== st.annots.length || kept !== originals;
  };

  /**
   * Warn before a save that would break a digital signature (or a
   * certification). `base`: the file the save builds on. False = cancelled.
   */
  const confirmSignedSave = async (st: PdfState, reasons: string[], base: Uint8Array): Promise<boolean> => {
    if (reasons.length) {
      return dialogs.confirm({
        title: "Document signé électroniquement",
        message:
          `Ce document porte une signature électronique. Cet enregistrement doit réécrire tout le fichier (${reasons.join(" ; ")}) : ` +
          "la signature sera supprimée et ne pourra plus être vérifiée.\n\nPour la conserver, annulez et renoncez à ces modifications (les commentaires et le remplissage de formulaire, eux, sont enregistrés sans toucher à la signature).",
        confirmLabel: "Réécrire et perdre la signature",
        cancelLabel: "Annuler",
      });
    }
    const changes = contentChanges(st);
    // A certifying signature (DocMDP) narrows what may change after it.
    const { certificationLevel } = await import("../ops/incremental");
    const level = certificationLevel(base);
    const comments = annotationChanges(st);
    if (level === 1 || (level === 2 && comments)) {
      return dialogs.confirm({
        title: "Document certifié",
        message:
          level === 1
            ? "Ce document est certifié sans aucune modification autorisée : tout enregistrement de modifications sera signalé par Acrobat comme une violation de la certification."
            : "Ce document est certifié pour le seul remplissage de formulaire et la signature : les commentaires ajoutés ou modifiés seront signalés par Acrobat comme une violation de la certification.",
        confirmLabel: "Enregistrer quand même",
        cancelLabel: "Annuler",
      });
    }
    if (!changes.length) return true; // comments and form filling keep an approval signature valid
    return dialogs.confirm({
      title: "Document signé électroniquement",
      message:
        `Vous avez modifié le contenu signé (${changes.join(", ")}). La version signée restera intacte dans le fichier ` +
        "(enregistrement incrémental), mais Acrobat signalera que le document a été modifié après signature : " +
        "la signature apparaîtra comme invalide pour la version actuelle. Les commentaires et le remplissage de formulaire, eux, ne l'affectent pas.",
      confirmLabel: "Enregistrer quand même",
      cancelLabel: "Annuler",
    });
  };

  /** Tell the user exactly what was written — never a plain success when an edit was lost. */
  const reportSave = async (
    r: BuildReport,
    dest: SaveDestination,
    signedOutput: Uint8Array | null,
    notes: string[] = [],
  ) => {
    const size = (n: number) =>
      n < 1024 ? `${n} o` : n < 1048576 ? `${(n / 1024).toFixed(1)} Ko` : `${(n / 1048576).toFixed(2)} Mo`;
    const facts: string[] = [];
    facts.push(
      r.mode === "incremental"
        ? r.objectsWritten
          ? `enregistrement incrémental : +${size(r.bytesAdded)}, contenu d'origine intact`
          : "aucune modification à écrire"
        : `fichier entièrement réécrit (${r.fullReasons.join(" ; ")}) : ${size(r.bytes)}`,
    );
    if (r.encryption === "kept") facts.push(`protection ${r.scheme} conservée`);
    if (r.encryption === "added") facts.push(`protégé (${r.scheme})`);
    if (r.encryption === "changed") facts.push(`nouveau mot de passe (${r.scheme})`);
    if (r.encryption === "removed") facts.push("protection retirée");
    if (r.redactedGlyphs || r.redactedImages) {
      facts.push(`${r.redactedGlyphs} caractère(s) et ${r.redactedImages} image(s) caviardés`);
    }
    facts.push(...notes);
    if (signedOutput) {
      try {
        const { verifyPdfSignatures } = await import("../ops/pades");
        const v = verifyPdfSignatures(signedOutput);
        if (v.length && v.every((x) => x.digestMatches)) {
          facts.push("signature électronique préservée (version signée intacte)");
        } else {
          facts.push("signature électronique supprimée");
          toast(
            "warning",
            "Signature électronique",
            "La signature du document n'est plus vérifiable dans le fichier enregistré.",
          );
        }
      } catch {
        /* verification is informative */
      }
    }
    const where = dest.kind === "download" ? `Téléchargé : ${dest.name}` : `Enregistré : ${dest.name}`;
    if (r.lost.length) {
      toast("warning", `${where} — ${r.lost.length} modification(s) NON enregistrée(s)`, facts.join(" · "));
      await dialogs.alert({
        title: "Certaines modifications n'ont pas été enregistrées",
        message: `Le fichier a été écrit, mais ces modifications visibles à l'écran n'y figurent pas :\n\n• ${r.lost.join("\n• ")}`,
      });
    } else {
      toast("success", where, `${r.durationMs} ms · ${facts.join(" · ")}`);
    }
    for (const w of r.warnings) toast("info", w);
  };

  /**
   * Write the document to `dest`. `copy`: a transformed copy (the document
   * stays attached to its current file); `fresh`: the destination does not
   * hold the document yet (a new file, a download) — start from the source.
   */
  const runSave = async (
    dest: SaveDestination,
    options: Partial<BuildOptions>,
    how: { copy: boolean; fresh: boolean; mode?: "auto" | "full" },
  ): Promise<boolean> => {
    if (!bytesRef.current || !engine || saving.current) return false;
    // Write access first, while the user's gesture is still valid.
    let allowed = false;
    try {
      allowed = await dest.prepare();
    } catch {
      allowed = false;
    }
    if (!allowed) {
      toast("danger", "Enregistrement impossible", `L'accès en écriture à « ${dest.name} » a été refusé.`);
      return false;
    }
    const st = state;
    const ver = version;
    const source = bytesRef.current;
    const disk = how.copy || how.fresh || !dest.persistent ? null : diskRef.current;
    // A protection change is relative to the source: re-applied whenever we start from it.
    const security = disk ? (securityDirtyRef.current ? securityRef.current : null) : securityRef.current;
    // A recomposed session saved into the file that still has the pages it
    // removed before recomposing: that file must be rewritten.
    const forceFull = disk && derivedRef.current?.forceFull.length ? derivedRef.current.forceFull : undefined;
    const opts: Partial<BuildOptions> = { ...saveOptions(st), ...options };
    const marks = st.annots.filter((a) => a.kind === "redact").length;
    if (marks && opts.applyRedactions && !redactConfirmed.current) {
      const ok = await dialogs.confirm({
        title: "Appliquer le caviardage",
        message: `${marks} zone(s) marquée(s) seront définitivement supprimées du fichier enregistré (texte, images et annotations dessous), révisions précédentes comprises.`,
        confirmLabel: "Caviarder et enregistrer",
      });
      if (!ok) return false;
      redactConfirmed.current = true;
    }
    await engine.infoReady;
    // Signed as the file this save builds on is — not as the source once was
    // (a full rewrite already removed the signature from the file saved into).
    const signed = disk ? diskSignedRef.current : sourceSignedRef.current;
    if (signed) {
      const reasons = fullRewriteReasons(
        st,
        {
          applyRedactions: !!opts.applyRedactions,
          optimise: !!opts.optimise,
          sanitise: !!opts.sanitise,
          flattenForms: !!opts.flattenForms,
        },
        engine.pageCount,
        security,
      );
      for (const r of forceFull ?? []) if (!reasons.includes(r)) reasons.push(r);
      if (how.mode === "full" && !reasons.length) reasons.push("réécriture complète demandée");
      if (!(await confirmSignedSave(st, reasons, disk?.bytes ?? source))) return false;
    }

    saving.current = true;
    setBusy(true);
    const id = toast("progress", "Enregistrement…");
    try {
      const res = await savePdf({
        source,
        disk,
        state: st,
        options: {
          ...opts,
          onProgress: (label, ratio) =>
            setToasts((v) => v.map((t) => (t.id === id ? { ...t, text: label, ratio } : t))),
        },
        security,
        forceFullReasons: forceFull,
        mode: how.mode ?? "auto",
      });
      await dest.write(res.bytes);
      const notes: string[] = [];
      // The session goes on from the file just written when that file
      // replaced everything (no earlier revision kept): the original — e.g.
      // what a redaction removed — is no longer held anywhere, and the next
      // saves append to this file again instead of rewriting it each time.
      const rebase = !how.copy && dest.persistent && res.report.mode === "full";
      if (!how.copy) {
        if (dest.persistent) {
          destRef.current = dest;
          diskRef.current = res.disk;
          diskKeyRef.current = null;
          if (!disk) sourceOnDiskRef.current = true; // written as source + update
          if (res.report.mode === "full") diskSignedRef.current = false;
          else if (!disk) diskSignedRef.current = sourceSignedRef.current;
          derivedRef.current = null;
          // Recovery finds the session by the file saved into (its source is
          // its first bytes, or kept apart for a recomposed session).
          if (!rebase) {
            void sourceKey(res.bytes).then((k) => {
              if (diskRef.current === res.disk) diskKeyRef.current = k;
            });
          }
          if (dest.name !== fileName) setFileName(dest.name);
        } else {
          diskRef.current = null;
        }
        setSavedVersion(ver);
        setSecurityDirty(false);
        setEverSaved(true);
        const key = sourceKeyRef.current;
        if (key) void deletePdfDraft(key).catch(() => {});
        sourceStoredRef.current = null;
      }
      dismissToast(id);
      if (rebase) {
        notes.push("l'historique d'annulation repart du fichier enregistré");
        const pw =
          security === "remove"
            ? undefined
            : security
              ? security.protect.userPassword || security.protect.ownerPassword || undefined
              : (passwordRef.current ?? undefined);
        await openBytes(res.bytes, dest.name, pw, undefined, dest.handle ?? openHandleRef.current, {
          rebased: { disk: res.disk, dest },
        });
      }
      await reportSave(res.report, dest, signed ? res.bytes : null, notes);
      return true;
    } catch (e) {
      dismissToast(id);
      toast(
        "danger",
        "Échec de l'enregistrement",
        e instanceof Error ? e.message : "Le fichier n'a pas pu être écrit : rien n'a été modifié.",
      );
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  };

  /** « Enregistrer » (Ctrl+S): back into the open file, or ask once where. */
  const saveNow = async (force = false) => {
    if (!bytesRef.current || !engine) return;
    const current = destRef.current;
    if (current && !pdfDirty && !force) {
      toast("info", "Aucune modification à enregistrer.", `« ${current.name} » est à jour.`);
      return;
    }
    let dest = current;
    if (!dest) {
      if (canWriteFiles()) {
        try {
          dest = await pickSaveTarget(pdfName(fileName));
        } catch {
          dest = downloadDestination(pdfName(fileName));
        }
        if (!dest) return; // cancelled
      } else {
        dest = downloadDestination(pdfName(fileName));
      }
    }
    await runSave(dest, {}, { copy: false, fresh: dest !== current });
  };

  /** « Enregistrer sous… » / « Enregistrer une copie » (from the dialog). */
  const saveAs = async (name: string, o: SaveAsOptions) => {
    const copy = isCopyOptions(o);
    let dest: SaveDestination | null;
    if (canWriteFiles()) {
      try {
        dest = await pickSaveTarget(pdfName(name));
      } catch {
        dest = downloadDestination(pdfName(name));
      }
      if (!dest) return;
    } else {
      dest = downloadDestination(pdfName(name));
    }
    await runSave(dest, o, { copy, fresh: true, mode: o.optimise ? "full" : "auto" });
  };

  /** Leaving the document with unsaved changes asks first. */
  const confirmDiscard = async (): Promise<boolean> => {
    if (!dirty) return true;
    const ok = await dialogs.confirm({
      title: "Modifications non enregistrées",
      message: `« ${fileName} » a des modifications qui ne sont pas enregistrées dans le fichier. Les abandonner ?`,
      confirmLabel: "Abandonner les modifications",
      cancelLabel: "Annuler",
    });
    if (ok && sourceKeyRef.current) void deletePdfDraft(sourceKeyRef.current).catch(() => {});
    return ok;
  };

  /** Where the source bytes of a recomposed document (inserted pages, OCR) go: see `openBytes` « derived ». */
  const adoptDerived = async (bytes: Uint8Array, session: DerivedSession, signedKept: boolean, keep?: PdfState) => {
    // The destination still holds the previous source (never saved into):
    // describe it now — it is what the next save appends to.
    let disk: DiskState | null = null;
    if (!diskRef.current && destRef.current?.persistent && bytesRef.current) {
      disk = await readDiskState(bytesRef.current, passwordRef.current);
    }
    const diskKey = diskKeyRef.current ?? sourceKeyRef.current;
    await openBytes(bytes, fileName, passwordRef.current ?? undefined, keep, openHandleRef.current, {
      derived: { session, disk, diskKey, signedKept },
    });
  };

  const goHome = async () => {
    if (await confirmDiscard()) onHome();
  };

  /** Open a file: system picker (keeps a handle to save back) or the classic input. */
  const openDialog = async () => {
    if (!(await confirmDiscard())) return;
    if (canWriteFiles()) {
      try {
        const picked = await pickPdfToOpen();
        if (picked) await openFile(picked.file, picked.handle);
        return;
      } catch {
        /* fall back to the classic input */
      }
    }
    openInput.current?.click();
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
    return buildDerived(st);
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
    const base = fileName.replace(/.pdf$/i, "") || "document";
    const title = await dialogs.prompt({
      title: "Enregistrer en .elium",
      label: "Nom du document",
      defaultValue: base,
    });
    if (title === null) return;
    const ver = version;
    const ok = await onExportElium(
      serialize(fileName || "document.pdf", bytesRef.current, state, {
        fonts: collectFonts(),
        signatures: signatures.map((s) => s.src),
        sourcePassword: passwordRef.current ?? undefined,
      }),
      title.trim() || base,
    );
    // Cancelled (password dialog closed) or failed: nothing was saved.
    if (!ok) return;
    // The whole session (source + edits) is now kept in the .elium — but the
    // PDF file itself is not updated: Ctrl+S still writes it.
    setEliumVersion(ver);
    if (sourceKeyRef.current) void deletePdfDraft(sourceKeyRef.current).catch(() => {});
    sourceStoredRef.current = null;
    toast(
      "success",
      "Session enregistrée en .elium",
      pdfDirty && destRef.current
        ? `Scellée et re-modifiable. « ${destRef.current.name} » n'a pas ces modifications : Ctrl+S pour l'enregistrer.`
        : "Scellée, chiffrable et re-modifiable.",
    );
  };

  const printDocument = async () => {
    if (!bytesRef.current) return;
    setBusy(true);
    const id = toast("progress", "Préparation de l'impression…");
    try {
      const { bytes } = await buildDerived(state, { interactiveAnnots: false, flattenForms: true });
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
  const currentPage = () => pages[currentStore.get() - 1];
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
        void saveNow();
        return;
      case "saveAs":
        setSaveAsPreset({});
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
      case "formPrepare":
        setMode(mode === "fields" ? "view" : "fields");
        setPrepSelected([]);
        setSelectedIds([]);
        if (mode !== "fields") setTool("select");
        return;
      case "formMode":
        // Fields are fillable as soon as the file opens (pdf.js form layer):
        // this command only toggles their highlighting, like Acrobat.
        setFieldHighlight((v) => !v);
        if (mode === "form" || mode === "fields") setMode("view");
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
        requestFit("fitWidth");
        return;
      case "fitPage":
        requestFit("fitPage");
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
      case "exportFormXfdf":
      case "exportFormCsv":
      case "exportFormText": {
        // Every fillable field (Acrobat's export), not only the edited ones.
        if (!formSession) return;
        await formSession.ready;
        await formSession.flush();
        const entries = exportEntries(formSession.fields, formSession.values());
        if (!entries.length) {
          toast("warning", "Ce document n'a aucun champ de formulaire à exporter.");
          return;
        }
        const stem = fileName.replace(/\.pdf$/i, "") || "formulaire";
        if (id === "exportFormData") {
          downloadBlob(`${stem}.fdf`, "application/vnd.fdf", toFdf(entries, fileName || "document.pdf"));
        } else if (id === "exportFormXfdf") {
          downloadBlob(
            `${stem}-donnees.xfdf`,
            "application/vnd.adobe.xfdf",
            toXfdfFields(entries, fileName || "document.pdf"),
          );
        } else if (id === "exportFormCsv") {
          downloadBlob(`${stem}-donnees.csv`, "text/csv;charset=utf-8", toCsv(entries));
        } else {
          downloadBlob(`${stem}-donnees.txt`, "text/plain;charset=utf-8", toTabText(entries));
        }
        toast("success", "Données exportées", `${entries.length} champ(s).`);
        return;
      }
      case "formReset": {
        // Every field back to its default value (/DV, else empty), on screen
        // and in the file — not merely « forget this session's edits ».
        if (!formSession) return;
        await formSession.ready;
        const defaults = formSession.defaults();
        const changed = Object.entries(defaults).filter(
          ([name, v]) => !sameFormValue(formSession.values()[name], v),
        ).length;
        setState((s) => ({ ...s, formValues: { ...s.formValues, ...defaults } }));
        toast("info", changed ? `Formulaire réinitialisé (${changed} champ(s)).` : "Le formulaire est déjà vide.");
        return;
      }
      case "formFlatten":
        setSaveAsPreset({ flattenForms: true });
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
          message: `${marks.length} zone(s) seront définitivement supprimées du fichier à l'enregistrement : texte, images et annotations situés dessous. Le fichier est entièrement réécrit, sans révision antérieure qui garderait ce contenu.`,
          confirmLabel: "Caviarder et enregistrer",
        });
        if (!ok) return;
        redactConfirmed.current = true;
        void saveNow(true);
        return;
      }
      case "sanitise":
        setSaveAsPreset({ sanitise: true });
        setDialog("save");
        return;
      case "optimise":
        setSaveAsPreset({ optimise: true });
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
      const { bytes } = await buildDerived();
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
      `Formulaire : ${engine.info.isXfa ? `XFA ${xfaKind === "hybrid" ? "hybride" : "dynamique"}` : engine.info.hasAcroForm ? "AcroForm" : "aucun"}`,
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
      // Checks the password (throws WrongPassword); the protection itself is
      // dropped by the save that follows — like Acrobat, a security change
      // takes effect when the document is saved.
      const result = await removeProtection(bytesRef.current, pw);
      securityRef.current = "remove";
      setSecurityDirty(true);
      toast("info", "Protection retirée à l'enregistrement", `Chiffrement ${result.scheme}.`);
      setBusy(false);
      await saveNow(true);
    } catch (e) {
      toast(
        "danger",
        e instanceof WrongPassword ? "Mot de passe incorrect." : "Ce document ne peut pas être déchiffré ici.",
      );
    } finally {
      setBusy(false);
    }
  };

  // --- « Préparer un formulaire » -------------------------------------------

  const FIELD_BASE: Record<FieldKind, string> = {
    text: "Texte",
    checkbox: "Case",
    radio: "Groupe",
    dropdown: "Liste",
    listbox: "ZoneListe",
    signature: "Signature",
    button: "Bouton",
  };

  /** « Texte1 », « Texte2 »… free among created fields, the file's and renames (as Acrobat numbers them). */
  const nextFieldName = (st: PdfState, base: string): string => {
    const taken = new Set<string>([...st.createdFields.map((f) => f.name), ...(formSession?.fields.keys() ?? [])]);
    for (const e of st.fieldEdits) if (e.rename) taken.add(e.rename);
    for (let n = 1; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
  };

  const createFieldAt = (pageId: string, kind: FieldKind, rect: Rect) => {
    const id = newId("fd");
    setState((s) => {
      // A radio button drawn while another created radio is selected joins its group.
      const sel = prepSelected.length === 1 && prepSelected[0].startsWith("c:") ? prepSelected[0].slice(2) : null;
      const group = kind === "radio" ? s.createdFields.find((f) => f.id === sel && f.kind === "radio") : undefined;
      let name: string;
      let exportValue: string | undefined;
      if (group) {
        name = group.name;
        const used = new Set(s.createdFields.filter((f) => f.name === name).map((f) => f.exportValue));
        let n = 1;
        while (used.has(`Choix${n}`)) n++;
        exportValue = `Choix${n}`;
      } else {
        name = nextFieldName(s, FIELD_BASE[kind]);
        exportValue = kind === "radio" ? "Choix1" : kind === "checkbox" ? "Oui" : undefined;
      }
      return D.addField(s, { id, pageId, name, kind, rect, ...(exportValue ? { exportValue } : {}) });
    });
    setPrepSelected([`c:${id}`]);
    if (!stickyRef.current) setTool("select");
  };

  const movePrepFields = (changes: { key: string; rect: Rect; fieldName?: string }[]) => {
    setQuiet((s) => {
      let next = s;
      for (const c of changes) {
        if (c.key.startsWith("c:")) next = D.updateField(next, c.key.slice(2), { rect: c.rect });
        else if (c.fieldName) next = D.upsertFieldEdit(next, c.fieldName, { rects: { [c.key.slice(2)]: c.rect } });
      }
      return next;
    });
  };

  const deletePrepFields = (items: { key: string; fieldName?: string }[]) => {
    setQuiet((s) => {
      let next = s;
      for (const it of items) {
        if (it.key.startsWith("c:")) next = D.removeField(next, it.key.slice(2));
        else if (it.fieldName) {
          const prev = next.fieldEdits.find((e) => e.name === it.fieldName)?.removeWidgets ?? [];
          next = D.upsertFieldEdit(next, it.fieldName, { removeWidgets: [...prev, it.key.slice(2)] });
        }
      }
      return next;
    });
    setPrepSelected([]);
  };

  /** Every field name as « Préparer » shows it (renames applied, deleted ones left out). */
  const allFieldNames = (st: PdfState): string[] => {
    const out = new Set<string>();
    for (const name of formSession?.fields.keys() ?? []) {
      const e = st.fieldEdits.find((x) => x.name === name);
      if (e?.deleted) continue;
      out.add(e?.rename ?? name);
    }
    for (const f of st.createdFields) out.add(f.name);
    return [...out];
  };

  const openFieldProps = async (key: string, fieldName?: string) => {
    if (key.startsWith("c:")) {
      const f = state.createdFields.find((x) => x.id === key.slice(2));
      if (!f) return;
      const { id: _i, pageId: _p, name, kind, rect: _r, tabIndex: _t, ...props } = f;
      void [_i, _p, _r, _t];
      setPrepProps({ key, kind, name, initial: props });
      return;
    }
    if (!fieldName || !formSession || !engine) return;
    const field = formSession.fields.get(fieldName);
    const widgetId = key.slice(2);
    const page = field?.widgets.find((w) => w.id === widgetId)?.page ?? field?.widgets[0]?.page ?? -1;
    const [anns, objects] = await Promise.all([
      page >= 0 ? engine.annotations(page).catch(() => []) : Promise.resolve([]),
      (engine.raw.getFieldObjects() as Promise<Record<string, { actions?: Record<string, string[]> }[]> | null>).catch(
        () => null,
      ),
    ]);
    const a = (
      anns as ({ id?: string } & PdfjsWidgetData & {
          fieldType?: string;
          checkBox?: boolean;
          radioButton?: boolean;
          combo?: boolean;
          pushButton?: boolean;
        })[]
    ).find((x) => x.id === widgetId);
    if (!a) return;
    const kind: FieldKind =
      a.fieldType === "Tx"
        ? "text"
        : a.fieldType === "Ch"
          ? a.combo
            ? "dropdown"
            : "listbox"
          : a.fieldType === "Sig"
            ? "signature"
            : a.pushButton
              ? "button"
              : a.radioButton
                ? "radio"
                : "checkbox";
    const actions = objects?.[fieldName]?.find((o) => o.actions)?.actions ?? null;
    const edit = state.fieldEdits.find((e) => e.name === fieldName);
    setPrepProps({
      key,
      fieldName,
      kind,
      name: edit?.rename ?? fieldName,
      initial: {
        ...propsFromPdfjs(a, actions),
        ...(edit?.props ?? {}),
        ...(edit?.exportValues?.[widgetId] ? { exportValue: edit.exportValues[widgetId] } : {}),
      },
    });
  };

  const applyFieldProps = (v: { name: string; props: FieldProps }) => {
    const target = prepProps;
    setPrepProps(null);
    if (!target) return;
    setState((s) => {
      if (target.key.startsWith("c:")) {
        const f = s.createdFields.find((x) => x.id === target.key.slice(2));
        if (!f) return s;
        let next = D.updateField(s, f.id, v.props);
        if (v.name !== f.name) {
          // The whole radio group follows, and so does what was filled in.
          next = {
            ...next,
            createdFields: next.createdFields.map((x) => (x.name === f.name ? { ...x, name: v.name } : x)),
          };
          if (f.name in next.formValues) {
            const { [f.name]: moved, ...rest } = next.formValues;
            next = { ...next, formValues: { ...rest, [v.name]: moved } };
          }
        }
        return next;
      }
      if (!target.fieldName) return s;
      const rename = v.name !== target.fieldName ? v.name : undefined;
      // A box's export value belongs to the widget whose dialog was opened.
      const { exportValue, ...props } = v.props;
      const exportValues = exportValue ? { [target.key.slice(2)]: exportValue } : undefined;
      if (
        !Object.keys(props).length &&
        !exportValues &&
        rename === s.fieldEdits.find((e) => e.name === target.fieldName)?.rename
      ) {
        return s;
      }
      return D.upsertFieldEdit(s, target.fieldName, {
        props: Object.keys(props).length ? props : undefined,
        rename,
        ...(exportValues ? { exportValues } : {}),
      });
    });
  };

  /**
   * Leaving « Préparer » : the fields prepared there go into the document
   * itself (an update of the source, encrypted with its key, like OCR), so
   * the form layer shows them as the real fields they now are — scripts,
   * formats and calculations included. The session goes on, its other edits
   * kept; fields on pages the source does not have (added in Elium, duplicates)
   * stay in the model and are written by the next save.
   */
  const foldPreparedFields = async (then: Mode) => {
    if (!engine || !bytesRef.current) return;
    const st = state;
    const idByFrom = new Map<number, string>();
    for (const pg of st.pages) if (pg.from != null && !idByFrom.has(pg.from)) idByFrom.set(pg.from, pg.id);
    const identity = D.pagesFromSource(engine.pageCount).map((pg, i) => ({ ...pg, id: idByFrom.get(i) ?? pg.id }));
    const ids = new Set(identity.map((pg) => pg.id));
    const folded = st.createdFields.filter((f) => ids.has(f.pageId));
    if (!folded.length && !st.fieldEdits.length) return;
    setBusy(true);
    const id = toast("progress", "Mise à jour du formulaire…");
    try {
      const res = await savePdf({
        source: bytesRef.current,
        state: { ...emptyState(), pages: identity, createdFields: folded, fieldEdits: st.fieldEdits },
        options: { password: passwordRef.current ?? "", author, fileName },
        security: null,
      });
      dismissToast(id);
      // What was filled in follows renamed fields and new export values;
      // deleted fields take theirs along.
      const formValues = { ...st.formValues };
      for (const e of st.fieldEdits) {
        if (!e.exportValues || !(e.name in formValues)) continue;
        const f = formSession?.fields.get(e.name);
        for (const [widgetId, next] of Object.entries(e.exportValues)) {
          const old = f?.widgets.find((w) => w.id === widgetId)?.exportValue;
          if (old && formValues[e.name] === old) formValues[e.name] = next;
        }
      }
      for (const e of st.fieldEdits) {
        if (!(e.name in formValues)) continue;
        const v = formValues[e.name];
        delete formValues[e.name];
        if (!e.deleted && !(e.removeWidgets && !e.rename)) formValues[e.rename ?? e.name] = v;
        else if (e.removeWidgets && !e.deleted) formValues[e.name] = v;
      }
      // A created field the file could not take (a name clash…) stays in the model, not lost.
      const made = await PDFDocument.load(res.bytes, { ignoreEncryption: true, updateMetadata: false })
        .then(
          (d) =>
            new Set(
              formOf(d)
                .getFields()
                .map((f) => f.getName()),
            ),
        )
        .catch(() => null);
      const keep: PdfState = {
        ...st,
        formValues,
        createdFields: st.createdFields.filter((f) => !folded.includes(f) || (made && !made.has(f.name))),
        fieldEdits: [],
      };
      if (res.report.lost.length) {
        toast("warning", "Préparation du formulaire", res.report.lost.join(" · "));
      }
      await adoptDerived(
        res.bytes,
        {
          changes: ["formulaire préparé"],
          forceFull: res.report.mode === "full" ? res.report.fullReasons : [],
        },
        res.report.mode === "incremental",
        keep,
      );
      // Reopening shows the document in « view »: go on in the mode the user asked for.
      if (then !== "view") setMode(then);
    } catch (err) {
      dismissToast(id);
      toast("danger", "Mise à jour du formulaire impossible", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  // Required fields still empty (Acrobat's « champs obligatoires »), in page order.
  const [requiredLeft, setRequiredLeft] = useState<{ name: string; widget: string; page: number }[]>([]);
  useEffect(() => {
    if (!formSession) {
      setRequiredLeft([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      await formSession.ready;
      const details = await formSession.details();
      const values = formSession.values();
      const out: { name: string; widget: string; page: number }[] = [];
      for (const f of formSession.fields.values()) {
        const d = details.get(f.name);
        if (!d?.required || d.readOnly || d.hidden) continue;
        if (!isEmptyValue(f, values[f.name] ?? f.fileValue)) continue;
        const w = f.widgets.find((x) => x.page >= 0);
        if (w) out.push({ name: f.name, widget: w.id, page: w.page });
      }
      out.sort((a, b) => a.page - b.page);
      if (!cancelled) setRequiredLeft(out);
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [formSession, state.formValues]);

  /** Show and focus the next required field still empty. */
  const goNextRequired = () => {
    const next = requiredLeft[0];
    if (!next) return;
    const index = pages.findIndex((pg) => pg.from === next.page);
    if (index < 0) return;
    goTo(index + 1);
    // The page mounts, then its form layer: wait for the control.
    let tries = 0;
    const focus = () => {
      const el = document.querySelector<HTMLElement>(`.pdfx-stack [data-element-id="${CSS.escape(next.widget)}"]`);
      if (el) {
        el.scrollIntoView({ block: "center" });
        el.focus();
      } else if (tries++ < 40) setTimeout(focus, 50);
    };
    focus();
  };

  useEffect(() => {
    const was = previousMode.current;
    previousMode.current = mode;
    if (was === "fields" && mode !== "fields") {
      setPrepSelected([]);
      if (tool === "select" || tool.startsWith("field:")) setTool("textSelect");
      void foldPreparedFields(mode as Mode);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

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
    const at = currentStore.get();
    const node: Bookmark = { id: newId("bm"), title: `Page ${at}`, page: at, children: [] };
    setState((s) => ({ ...s, bookmarks: D.insertBookmark(s.bookmarks ?? [], parentId, node) }));
    setPanel("bookmarks");
  };

  // -------------------------------------------------------------------------
  // File pickers
  // -------------------------------------------------------------------------
  /**
   * « Insérer depuis un PDF » / « Fusionner »: the other files' pages are
   * appended to THIS document — the same file, saved like any other edit: an
   * incremental update of it (a signed revision stays intact), encrypted with
   * its key, into the file it was opened from. The session goes on with the
   * recomposed document (the current edits folded in), marked unsaved.
   */
  const onMergePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length || !bytesRef.current || !engine) return;
    await engine.infoReady;
    const signed = sourceSignedRef.current || (!!diskRef.current && diskSignedRef.current);
    if (signed) {
      const ok = await dialogs.confirm({
        title: "Document signé électroniquement",
        message:
          "Insérer des pages modifie le contenu signé. La version signée restera intacte dans le fichier " +
          "(enregistrement incrémental), mais Acrobat signalera que le document a été modifié après signature.",
        confirmLabel: "Insérer quand même",
        cancelLabel: "Annuler",
      });
      if (!ok) return;
    }
    setBusy(true);
    const id = toast("progress", "Insertion des pages…");
    try {
      const inputs = await Promise.all(
        files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
      );
      let outcome: Awaited<ReturnType<typeof appendPdfPages>> = { inserted: 0, failed: [] };
      const res = await savePdf({
        source: bytesRef.current,
        state,
        // Redaction marks stay marks (/Redact): applying them is a save's job, confirmed.
        options: { ...saveOptions(state), applyRedactions: false },
        security: null,
        transform: async (doc) => {
          outcome = await appendPdfPages(doc, inputs, (name, wrong) =>
            dialogs.prompt({
              title: "PDF protégé",
              label: wrong ? `Mot de passe incorrect pour « ${name} », réessayez` : `Mot de passe de « ${name} »`,
            }),
          );
        },
      });
      dismissToast(id);
      const failed = outcome.failed.map((f) => `${f.name} (${f.reason})`);
      if (!outcome.inserted) {
        toast("warning", "Aucune page insérée", failed.join(", ") || undefined);
        return;
      }
      if (res.report.lost.length) {
        toast(
          "warning",
          "Insertion : certaines modifications n'ont pas pu être reportées",
          res.report.lost.join(" · "),
        );
      }
      const names = inputs.filter((f) => !outcome.failed.some((x) => x.name === f.name)).map((f) => f.name);
      await adoptDerived(
        res.bytes,
        {
          changes: [`${outcome.inserted} page(s) insérée(s) (${names.join(", ")})`],
          forceFull: res.report.mode === "full" ? res.report.fullReasons : [],
        },
        res.report.mode === "incremental",
      );
      toast(
        "success",
        `${outcome.inserted} page(s) insérée(s)`,
        [
          destRef.current
            ? `Enregistrez (Ctrl+S) pour les écrire dans « ${destRef.current.name} ».`
            : "Enregistrez (Ctrl+S).",
          failed.length ? `Ignoré : ${failed.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join(" "),
      );
    } catch (err) {
      dismissToast(id);
      toast("danger", "Insertion impossible.", err instanceof Error ? err.message : undefined);
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
      // A new document, saved nowhere yet.
      await openBytes(bytes, files[0].name.replace(/\.[^.]+$/, ".pdf"), undefined, undefined, null, {
        unsaved: true,
      });
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
    const bytes = new Uint8Array(await file.arrayBuffer());
    const head = new TextDecoder("latin1").decode(bytes.subarray(0, 1024));
    // Form data (FDF, XFDF <fields>, tab-delimited text) and comments (XFDF <annots>).
    let raw = new Map<string, RawDataValue>();
    let comments = 0;
    try {
      if (head.startsWith("%FDF")) {
        raw = parseFdf(bytes);
      } else {
        const text = new TextDecoder("utf-8").decode(bytes);
        if (/\.xfdf$/i.test(file.name) || /<xfdf[\s>]/.test(text)) {
          raw = parseXfdfFields(text);
          const heights = new Map(pages.map((pg) => [pg.id, sizeOf(pg).h]));
          const imported = fromXfdf(text, pages, heights, author);
          if (imported.length) {
            setState((s) => imported.reduce((acc, a) => D.addAnnot(acc, a), s));
            comments = imported.length;
          }
        } else {
          raw = parseTabText(text);
        }
      }
    } catch (err) {
      toast("danger", "Import impossible", err instanceof Error ? err.message : "Fichier illisible.");
      return;
    }
    if (raw.size && formSession) {
      await formSession.ready;
      const res = matchImported(formSession.fields, raw);
      const count = Object.keys(res.values).length;
      if (count) {
        setState((s) => ({ ...s, formValues: { ...s.formValues, ...res.values } }));
        setMode("form");
      }
      const notes: string[] = [];
      if (res.unknown.length) {
        notes.push(`${res.unknown.length} champ(s) absent(s) de ce document : ${res.unknown.slice(0, 5).join(", ")}.`);
      }
      if (res.rejected.length) {
        notes.push(`Valeur inadaptée ignorée pour : ${res.rejected.slice(0, 5).join(", ")}.`);
      }
      if (comments) notes.push(`${comments} commentaire(s) importé(s).`);
      toast(
        count ? (notes.length ? "warning" : "success") : "warning",
        `${count} champ(s) importé(s)`,
        notes.join(" "),
      );
      return;
    }
    if (comments) {
      setPanel("comments");
      toast("success", `${comments} commentaire(s) importé(s).`);
      return;
    }
    toast("warning", "Aucune donnée de formulaire ni commentaire dans ce fichier.");
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
  // The keyboard handler below is registered for a subset of the state only:
  // saving must always see the latest state, so it goes through refs.
  const saveNowRef = useRef(saveNow);
  saveNowRef.current = saveNow;
  const openDialogRef = useRef(openDialog);
  openDialogRef.current = openDialog;
  // Ctrl+S / Ctrl+Maj+S, caught in the capture phase so it works everywhere —
  // even inside a text box that stops key events — and never falls through to
  // the browser's « save page ». A comment, text block or bookmark being edited
  // commits on blur: blur first, then save the state that includes it.
  useEffect(() => {
    const onSaveKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      e.stopPropagation();
      if (document.querySelector('[role="dialog"]')) return; // a dialog is open: finish it first
      const active = document.activeElement as HTMLElement | null;
      const editing =
        !!active && (active.tagName === "TEXTAREA" || active.tagName === "INPUT" || active.isContentEditable);
      const run = () => {
        if (e.shiftKey) {
          setSaveAsPreset({});
          setDialog("save");
        } else void saveNowRef.current();
      };
      if (editing) {
        active!.blur();
        setTimeout(run, 0);
      } else run();
    };
    window.addEventListener("keydown", onSaveKey, true);
    return () => window.removeEventListener("keydown", onSaveKey, true);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog owns the keyboard (a tool letter would leave the mode behind it).
      if (document.querySelector('[role="dialog"]')) return;
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
        if (k === "p") {
          e.preventDefault();
          void printDocument();
          return;
        }
        if (k === "o") {
          e.preventDefault();
          void openDialogRef.current();
          return;
        }
        if (!inField && k === "a" && mode !== "fields") {
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
        // Acrobat's: Ctrl+0 page entière, Ctrl+1 taille réelle (100 %), Ctrl+2 largeur.
        if (k === "0") {
          e.preventDefault();
          requestFit("fitPage");
          return;
        }
        if (k === "1" && !e.shiftKey) {
          e.preventDefault();
          setScale(ZOOM_UNIT);
          return;
        }
        if (k === "2" && !e.shiftKey) {
          e.preventDefault();
          requestFit("fitWidth");
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
      // « Préparer » handles its own keys (PrepareLayer): only Escape leaves the mode here.
      if (mode === "fields" && e.key !== "Escape") return;

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
          goTo(currentStore.get() + 1);
          return;
        case "PageUp":
          e.preventDefault();
          goTo(currentStore.get() - 1);
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
  }, [state.annots, selectedIds, pageCount, searchState.open, mode, hits.length, searchState.index]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  if (!engine) {
    return (
      <div className="pdfx pdfx--empty">
        <header className="pdfx-topbar">
          <button className="pdfx-topbtn" onClick={() => void goHome()}>
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
            const handle = droppedHandle(e.dataTransfer); // synchronous: the transfer empties after the event
            const f = e.dataTransfer.files?.[0];
            if (f) void handle.then((h) => openFile(f, h));
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
              <button className="eb eb--primary" onClick={() => void openDialog()} disabled={loading}>
                {loading ? <Loader2 size={16} className="pdfx-spin" /> : <Upload size={16} />} Choisir un PDF
              </button>
              <button className="eb eb--outline" onClick={() => imageInput.current?.click()} disabled={loading}>
                Créer depuis des images
              </button>
            </div>
            {drafts.length > 0 && (
              <div className="pdfx-recover" role="region" aria-label="Modifications récupérables">
                <b>Modifications non enregistrées récupérables</b>
                <ul>
                  {drafts.slice(0, 5).map((d) => (
                    <li key={d.id}>
                      <span className="pdfx-recover__name" title={d.name}>
                        {d.name}
                      </span>
                      <span className="pdfx-recover__when">{new Date(d.updatedAt).toLocaleString("fr-FR")}</span>
                      {d.handle ? (
                        <button className="eb eb--outline eb--sm" onClick={() => void reopenDraft(d)}>
                          Rouvrir
                        </button>
                      ) : (
                        <small>Rouvrez ce fichier pour les restaurer</small>
                      )}
                      <button
                        className="eb eb--ghost eb--sm"
                        title="Oublier ces modifications"
                        aria-label={`Oublier les modifications de ${d.name}`}
                        onClick={() => {
                          void deletePdfDraft(d.id).catch(() => {});
                          setDrafts((v) => v.filter((x) => x.id !== d.id));
                        }}
                      >
                        <X size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
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
            onConfirm={(pw) =>
              void openBytes(pendingPassword.bytes, pendingPassword.name, pw, undefined, pendingPassword.handle)
            }
            onClose={() => setPendingPassword(null)}
          />
        )}
      </div>
    );
  }

  const themeDef = READING_THEMES.find((t) => t.id === view.theme) ?? READING_THEMES[0];
  /** XFA in the file: hybrid (AcroForm fields too, fillable) or dynamic (XFA only). */
  const xfaKind: "none" | "hybrid" | "dynamic" = !engine.info.isXfa
    ? "none"
    : hasForm && (formSession?.hasFields ?? true)
      ? "hybrid"
      : "dynamic";

  // Elium's layers for one page, rendered by PageStack inside the page slot
  // (same stacking and coordinates as the old PageView children). `scale` is
  // PageStack's — during a Ctrl+wheel gesture it leads `view.scale`.
  const renderOverlay = (page: Page, index: number, { size, rotation, scale }: OverlayGeometry) => {
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
        {mode === "fields" && (
          <PreparePage
            engine={engine}
            // A duplicated page shows its original's fields only on the first copy
            // (the same widgets: editing them twice would move both).
            from={page.from != null && pages.findIndex((q) => q.from === page.from) === index ? page.from : null}
            pageId={page.id}
            size={size}
            rotation={rotation}
            scale={scale}
            tool={tool}
            created={state.createdFields}
            edits={state.fieldEdits}
            selected={prepSelected}
            onSelect={(keys) => setPrepSelected(keys)}
            onCreate={(kind, rect) => createFieldAt(page.id, kind, rect)}
            onChangeRects={movePrepFields}
            onBeginChange={checkpoint}
            onOpen={(key, fieldName) => void openFieldProps(key, fieldName)}
            onDelete={deletePrepFields}
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
        <button className="pdfx-topbtn" onClick={() => void goHome()} title="Retour à l'accueil">
          <Home size={16} />
        </button>
        <span className="pdfx-topbar__brand">
          <FileText size={15} /> PDF
        </span>
        <span className="pdfx-topbar__file" title={fileName}>
          {fileName}
        </span>
        {dirty ? (
          <span className="pdfx-savestate pdfx-savestate--dirty" title="Modifications non enregistrées (Ctrl+S)">
            ● Modifié
          </span>
        ) : pdfDirty ? (
          <span
            className="pdfx-savestate"
            title="La session est enregistrée dans un .elium ; le fichier PDF lui-même n'a pas ces modifications (Ctrl+S)"
          >
            Enregistré en .elium
          </span>
        ) : everSaved ? (
          <span className="pdfx-savestate" title="Toutes les modifications sont enregistrées">
            Enregistré
          </span>
        ) : null}
        {engine.info.encrypted && <span className="pdfx-badge pdfx-badge--lock">protégé</span>}
        {(docSigned ?? engine.info.signed) && <span className="pdfx-badge pdfx-badge--seal">signé</span>}
        {engine.info.isXfa && (
          <span className="pdfx-badge pdfx-badge--warn">
            {xfaKind === "hybrid" ? "XFA hybride" : "XFA dynamique — lecture seule"}
          </span>
        )}

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

        <PageNav store={currentStore} pageCount={pageCount} goTo={goTo} />

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
              if (v === "fitWidth" || v === "fitPage" || v === "fitVisible") requestFit(v);
              else setScale(presetScale(Number(v)));
            }}
          >
            <option value="custom">{zoomPercent(view.scale)} %</option>
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
        preparing={mode === "fields"}
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
              currentPage={currentStore}
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
          <div className="pdfx-viewcol">
            {hasForm && !formBarHidden && mode !== "fields" && (
              <div className="pdfx-formbar" role="status">
                <PenSquare size={15} aria-hidden />
                <span className="pdfx-formbar__text">
                  {xfaKind === "hybrid"
                    ? "Formulaire XFA hybride : il se remplit par ses champs AcroForm ; à l'enregistrement, la partie XFA est retirée pour qu'Acrobat affiche vos valeurs."
                    : xfaKind === "dynamic"
                      ? "Formulaire XFA dynamique : il ne peut pas être rempli ici (Adobe Acrobat ou Reader requis)."
                      : "Ce document contient des champs de formulaire remplissables."}
                </span>
                {requiredLeft.length > 0 && (
                  <button
                    className="pdfx-formbar__btn pdfx-formbar__btn--req"
                    onClick={goNextRequired}
                    title="Aller au prochain champ obligatoire vide"
                  >
                    {requiredLeft.length} champ(s) obligatoire(s) à remplir — Suivant
                  </button>
                )}
                <label className="pdfx-formbar__toggle">
                  <input
                    type="checkbox"
                    checked={fieldHighlight}
                    onChange={(e) => setFieldHighlight(e.target.checked)}
                  />
                  Surligner les champs
                </label>
                <button className="pdfx-formbar__btn" onClick={() => void command("formReset")}>
                  Effacer le formulaire
                </button>
                <button
                  className="pdfx-formbar__close"
                  onClick={() => setFormBarHidden(true)}
                  title="Masquer ce bandeau"
                  aria-label="Masquer ce bandeau"
                >
                  ×
                </button>
              </div>
            )}
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
              currentPage={currentStore}
              showTextLayer={mode === "view" && tool !== "hand"}
              fieldHighlight={fieldHighlight}
              maskImported={state.importedAnnots}
              optionalContent={ocConfig}
              hitsOf={hitsOf}
              className={`pdfx-canvas--${view.mode} ${tool === "hand" ? "is-hand" : ""} ${mode === "fields" ? "is-preparing" : ""} ${mode === "view" && tool === "select" ? "is-annot-select" : ""}`}
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
          </div>
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
        <span>{zoomPercent(view.scale)} %</span>
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
      <input ref={dataInput} type="file" accept=".xfdf,.fdf,.xml,.txt" hidden onChange={onDataPick} />
      <input ref={compareInput} type="file" accept="application/pdf,.pdf" hidden onChange={onComparePick} />
      <input ref={p12Input} type="file" accept=".p12,.pfx" hidden onChange={onP12Pick} />

      {/* dialogs */}
      {dialog === "save" && (
        <SaveDialog
          fileName={fileName}
          options={{
            interactiveAnnots: true,
            flattenForms: false,
            applyRedactions: true,
            sanitise: false,
            optimise: false,
            ...saveAsPreset,
          }}
          hasRedactions={state.annots.some((a) => a.kind === "redact")}
          hasForm={hasForm || state.createdFields.length > 0}
          signed={!!engine?.info.signed}
          inPlace={canWriteFiles()}
          onConfirm={(name, o) => {
            setDialog(null);
            void saveAs(name, o);
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
            securityRef.current = { protect: v };
            setSecurityDirty(true);
            await saveNow(true);
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
          xfa={xfaKind}
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
      {prepProps && (
        <FieldPropertiesDialog
          kind={prepProps.kind}
          name={prepProps.name}
          initial={prepProps.initial}
          otherFields={allFieldNames(state)}
          takenNames={
            new Set([...allFieldNames(state), ...state.fieldEdits.filter((e) => e.rename).map((e) => e.name)])
          }
          onConfirm={applyFieldProps}
          onClose={() => setPrepProps(null)}
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

              const { FontBook } = await import("../ops/fonts");
              if (!engine) return;
              // The text layer goes into the document itself — an update of
              // the source, encrypted with its key, its signed revision left
              // intact — and the session goes on with it, edits kept.
              const res = await savePdf({
                source: bytesRef.current,
                state: { ...emptyState(), pages: D.pagesFromSource(engine.pageCount) },
                options: { password: passwordRef.current ?? "", author, fileName },
                security: null,
                transform: async (doc) => {
                  const book = new FontBook(doc);
                  const docPages = doc.getPages();
                  for (const r of results) {
                    const target = docPages[r.page];
                    if (target && r.words.length) await writeOcrLayer(doc, target, r.words, book);
                  }
                },
              });
              await adoptDerived(
                res.bytes,
                {
                  changes: ["texte reconnu (OCR) ajouté"],
                  forceFull: res.report.mode === "full" ? res.report.fullReasons : [],
                },
                res.report.mode === "incremental",
                state,
              );
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
              const { bytes } = await buildDerived();
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
          onConfirm={(pw) =>
            void openBytes(pendingPassword.bytes, pendingPassword.name, pw, undefined, pendingPassword.handle)
          }
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

/**
 * Previous / page number / next. Subscribes to the current page itself, so
 * scrolling re-renders this box — not the workspace around it.
 */
function PageNav({ store, pageCount, goTo }: { store: CurrentPage; pageCount: number; goTo: (page: number) => void }) {
  const current = useCurrentPage(store);
  return (
    <div className="pdfx-pagenav">
      <button
        className="pdfx-topbtn"
        onClick={() => goTo(current - 1)}
        disabled={current <= 1}
        title="Page précédente"
        aria-label="Page précédente"
      >
        <ChevronLeft size={16} />
      </button>
      <input
        className="pdfx-pagenav__input"
        value={current}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/\D/g, ""));
          if (n) goTo(n);
        }}
        aria-label="Numéro de page"
      />
      <span className="pdfx-pagenav__total">/ {pageCount}</span>
      <button
        className="pdfx-topbtn"
        onClick={() => goTo(current + 1)}
        disabled={current >= pageCount}
        title="Page suivante"
        aria-label="Page suivante"
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
}
