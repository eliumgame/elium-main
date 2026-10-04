/**
 * Collecte et restauration d'une sauvegarde de l'espace de travail, avec toutes
 * les E/S injectées (testées en aller-retour sur des magasins en mémoire dans
 * tests/workspace-backup.test.ts) + chiffrement optionnel par mot de passe dans
 * le conteneur Elium existant.
 */
import type { VaultSecret } from "../crypto/local-vault";
import { hasVaultSecret } from "../crypto/local-vault";
import { EliumCryptoEngine } from "../crypto/elium-crypto";
import type { Catalog } from "./catalog";
import {
  SECRET_KEYS,
  SETTINGS_KEYS,
  contentKey,
  decodeBackup,
  encodeBackup,
  pickKeys,
  type BackupManifest,
  type BackupSnapshot,
  type RestorePlan,
} from "./backup";
import type { ContentStoreId, WorkItem } from "./types";

/** Lecture / écriture du contenu BRUT (déchiffré) d'un élément. */
export interface ContentIO {
  read(item: WorkItem): Promise<Uint8Array | undefined>;
  write(item: WorkItem, bytes: Uint8Array): Promise<void>;
}

export interface KeyValueIO {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface BackupDeps {
  catalog: Catalog;
  contents: Record<ContentStoreId, ContentIO>;
  getSecret: () => VaultSecret | undefined;
  storage: KeyValueIO;
  appVersion?: string;
  now?: () => Date;
  /** Copie d'un .elium sous un nouvel identifiant (échoue pour un document chiffré). */
  rewriteDoc?: (bytes: Uint8Array, newId: string, newTitle: string) => Promise<Uint8Array>;
}

export class VaultLockedError extends Error {}

export async function collectSnapshot(deps: BackupDeps, opts: { includeSecrets: boolean }): Promise<BackupSnapshot> {
  const { items, folders } = await deps.catalog.load();
  if (items.some((i) => i.locked) || folders.some((f) => f.locked))
    throw new VaultLockedError(
      "Le coffre local est verrouillé : déverrouillez-le pour sauvegarder l'espace de travail.",
    );
  const contents = new Map<string, Uint8Array>();
  for (const item of items) {
    const bytes = await deps.contents[item.contentStore].read(item);
    if (bytes) contents.set(contentKey(item.contentStore, item.id), bytes);
  }
  const all = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, deps.storage.get(k)]));
  return {
    createdAt: (deps.now?.() ?? new Date()).toISOString(),
    appVersion: deps.appVersion,
    folders,
    items,
    contents,
    settings: pickKeys(all(SETTINGS_KEYS), SETTINGS_KEYS),
    secrets: opts.includeSecrets ? pickKeys(all(SECRET_KEYS), SECRET_KEYS) : {},
  };
}

export interface RestoreReport {
  added: number;
  replaced: number;
  copied: number;
  skipped: number;
  foldersAdded: number;
  settingsApplied: number;
  secretsApplied: number;
  errors: { title: string; message: string }[];
}

export async function restoreSnapshot(
  deps: BackupDeps,
  snap: BackupSnapshot,
  plan: RestorePlan,
  opts: { applySettings: boolean; applySecrets: boolean },
): Promise<RestoreReport> {
  const protectedNow = hasVaultSecret(deps.getSecret());
  const report: RestoreReport = {
    added: 0,
    replaced: 0,
    copied: 0,
    skipped: 0,
    foldersAdded: 0,
    settingsApplied: 0,
    secretsApplied: 0,
    errors: [],
  };
  for (const f of plan.foldersToAdd) {
    await deps.catalog.putFolder({ ...f, vaultProtected: protectedNow });
    report.foldersAdded++;
  }
  const folderOk = new Set([...(await deps.catalog.load()).folders.map((f) => f.id)]);
  for (const a of plan.actions) {
    if (a.action === "skip") {
      report.skipped++;
      continue;
    }
    const src = snap.contents.get(contentKey(a.item.contentStore, a.item.id));
    if (!src) {
      report.skipped++;
      continue;
    }
    try {
      const folderId = a.item.folderId && folderOk.has(a.item.folderId) ? a.item.folderId : null;
      if (a.action === "copy") {
        let bytes = src;
        if (a.item.contentStore === "drive") {
          if (!deps.rewriteDoc) throw new Error("Copie de document indisponible.");
          bytes = await deps.rewriteDoc(src, a.newId!, a.newTitle!);
        }
        const copy: WorkItem = {
          ...a.item,
          id: a.newId!,
          title: a.newTitle!,
          folderId,
          starred: false,
          size: bytes.length,
          vaultProtected: protectedNow,
        };
        await deps.contents[copy.contentStore].write(copy, bytes);
        await deps.catalog.upsertItem(copy);
        report.copied++;
      } else {
        const item: WorkItem = { ...a.item, folderId, size: src.length, vaultProtected: protectedNow };
        await deps.contents[item.contentStore].write(item, src);
        await deps.catalog.upsertItem(item);
        if (a.action === "add") report.added++;
        else report.replaced++;
      }
    } catch (e) {
      report.errors.push({ title: a.item.title, message: e instanceof Error ? e.message : String(e) });
    }
  }
  if (opts.applySettings) {
    for (const [k, v] of Object.entries(snap.settings)) {
      deps.storage.set(k, v);
      report.settingsApplied++;
    }
  }
  if (opts.applySecrets) {
    for (const [k, v] of Object.entries(snap.secrets)) {
      deps.storage.set(k, v);
      report.secretsApplied++;
    }
  }
  return report;
}

// --- Chiffrement optionnel -------------------------------------------------------

export class BackupPasswordRequired extends Error {
  constructor() {
    super("Cette sauvegarde est chiffrée : saisissez son mot de passe.");
  }
}
export class BackupPasswordWrong extends Error {
  constructor() {
    super("Mot de passe incorrect, ou fichier de sauvegarde endommagé.");
  }
}

/** Une archive zip commence par « PK » ; sinon c'est un conteneur Elium chiffré. */
export function isPlainBackup(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
}

export async function packBackup(
  snap: BackupSnapshot,
  opts: { includeSecrets: boolean; password?: string },
): Promise<Uint8Array> {
  const zip = encodeBackup(snap, { includeSecrets: opts.includeSecrets });
  if (!opts.password) return zip;
  return EliumCryptoEngine.encodeContainer(zip, opts.password, "espace.zip");
}

export async function openBackup(
  bytes: Uint8Array,
  password?: string,
): Promise<{ manifest: BackupManifest; snapshot: BackupSnapshot }> {
  if (isPlainBackup(bytes)) return decodeBackup(bytes);
  if (!password) throw new BackupPasswordRequired();
  let payload: Uint8Array;
  try {
    ({ payload } = await EliumCryptoEngine.decodeContainer(bytes, password));
  } catch {
    throw new BackupPasswordWrong();
  }
  return decodeBackup(payload); // une archive illisible lève BackupFormatError, distincte d'un mauvais mot de passe
}
