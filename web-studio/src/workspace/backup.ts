/**
 * Sauvegarde / restauration de TOUT l'espace de travail dans un seul fichier
 * `.elium-workspace` : une archive zip (fflate) contenant le catalogue
 * (dossiers, éléments, étiquettes, corbeille), le contenu de chaque élément et
 * les réglages. Facultativement chiffrée par mot de passe dans le conteneur
 * Elium existant (voir backup-io.ts).
 *
 * Ce fichier ne contient que de la logique PURE : encodage/décodage de
 * l'archive, validation, plan de restauration avec choix de conflit. Les
 * secrets (identité de signature, clé de réception, carnet, sceaux épinglés)
 * n'y entrent QUE sur demande explicite.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { ContentStoreId, WorkFolder, WorkItem } from "./types";

export const BACKUP_FORMAT = "elium-workspace";
export const BACKUP_VERSION = 1;
export const BACKUP_EXTENSION = ".elium-workspace";

/** Réglages sauvegardés (aucun secret). */
export const SETTINGS_KEYS = [
  "elium_prefs",
  "elium_shortcuts",
  "elium_locale",
  "elium_theme",
  "elium.proofing.v1",
  "elium_recent_commands",
] as const;

/** Clés sensibles : identité de signature chiffrée, clé de réception, carnet de confiance, sceaux épinglés. Sur demande seulement. */
export const SECRET_KEYS = ["elium_identity", "elium_recipient_key", "elium_trust_book", "elium_seal_pins"] as const;

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: number;
  createdAt: string;
  appVersion?: string;
  includesSecrets: boolean;
  counts: { items: number; folders: number; trashed: number };
}

export interface BackupSnapshot {
  createdAt: string;
  appVersion?: string;
  folders: WorkFolder[];
  items: WorkItem[];
  /** Contenu par élément : `${contentStore}/${id}` → octets. */
  contents: Map<string, Uint8Array>;
  settings: Record<string, string>;
  secrets: Record<string, string>;
}

export const contentKey = (store: ContentStoreId, id: string) => `${store}/${id}`;

const MAX_ENTRY_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 50_000;

const enc = (s: string) => encodeURIComponent(s);
const dec = (s: string) => decodeURIComponent(s);

/** Ne garde que les clés autorisées d'un dictionnaire de réglages. */
export function pickKeys(source: Record<string, string | null>, allowed: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of allowed) if (typeof source[k] === "string") out[k] = source[k] as string;
  return out;
}

export function encodeBackup(snap: BackupSnapshot, opts: { includeSecrets: boolean }): Uint8Array {
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: snap.createdAt,
    appVersion: snap.appVersion,
    includesSecrets: opts.includeSecrets,
    counts: {
      items: snap.items.length,
      folders: snap.folders.length,
      trashed: snap.items.filter((i) => i.trashedAt).length,
    },
  };
  const files: Record<string, Uint8Array> = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "catalog.json": strToU8(JSON.stringify({ folders: snap.folders, items: snap.items })),
    "settings.json": strToU8(JSON.stringify(snap.settings)),
  };
  if (opts.includeSecrets) files["secrets.json"] = strToU8(JSON.stringify(snap.secrets));
  for (const [key, bytes] of snap.contents) files[`content/${key.split("/").map(enc).join("/")}`] = bytes;
  // Les contenus sont déjà compressés (.elium, PDF) ou du JSON volumineux : niveau modéré.
  return zipSync(files, { level: 4 });
}

export class BackupFormatError extends Error {}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function parseJson(files: Record<string, Uint8Array>, name: string): unknown {
  const raw = files[name];
  if (!raw) throw new BackupFormatError(`Archive invalide : « ${name} » est absent.`);
  try {
    return JSON.parse(strFromU8(raw));
  } catch {
    throw new BackupFormatError(`Archive invalide : « ${name} » est illisible.`);
  }
}

const STORES: ContentStoreId[] = ["drive", "sheets", "slides", "pdfs"];
const KINDS = ["doc", "sheet", "slides", "pdf"];

function cleanItem(v: unknown): WorkItem | null {
  if (!isObj(v) || typeof v.id !== "string" || typeof v.title !== "string") return null;
  if (!KINDS.includes(v.kind as string) || !STORES.includes(v.contentStore as ContentStoreId)) return null;
  const iso = (x: unknown, fb: string) => (typeof x === "string" && !Number.isNaN(Date.parse(x)) ? x : fb);
  const now = new Date().toISOString();
  return {
    id: v.id,
    kind: v.kind as WorkItem["kind"],
    contentStore: v.contentStore as ContentStoreId,
    title: v.title.slice(0, 300),
    size: typeof v.size === "number" ? v.size : 0,
    createdAt: iso(v.createdAt, now),
    modifiedAt: iso(v.modifiedAt, now),
    lastOpenedAt: typeof v.lastOpenedAt === "string" ? v.lastOpenedAt : undefined,
    folderId: typeof v.folderId === "string" ? v.folderId : null,
    tags: Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === "string").slice(0, 50) : [],
    starred: v.starred === true,
    trashedAt: typeof v.trashedAt === "string" ? v.trashedAt : undefined,
    trashedBy: typeof v.trashedBy === "string" ? v.trashedBy : undefined,
    vaultProtected: false, // recalculé selon le coffre de la machine de destination
    profile: typeof v.profile === "string" ? v.profile : undefined,
  };
}

function cleanFolder(v: unknown): WorkFolder | null {
  if (!isObj(v) || typeof v.id !== "string" || typeof v.name !== "string") return null;
  return {
    id: v.id,
    parentId: typeof v.parentId === "string" ? v.parentId : null,
    name: v.name.slice(0, 200),
    createdAt: typeof v.createdAt === "string" ? v.createdAt : new Date().toISOString(),
    trashedAt: typeof v.trashedAt === "string" ? v.trashedAt : undefined,
    trashedBy: typeof v.trashedBy === "string" ? v.trashedBy : undefined,
    vaultProtected: false,
  };
}

/** Lit et VALIDE une archive (jamais de confiance aveugle : le fichier peut venir de n'importe où). */
export function decodeBackup(bytes: Uint8Array): { manifest: BackupManifest; snapshot: BackupSnapshot } {
  let files: Record<string, Uint8Array>;
  try {
    let count = 0;
    files = unzipSync(bytes, {
      filter: (f) => {
        if (++count > MAX_ENTRIES) throw new BackupFormatError("Archive invalide : trop d'entrées.");
        if (f.originalSize > MAX_ENTRY_BYTES)
          throw new BackupFormatError("Archive invalide : entrée trop volumineuse.");
        return true;
      },
    });
  } catch (e) {
    if (e instanceof BackupFormatError) throw e;
    throw new BackupFormatError("Ce fichier n'est pas une sauvegarde Elium lisible.");
  }
  const m = parseJson(files, "manifest.json");
  if (!isObj(m) || m.format !== BACKUP_FORMAT)
    throw new BackupFormatError("Ce fichier n'est pas une sauvegarde d'espace de travail Elium.");
  if (typeof m.version !== "number" || m.version > BACKUP_VERSION)
    throw new BackupFormatError(
      "Cette sauvegarde vient d'une version plus récente d'Elium : mettez Elium à jour pour la restaurer.",
    );
  const cat = parseJson(files, "catalog.json");
  if (!isObj(cat) || !Array.isArray(cat.items) || !Array.isArray(cat.folders))
    throw new BackupFormatError("Archive invalide : catalogue illisible.");
  const items = cat.items.map(cleanItem).filter((x): x is WorkItem => !!x);
  const folders = cat.folders.map(cleanFolder).filter((x): x is WorkFolder => !!x);
  const contents = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(files)) {
    if (!name.startsWith("content/")) continue;
    const parts = name.slice("content/".length).split("/");
    if (parts.length !== 2) continue;
    try {
      contents.set(`${dec(parts[0]!)}/${dec(parts[1]!)}`, data);
    } catch {
      /* nom d'entrée illisible : ignorée */
    }
  }
  const strMap = (v: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (isObj(v)) for (const [k, val] of Object.entries(v)) if (typeof val === "string") out[k] = val;
    return out;
  };
  const settings = pickKeys(strMap(files["settings.json"] ? parseJson(files, "settings.json") : {}), SETTINGS_KEYS);
  const includesSecrets = m.includesSecrets === true && !!files["secrets.json"];
  const secrets = includesSecrets ? pickKeys(strMap(parseJson(files, "secrets.json")), SECRET_KEYS) : {};
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: m.version,
    createdAt: typeof m.createdAt === "string" ? m.createdAt : "",
    appVersion: typeof m.appVersion === "string" ? m.appVersion : undefined,
    includesSecrets,
    counts: { items: items.length, folders: folders.length, trashed: items.filter((i) => i.trashedAt).length },
  };
  return {
    manifest,
    snapshot: {
      createdAt: manifest.createdAt,
      appVersion: manifest.appVersion,
      folders,
      items,
      contents,
      settings,
      secrets,
    },
  };
}

// ---------------------------------------------------------------------------
// Plan de restauration
// ---------------------------------------------------------------------------

export type ConflictChoice = "skip" | "replace" | "keep_both";

export interface RestoreAction {
  /** Élément de la sauvegarde. */
  item: WorkItem;
  action: "add" | "skip" | "replace" | "copy";
  /** Pour « copy » : identifiant de la copie. */
  newId?: string;
  /** Pour « copy » : titre de la copie. */
  newTitle?: string;
  /** Contenu absent de l'archive : élément ignoré. */
  reason?: "no_content";
}

export interface RestorePlan {
  actions: RestoreAction[];
  /** Dossiers à créer (absents localement) — ceux qui existent déjà sont conservés tels quels. */
  foldersToAdd: WorkFolder[];
  counts: { add: number; replace: number; copy: number; skip: number; conflicts: number };
}

/**
 * Compare la sauvegarde à l'espace local. Un « conflit » = même identifiant des deux côtés.
 * `choice` donne le choix par défaut, `perItem` des exceptions.
 */
export function planBackupRestore(
  local: Pick<WorkItem, "id" | "title" | "folderId" | "trashedAt">[],
  localFolders: Pick<WorkFolder, "id">[],
  snap: Pick<BackupSnapshot, "items" | "folders" | "contents">,
  choice: ConflictChoice,
  perItem: Map<string, ConflictChoice> = new Map(),
  newId: () => string = () => globalThis.crypto.randomUUID(),
): RestorePlan {
  const localIds = new Set(local.map((i) => i.id));
  const takenTitles = new Set(local.map((i) => i.title.toLowerCase()));
  const folderIds = new Set(localFolders.map((f) => f.id));
  const actions: RestoreAction[] = [];
  const counts = { add: 0, replace: 0, copy: 0, skip: 0, conflicts: 0 };
  for (const item of snap.items) {
    if (!snap.contents.has(contentKey(item.contentStore, item.id))) {
      actions.push({ item, action: "skip", reason: "no_content" });
      counts.skip++;
      continue;
    }
    if (!localIds.has(item.id)) {
      actions.push({ item, action: "add" });
      counts.add++;
      continue;
    }
    counts.conflicts++;
    const c = perItem.get(item.id) ?? choice;
    if (c === "skip") {
      actions.push({ item, action: "skip" });
      counts.skip++;
    } else if (c === "replace") {
      actions.push({ item, action: "replace" });
      counts.replace++;
    } else {
      let title = `${item.title} (restauré)`;
      for (let n = 2; takenTitles.has(title.toLowerCase()); n++) title = `${item.title} (restauré ${n})`;
      takenTitles.add(title.toLowerCase());
      actions.push({ item, action: "copy", newId: newId(), newTitle: title });
      counts.copy++;
    }
  }
  return { actions, foldersToAdd: snap.folders.filter((f) => !folderIds.has(f.id)), counts };
}

/** Nom de fichier proposé : elium-espace-2026-10-03.elium-workspace. */
export function backupFileName(now: Date): string {
  return `elium-espace-${now.toISOString().slice(0, 10)}${BACKUP_EXTENSION}`;
}
