/**
 * Chef d'orchestre de la sauvegarde Drive (singleton, hors React) : tient l'état visible par toute
 * l'interface (pastille « enregistré / en attente / hors ligne »), planifie les envois du moteur
 * incrémental (drive-sync.ts) et expose les actions « Enregistrer dans le Drive », « Restaurer »,
 * « Repartir à neuf ». Le composant `DriveSyncRunner` le configure ; les éditeurs l'appellent.
 */
import { useSyncExternalStore } from "react";
import { localSyncStore, opsRemote } from "../drive-cloud/sync-remote";
import type { OpsCtx } from "../drive-cloud/ops";
import { pullNamedFile } from "../drive-cloud/named-file";
import { reportError } from "../ui/crash-log";
import { planBackupRestore, type ConflictChoice } from "./backup";
import { openBackup, restoreSnapshot, VaultLockedError, type BackupDeps } from "./backup-io";
import {
  LEGACY_FILE,
  markReady,
  pendingCount,
  probeRemote,
  restoreIncremental,
  syncOnce,
  type RemoteProbe,
  type RestoreSummary,
  type SyncEnv,
} from "./drive-sync";
import { EXTRA_PIECES, applyExtra, dumpExtra, packRecords, unpackRecords } from "./extras";
import { clearDirty, dirtyPieces } from "./sync-dirty";
import type { WorkItem } from "./types";

export type SyncPhase =
  | "off" // pas de session Drive déverrouillée
  | "checking" // détection d'une sauvegarde existante
  | "needs-restore" // une sauvegarde existe : à restaurer ou à écarter avant tout envoi
  | "idle" // à jour
  | "syncing"
  | "pending" // des modifications attendent leur envoi
  | "offline"
  | "locked" // coffre local verrouillé
  | "error";

export interface SyncStatus {
  phase: SyncPhase;
  /** Éléments + pièces annexes en attente d'envoi. */
  pending: number;
  lastOkAt?: string;
  message?: string;
  /** Sauvegarde automatique active (obligatoire ou choisie). */
  auto: boolean;
  required: boolean;
  probe?: RemoteProbe;
}

let status: SyncStatus = { phase: "off", pending: 0, auto: false, required: false };
const listeners = new Set<() => void>();
const set = (patch: Partial<SyncStatus>) => {
  status = { ...status, ...patch };
  for (const l of listeners) l();
};
export const getSyncStatus = () => status;
export const subscribeSync = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const useSyncStatus = (): SyncStatus => useSyncExternalStore(subscribeSync, getSyncStatus, getSyncStatus);

interface Config {
  ctx: OpsCtx | null;
  getDeps: () => BackupDeps;
  getItems: () => WorkItem[];
  auto: boolean;
  required: boolean;
  appVersion?: string;
}

let cfg: Config | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<unknown> | null = null;
let rerun = false;
let ctxId = "";

const DELAY_MS = 15_000;
const RETRY_MS = 30_000;

const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

function makeEnv(c: Config): SyncEnv | null {
  if (!c.ctx) return null;
  return {
    remote: opsRemote(c.ctx),
    store: localSyncStore(c.ctx),
    deps: c.getDeps(),
    extras: {
      pieces: EXTRA_PIECES,
      dump: dumpExtra,
      apply: applyExtra,
      pack: packRecords,
      unpack: unpackRecords,
    },
    dirty: { list: dirtyPieces, clear: clearDirty },
    yieldNow,
    appVersion: c.appVersion,
  };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const isOffline = (e: unknown) =>
  (typeof navigator !== "undefined" && navigator.onLine === false) ||
  (e instanceof TypeError && /fetch|network|load failed/i.test(e.message));

function refreshPending(): void {
  if (!cfg?.ctx) return;
  const st = localSyncStore(cfg.ctx).load();
  const n = pendingCount(cfg.getItems(), st, dirtyPieces());
  if (!st.ready) return;
  if (status.phase === "idle" || status.phase === "pending")
    set({ pending: n, phase: n ? "pending" : "idle", lastOkAt: st.lastOkAt ?? status.lastOkAt });
  else set({ pending: n });
}

/** Appelé par `DriveSyncRunner` à chaque changement de session, d'option ou de contenu. */
export function configureSync(next: Config): void {
  const id = next.ctx ? `${next.ctx.userId}:${next.ctx.orgId}` : "";
  cfg = next;
  set({ auto: next.auto, required: next.required });
  if (!next.ctx) {
    ctxId = "";
    if (timer) clearTimeout(timer);
    set({ phase: "off", pending: 0, probe: undefined, message: undefined });
    return;
  }
  if (id !== ctxId) {
    ctxId = id;
    set({ phase: "checking", probe: undefined, message: undefined });
    void reconcile();
    return;
  }
  refreshPending();
}

/** Détecte ce que le Drive contient déjà ; ne pousse jamais avant que l'utilisateur ait tranché. */
export async function reconcile(): Promise<void> {
  const c = cfg;
  const env = c && makeEnv(c);
  if (!c || !env) return;
  try {
    const st = env.store.load();
    if (st.ready) {
      set({ phase: "idle", lastOkAt: st.lastOkAt });
      refreshPending();
      if (c.auto || c.required) request("reconnexion");
      return;
    }
    set({ phase: "checking" });
    const probe = await probeRemote(env);
    if (probe.kind === "none") {
      markReady(env, probe.folderId);
      set({ phase: "idle", probe: undefined });
      refreshPending();
      if (c.auto || c.required) request("première sauvegarde");
      return;
    }
    set({ phase: "needs-restore", probe, message: undefined });
  } catch (e) {
    fail(e, "reconcile");
  }
}

function fail(e: unknown, where: string): void {
  if (e instanceof VaultLockedError) return void set({ phase: "locked", message: e.message });
  if (isOffline(e))
    return void set({
      phase: "offline",
      message: "Hors ligne : vos modifications sont gardées et partiront à la reconnexion.",
    });
  reportError(`drive-sync.${where}`, e);
  set({ phase: "error", message: errText(e) });
  scheduleRetry();
}

function scheduleRetry(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void run("reprise"), RETRY_MS);
}

/** Planifie un envoi dans quelques secondes (regroupe les modifications rapprochées). */
export function request(_reason = "modification"): void {
  if (!cfg?.ctx || !(cfg.auto || cfg.required)) return refreshPending();
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void run(_reason), DELAY_MS);
  refreshPending();
}

async function run(_reason: string, opts: { only?: string[]; piecesToo?: boolean } = {}): Promise<boolean> {
  if (running) {
    rerun = true;
    await running.catch(() => undefined);
    if (!opts.only) return true; // une demande ciblée repart après la fin de l'envoi en cours
  }
  const c = cfg;
  const env = c && makeEnv(c);
  if (!c || !env) return false;
  const st = env.store.load();
  if (!st.ready) return false;
  set({ phase: "syncing", message: undefined });
  let ok = true;
  running = (async () => {
    try {
      const rep = await syncOnce(env, opts);
      if (rep?.failed.length) {
        ok = false;
        set({ phase: "error", message: `${rep.failed[0]!.name} : ${rep.failed[0]!.message}` });
        scheduleRetry();
      } else {
        set({ phase: "idle", message: undefined, lastOkAt: env.store.load().lastOkAt });
        // Le serveur retient la date de la dernière sauvegarde réussie (portail du propriétaire, sauvegarde imposée).
        void c.ctx?.api.backupHeartbeat((await env.deps.catalog.load()).items.length).catch(() => undefined);
      }
    } catch (e) {
      ok = false;
      fail(e, "push");
    } finally {
      running = null;
      refreshPending();
      if (rerun) {
        rerun = false;
        if (cfg?.auto || cfg?.required) request("suite");
      }
    }
  })();
  await running;
  return ok;
}

/** Envoi immédiat de tout ce qui attend (fermeture de la page, bouton « Sauvegarder maintenant »). */
export function flushNow(): Promise<boolean> {
  if (timer) clearTimeout(timer);
  return run("immédiat");
}

/**
 * « Enregistrer dans le Drive » : envoie CET élément tout de suite (puis le catalogue). `false` si le
 * Drive n'est pas prêt (non connecté, ou une sauvegarde existante attend d'être restaurée / écartée).
 */
export async function saveItemToDrive(itemId: string): Promise<{ ok: boolean; reason?: string }> {
  if (!cfg?.ctx) return { ok: false, reason: "not-connected" };
  if (status.phase === "needs-restore") return { ok: false, reason: "needs-restore" };
  const env = makeEnv(cfg);
  if (env && !env.store.load().ready) await reconcile();
  if (getSyncStatus().phase === "needs-restore") return { ok: false, reason: "needs-restore" };
  const ok = await run("manuel", { only: [itemId], piecesToo: true });
  return ok ? { ok: true } : { ok: false, reason: getSyncStatus().phase === "offline" ? "offline" : "error" };
}

export async function restoreFromProbe(
  choice: ConflictChoice,
  onProgress?: (done: number, total: number) => void,
): Promise<RestoreSummary> {
  const c = cfg;
  const env = c && makeEnv(c);
  const probe = status.probe;
  if (!c || !env || !probe) throw new Error("Aucune sauvegarde à restaurer.");
  set({ phase: "syncing", message: "Restauration en cours…" });
  try {
    let summary: RestoreSummary;
    if (probe.kind === "legacy") summary = await restoreLegacy(c, env, choice);
    else summary = await restoreIncremental(env, probe, choice, onProgress);
    set({ phase: "idle", probe: undefined, message: undefined });
    window.dispatchEvent(new CustomEvent("elium-workspace-restored"));
    refreshPending();
    if (c.auto || c.required) request("après restauration");
    return summary;
  } catch (e) {
    set({ phase: "needs-restore", message: errText(e) });
    throw e;
  }
}

async function restoreLegacy(c: Config, env: SyncEnv, choice: ConflictChoice): Promise<RestoreSummary> {
  const got = await pullNamedFile(c.ctx!, "workspace", LEGACY_FILE);
  if (!got) throw new Error("L'ancienne sauvegarde n'est plus dans le Drive.");
  const { snapshot } = await openBackup(got.bytes);
  const local = await env.deps.catalog.load();
  const plan = planBackupRestore(local.items, local.folders, snapshot, choice);
  const report = await restoreSnapshot(env.deps, snapshot, plan, { applySettings: true, applySecrets: false });
  markReady(env);
  return { ...report, extras: 0, extraLabels: [] };
}

/** « Repartir à neuf » : on ne restaure pas ; les éléments du Drive de même nom seront remplacés par les versions locales. */
export function startFresh(): void {
  const c = cfg;
  const env = c && makeEnv(c);
  if (!c || !env) return;
  markReady(env, status.probe?.folderId);
  set({ phase: "idle", probe: undefined });
  refreshPending();
  if (c.auto || c.required) request("repartir à neuf");
}

/** Nouvelle détection (bouton « Restaurer depuis le Drive » des Réglages). */
export async function recheck(): Promise<void> {
  const c = cfg;
  const env = c && makeEnv(c);
  if (!c || !env) return;
  set({ phase: "checking" });
  try {
    const probe = await probeRemote(env);
    if (probe.kind === "none") set({ phase: "idle", message: "Aucune sauvegarde dans le Drive.", probe: undefined });
    else set({ phase: "needs-restore", probe, message: undefined });
  } catch (e) {
    fail(e, "recheck");
  }
}

export function dismissRestorePrompt(): void {
  // « Plus tard » : l'envoi reste suspendu ; la pastille continue d'inviter à trancher.
  set({ message: "Sauvegarde en pause : restaurez la sauvegarde du Drive ou repartez à neuf." });
}
