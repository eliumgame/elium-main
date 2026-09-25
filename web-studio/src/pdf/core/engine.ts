/**
 * `PdfEngine` — the single owner of the pdf.js document.
 *
 * Everything that needs the *source* PDF (page geometry, text, embedded
 * annotations, the outline, attachments, layers, metadata) goes through here, so
 * the UI never juggles proxies or forgets to destroy a loading task. The engine
 * is deliberately dumb about editing: it describes the file as it is on disk;
 * the editable overlay lives in `model/`.
 *
 * OPENING IS INSTANT: `open` only waits for the document itself, page 1 and the
 * metadata dictionary. Every other page's geometry starts as an *estimate*
 * (page 1's size) and is replaced by the real one either on demand — the first
 * time anything asks for that page (`page()`, `text()`, `annotations()`,
 * `pageInfo()`), which is what the viewer does for every page it shows — or by
 * a low-priority background pass. Listeners registered with `subscribe` are told
 * which pages changed, so the layout can correct itself while keeping the page
 * being read anchored. The form / signature facts (`info.hasAcroForm`,
 * `info.signed`) are likewise computed in the background; `infoReady` resolves
 * once they are final.
 */

import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import { openPdfDocument, type LoadingTask } from "./assets";
import type { Rotation } from "./coords";
import { normRotation } from "./coords";
import type { DestFit } from "../model/types";

/** Geometry of one source page, in unrotated page space. */
export interface PageInfo {
  index: number;
  /** Crop-box width/height in points (the page-space extent). */
  w: number;
  h: number;
  /** Crop-box origin in PDF user space — non-zero on cropped/imposed files. */
  ox: number;
  oy: number;
  /** The page's own /Rotate. */
  rotate: Rotation;
  /**
   * True while this is only a guess (copied from page 1) because the page has
   * not been loaded yet. `pageInfo(index)` always resolves to the real values.
   */
  estimated?: boolean;
}

export interface Attachment {
  name: string;
  description?: string;
  bytes: Uint8Array;
}

export interface OutlineNode {
  title: string;
  bold: boolean;
  italic: boolean;
  color?: string;
  /** Resolved 1-based page number, or null when the destination is unresolvable. */
  page: number | null;
  /** Vertical offset from the top of the page in points, when the dest carries one. */
  y?: number;
  /** Horizontal offset from the left of the page, when the dest carries one. */
  x?: number;
  fit?: DestFit;
  zoom?: number;
  url?: string;
  /** A named action (NextPage…). */
  action?: string;
  /** Neither a page nor a URL nor a named action: another file, a script… */
  other?: string;
  /** Collapsed in the file (/Count negative). */
  closed?: boolean;
  /** Position in the file's outline ("0.2.1"). */
  path: string;
  children: OutlineNode[];
}

export interface DocInfo {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modDate?: string;
  pdfVersion?: string;
  language?: string;
  /**
   * True when the file is protected by the standard security handler —
   * including "owner-only" files that open without a password but restrict
   * printing/copying/editing.
   */
  encrypted: boolean;
  /** True when the file carries at least one AcroForm field (final once `infoReady` resolves). */
  hasAcroForm: boolean;
  /** True when the file carries an XFA form (we can view but not edit those). */
  isXfa: boolean;
  /** True when the file already carries a digital signature (final once `infoReady` resolves). */
  signed: boolean;
  pageCount: number;
  byteLength: number;
}

export interface LayerInfo {
  id: string;
  name: string;
  visible: boolean;
}

/** What `subscribe` listeners are told. */
export type EngineEvent =
  /** Real geometry replaced the estimate for these (0-based) pages. */
  | { type: "geometry"; indices: number[] }
  /** `info.hasAcroForm` / `info.signed` are now final. */
  | { type: "info"; info: DocInfo };

/** Thrown when the file needs a password we do not have (or the wrong one). */
export class PdfPasswordRequired extends Error {
  constructor(public readonly wrong: boolean) {
    super(wrong ? "Mot de passe incorrect." : "Ce PDF est protégé par un mot de passe.");
    this.name = "PdfPasswordRequired";
  }
}

const isPasswordException = (e: unknown): boolean =>
  !!e && typeof e === "object" && (e as { name?: string }).name === "PasswordException";

/** pdf.js `PasswordResponses.INCORRECT_PASSWORD` */
const INCORRECT_PASSWORD = 2;

/** Pages whose geometry the background pass asks for per round trip. */
const GEOMETRY_BATCH = 16;
/** Delay before the background work starts, so it never competes with the first paint. */
const BACKGROUND_DELAY_MS = 120;
/** How many leading pages are scanned for a signature widget. */
const SIGNATURE_SCAN_PAGES = 8;
/** Concurrent `getTextContent` calls while extracting the whole document's text. */
const TEXT_CONCURRENCY = 4;

/**
 * A "Prepare form" pass (`ops/forms.ts::addSignatureField`) can drop a bare,
 * never-signed `/FT /Sig` widget onto a page. pdf.js's own annotation layer
 * cannot tell that apart from a real signature: `SignatureWidgetAnnotation`
 * hard-codes `data.fieldValue` (and `getFieldObject().value`) to `null`
 * regardless of whether the widget's `/V` is actually set, so neither
 * `getAnnotations()` nor `getFieldObjects()` exposes the real value for this
 * field type. A genuine signature (`ops/pades.ts::addSignaturePlaceholder`)
 * always writes a signature dictionary containing `/ByteRange`, which a bare
 * prepared widget never has — used below as the "is there really a `/V`"
 * check. Scanned byte-wise (not via a full string conversion of the file) so
 * opening a large PDF stays cheap.
 */
function hasSignatureDictionary(bytes: Uint8Array): boolean {
  const marker = "/ByteRange";
  const first = marker.charCodeAt(0);
  const limit = bytes.length - marker.length;
  for (let i = 0; i <= limit; i++) {
    if (bytes[i] !== first) continue;
    let matches = true;
    for (let j = 1; j < marker.length; j++) {
      if (bytes[i + j] !== marker.charCodeAt(j)) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
}

function geometryOf(page: PDFPageProxy, index: number): PageInfo {
  const vp = page.getViewport({ scale: 1, rotation: 0 });
  const view = page.view as number[];
  return {
    index,
    w: vp.width,
    h: vp.height,
    ox: view?.[0] ?? 0,
    oy: view?.[1] ?? 0,
    rotate: normRotation(page.rotate ?? 0),
  };
}

const sameGeometry = (a: PageInfo, b: PageInfo): boolean =>
  Math.abs(a.w - b.w) < 1e-6 && Math.abs(a.h - b.h) < 1e-6 && a.ox === b.ox && a.oy === b.oy && a.rotate === b.rotate;

const yieldToMain = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class PdfEngine {
  private doc: PDFDocumentProxy;
  private task: LoadingTask;
  private pageCache = new Map<number, Promise<PDFPageProxy>>();
  private textCache = new Map<number, Promise<TextContentLike>>();
  private readonly fontCache = new Map<number, Promise<Map<string, FontFacts>>>();
  private annotCache = new Map<number, Promise<unknown[]>>();
  /** Page index → number of viewers currently showing it (see `retainPage`). */
  private pageUsers = new Map<number, number>();
  private destroyed = false;
  private listeners = new Set<(e: EngineEvent) => void>();
  private pendingGeometry = new Set<number>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private backgroundTimer: ReturnType<typeof setTimeout> | null = null;
  private resolveInfo!: (info: DocInfo) => void;
  private resolveGeometry!: () => void;
  private _geometryVersion = 0;

  /** One entry per source page; an estimated entry is replaced (never mutated) once the page is known. */
  readonly pages: PageInfo[];
  readonly info: DocInfo;
  readonly bytes: Uint8Array;
  /** The password the document was opened with, if any (needed to re-save). */
  readonly password: string | null;
  /** Resolves once `info.hasAcroForm` and `info.signed` are final. */
  readonly infoReady: Promise<DocInfo>;
  /** Resolves once every page's real geometry is known. */
  readonly geometryReady: Promise<void>;

  private constructor(
    doc: PDFDocumentProxy,
    task: LoadingTask,
    pages: PageInfo[],
    info: DocInfo,
    bytes: Uint8Array,
    password: string | null,
  ) {
    this.doc = doc;
    this.task = task;
    this.pages = pages;
    this.info = info;
    this.bytes = bytes;
    this.password = password;
    this.infoReady = new Promise((resolve) => (this.resolveInfo = resolve));
    this.geometryReady = new Promise((resolve) => (this.resolveGeometry = resolve));
  }

  get pageCount(): number {
    return this.pages.length;
  }

  get raw(): PDFDocumentProxy {
    return this.doc;
  }

  /** Bumped every time some page's geometry changes — handy as a memo key. */
  get geometryVersion(): number {
    return this._geometryVersion;
  }

  /**
   * Open a PDF. Throws `PdfPasswordRequired` when a password is needed, so the
   * caller can prompt and retry rather than showing a generic failure.
   */
  static async open(bytes: Uint8Array, password?: string): Promise<PdfEngine> {
    // pdf.js takes ownership of (and detaches) the buffer it is handed
    // (`openPdfDocument` passes it a copy); keep ours intact for pdf-lib.
    const mine = bytes.slice();
    const task = openPdfDocument(bytes, password);
    let doc: PDFDocumentProxy;
    try {
      doc = await task.promise;
    } catch (e) {
      void task.destroy();
      if (isPasswordException(e)) {
        throw new PdfPasswordRequired((e as { code?: number }).code === INCORRECT_PASSWORD);
      }
      throw e;
    }

    const [first, meta] = await Promise.all([doc.getPage(1), doc.getMetadata().catch(() => null)]);
    const firstInfo = geometryOf(first, 0);
    const pages: PageInfo[] = new Array(doc.numPages);
    pages[0] = firstInfo;
    for (let i = 1; i < doc.numPages; i++) pages[i] = { ...firstInfo, index: i, estimated: true };

    const raw = (meta?.info ?? {}) as Record<string, unknown>;
    const str = (k: string): string | undefined => {
      const v = raw[k];
      return typeof v === "string" && v.trim() ? v : undefined;
    };
    const info: DocInfo = {
      title: str("Title"),
      author: str("Author"),
      subject: str("Subject"),
      keywords: str("Keywords"),
      creator: str("Creator"),
      producer: str("Producer"),
      creationDate: str("CreationDate"),
      modDate: str("ModDate"),
      pdfVersion: str("PDFFormatVersion"),
      language: str("Language"),
      encrypted: !!password || typeof raw.EncryptFilterName === "string",
      hasAcroForm: false,
      isXfa: !!(raw.IsXFAPresent as boolean),
      signed: false,
      pageCount: doc.numPages,
      byteLength: mine.length,
    };

    const engine = new PdfEngine(doc, task, pages, info, mine, password ?? null);
    engine.pageCache.set(0, Promise.resolve(first));
    engine.startBackground();
    return engine;
  }

  // -- change notifications ---------------------------------------------------

  /** Be told about geometry / info updates. Returns the unsubscribe function. */
  subscribe(listener: (e: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(e: EngineEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* a faulty listener must not break the others */
      }
    }
  }

  private recordGeometry(index: number, page: PDFPageProxy): void {
    if (this.destroyed) return;
    const prev = this.pages[index];
    if (prev && !prev.estimated) return;
    const next = geometryOf(page, index);
    this.pages[index] = next;
    if (prev && sameGeometry(prev, next)) return;
    this._geometryVersion++;
    this.pendingGeometry.add(index);
    // Coalesce: a background batch resolves many pages in a row.
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      const indices = [...this.pendingGeometry].sort((a, b) => a - b);
      this.pendingGeometry.clear();
      if (indices.length && !this.destroyed) this.emit({ type: "geometry", indices });
    }, 0);
  }

  // -- background work --------------------------------------------------------

  private startBackground(): void {
    this.backgroundTimer = setTimeout(() => {
      this.backgroundTimer = null;
      void this.computeDetails();
      void this.computeGeometry();
    }, BACKGROUND_DELAY_MS);
  }

  /** Real geometry for every page, a few round trips at a time. */
  private async computeGeometry(): Promise<void> {
    const n = this.pageCount;
    for (let start = 0; start < n && !this.destroyed; start += GEOMETRY_BATCH) {
      const batch: Promise<unknown>[] = [];
      for (let i = start; i < Math.min(n, start + GEOMETRY_BATCH); i++) {
        if (this.pages[i]?.estimated) batch.push(this.page(i).catch(() => null));
      }
      if (batch.length) {
        await Promise.all(batch);
        // Let rendering and user input through between batches.
        await yieldToMain();
      }
    }
    this.resolveGeometry();
  }

  /** `hasAcroForm` / `signed`, which need extra worker round trips. */
  private async computeDetails(): Promise<void> {
    let hasAcroForm = false;
    let signed = false;
    try {
      const fields = await this.doc.getFieldObjects();
      hasAcroForm = !!fields && Object.keys(fields).length > 0;
    } catch {
      /* not a form */
    }
    try {
      // A signature shows up as a widget annotation with fieldType "Sig" —
      // but a field merely PREPARED for signing (never actually signed) looks
      // identical through this API (see hasSignatureDictionary above), so
      // also require a real signature dictionary in the raw bytes before
      // reporting the document as signed.
      let hasSigWidget = false;
      for (let i = 0; i < Math.min(this.pageCount, SIGNATURE_SCAN_PAGES) && !hasSigWidget; i++) {
        if (this.destroyed) return;
        const anns = (await this.annotations(i)) as { fieldType?: string }[];
        hasSigWidget = anns.some((a) => a.fieldType === "Sig");
      }
      signed = hasSigWidget && hasSignatureDictionary(this.bytes);
    } catch {
      /* best effort */
    }
    if (this.destroyed) return;
    this.info.hasAcroForm = hasAcroForm;
    this.info.signed = signed;
    this.resolveInfo(this.info);
    this.emit({ type: "info", info: this.info });
  }

  // -- pages ---------------------------------------------------------------

  /** Cached page proxy (0-based). Loading a page also settles its geometry. */
  page(index: number): Promise<PDFPageProxy> {
    let p = this.pageCache.get(index);
    if (!p) {
      p = this.doc.getPage(index + 1);
      p.then(
        (page) => this.recordGeometry(index, page),
        () => {},
      );
      this.pageCache.set(index, p);
    }
    return p;
  }

  /**
   * A viewer is showing page `index` (0-based): its rendering resources must
   * stay loaded. Returns the release function (safe to call twice).
   */
  retainPage(index: number): () => void {
    this.pageUsers.set(index, (this.pageUsers.get(index) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.pageUsers.get(index) ?? 1) - 1;
      if (n > 0) this.pageUsers.set(index, n);
      else this.pageUsers.delete(index);
    };
  }

  /**
   * Free what pdf.js keeps for a page after drawing it — operator lists,
   * decoded images (≈ 15 MB for one 200 dpi scanned A4) — unless a viewer
   * still retains the page. pdf.js defers the clean-up itself while a render
   * of that page is in flight. The page proxy (and so its geometry and text)
   * stays cached; a later render simply asks the worker again.
   */
  releasePageResources(index: number): void {
    if (this.destroyed || this.pageUsers.get(index)) return;
    void this.pageCache.get(index)?.then(
      (page) => {
        if (!this.destroyed && !this.pageUsers.get(index)) page.cleanup();
      },
      () => {},
    );
  }

  /** The real geometry of a page (loads it if it is still an estimate). */
  async pageInfo(index: number): Promise<PageInfo> {
    const cur = this.pages[index];
    if (cur && !cur.estimated) return cur;
    await this.page(index);
    return this.pages[index];
  }

  /** Cached text content (0-based). */
  text(index: number): Promise<TextContentLike> {
    let t = this.textCache.get(index);
    if (!t) {
      t = this.page(index)
        .then((p) => p.getTextContent({ includeMarkedContent: false }) as unknown as TextContentLike)
        .catch(() => ({ items: [], styles: {} }) as TextContentLike);
      this.textCache.set(index, t);
    }
    return t;
  }

  /**
   * The real fonts of a page's text (0-based), by pdf.js' font id — what
   * `getTextContent` does not tell: its `fontName` is an internal id
   * (« g_d0_f2 »), so bold / italic had to be guessed and never were. The
   * page's operator list is loaded once for it (fonts reach the main thread
   * with it).
   */
  fonts(index: number): Promise<Map<string, FontFacts>> {
    let f = this.fontCache.get(index);
    if (!f) {
      f = (async () => {
        const { pageFontFacts } = await import("./text");
        return pageFontFacts(await this.page(index), await this.text(index));
      })().catch(() => new Map<string, FontFacts>());
      this.fontCache.set(index, f);
    }
    return f;
  }

  /** Cached raw annotations (0-based) — widgets, links, existing markup. */
  annotations(index: number): Promise<unknown[]> {
    let a = this.annotCache.get(index);
    if (!a) {
      a = this.page(index)
        .then((p) => p.getAnnotations({ intent: "any" }) as Promise<unknown[]>)
        .catch(() => []);
      this.annotCache.set(index, a);
    }
    return a;
  }

  /** Plain text of every page, in order. Used by search, export and compare. */
  async allText(onProgress?: (done: number, total: number) => void): Promise<string[]> {
    const out: string[] = new Array(this.pageCount);
    let next = 0;
    let done = 0;
    const work = async () => {
      while (next < this.pageCount) {
        const i = next++;
        const tc = await this.text(i);
        out[i] = joinItems(tc.items);
        onProgress?.(++done, this.pageCount);
      }
    };
    await Promise.all(Array.from({ length: Math.min(TEXT_CONCURRENCY, this.pageCount) }, work));
    return out;
  }

  // -- outline -------------------------------------------------------------

  /** The PDF's own bookmark tree, with destinations resolved to page numbers. */
  async outline(): Promise<OutlineNode[]> {
    const raw = await this.doc.getOutline().catch(() => null);
    if (!raw) return [];
    const walk = async (items: RawOutlineItem[], prefix: string): Promise<OutlineNode[]> => {
      const out: OutlineNode[] = [];
      for (const [i, it] of items.entries()) {
        const path = prefix ? `${prefix}.${i}` : String(i);
        const resolved = it.dest ? await this.resolveDest(it.dest) : { page: null };
        const url = it.url ?? undefined;
        const action = typeof it.action === "string" ? it.action : undefined;
        const other =
          resolved.page == null && !url && !action
            ? it.unsafeUrl
              ? "Lien vers un autre fichier"
              : it.attachment
                ? "Pièce jointe"
                : it.setOCGState
                  ? "Calques"
                  : "Action non prise en charge"
            : undefined;
        out.push({
          title: (it.title ?? "").trim() || "(sans titre)",
          bold: !!it.bold,
          italic: !!it.italic,
          color: colorArrayToHex(it.color),
          page: resolved.page,
          y: resolved.y,
          x: resolved.x,
          fit: resolved.fit,
          zoom: resolved.zoom,
          url,
          action,
          other,
          closed: typeof it.count === "number" && it.count < 0 ? true : undefined,
          path,
          children: it.items?.length ? await walk(it.items, path) : [],
        });
      }
      return out;
    };
    return walk(raw as RawOutlineItem[], "");
  }

  /** Resolve a pdf.js destination (named or explicit) to a 1-based page + offset. */
  async resolveDest(
    dest: unknown,
  ): Promise<{ page: number | null; y?: number; x?: number; fit?: DestFit; zoom?: number }> {
    try {
      const explicit = typeof dest === "string" ? await this.doc.getDestination(dest) : dest;
      if (!Array.isArray(explicit) || !explicit.length) return { page: null };
      const ref = explicit[0];
      const index =
        typeof ref === "object" && ref !== null && "num" in ref
          ? await this.doc.getPageIndex(ref as { num: number; gen: number })
          : typeof ref === "number"
            ? ref
            : null;
      if (index == null || index < 0 || index >= this.pageCount) return { page: null };
      const info = await this.pageInfo(index);
      // [ref, /XYZ, left, top, zoom] — `top` is in PDF space, flip it (against
      // the crop box, whose origin may not be 0).
      const mode = explicit[1] as { name?: string } | undefined;
      const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
      const fit = (DEST_FITS as readonly string[]).includes(mode?.name ?? "") ? (mode!.name as DestFit) : undefined;
      let y: number | undefined;
      let x: number | undefined;
      let zoom: number | undefined;
      const top = (v: unknown) => (num(v) != null ? info.h - (num(v)! - info.oy) : undefined);
      const left = (v: unknown) => (num(v) != null ? num(v)! - info.ox : undefined);
      if (fit === "XYZ") {
        x = left(explicit[2]);
        y = top(explicit[3]);
        zoom = num(explicit[4]) || undefined;
      } else if (fit === "FitH" || fit === "FitBH") y = top(explicit[2]);
      else if (fit === "FitV" || fit === "FitBV") x = left(explicit[2]);
      else if (fit === "FitR") {
        x = left(explicit[2]);
        y = top(explicit[5]);
      }
      if (y != null) y = Math.max(0, Math.min(info.h, y));
      if (x != null) x = Math.max(0, Math.min(info.w, x));
      return { page: index + 1, y, x, fit, zoom };
    } catch {
      return { page: null };
    }
  }

  // -- attachments / layers -------------------------------------------------

  async attachments(): Promise<Attachment[]> {
    try {
      const raw = (await this.doc.getAttachments()) as Record<string, RawAttachment> | null;
      if (!raw) return [];
      return Object.values(raw).map((a) => ({
        name: a.filename || "pièce-jointe",
        description: a.description,
        bytes: a.content instanceof Uint8Array ? a.content : new Uint8Array(a.content ?? []),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Optional-content groups (Acrobat's "Layers" panel), flattened from the
   * catalogue's display order — nested groups are listed with their parent's
   * name prefixed rather than as a tree, which matches how the panel reads.
   */
  async layers(): Promise<LayerInfo[]> {
    try {
      const cfg = await this.doc.getOptionalContentConfig();
      if (!cfg) return [];
      const out: LayerInfo[] = [];
      const seen = new Set<string>();
      const walk = (order: unknown[], prefix: string) => {
        for (const entry of order ?? []) {
          if (typeof entry === "string") {
            if (seen.has(entry)) continue;
            seen.add(entry);
            const g = cfg.getGroup(entry) as { name?: string } | null;
            out.push({
              id: entry,
              name: prefix + (g?.name || entry),
              visible: cfg.isVisible(entry) !== false,
            });
          } else if (Array.isArray(entry)) {
            walk(entry, prefix);
          } else if (entry && typeof entry === "object") {
            const grouped = entry as { name?: string; order?: unknown[] };
            walk(grouped.order ?? [], grouped.name ? `${grouped.name} › ` : prefix);
          }
        }
      };
      walk((cfg.getOrder() as unknown[]) ?? [], "");
      return out;
    } catch {
      return [];
    }
  }

  /** Build an optional-content config with `hidden` layers switched off. */
  async optionalContentConfig(hidden: ReadonlySet<string>) {
    const cfg = await this.doc.getOptionalContentConfig();
    if (!cfg) return null;
    for (const id of hidden) {
      try {
        cfg.setVisibility(id, false);
      } catch {
        /* unknown group */
      }
    }
    return cfg;
  }

  // -- lifecycle -----------------------------------------------------------

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.listeners.clear();
    this.pageUsers.clear();
    this.pageCache.clear();
    this.textCache.clear();
    this.annotCache.clear();
    // Never leave an awaiting caller hanging on a destroyed document.
    this.resolveInfo(this.info);
    this.resolveGeometry();
    // Destroying the loading task tears down the document (and the worker,
    // unless it is the app-wide shared one).
    void this.task.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Shapes of the untyped values pdf.js hands back
// ---------------------------------------------------------------------------

export interface TextItemLike {
  str: string;
  dir?: string;
  width?: number;
  height?: number;
  transform?: number[];
  fontName?: string;
  hasEOL?: boolean;
}

/** A text font as the page uses it (see `PdfEngine.fonts`). */
export interface FontFacts {
  /** Its BaseFont (« ABCDEF+Arial-BoldMT »). */
  name: string;
  bold: boolean;
  italic: boolean;
}

export interface TextContentLike {
  items: TextItemLike[];
  styles: Record<string, { fontFamily?: string; ascent?: number; descent?: number; vertical?: boolean }>;
}

interface RawOutlineItem {
  title?: string;
  bold?: boolean;
  italic?: boolean;
  color?: Uint8ClampedArray | number[];
  dest?: unknown;
  url?: string | null;
  unsafeUrl?: string;
  action?: string | null;
  attachment?: unknown;
  setOCGState?: unknown;
  count?: number;
  items?: RawOutlineItem[];
}

const DEST_FITS = ["XYZ", "Fit", "FitH", "FitV", "FitB", "FitBH", "FitBV", "FitR"] as const;

interface RawAttachment {
  filename?: string;
  description?: string;
  content?: Uint8Array | number[];
}

function colorArrayToHex(c: Uint8ClampedArray | number[] | undefined): string | undefined {
  if (!c || c.length < 3) return undefined;
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

/**
 * Flatten text items into one string the way the rendered text layer reads, so
 * search offsets computed off-screen line up with the DOM spans on-screen.
 * Exported for the tests and for the search index.
 */
export function joinItems(items: readonly TextItemLike[]): string {
  let out = "";
  for (const it of items) {
    if (typeof it.str !== "string" || !it.str) {
      if (it.hasEOL) out += "\n";
      continue;
    }
    out += it.str;
    if (it.hasEOL) out += "\n";
  }
  return out;
}
