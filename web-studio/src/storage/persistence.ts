/**
 * Interface de stockage choisie à l'exécution, SANS dupliquer les modules :
 * IndexedDB reste le cache de travail partout ; en plus, l'app Windows miroite
 * l'espace de travail en fichiers (voir file-mirror.ts).
 *
 *  - `IdbBackend` (site hébergé / PWA / dev) : aucun fichier ; demande seulement
 *    `navigator.storage.persist()` pour éviter l'éviction sous pression de quota.
 *  - `LauncherFilesBackend` (app Windows) : API loopback `/__files__/` du lanceur,
 *    authentifiée par le jeton de session injecté dans la page.
 */

export interface FileEntry {
  /** Chemin logique « Dossier/fichier.ext » (jamais un chemin du disque). */
  p: string;
  size: number;
  mtime: number;
}

export interface FileBackend {
  /** Dossier de travail affiché à l'utilisateur. */
  readonly root: string;
  list(): Promise<FileEntry[]>;
  read(p: string): Promise<Uint8Array | undefined>;
  write(p: string, bytes: Uint8Array): Promise<void>;
  /** Déplace dans la corbeille du dossier ; `hard` : effacement définitif. */
  remove(p: string, opts?: { hard?: boolean }): Promise<void>;
}

export type Persistence = { kind: "idb" } | { kind: "files"; backend: FileBackend };

function launcherToken(): string | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLMetaElement>('meta[name="elium-token"]')?.content || null;
}

const q = (p: string) => encodeURIComponent(p);

/** Backend fichiers du lanceur, ou null hors lanceur (jeton absent / API muette). */
export async function launcherFilesBackend(fetchFn: typeof fetch = fetch): Promise<FileBackend | null> {
  const token = launcherToken();
  if (!token) return null;
  const call = (path: string, init: RequestInit = {}) =>
    fetchFn(`/__files__/${path}`, { ...init, headers: { ...(init.headers ?? {}), "X-Elium-Token": token } });
  let root: string;
  try {
    const r = await call("info");
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    const info = (await r.json()) as { enabled?: boolean; root?: string };
    if (info.enabled !== true || typeof info.root !== "string") return null;
    root = info.root;
  } catch {
    return null;
  }
  const must = async (r: Response, what: string) => {
    if (!r.ok) throw new Error(`Fichiers locaux : ${what} refusé (${r.status}).`);
    return r;
  };
  return {
    root,
    async list() {
      const r = await must(await call("list"), "liste");
      return ((await r.json()) as { files: FileEntry[] }).files;
    },
    async read(p) {
      const r = await call(`read?p=${q(p)}`);
      if (r.status === 404) return undefined;
      await must(r, "lecture");
      return new Uint8Array(await r.arrayBuffer());
    },
    async write(p, bytes) {
      await must(
        await call(`write?p=${q(p)}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: bytes as unknown as BodyInit,
        }),
        "écriture",
      );
    },
    async remove(p, opts) {
      await must(
        await call(`remove?p=${q(p)}${opts?.hard ? "&hard=1" : ""}`, { method: "POST", body: "" }),
        "suppression",
      );
    },
  };
}

/** Choix à l'exécution : fichiers locaux si le lanceur répond, sinon IndexedDB seul. */
export async function detectPersistence(fetchFn?: typeof fetch): Promise<Persistence> {
  const backend = await launcherFilesBackend(fetchFn);
  return backend ? { kind: "files", backend } : { kind: "idb" };
}

/** Site : demande un stockage persistant (non évincable). Renvoie l'état obtenu, jamais ne lève. */
export async function requestPersistentStorage(
  storage: Pick<StorageManager, "persist" | "persisted"> | undefined = typeof navigator !== "undefined"
    ? navigator.storage
    : undefined,
): Promise<boolean> {
  try {
    if (!storage?.persist) return false;
    if (storage.persisted && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
