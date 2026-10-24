/**
 * Sauvegarde INCRÉMENTALE de l'espace de travail dans le Drive entreprise (chiffré de bout en bout,
 * versionné par le serveur). Remplace l'archive monolithique : dans le dossier « Sauvegarde Elium » à
 * la racine du Drive du compte, un fichier par élément (le contenu brut : .elium, classeur,
 * présentation, PDF) + quelques pièces légères :
 *   - `_index.json`   : catalogue (dossiers, métadonnées, favoris, étiquettes, corbeille) ;
 *   - `_reglages.json`: réglages et préférences sans secret ;
 *   - `_<pièce>.elium-extra` : brouillons, versions, polices, passeport, circuits (extras.ts).
 * Seul ce qui a changé est renvoyé. La restauration (appareil vierge, cache effacé) lit l'index, réutilise
 * le plan de conflit existant (backup.ts) et n'écrase jamais en silence : le moteur ne pousse RIEN tant
 * que l'espace n'a pas été « réconcilié » (`ready`) avec ce que le Drive contient déjà.
 *
 * Toutes les E/S (Drive, état local, magasins) sont injectées : testé sur un Drive en mémoire.
 * Les clés privées et identités ne sont jamais envoyées (zéro connaissance).
 */
import { strFromU8, strToU8 } from "fflate";
import {
  cleanFolder,
  cleanItem,
  contentKey,
  pickKeys,
  planBackupRestore,
  type ConflictChoice,
  type BackupSnapshot,
} from "./backup";
import { restoreSnapshot, VaultLockedError, type BackupDeps, type RestoreReport } from "./backup-io";
import type { ExtraPiece, Records } from "./extras";
import type { ContentStoreId, WorkFolder, WorkItem } from "./types";

export const SYNC_FOLDER = "Sauvegarde Elium";
export const INDEX_FILE = "_index.json";
export const SETTINGS_FILE = "_reglages.json";
export const EXTRA_SUFFIX = ".elium-extra";
/** Archive monolithique des versions précédentes d'Elium (lue pour la migration, plus écrite). */
export const LEGACY_FILE = "Espace-de-travail-Elium.elium-workspace";

/** Réglages sauvegardés en plus de ceux de l'archive : contenu utilisateur (sources, styles) sans secret. */
export const SYNC_SETTINGS_KEYS = [
  "elium_prefs",
  "elium_shortcuts",
  "elium_locale",
  "elium_theme",
  "elium.proofing.v1",
  "elium_recent_commands",
  "elium.bibliography.sources.v1",
  "elium.citation.style",
  "elium.pdf.prefs",
  "elium.pdf.print",
  "elium.pdf.customStamps",
  "elium-editor-density",
  "elium_view_mode",
] as const;

export interface RemoteEntry {
  id: string;
  name: string;
  modifiedAt: string;
}

export interface SyncRemote {
  findFolder(): Promise<string | null>;
  ensureFolder(): Promise<string>;
  list(folderId: string): Promise<RemoteEntry[]>;
  upload(folderId: string, name: string, bytes: Uint8Array): Promise<RemoteEntry>;
  update(nodeId: string, bytes: Uint8Array): Promise<RemoteEntry>;
  rename(nodeId: string, name: string): Promise<void>;
  download(entry: RemoteEntry): Promise<Uint8Array>;
  /** Archive monolithique d'une ancienne version, s'il y en a une à la racine. */
  findLegacy(): Promise<RemoteEntry | null>;
}

export interface ItemLink {
  node: string;
  /** Empreinte du contenu au dernier envoi/lecture (`modifiedAt|taille`). Vide : à renvoyer. */
  sig: string;
  name: string;
}

export interface SyncState {
  v: 1;
  /** Espace réconcilié avec le Drive : l'envoi automatique est autorisé. */
  ready: boolean;
  folderId?: string;
  items: Record<string, ItemLink>;
  pieces: Record<string, { node: string; sig: string }>;
  lastOkAt?: string;
}

export const emptyState = (): SyncState => ({ v: 1, ready: false, items: {}, pieces: {} });

export interface SyncStateStore {
  load(): SyncState;
  save(s: SyncState): void;
}

export interface SyncEnv {
  remote: SyncRemote;
  store: SyncStateStore;
  deps: BackupDeps;
  extras: {
    pieces: ExtraPiece[];
    dump(p: ExtraPiece): Promise<Records>;
    apply(p: ExtraPiece, r: Records): Promise<number>;
    pack(r: Records): Promise<Uint8Array>;
    unpack(b: Uint8Array): Promise<Records>;
  };
  dirty: { list(): string[]; clear(piece: string): void };
  /** Rend la main au navigateur (jamais de tâche longue). */
  yieldNow?: () => Promise<void>;
  now?: () => Date;
  appVersion?: string;
}

// --- Utilitaires purs -------------------------------------------------------------------------------

export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const EXT: Record<ContentStoreId, string> = {
  drive: ".elium",
  sheets: ".classeur.json",
  slides: ".presentation.json",
  pdfs: ".pdf",
};

const safeTitle = (t: string) =>
  (t || "Sans titre")
    .replace(/[\\/:*?"<>|[\]\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "Sans titre";

export const itemFileName = (item: Pick<WorkItem, "id" | "title" | "contentStore">): string =>
  `${safeTitle(item.title)} [${item.id}]${EXT[item.contentStore]}`;

/** Identifiant d'élément porté par un nom de fichier de sauvegarde (`Titre [id].ext`). */
export function itemIdFromName(name: string): string | null {
  const m = /\[([^\]]+)\]\.[a-z.]+$/i.exec(name);
  return m ? m[1]! : null;
}

export const contentSig = (item: Pick<WorkItem, "modifiedAt" | "size">): string => `${item.modifiedAt}|${item.size}`;

const pieceFileName = (piece: string) => `_${piece}${EXTRA_SUFFIX}`;

/** Éléments à envoyer : nouveaux ou changés depuis le dernier envoi. */
export function changedItems(items: WorkItem[], state: SyncState): WorkItem[] {
  return items.filter((i) => !i.locked && state.items[i.id]?.sig !== contentSig(i));
}

/** Nombre d'éléments en attente d'envoi (affiché dans la pastille d'état). */
export function pendingCount(items: WorkItem[], state: SyncState, dirty: string[]): number {
  return changedItems(items, state).length + dirty.length;
}

// --- Envoi ------------------------------------------------------------------------------------------

export interface SyncReport {
  items: number;
  pieces: number;
  skippedLocked: number;
  /** Éléments déjà modifiés dans le Drive depuis (une autre version existe dans l'historique du serveur). */
  failed: { name: string; message: string }[];
}

const tick = (env: SyncEnv) => env.yieldNow?.() ?? Promise.resolve();

/**
 * Envoie ce qui a changé. `only` limite aux éléments donnés (bouton « Enregistrer dans le Drive »).
 * Ne fait rien (`null`) tant que l'espace n'est pas réconcilié avec le Drive.
 */
export async function syncOnce(
  env: SyncEnv,
  opts: { only?: string[]; piecesToo?: boolean } = {},
): Promise<SyncReport | null> {
  let state = env.store.load();
  if (!state.ready) return null;
  const { items, folders } = await env.deps.catalog.load();
  if (items.some((i) => i.locked) || folders.some((f) => f.locked))
    throw new VaultLockedError("Le coffre local est verrouillé : déverrouillez-le pour sauvegarder.");
  const report: SyncReport = { items: 0, pieces: 0, skippedLocked: 0, failed: [] };
  const folderId = state.folderId ?? (state.folderId = await env.remote.ensureFolder());
  env.store.save(state);
  const todo = changedItems(items, state).filter((i) => !opts.only || opts.only.includes(i.id));
  for (const item of todo) {
    try {
      const bytes = await env.deps.contents[item.contentStore].read(item);
      if (!bytes) continue;
      const link = state.items[item.id];
      const name = itemFileName(item);
      let entry: RemoteEntry;
      if (link) {
        try {
          // Pas de contrôle de conflit bloquant : la version précédente reste dans l'historique du serveur.
          entry = await env.remote.update(link.node, bytes);
          if (link.name !== name) await env.remote.rename(link.node, name).catch(() => undefined);
        } catch {
          entry = await env.remote.upload(folderId, name, bytes); // nœud supprimé côté Drive : on le recrée
        }
      } else entry = await env.remote.upload(folderId, name, bytes);
      state = env.store.load();
      state.items[item.id] = { node: entry.id, sig: `${item.modifiedAt}|${item.size}`, name };
      env.store.save(state);
      report.items++;
    } catch (e) {
      if (e instanceof VaultLockedError) throw e;
      report.failed.push({ name: item.title, message: e instanceof Error ? e.message : String(e) });
    }
    await tick(env);
  }
  if (opts.only && !opts.piecesToo) return finish(env, report);
  // Index et réglages (petits : comparés par empreinte).
  const meta = {
    folders,
    items: items.map((i) => ({ ...i, locked: undefined })),
    createdAt: nowIso(env),
    appVersion: env.appVersion,
  };
  await putPiece(
    env,
    folderId,
    INDEX_FILE,
    "index",
    strToU8(JSON.stringify(meta)),
    hashString(JSON.stringify({ folders, items: items.map(({ lastOpenedAt: _o, ...rest }) => (void _o, rest)) })),
    report,
  );
  const settings = pickKeys(
    Object.fromEntries(SYNC_SETTINGS_KEYS.map((k) => [k, env.deps.storage.get(k)])),
    SYNC_SETTINGS_KEYS,
  );
  const sj = JSON.stringify(settings);
  await putPiece(env, folderId, SETTINGS_FILE, "reglages", strToU8(sj), hashString(sj), report);
  // Pièces annexes signalées modifiées.
  for (const piece of env.dirty.list()) {
    const spec = env.extras.pieces.find((p) => p.piece === piece);
    if (!spec) {
      env.dirty.clear(piece);
      continue;
    }
    try {
      const bytes = await env.extras.pack(await env.extras.dump(spec));
      await putPiece(env, folderId, pieceFileName(piece), piece, bytes, undefined, report);
      env.dirty.clear(piece);
    } catch (e) {
      report.failed.push({ name: spec.label, message: e instanceof Error ? e.message : String(e) });
    }
    await tick(env);
  }
  return finish(env, report);
}

const nowIso = (env: SyncEnv) => (env.now?.() ?? new Date()).toISOString();

function finish(env: SyncEnv, report: SyncReport): SyncReport {
  if (!report.failed.length) {
    const s = env.store.load();
    s.lastOkAt = nowIso(env);
    env.store.save(s);
  }
  return report;
}

async function putPiece(
  env: SyncEnv,
  folderId: string,
  name: string,
  key: string,
  bytes: Uint8Array,
  sig: string | undefined,
  report: SyncReport,
): Promise<void> {
  const state = env.store.load();
  const known = state.pieces[key];
  if (sig !== undefined && known?.sig === sig) return;
  let entry: RemoteEntry;
  if (known) {
    try {
      entry = await env.remote.update(known.node, bytes);
    } catch {
      entry = await env.remote.upload(folderId, name, bytes);
    }
  } else entry = await env.remote.upload(folderId, name, bytes);
  const s = env.store.load();
  s.pieces[key] = { node: entry.id, sig: sig ?? "" };
  env.store.save(s);
  report.pieces++;
}

// --- Détection et restauration ---------------------------------------------------------------------

export interface RemoteProbe {
  /** `none` : rien dans le Drive ; `incremental` : sauvegarde de cette version ; `legacy` : ancienne archive monolithique. */
  kind: "none" | "incremental" | "legacy";
  folderId?: string;
  entries: RemoteEntry[];
  items: WorkItem[];
  folders: WorkFolder[];
  createdAt?: string;
  legacy?: RemoteEntry;
}

export async function probeRemote(env: SyncEnv): Promise<RemoteProbe> {
  const folderId = await env.remote.findFolder();
  if (folderId) {
    const entries = await env.remote.list(folderId);
    const idx = entries.find((e) => e.name === INDEX_FILE);
    if (idx) {
      const raw = JSON.parse(strFromU8(await env.remote.download(idx))) as {
        items?: unknown[];
        folders?: unknown[];
        createdAt?: string;
      };
      const present = new Set(entries.map((e) => itemIdFromName(e.name)).filter((x): x is string => !!x));
      const items = (raw.items ?? []).map(cleanItem).filter((x): x is WorkItem => !!x && present.has(x.id));
      const folders = (raw.folders ?? []).map(cleanFolder).filter((x): x is WorkFolder => !!x);
      return { kind: "incremental", folderId, entries, items, folders, createdAt: raw.createdAt };
    }
  }
  const legacy = await env.remote.findLegacy();
  if (legacy) return { kind: "legacy", entries: [], items: [], folders: [], legacy };
  return { kind: "none", folderId: folderId ?? undefined, entries: [], items: [], folders: [] };
}

/** Aucun travail à restaurer ni à protéger : le Drive est vide ou l'espace local est vierge. */
export function markReady(env: SyncEnv, folderId?: string): void {
  const s = env.store.load();
  s.ready = true;
  if (folderId) s.folderId = folderId;
  env.store.save(s);
}

export interface RestoreSummary extends RestoreReport {
  extras: number;
  extraLabels: string[];
}

/**
 * Restaure la sauvegarde incrémentale dans l'espace local (additif : rien n'est supprimé en local) puis
 * déclare l'espace réconcilié. `choice` s'applique aux éléments présents des deux côtés.
 */
export async function restoreIncremental(
  env: SyncEnv,
  probe: RemoteProbe,
  choice: ConflictChoice,
  onProgress?: (done: number, total: number) => void,
): Promise<RestoreSummary> {
  const folderId = probe.folderId!;
  const local = await env.deps.catalog.load();
  const byId = new Map<string, RemoteEntry>();
  for (const e of probe.entries) {
    const id = itemIdFromName(e.name);
    if (id) byId.set(id, e);
  }
  const placeholder = new Uint8Array(0);
  const snap: BackupSnapshot = {
    createdAt: probe.createdAt ?? "",
    folders: probe.folders,
    items: probe.items,
    contents: new Map(probe.items.map((i) => [contentKey(i.contentStore, i.id), placeholder])),
    settings: {},
    secrets: {},
  };
  const settingsEntry = probe.entries.find((e) => e.name === SETTINGS_FILE);
  if (settingsEntry) {
    try {
      const raw = JSON.parse(strFromU8(await env.remote.download(settingsEntry))) as Record<string, unknown>;
      snap.settings = pickKeys(
        Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, typeof v === "string" ? v : null])),
        SYNC_SETTINGS_KEYS,
      );
    } catch {
      /* réglages illisibles : le reste est restauré */
    }
  }
  const plan = planBackupRestore(local.items, local.folders, snap, choice);
  const todo = plan.actions.filter((a) => a.action !== "skip");
  let done = 0;
  for (const a of todo) {
    const entry = byId.get(a.item.id);
    if (entry) snap.contents.set(contentKey(a.item.contentStore, a.item.id), await env.remote.download(entry));
    onProgress?.(++done, todo.length);
    await tick(env);
  }
  const report = await restoreSnapshot(env.deps, snap, plan, { applySettings: true, applySecrets: false });
  // Pièces annexes.
  let extras = 0;
  const extraLabels: string[] = [];
  for (const spec of env.extras.pieces) {
    const entry = probe.entries.find((e) => e.name === pieceFileName(spec.piece));
    if (!entry) continue;
    try {
      const n = await env.extras.apply(spec, await env.extras.unpack(await env.remote.download(entry)));
      if (n) {
        extras += n;
        extraLabels.push(spec.label);
      }
    } catch (e) {
      report.errors.push({ title: spec.label, message: e instanceof Error ? e.message : String(e) });
    }
    await tick(env);
  }
  // Liens : les éléments restaurés correspondent exactement au Drive (rien à renvoyer) ; les autres seront renvoyés.
  const state = env.store.load();
  state.ready = true;
  state.folderId = folderId;
  for (const a of plan.actions) {
    const entry = byId.get(a.item.id);
    if (!entry || a.action === "copy") continue;
    const src = snap.contents.get(contentKey(a.item.contentStore, a.item.id));
    const restored = a.action === "add" || a.action === "replace";
    state.items[a.item.id] = {
      node: entry.id,
      sig: restored && src ? `${a.item.modifiedAt}|${src.length}` : "",
      name: entry.name,
    };
  }
  for (const e of probe.entries) {
    const piece = e.name === INDEX_FILE ? "index" : e.name === SETTINGS_FILE ? "reglages" : null;
    if (piece) state.pieces[piece] = { node: e.id, sig: "" };
    else if (e.name.startsWith("_") && e.name.endsWith(EXTRA_SUFFIX))
      state.pieces[e.name.slice(1, -EXTRA_SUFFIX.length)] = { node: e.id, sig: "" };
  }
  env.store.save(state);
  return { ...report, extras, extraLabels };
}
