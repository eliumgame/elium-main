/**
 * Stop pdf.js from painting the markup Elium imported into its own model.
 *
 * Once a file's comments (highlights, notes, ink…) are imported, Elium draws
 * them itself — editable — and the export rewrites them from the model. If
 * pdf.js kept painting the originals from the file, every comment would show
 * twice. Turning pdf.js' annotation painting off wholesale (`AnnotationMode.
 * DISABLE`, what the old viewer did) also wiped out form-field appearances and
 * link areas. Instead we use the mechanism pdf.js' own editor relies on: the
 * document's `AnnotationStorage.modifiedIds` — the ids listed there are skipped
 * by the worker when it builds a page's operator list
 * (`mustBeViewedWhenEditing`), while links and widgets keep rendering.
 *
 * The ids are collected per page, from the same `getAnnotations` data the
 * import reads, BEFORE that page is first drawn (`ensure`), so an imported
 * comment is never painted even for a frame. The set only ever holds ids of
 * importable subtypes (`isImportedSubtype`, shared with the export's strip), so
 * for a document without markup it stays empty and pdf.js' render cache keys
 * are unaffected.
 */

import type { PdfEngine } from "../engine";
import { isImportedSubtype } from "../../ops/import-annots";

interface ModifiedIds {
  ids: Set<string>;
  hash: string;
}

const EMPTY: ModifiedIds = Object.freeze({ ids: new Set<string>(), hash: "" }) as ModifiedIds;

/** One mask per document: it is installed on the document's (single) annotation storage. */
const masks = new WeakMap<PdfEngine, ImportedAnnotationMask>();

export class ImportedAnnotationMask {
  private ids = new Set<string>();
  private perPage = new Map<number, string[]>();
  private pending = new Map<number, Promise<boolean>>();
  private version = 0;
  private storage: object | null = null;
  private current: ModifiedIds = EMPTY;
  private _enabled = false;
  private bypass = 0;

  /** The document's mask, created on first use. */
  static for(engine: PdfEngine): ImportedAnnotationMask {
    let m = masks.get(engine);
    if (!m) {
      m = new ImportedAnnotationMask(engine);
      masks.set(engine, m);
    }
    return m;
  }

  /** The document's mask if one exists (never creates it). */
  static peek(engine: PdfEngine): ImportedAnnotationMask | null {
    return masks.get(engine) ?? null;
  }

  private constructor(private readonly engine: PdfEngine) {
    this.install();
  }

  /**
   * Run `fn` with the mask lifted — for renders that must show the file as it
   * is (page thumbnails). pdf.js reads `modifiedIds` synchronously when a
   * render starts, so wrapping the `page.render(...)` call is enough.
   */
  unmasked<T>(fn: () => T): T {
    this.bypass++;
    try {
      return fn();
    } finally {
      this.bypass--;
    }
  }

  get enabled(): boolean {
    return this._enabled;
  }

  /** Turn masking on/off. Returns the source pages whose rendering changes. */
  setEnabled(on: boolean): number[] {
    if (on === this._enabled) return [];
    this._enabled = on;
    this.refresh();
    return [...this.perPage].filter(([, ids]) => ids.length).map(([from]) => from);
  }

  /** Does masking change how this source page renders? */
  affects(from: number): boolean {
    return this._enabled && !!this.perPage.get(from)?.length;
  }

  /**
   * Make sure the page's importable ids are in the set. Resolves to true when
   * the page has any (i.e. its rendering depends on the mask).
   */
  ensure(from: number): Promise<boolean> {
    const known = this.perPage.get(from);
    if (known) return Promise.resolve(known.length > 0);
    let p = this.pending.get(from);
    if (!p) {
      p = this.engine
        .annotations(from)
        .then((raw) => {
          const ids = (raw as { id?: string; subtype?: string }[])
            .filter((a) => a.id && isImportedSubtype(a.subtype))
            .map((a) => a.id!);
          this.perPage.set(from, ids);
          if (ids.length) {
            for (const id of ids) this.ids.add(id);
            this.version++;
            this.refresh();
          }
          return ids.length > 0;
        })
        .catch(() => {
          this.perPage.set(from, []);
          return false;
        })
        .finally(() => this.pending.delete(from));
      this.pending.set(from, p);
    }
    return p;
  }

  private refresh(): void {
    this.current = this._enabled && this.ids.size ? { ids: this.ids, hash: `elium-imported-${this.version}` } : EMPTY;
  }

  private install(): void {
    const storage = (this.engine.raw as unknown as { annotationStorage?: object }).annotationStorage;
    if (!storage) return;
    this.storage = storage;
    // An own accessor shadows AnnotationStorage.prototype.modifiedIds, which
    // is what PDFPageProxy.render → getRenderingIntent reads (its hash is part
    // of pdf.js' operator-list cache key, so a change re-renders correctly).
    Object.defineProperty(storage, "modifiedIds", {
      configurable: true,
      get: () => (this.bypass ? EMPTY : this.current),
    });
  }

  destroy(): void {
    if (masks.get(this.engine) === this) masks.delete(this.engine);
    if (this.storage) {
      try {
        delete (this.storage as { modifiedIds?: unknown }).modifiedIds;
      } catch {
        /* the document is being torn down anyway */
      }
    }
    this.storage = null;
    this.perPage.clear();
    this.ids.clear();
  }
}
