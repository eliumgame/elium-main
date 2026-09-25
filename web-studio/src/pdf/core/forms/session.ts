/**
 * `FormSession` — the live link between a document's AcroForm as pdf.js fills
 * it and Elium's model.
 *
 * FILLING IS pdf.js' (Firefox's form engine): its annotation layer renders the
 * fields as real controls in every page view, writes what the user types into
 * the document's `annotationStorage`, runs the form's JavaScript through the
 * scripting sandbox (`scripting.ts`), and `saveDocument()` writes the values and
 * their appearance streams as an incremental update.
 *
 * THE MODEL STILL OWNS THE VALUES (`state.formValues`): they are what `.elium`
 * sessions, recovery drafts and undo/redo persist. So the two are kept in step:
 *  - storage → model: every `annotationStorage.setValue` of a field widget is
 *    observed (an own `setValue` shadows the prototype's, like the imported-
 *    markup mask shadows `modifiedIds`) and reported, batched, as field-name →
 *    value changes (`onChange`);
 *  - model → storage: `sync(formValues)` pushes whatever differs (undo, reset,
 *    data import, a restored session) into the storage, has the viewer rebuild
 *    the affected pages' form layers, and restarts the sandbox on the new
 *    values so calculations and formats see them.
 *
 * One session per engine (`FormSession.for`), like the markup mask.
 */

import type { PdfEngine } from "../engine";
import type { FormValue } from "../../model/types";
import { FormScripting, scriptingSupported, type ScriptCommand } from "./scripting";
import {
  buildFields,
  coerceValue,
  defaultsOf,
  normalizeValue,
  sameFormValue,
  storageEntries,
  valueFromStorage,
  type FormField,
  type RawFieldObject,
} from "./values";

interface StorageLike {
  setValue(key: string, value: Record<string, unknown>): void;
  getRawValue(key: string): Record<string, unknown> | undefined;
  remove(key: string): void;
  has(key: string): boolean;
  readonly size: number;
}

interface EventBusLike {
  on(name: string, fn: (evt: never) => void, opts?: { signal?: AbortSignal }): void;
}

/** What a page viewer gives the session. */
export interface FormViewer {
  eventBus: EventBusLike;
  /** Rebuild the form layer of these source pages (0-based) from the storage. */
  refresh(pages: ReadonlySet<number>): void;
  /** 1-based source page on screen. */
  currentPage(): number;
}

export interface FormChangeMeta {
  /** The batch holds a change the user made in the focused field (not only script results). */
  user: boolean;
  /** Start a new undo step for it (first change of this field visit, or a click on a box / list). */
  newStep: boolean;
}

/** Extra facts about a field read from its widget annotations (`details()`). */
export interface FieldDetails {
  required: boolean;
  tooltip: string;
  readOnly: boolean;
  hidden: boolean;
}

const sessions = new WeakMap<PdfEngine, FormSession>();

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class FormSession {
  /** The document's session, created on first use. */
  static for(engine: PdfEngine): FormSession {
    let s = sessions.get(engine);
    if (!s) {
      s = new FormSession(engine);
      sessions.set(engine, s);
    }
    return s;
  }

  static peek(engine: PdfEngine): FormSession | null {
    return sessions.get(engine) ?? null;
  }

  readonly fieldObjects: Promise<Record<string, RawFieldObject[]> | null>;
  readonly hasJSActions: Promise<boolean>;
  /** Resolves with `enableScripting` for the form layers, before any is built. */
  readonly layerReady: Promise<boolean>;
  /** Resolves once the fields are known. */
  readonly ready: Promise<void>;

  fields = new Map<string, FormField>();
  scriptingEnabled = false;
  /** File name handed to the scripts (`this.documentFileName`). */
  fileName = "document.pdf";

  private byWidget = new Map<string, FormField>();
  private known = new Map<string, FormValue>();
  private storage: StorageLike | null = null;
  private suppress = 0;
  private pendingIds = new Set<string>();
  private flushQueued = false;
  private loaded = false;
  private destroyed = false;
  private listeners = new Set<(changes: Record<string, FormValue>, meta: FormChangeMeta) => void>();
  private viewer: FormViewer | null = null;
  private scripting: FormScripting | null = null;
  private commandHandler: ((c: ScriptCommand) => void) | null = null;
  private errorHandler: ((message: string) => void) | null = null;
  private lastModel: Record<string, FormValue> | null = null;
  private detailCache: Promise<Map<string, FieldDetails>> | null = null;
  private focusToken = 0;
  private stepToken = -1;
  /** > 0 while the scripts' answer is being applied (their changes are not the user's). */
  private scriptDepth = 0;
  /** The pending batch holds a change the user made (not only script results). */
  private batchUser = false;
  private readonly abort = new AbortController();

  private constructor(private readonly engine: PdfEngine) {
    const raw = engine.raw;
    this.fieldObjects = (
      raw.getFieldObjects() as Promise<Record<string, RawFieldObject[]> | null>
    ).catch(() => null);
    this.hasJSActions = raw.hasJSActions().catch(() => false);
    this.layerReady = this.hasJSActions.then((js) => {
      this.scriptingEnabled = js && scriptingSupported();
      return this.scriptingEnabled;
    });
    this.install();
    this.ready = this.load();
    if (typeof document !== "undefined") {
      document.addEventListener(
        "focusin",
        (e) => {
          const t = e.target as HTMLElement | null;
          if (t?.closest?.(".annotationLayer")) this.focusToken++;
        },
        { signal: this.abort.signal },
      );
    }
  }

  // -------------------------------------------------------------------------
  // loading
  // -------------------------------------------------------------------------

  private async load(): Promise<void> {
    const objects = await this.fieldObjects;
    if (this.destroyed) return;
    const fields = buildFields(objects);
    // pdf.js' field objects carry only the FIRST value of a multi-select
    // list; its widget annotation has them all.
    const multi = [...fields.values()].filter((f) => f.multiSelect && f.widgets[0]?.page >= 0);
    for (const f of multi) {
      try {
        const anns = (await this.engine.annotations(f.widgets[0].page)) as {
          id?: string;
          fieldValue?: unknown;
          defaultFieldValue?: unknown;
        }[];
        const a = anns.find((x) => x.id === f.widgets[0].id);
        if (a) {
          f.fileValue = normalizeValue(f, a.fieldValue);
          f.defaultValue = normalizeValue(f, a.defaultFieldValue);
        }
      } catch {
        /* keep pdf.js' first value */
      }
    }
    if (this.destroyed) return;
    this.fields = fields;
    this.byWidget.clear();
    for (const f of fields.values()) for (const w of f.widgets) this.byWidget.set(w.id, f);
    for (const f of fields.values()) {
      const stored = this.storage ? valueFromStorage(f, (id) => this.storage!.getRawValue(id)) : undefined;
      this.known.set(f.name, stored ?? f.fileValue);
    }
    this.loaded = true;
    this.pendingIds.clear();
    if (this.lastModel) this.sync(this.lastModel);
  }

  /** Does the document have fillable fields? */
  get hasFields(): boolean {
    for (const f of this.fields.values()) if (f.type !== "button") return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // storage observation
  // -------------------------------------------------------------------------

  private install(): void {
    const storage = (this.engine.raw as unknown as { annotationStorage?: StorageLike }).annotationStorage;
    if (!storage) return;
    this.storage = storage;
    const proto = Object.getPrototypeOf(storage) as StorageLike;
    Object.defineProperty(storage, "setValue", {
      configurable: true,
      writable: true,
      value: (key: string, value: Record<string, unknown>) => {
        proto.setValue.call(storage, key, value);
        if (!this.suppress) this.note(key);
      },
    });
    Object.defineProperty(storage, "remove", {
      configurable: true,
      writable: true,
      value: (key: string) => {
        proto.remove.call(storage, key);
        if (!this.suppress) this.note(key);
      },
    });
  }

  private note(key: string): void {
    if (this.destroyed) return;
    if (!this.loaded) {
      this.pendingIds.add(key);
      return;
    }
    if (!this.byWidget.has(key)) return;
    this.pendingIds.add(key);
    if (this.scriptDepth === 0) this.batchUser = true;
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => this.flushNotes());
  }

  private flushNotes(): void {
    this.flushQueued = false;
    if (this.destroyed || !this.storage) return;
    const names = new Set<string>();
    const user = this.batchUser;
    this.batchUser = false;
    for (const id of this.pendingIds) {
      const f = this.byWidget.get(id);
      if (f) names.add(f.name);
    }
    this.pendingIds.clear();
    const changes: Record<string, FormValue> = {};
    let any = false;
    for (const name of names) {
      const f = this.fields.get(name)!;
      const v = valueFromStorage(f, (id) => this.storage!.getRawValue(id)) ?? f.fileValue;
      if (sameFormValue(v, this.known.get(name))) continue;
      this.known.set(name, v);
      changes[name] = v;
      any = true;
    }
    if (!any) return;
    // Typing: one step per visit of the field (focus); a box, a button or a
    // list choice: one step per change.
    let newStep = false;
    if (user) {
      const textual = Object.keys(changes).every((n) => this.fields.get(n)?.type === "text");
      newStep = !textual || this.stepToken !== this.focusToken;
      this.stepToken = this.focusToken;
    }
    for (const l of [...this.listeners]) {
      try {
        l(changes, { user, newStep });
      } catch {
        /* a faulty listener must not break the others */
      }
    }
  }

  /** Be told about values changed in the form layer / by the form's scripts. */
  onChange(listener: (changes: Record<string, FormValue>, meta: FormChangeMeta) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onCommand(handler: ((c: ScriptCommand) => void) | null): void {
    this.commandHandler = handler;
  }

  onScriptError(handler: ((message: string) => void) | null): void {
    this.errorHandler = handler;
  }

  // -------------------------------------------------------------------------
  // values
  // -------------------------------------------------------------------------

  /** Every field's current value (file value, or what was filled in). */
  values(): Record<string, FormValue> {
    const out: Record<string, FormValue> = {};
    for (const f of this.fields.values()) {
      if (f.type === "button" || f.type === "signature") continue;
      out[f.name] = this.known.get(f.name) ?? f.fileValue;
    }
    return out;
  }

  /** What « Réinitialiser » gives every field (its /DV, else empty / Off). */
  defaults(): Record<string, FormValue> {
    return defaultsOf(this.fields.values());
  }

  /**
   * Bring the storage in line with the model. `model` holds only the fields
   * the session changed; a field missing from it takes the file's value.
   * Returns the names that had to be changed.
   */
  sync(model: Record<string, FormValue>): string[] {
    this.lastModel = model;
    if (!this.loaded || !this.storage || this.destroyed) return [];
    const pages = new Set<number>();
    const changed: FormField[] = [];
    this.suppress++;
    try {
      for (const f of this.fields.values()) {
        if (f.type === "button" || f.type === "signature") continue;
        const has = Object.prototype.hasOwnProperty.call(model, f.name);
        const desired = has ? coerceValue(f, model[f.name]) : f.fileValue;
        const current = this.known.get(f.name) ?? f.fileValue;
        if (sameFormValue(desired, current)) continue;
        if (has) {
          for (const [id, entry] of storageEntries(f, desired)) {
            // A stale formatted value would be shown (and saved) instead of the new one.
            this.storage.setValue(id, f.type === "text" ? { ...entry, formattedValue: null } : entry);
          }
        } else {
          for (const w of f.widgets) this.storage.remove(w.id);
        }
        this.known.set(f.name, desired);
        for (const w of f.widgets) if (w.page >= 0) pages.add(w.page);
        changed.push(f);
      }
    } finally {
      this.suppress--;
    }
    if (!changed.length) return [];
    this.viewer?.refresh(pages);
    void this.rescript(changed);
    return changed.map((f) => f.name);
  }

  /** Restart the scripts on the new values, then let them format / recalculate what changed. */
  private async rescript(changed: FormField[]): Promise<void> {
    const scripting = this.scripting;
    if (!scripting) return;
    const ok = await scripting.rebuild();
    if (!ok || this.scripting !== scripting) return;
    let committed = false;
    for (const f of changed) {
      if (f.type !== "text" || !f.widgets[0]) continue;
      scripting.commit(f.widgets[0].id, this.known.get(f.name) ?? "");
      committed = true;
    }
    if (!committed) {
      const id = scripting.calculationIds[0];
      const f = id ? this.byWidget.get(id) : undefined;
      if (f && id) scripting.commit(id, this.known.get(f.name) ?? "");
    }
  }

  // -------------------------------------------------------------------------
  // viewer / scripts
  // -------------------------------------------------------------------------

  /** A page viewer shows this document. Returns the detach function. */
  attachViewer(viewer: FormViewer): () => void {
    this.viewer = viewer;
    let scripting: FormScripting | null = null;
    void this.layerReady.then((enabled) => {
      if (!enabled || this.viewer !== viewer || this.destroyed) return;
      scripting = new FormScripting({
        pdf: this.engine.raw,
        eventBus: viewer.eventBus,
        objects: () => this.sandboxObjects(),
        fileName: () => this.fileName,
        byteLength: this.engine.bytes.length,
        currentPage: () => viewer.currentPage(),
        onCommand: (c) => this.commandHandler?.(c),
        setStorage: (id, detail) => {
          const f = this.byWidget.get(id);
          if (!f || !this.storage) return;
          const entry: Record<string, unknown> = {};
          if ("value" in detail) {
            entry.value =
              f.type === "checkbox" || f.type === "radiobutton"
                ? detail.value !== "Off" && detail.value !== false && detail.value != null
                : detail.value;
          }
          if ("formattedValue" in detail) entry.formattedValue = detail.formattedValue;
          if (Object.keys(entry).length) this.storage.setValue(id, entry);
        },
        ownsId: (id) => this.byWidget.has(id),
        asScript: (fn) => {
          this.scriptDepth++;
          try {
            fn();
          } finally {
            this.scriptDepth--;
          }
        },
        onError: (m) => this.errorHandler?.(m),
      });
      this.scripting = scripting;
    });
    return () => {
      if (this.viewer === viewer) this.viewer = null;
      if (scripting && this.scripting === scripting) this.scripting = null;
      scripting?.destroy();
    };
  }

  /** Resolves true once the form's scripts run (false: none, or they could not start). */
  async scriptsReady(): Promise<boolean> {
    if (!(await this.layerReady)) return false;
    for (let i = 0; i < 50 && !this.scripting && !this.destroyed; i++) await tick();
    return this.scripting ? this.scripting.ready : false;
  }

  private async sandboxObjects(): Promise<Record<string, unknown[]>> {
    await this.ready;
    const objects = (await this.fieldObjects) ?? {};
    const out: Record<string, unknown[]> = {};
    for (const [name, list] of Object.entries(objects)) {
      const f = this.fields.get(name);
      out[name] = (list ?? []).map((o) => {
        const copy = { ...o } as Record<string, unknown>;
        if (f && o.type && o.type === f.type) {
          const v = this.known.get(name) ?? f.fileValue;
          copy.value = f.multiSelect ? v : Array.isArray(v) ? (v[0] ?? "") : v;
        }
        return copy;
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // saving
  // -------------------------------------------------------------------------

  /**
   * Commit the field being edited (its blur runs the keystroke-commit,
   * validate, calculate and format scripts) and let the scripts settle.
   */
  async flush(): Promise<void> {
    if (typeof document === "undefined") return;
    const active = document.activeElement as HTMLElement | null;
    if (active?.closest?.(".annotationLayer")) active.blur();
    if (this.scripting) this.scripting.willSave();
    // Widget handler → sandbox (setTimeout 0) → updates → storage (microtask).
    for (let i = 0; i < 3; i++) await tick();
  }

  /**
   * The source with pdf.js' incremental update of the filled-in values and
   * their appearances (`saveDocument`), or null when nothing was filled in.
   */
  async saveBase(): Promise<Uint8Array | null> {
    await this.ready;
    await this.flush();
    if (!this.storage || this.storage.size === 0) return null;
    const bytes = await this.engine.raw.saveDocument();
    this.scripting?.didSave();
    return bytes;
  }

  /** Per-field facts only the widget annotations carry (required, tooltip…), read once. */
  details(): Promise<Map<string, FieldDetails>> {
    this.detailCache ??= (async () => {
      await this.ready;
      const out = new Map<string, FieldDetails>();
      const pages = new Set<number>();
      for (const f of this.fields.values()) for (const w of f.widgets) if (w.page >= 0) pages.add(w.page);
      for (const page of [...pages].sort((a, b) => a - b)) {
        const anns = (await this.engine.annotations(page).catch(() => [])) as {
          id?: string;
          fieldName?: string;
          required?: boolean;
          alternativeText?: string;
          readOnly?: boolean;
          hidden?: boolean;
        }[];
        for (const a of anns) {
          const f = a.id ? this.byWidget.get(a.id) : undefined;
          if (!f) continue;
          const prev = out.get(f.name);
          out.set(f.name, {
            required: !!a.required || !!prev?.required,
            tooltip: prev?.tooltip || a.alternativeText || "",
            readOnly: !!a.readOnly || !!prev?.readOnly,
            hidden: (prev ? prev.hidden : true) && !!a.hidden,
          });
        }
      }
      return out;
    })();
    return this.detailCache;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    this.scripting?.destroy();
    this.scripting = null;
    this.viewer = null;
    this.listeners.clear();
    if (sessions.get(this.engine) === this) sessions.delete(this.engine);
    if (this.storage) {
      try {
        delete (this.storage as { setValue?: unknown }).setValue;
        delete (this.storage as { remove?: unknown }).remove;
      } catch {
        /* the document is being torn down anyway */
      }
    }
    this.storage = null;
  }
}
