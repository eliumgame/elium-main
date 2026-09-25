/**
 * Where a save goes.
 *
 * A real « Enregistrer » writes back into the file that is open — in the
 * desktop app (Edge `--app`) and in Chromium browsers that is the File System
 * Access API: a file handle obtained when the file was opened (picker or
 * drag-and-drop) or chosen once with « Enregistrer sous… ». Where the API is
 * missing (Firefox, Safari, an iframe…) saving falls back to downloading a
 * copy, and says so. The Drive (chantier T11) plugs in a third kind that
 * uploads a new version.
 *
 * Nothing here depends on the Content-Security-Policy: the desktop app's CSP
 * and the Drive's absence of one behave the same.
 */

import { downloadBlob } from "../../export/exporters";

/** The subset of the File System Access API this module uses. */
export interface FsWritable {
  write(data: Blob | BufferSource): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

export interface FsFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FsWritable>;
  queryPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  isSameEntry?(other: FsFileHandle): Promise<boolean>;
}

interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

interface FsWindow {
  showOpenFilePicker?: (o: {
    types?: PickerType[];
    multiple?: boolean;
    excludeAcceptAllOption?: boolean;
    id?: string;
  }) => Promise<FsFileHandle[]>;
  showSaveFilePicker?: (o: { suggestedName?: string; types?: PickerType[]; id?: string }) => Promise<FsFileHandle>;
  isSecureContext?: boolean;
}

const PDF_TYPE: PickerType = { description: "Document PDF", accept: { "application/pdf": [".pdf"] } };

function fsWindow(): FsWindow | null {
  return typeof window === "undefined" ? null : (window as unknown as FsWindow);
}

/** True when files can be opened and written in place (File System Access API). */
export function canWriteFiles(): boolean {
  const w = fsWindow();
  if (!w || w.isSecureContext === false) return false;
  // The pickers throw in a cross-origin iframe; an embedded viewer downloads instead.
  try {
    if (window.top !== window.self) return false;
  } catch {
    return false;
  }
  return typeof w.showOpenFilePicker === "function" && typeof w.showSaveFilePicker === "function";
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/** Where a save goes. */
export interface SaveDestination {
  readonly kind: "file" | "download" | "drive";
  /** File name as the user sees it. */
  readonly name: string;
  /** For reports: « rapport.pdf » / « téléchargement de rapport.pdf ». */
  readonly label: string;
  /**
   * True when the destination keeps what was written — the next « Enregistrer »
   * appends to it (a file on disk, a Drive document). A download does not: each
   * save is a new, self-contained copy.
   */
  readonly persistent: boolean;
  /**
   * Obtain write access (asks the user if needed). Call it from the user's
   * gesture, BEFORE any long work: browsers refuse a permission prompt once
   * the gesture has expired. Resolves false when the user refuses.
   */
  prepare(): Promise<boolean>;
  write(bytes: Uint8Array): Promise<void>;
}

/** A file on disk, written in place. */
export function fileDestination(handle: FsFileHandle): SaveDestination {
  return {
    kind: "file",
    name: handle.name,
    label: handle.name,
    persistent: true,
    async prepare() {
      if (!handle.queryPermission || !handle.requestPermission) return true;
      const mode = { mode: "readwrite" as const };
      if ((await handle.queryPermission(mode)) === "granted") return true;
      return (await handle.requestPermission(mode)) === "granted";
    },
    async write(bytes) {
      const writable = await handle.createWritable();
      try {
        await writable.write(new Blob([bytes as BlobPart], { type: "application/pdf" }));
        await writable.close();
      } catch (e) {
        await writable.abort?.().catch(() => {});
        throw e;
      }
    },
  };
}

/** A download (fallback when files cannot be written in place). */
export function downloadDestination(name: string): SaveDestination {
  return {
    kind: "download",
    name,
    label: `téléchargement de ${name}`,
    persistent: false,
    async prepare() {
      return true;
    },
    async write(bytes) {
      downloadBlob(name, "application/pdf", bytes);
    },
  };
}

/** Open a PDF with the system picker, keeping a handle to save back into it. Null = cancelled. */
export async function pickPdfToOpen(): Promise<{ file: File; handle: FsFileHandle } | null> {
  const w = fsWindow();
  if (!w?.showOpenFilePicker) return null;
  try {
    const [handle] = await w.showOpenFilePicker({ types: [PDF_TYPE], multiple: false, id: "elium-pdf" });
    if (!handle) return null;
    return { file: await handle.getFile(), handle };
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** Ask where to save (system « Enregistrer sous » dialog). Null = cancelled. */
export async function pickSaveTarget(suggestedName: string): Promise<SaveDestination | null> {
  const w = fsWindow();
  if (!w?.showSaveFilePicker) return null;
  try {
    const handle = await w.showSaveFilePicker({ suggestedName, types: [PDF_TYPE], id: "elium-pdf" });
    return fileDestination(handle);
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/**
 * The handle of a dropped file, when the browser exposes one. MUST be called
 * synchronously inside the `drop` event (the data transfer is emptied after).
 */
export function droppedHandle(dt: DataTransfer | null): Promise<FsFileHandle | null> {
  const item = dt?.items?.[0] as
    (DataTransferItem & { getAsFileSystemHandle?: () => Promise<FsFileHandle | null> }) | undefined;
  if (!item || item.kind !== "file" || typeof item.getAsFileSystemHandle !== "function") return Promise.resolve(null);
  return item
    .getAsFileSystemHandle()
    .then((h) => (h && h.kind === "file" ? h : null))
    .catch(() => null);
}

/** "rapport.pdf" → "rapport.pdf"; "rapport" → "rapport.pdf". */
export function pdfName(name: string): string {
  const base = (name || "document").trim() || "document";
  return /\.pdf$/i.test(base) ? base : `${base}.pdf`;
}
