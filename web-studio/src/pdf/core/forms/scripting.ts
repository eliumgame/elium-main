/**
 * AcroForm JavaScript — the scripting sandbox Firefox uses (pdf.js'
 * `pdf.sandbox.min.mjs`: the Acrobat JS API — AFNumber_Format, AFDate_*,
 * AFSimple_Calculate, AFRange_Validate, event, field, util… — running inside
 * QuickJS compiled to WebAssembly). No `eval` in the page: the document's
 * scripts only ever run inside the wasm interpreter, which the desktop CSP
 * allows through 'wasm-unsafe-eval'; the web (Drive) build has no CSP at all.
 *
 * This is pdf.js' `PDFScriptingManager` re-done for Elium's viewer (its page
 * views are not numbered like pdf.js' `PDFViewer`'s): the form layer's widgets
 * send their events (keystroke, format, validate, calculate, focus, blur…)
 * through the viewer's event bus as `dispatcheventinsandbox`; the sandbox
 * answers with window `updatefromsandbox` events that are routed to the widget
 * elements (`[data-element-id]`) or, for widgets not on screen, straight into
 * the document's annotationStorage.
 */

import type { PDFDocumentProxy } from "pdfjs-dist";
import { pdfjsAssetUrls } from "../assets";
import type { FormValue } from "../../model/types";

interface QuickSandbox {
  create(data: unknown): void;
  dispatchEvent(event: unknown): void;
  nukeSandbox(): void;
}

interface EventBusLike {
  on(name: string, fn: (evt: never) => void, opts?: { signal?: AbortSignal }): void;
}

export type ScriptCommand =
  | { kind: "print" }
  | { kind: "saveAs" }
  | { kind: "page"; page: number }
  | { kind: "nav"; to: "first" | "last" | "next" | "prev" };

export interface ScriptingOptions {
  pdf: PDFDocumentProxy;
  eventBus: EventBusLike;
  /** Field objects as pdf.js reports them, with `value` patched to the current values. */
  objects: () => Promise<Record<string, unknown[]>>;
  fileName: () => string;
  byteLength: number;
  /** 1-based source page on screen. */
  currentPage: () => number;
  onCommand: (cmd: ScriptCommand) => void;
  /** Push a sandbox update into the storage for a widget that is not on screen. */
  setStorage: (id: string, detail: Record<string, unknown>) => void;
  /** True for ids belonging to this document's fields. */
  ownsId: (id: string) => boolean;
  /** Run `fn` (which applies the scripts' answer) marked as script-caused. */
  asScript: (fn: () => void) => void;
  onError?: (message: string) => void;
}

let moduleLoad: Promise<{ QuickJSSandbox: (wasmUrl: string) => Promise<QuickSandbox> }> | null = null;

/** Can form JavaScript run here? (a page with the published pdf.js assets, WebAssembly available) */
export function scriptingSupported(): boolean {
  return typeof window !== "undefined" && typeof WebAssembly !== "undefined" && !!pdfjsAssetUrls();
}

function loadSandboxModule() {
  const urls = pdfjsAssetUrls();
  if (!urls) return Promise.reject(new Error("pdf.js assets unavailable"));
  moduleLoad ??= import(/* @vite-ignore */ urls.sandboxBundleSrc) as Promise<{
    QuickJSSandbox: (wasmUrl: string) => Promise<QuickSandbox>;
  }>;
  moduleLoad.catch(() => {
    moduleLoad = null;
  });
  return moduleLoad;
}

export class FormScripting {
  private sandbox: QuickSandbox | null = null;
  private creating: Promise<boolean> | null = null;
  private queue: unknown[] = [];
  private abort = new AbortController();
  private destroyed = false;
  private generation = 0;
  private docActions: unknown = null;
  private calculationOrder: string[] | null = null;
  /** Resolves once the first sandbox is up (true) or failed to start (false). */
  readonly ready: Promise<boolean>;

  constructor(private readonly o: ScriptingOptions) {
    const signal = this.abort.signal;
    o.eventBus.on(
      "dispatcheventinsandbox",
      ((evt: { detail: unknown }) => this.dispatch(evt.detail)) as (evt: never) => void,
      { signal },
    );
    window.addEventListener("updatefromsandbox", this.onUpdate as EventListener, { signal });
    this.ready = this.start();
  }

  private async start(): Promise<boolean> {
    try {
      const [actions, order] = await Promise.all([
        this.o.pdf.getJSActions().catch(() => null),
        this.o.pdf.getCalculationOrderIds().catch(() => null),
      ]);
      this.docActions = actions;
      this.calculationOrder = (order as string[] | null) ?? null;
    } catch {
      /* no document-level scripts */
    }
    const ok = await this.create();
    if (ok) {
      this.send({ id: "doc", name: "Open" });
      const pageNumber = this.o.currentPage();
      const page = await this.o.pdf.getPage(pageNumber).catch(() => null);
      const pageActions = page ? await page.getJSActions().catch(() => null) : null;
      this.send({ id: "page", name: "PageOpen", pageNumber, actions: pageActions });
    }
    return ok;
  }

  /** Ids of the calculated fields' widgets, in calculation order (/CO). */
  get calculationIds(): readonly string[] {
    return this.calculationOrder ?? [];
  }

  private create(): Promise<boolean> {
    const gen = ++this.generation;
    const run = (async () => {
      try {
        const [mod, objects] = await Promise.all([loadSandboxModule(), this.o.objects()]);
        const urls = pdfjsAssetUrls()!;
        const sandbox = await mod.QuickJSSandbox(new URL(urls.wasmUrl, location.href).href);
        if (this.destroyed || gen !== this.generation) {
          sandbox.nukeSandbox();
          return false;
        }
        const info = await this.o.pdf.getMetadata().catch(() => null);
        const meta = (info?.info ?? {}) as Record<string, unknown>;
        sandbox.create({
          objects,
          calculationOrder: this.calculationOrder,
          appInfo: { platform: navigator.platform, language: navigator.language },
          docInfo: {
            title: meta.Title,
            author: meta.Author,
            subject: meta.Subject,
            keywords: meta.Keywords,
            creator: meta.Creator,
            producer: meta.Producer,
            creationDate: meta.CreationDate,
            modDate: meta.ModDate,
            baseURL: "",
            filesize: this.o.byteLength,
            filename: this.o.fileName(),
            metadata: info?.metadata?.getRaw?.() ?? null,
            authors: null,
            numPages: this.o.pdf.numPages,
            URL: "",
            actions: this.docActions,
          },
        });
        this.sandbox = sandbox;
        const pending = this.queue;
        this.queue = [];
        for (const ev of pending) this.post(ev);
        return true;
      } catch (e) {
        if (!this.destroyed) this.o.onError?.(e instanceof Error ? e.message : String(e));
        return false;
      }
    })();
    this.creating = run;
    void run.finally(() => {
      if (this.creating === run) this.creating = null;
    });
    return run;
  }

  /**
   * Start over with a fresh sandbox holding the current values — after the
   * values changed behind the scripts' back (undo, reset, data import, a
   * restored session), so calculations and formats read the right inputs.
   */
  async rebuild(): Promise<boolean> {
    if (this.destroyed) return false;
    const old = this.sandbox;
    this.sandbox = null;
    try {
      old?.nukeSandbox();
    } catch {
      /* already gone */
    }
    return this.create();
  }

  /** Commit `value` into field widget `id` as if typed (runs validate, calculate, format). */
  commit(id: string, value: FormValue): void {
    const v = Array.isArray(value) ? value.join(",") : typeof value === "boolean" ? (value ? "Yes" : "Off") : value;
    this.send({ id, name: "Keystroke", value: v, willCommit: true, commitKey: 1, selStart: -1, selEnd: -1 });
  }

  /** « Enregistrer » is about to write the file (doc-level WillSave scripts). */
  willSave(): void {
    this.send({ id: "doc", name: "WillSave" });
  }

  didSave(): void {
    this.send({ id: "doc", name: "DidSave" });
  }

  private send(event: unknown): void {
    this.dispatch(event);
  }

  private dispatch(event: unknown): void {
    if (this.destroyed || !event) return;
    if (!this.sandbox) {
      this.queue.push(event);
      return;
    }
    this.post(event);
  }

  private post(event: unknown): void {
    const sandbox = this.sandbox;
    if (!sandbox) return;
    // Like pdf.js: after the widget's own DOM handlers have run.
    setTimeout(() => {
      if (this.sandbox !== sandbox) return;
      try {
        sandbox.dispatchEvent(event);
      } catch (e) {
        this.o.onError?.(e instanceof Error ? e.message : String(e));
      }
    }, 0);
  }

  private onUpdate = (event: CustomEvent) => {
    if (this.destroyed) return;
    const detail = { ...(event.detail ?? {}) } as Record<string, unknown> & {
      id?: string;
      siblings?: string[];
      command?: string;
      value?: unknown;
    };
    const { id, siblings, command, value } = detail;
    if (!id) {
      this.command(command, value);
      return;
    }
    delete detail.id;
    delete detail.siblings;
    this.o.asScript(() => {
      for (const elementId of siblings ? [id, ...siblings] : [id]) {
        if (!this.o.ownsId(elementId)) continue;
        const element = document.querySelector(`.pdfx-stack [data-element-id="${CSS.escape(elementId)}"]`);
        if (element) element.dispatchEvent(new CustomEvent("updatefromsandbox", { detail }));
        else this.o.setStorage(elementId, detail);
      }
    });
  };

  private command(command: unknown, value: unknown): void {
    switch (command) {
      case "print":
        this.o.onCommand({ kind: "print" });
        break;
      case "SaveAs":
        this.o.onCommand({ kind: "saveAs" });
        break;
      case "page-num":
        if (typeof value === "number") this.o.onCommand({ kind: "page", page: value + 1 });
        break;
      case "FirstPage":
        this.o.onCommand({ kind: "nav", to: "first" });
        break;
      case "LastPage":
        this.o.onCommand({ kind: "nav", to: "last" });
        break;
      case "NextPage":
        this.o.onCommand({ kind: "nav", to: "next" });
        break;
      case "PrevPage":
        this.o.onCommand({ kind: "nav", to: "prev" });
        break;
      case "error":
        console.error("[pdf] JavaScript du formulaire :", value);
        break;
      case "println":
        console.info("[pdf] JavaScript du formulaire :", value);
        break;
      default:
        break;
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    this.queue = [];
    try {
      this.sandbox?.nukeSandbox();
    } catch {
      /* already gone */
    }
    this.sandbox = null;
  }
}
