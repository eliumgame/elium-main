/**
 * Ouvrir / enregistrer EN PLACE avec l'API File System Access (Chromium : la
 * fenêtre de bureau Edge --app et Chrome), avec repli propre vers
 * <input type=file> et téléchargement ailleurs.
 *
 * Les poignées de fichier sont conservées dans IndexedDB (elium-workspace,
 * table `handles`, clonables) : « Enregistrer » réécrit le MÊME fichier, même
 * après un redémarrage — la permission, elle, est redemandée au clic si le
 * navigateur l'a retirée. Les décisions (que faire à « Enregistrer ») sont
 * pures et testées (tests/fs-access.test.ts).
 */
import { WORKSPACE_SPEC } from "../format/db-specs";
import type { FsFileHandle } from "../pdf/core/destination";
import { idbKv, type KvStore } from "./kv";

export type { FsFileHandle };

export interface PickerType {
  description: string;
  accept: Record<string, string[]>;
}

export const ELIUM_TYPE: PickerType = { description: "Document Elium", accept: { "application/x-elium": [".elium"] } };
export const OPEN_TYPES: PickerType[] = [
  ELIUM_TYPE,
  {
    description: "Documents importables",
    accept: {
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
      "text/plain": [".txt", ".md", ".markdown"],
      "text/html": [".html", ".htm"],
      "application/pdf": [".pdf"],
    },
  },
];

interface FsWindow {
  showOpenFilePicker?: (o: {
    types?: PickerType[];
    multiple?: boolean;
    id?: string;
    excludeAcceptAllOption?: boolean;
  }) => Promise<FsFileHandle[]>;
  showSaveFilePicker?: (o: { suggestedName?: string; types?: PickerType[]; id?: string }) => Promise<FsFileHandle>;
  isSecureContext?: boolean;
}

const w = (): FsWindow | null => (typeof window === "undefined" ? null : (window as unknown as FsWindow));

/** Les sélecteurs de fichiers natifs sont-ils disponibles (contexte sécurisé, pas dans une iframe) ? */
export function fsAccessSupported(): boolean {
  const win = w();
  if (!win || win.isSecureContext === false) return false;
  try {
    if (window.top !== window.self) return false;
  } catch {
    return false;
  }
  return typeof win.showOpenFilePicker === "function" && typeof win.showSaveFilePicker === "function";
}

const isAbort = (e: unknown) => e instanceof DOMException && e.name === "AbortError";

// ---------------------------------------------------------------------------
// Décisions pures
// ---------------------------------------------------------------------------

export type PermissionLike = "granted" | "prompt" | "denied" | "unknown";

export type SavePlan =
  /** Écrire dans le fichier déjà lié (permission déjà accordée). */
  | { kind: "write"; reason: "linked" }
  /** Fichier lié mais permission à redemander (dans le geste de l'utilisateur) puis écrire. */
  | { kind: "request_then_write" }
  /** Pas de fichier lié : demander où enregistrer. */
  | { kind: "pick" }
  /** Pas d'API fichier : télécharger une copie. */
  | { kind: "download" };

/**
 * Que faire quand l'utilisateur clique « Enregistrer » (ou « Enregistrer sous… » : `forcePick`) ?
 * - API absente → téléchargement ;
 * - « sous… » ou pas de fichier lié → sélecteur ;
 * - fichier lié → écriture directe si la permission est accordée, sinon on la redemande ;
 *   refusée → sélecteur (l'utilisateur peut choisir un autre emplacement).
 */
export function planSave(input: {
  supported: boolean;
  hasHandle: boolean;
  permission: PermissionLike;
  forcePick: boolean;
}): SavePlan {
  if (!input.supported) return { kind: "download" };
  if (input.forcePick || !input.hasHandle) return { kind: "pick" };
  if (input.permission === "granted") return { kind: "write", reason: "linked" };
  if (input.permission === "denied") return { kind: "pick" };
  return { kind: "request_then_write" };
}

/** Nom proposé pour un fichier : titre assaini + extension. */
export function suggestedFileName(title: string, ext = ".elium"): string {
  const base =
    (title || "document")
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || "document";
  return base.toLowerCase().endsWith(ext) ? base : base + ext;
}

// ---------------------------------------------------------------------------
// Poignées conservées
// ---------------------------------------------------------------------------

export interface HandleRecord {
  /** Clé : identifiant du document (docKey). */
  id: string;
  handle: FsFileHandle;
  name: string;
  updatedAt: string;
}

let handles: KvStore<HandleRecord> | null = null;
const store = () => (handles ??= idbKv<HandleRecord>(WORKSPACE_SPEC, "handles"));

/** Pour les tests : remplace le magasin de poignées. */
export function setHandleStoreForTests(s: KvStore<HandleRecord> | null): void {
  handles = s;
}

export async function rememberHandle(docKey: string, handle: FsFileHandle): Promise<void> {
  try {
    await store().put({ id: docKey, handle, name: handle.name, updatedAt: new Date().toISOString() });
  } catch {
    /* un environnement qui ne sait pas cloner la poignée : « Enregistrer » redemandera l'emplacement */
  }
}

export async function recallHandle(docKey: string): Promise<FsFileHandle | undefined> {
  try {
    return (await store().get(docKey))?.handle;
  } catch {
    return undefined;
  }
}

export async function forgetHandle(docKey: string): Promise<void> {
  try {
    await store().delete(docKey);
  } catch {
    /* rien à oublier */
  }
}

export async function permissionOf(
  handle: FsFileHandle,
  mode: "read" | "readwrite" = "readwrite",
): Promise<PermissionLike> {
  if (!handle.queryPermission) return "granted"; // pas de modèle de permission : l'écriture réussira ou échouera
  try {
    return await handle.queryPermission({ mode });
  } catch {
    return "unknown";
  }
}

/** À appeler DANS le geste de l'utilisateur (clic) : les navigateurs refusent sinon. */
export async function ensurePermission(
  handle: FsFileHandle,
  mode: "read" | "readwrite" = "readwrite",
): Promise<boolean> {
  if ((await permissionOf(handle, mode)) === "granted") return true;
  if (!handle.requestPermission) return false;
  try {
    return (await handle.requestPermission({ mode })) === "granted";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sélecteurs et écriture
// ---------------------------------------------------------------------------

export interface PickedFile {
  file: File;
  /** Absente quand le fichier vient d'un <input type=file> ou d'un glisser-déposer sans poignée. */
  handle?: FsFileHandle;
}

/** « Ouvrir… » : renvoie le fichier et sa poignée, ou null (annulé / API absente → l'appelant utilise <input type=file>). */
export async function pickFileToOpen(): Promise<PickedFile | null> {
  const win = w();
  if (!win?.showOpenFilePicker || !fsAccessSupported()) return null;
  try {
    const [handle] = await win.showOpenFilePicker({ types: OPEN_TYPES, multiple: false, id: "elium-open" });
    return handle ? { file: await handle.getFile(), handle } : null;
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** « Enregistrer sous… » : renvoie la poignée choisie, ou null si annulé. */
export async function pickSaveHandle(title: string): Promise<FsFileHandle | null> {
  const win = w();
  if (!win?.showSaveFilePicker) return null;
  try {
    return await win.showSaveFilePicker({
      suggestedName: suggestedFileName(title),
      types: [ELIUM_TYPE],
      id: "elium-save",
    });
  } catch (e) {
    if (isAbort(e)) return null;
    throw e;
  }
}

/** Écrit tout le fichier ; en cas d'échec le fichier d'origine reste intact (écriture atomique du navigateur). */
export async function writeToHandle(
  handle: FsFileHandle,
  bytes: Uint8Array,
  mime = "application/x-elium",
): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await writable.write(new Blob([bytes as BlobPart], { type: mime }));
    await writable.close();
  } catch (e) {
    await writable.abort?.().catch(() => undefined);
    throw e;
  }
}

/** Poignée d'un fichier déposé (à appeler SYNCHRONEMENT dans l'événement drop). */
export async function handleFromDrop(dt: DataTransfer | null): Promise<FsFileHandle | null> {
  const item = dt?.items?.[0] as
    (DataTransferItem & { getAsFileSystemHandle?: () => Promise<FsFileHandle | null> }) | undefined;
  if (!item || item.kind !== "file" || typeof item.getAsFileSystemHandle !== "function") return null;
  try {
    const h = await item.getAsFileSystemHandle();
    return h && h.kind === "file" ? h : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PWA : ouverture par double-clic (file_handlers + launchQueue)
// ---------------------------------------------------------------------------

interface LaunchParams {
  files?: FsFileHandle[];
}
interface LaunchQueueLike {
  setConsumer(cb: (params: LaunchParams) => void | Promise<void>): void;
}

/** Branche la réception des fichiers ouverts depuis l'explorateur dans la PWA installée. Renvoie false si l'API n'existe pas. */
export function consumeLaunchQueue(
  onFile: (picked: PickedFile) => void | Promise<void>,
  onError: (e: unknown) => void,
): boolean {
  const q = (window as unknown as { launchQueue?: LaunchQueueLike }).launchQueue;
  if (!q?.setConsumer) return false;
  q.setConsumer(async (params) => {
    for (const handle of params.files ?? []) {
      try {
        await onFile({ file: await handle.getFile(), handle });
      } catch (e) {
        onError(e);
      }
    }
  });
  return true;
}
