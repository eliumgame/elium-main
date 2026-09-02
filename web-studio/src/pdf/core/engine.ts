/**
 * `PdfEngine` — the single owner of the pdf.js document.
 *
 * Everything that needs the *source* PDF (page geometry, text, embedded
 * annotations, the outline, attachments, layers, metadata) goes through here, so
 * the UI never juggles proxies or forgets to destroy a loading task. The engine
 * is deliberately dumb about editing: it describes the file as it is on disk;
 * the editable overlay lives in `model/`.
 */

import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Rotation } from "./coords";
import { normRotation } from "./coords";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

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
  url?: string;
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
  /** True when the file was opened with a password. */
  encrypted: boolean;
  /** True when the file carries at least one AcroForm field. */
  hasAcroForm: boolean;
  /** True when the file carries an XFA form (we can view but not edit those). */
  isXfa: boolean;
  /** True when the file already carries a digital signature. */
  signed: boolean;
  pageCount: number;
  byteLength: number;
}

export interface LayerInfo {
  id: string;
  name: string;
  visible: boolean;
}

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

/** Minimal shape of the pdf.js loading task we keep in order to tear it down. */
interface LoadingTask {
  promise: Promise<PDFDocumentProxy>;
  destroy: () => Promise<void>;
}

export class PdfEngine {
  private doc: PDFDocumentProxy;
  private task: LoadingTask;
  private pageCache = new Map<number, Promise<PDFPageProxy>>();
  private textCache = new Map<number, Promise<TextContentLike>>();
  private annotCache = new Map<number, Promise<unknown[]>>();
  private destroyed = false;

  readonly pages: PageInfo[];
  readonly info: DocInfo;
  readonly bytes: Uint8Array;
  /** The password the document was opened with, if any (needed to re-save). */
  readonly password: string | null;

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
  }

  get pageCount(): number {
    return this.pages.length;
  }

  get raw(): PDFDocumentProxy {
    return this.doc;
  }

  /**
   * Open a PDF. Throws `PdfPasswordRequired` when a password is needed, so the
   * caller can prompt and retry rather than showing a generic failure.
   */
  static async open(bytes: Uint8Array, password?: string): Promise<PdfEngine> {
    // pdf.js takes ownership of (and detaches) the buffer it is handed, so give
    // it a private copy and keep ours intact for pdf-lib.
    const mine = bytes.slice();
    const task = pdfjs.getDocument({
      data: bytes.slice(),
      password: password || undefined,
      // Local-first: never reach out for standard fonts or CMaps.
      useSystemFonts: true,
      disableAutoFetch: false,
    }) as unknown as LoadingTask;
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

    const pages: PageInfo[] = [];
    for (let i = 0; i < doc.numPages; i++) {
      const page = await doc.getPage(i + 1);
      const vp = page.getViewport({ scale: 1, rotation: 0 });
      const view = page.view as number[];
      pages.push({
        index: i,
        w: vp.width,
        h: vp.height,
        ox: view?.[0] ?? 0,
        oy: view?.[1] ?? 0,
        rotate: normRotation(page.rotate ?? 0),
      });
      page.cleanup();
    }

    const meta = await doc.getMetadata().catch(() => null);
    const raw = (meta?.info ?? {}) as Record<string, unknown>;
    const str = (k: string): string | undefined => {
      const v = raw[k];
      return typeof v === "string" && v.trim() ? v : undefined;
    };

    let hasAcroForm = false;
    let signed = false;
    try {
      const fields = await doc.getFieldObjects();
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
      for (let i = 1; i <= Math.min(doc.numPages, 8) && !hasSigWidget; i++) {
        const page = await doc.getPage(i);
        const anns = (await page.getAnnotations()) as { fieldType?: string }[];
        hasSigWidget = anns.some((a) => a.fieldType === "Sig");
        page.cleanup();
      }
      signed = hasSigWidget && hasSignatureDictionary(mine);
    } catch {
      /* best effort */
    }

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
      encrypted: !!password,
      hasAcroForm,
      isXfa: !!(raw.IsXFAPresent as boolean),
      signed,
      pageCount: doc.numPages,
      byteLength: mine.length,
    };

    return new PdfEngine(doc, task, pages, info, mine, password ?? null);
  }

  // -- pages ---------------------------------------------------------------

  /** Cached page proxy (0-based). */
  page(index: number): Promise<PDFPageProxy> {
    let p = this.pageCache.get(index);
    if (!p) {
      p = this.doc.getPage(index + 1);
      this.pageCache.set(index, p);
    }
    return p;
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
    const out: string[] = [];
    for (let i = 0; i < this.pageCount; i++) {
      const tc = await this.text(i);
      out.push(joinItems(tc.items));
      onProgress?.(i + 1, this.pageCount);
    }
    return out;
  }

  // -- outline -------------------------------------------------------------

  /** The PDF's own bookmark tree, with destinations resolved to page numbers. */
  async outline(): Promise<OutlineNode[]> {
    const raw = await this.doc.getOutline().catch(() => null);
    if (!raw) return [];
    const walk = async (items: RawOutlineItem[]): Promise<OutlineNode[]> => {
      const out: OutlineNode[] = [];
      for (const it of items) {
        const resolved = await this.resolveDest(it.dest);
        out.push({
          title: (it.title ?? "").trim() || "(sans titre)",
          bold: !!it.bold,
          italic: !!it.italic,
          color: colorArrayToHex(it.color),
          page: resolved.page,
          y: resolved.y,
          url: it.url ?? undefined,
          children: it.items?.length ? await walk(it.items) : [],
        });
      }
      return out;
    };
    return walk(raw as RawOutlineItem[]);
  }

  /** Resolve a pdf.js destination (named or explicit) to a 1-based page + offset. */
  async resolveDest(dest: unknown): Promise<{ page: number | null; y?: number }> {
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
      if (index == null) return { page: null };
      const info = this.pages[index];
      // [ref, /XYZ, left, top, zoom] — `top` is in PDF space, flip it.
      const mode = explicit[1] as { name?: string } | undefined;
      let y: number | undefined;
      if (mode?.name === "XYZ" && typeof explicit[3] === "number" && info) y = info.h - explicit[3];
      else if (mode?.name === "FitH" && typeof explicit[2] === "number" && info) y = info.h - explicit[2];
      return { page: index + 1, y };
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
    this.pageCache.clear();
    this.textCache.clear();
    this.annotCache.clear();
    // Destroying the loading task tears down the worker *and* the document.
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
  items?: RawOutlineItem[];
}

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
