/**
 * Catalogue de l'espace de travail : lecture/écriture des métadonnées des
 * éléments et des dossiers. Quand le coffre local est actif, titre et étiquettes
 * (resp. nom de dossier) sont chiffrés au repos ; les champs d'organisation
 * (dossier, favori, dates, corbeille) restent en clair pour pouvoir être
 * modifiés sans déchiffrer ni rechiffrer — un déplacement ne coûte donc pas un
 * calcul Argon2 par élément.
 */
import { decryptAtRest, encryptAtRest, hasVaultSecret, type VaultSecret } from "../crypto/local-vault";
import type { KvStore } from "./kv";
import { canMoveFolder, normalizeTags, type TrashPlan } from "./model";
import type { FolderRecord, ItemRecord, WorkFolder, WorkItem } from "./types";

interface ItemMeta {
  title: string;
  tags: string[];
}
interface FolderMeta {
  name: string;
}

export const LOCKED_TITLE = "Élément protégé";
export const LOCKED_FOLDER = "Dossier protégé";

export async function sealItem(item: WorkItem, secret?: VaultSecret): Promise<ItemRecord> {
  const base: ItemRecord = {
    id: item.id,
    kind: item.kind,
    contentStore: item.contentStore,
    size: item.size,
    createdAt: item.createdAt,
    modifiedAt: item.modifiedAt,
    lastOpenedAt: item.lastOpenedAt,
    folderId: item.folderId,
    starred: item.starred,
    trashedAt: item.trashedAt,
    trashedBy: item.trashedBy,
    vaultProtected: false,
    profile: item.profile,
  };
  if (!hasVaultSecret(secret)) return { ...base, title: item.title, tags: item.tags };
  return {
    ...base,
    vaultProtected: true,
    enc: await encryptAtRest({ title: item.title, tags: item.tags } satisfies ItemMeta, secret),
  };
}

export async function openItem(rec: ItemRecord, secret?: VaultSecret): Promise<WorkItem> {
  const shared = {
    id: rec.id,
    kind: rec.kind,
    contentStore: rec.contentStore,
    size: rec.size,
    createdAt: rec.createdAt,
    modifiedAt: rec.modifiedAt,
    lastOpenedAt: rec.lastOpenedAt,
    folderId: rec.folderId ?? null,
    starred: !!rec.starred,
    trashedAt: rec.trashedAt,
    trashedBy: rec.trashedBy,
    vaultProtected: !!rec.vaultProtected,
    profile: rec.profile,
  };
  if (!rec.vaultProtected) return { ...shared, title: rec.title ?? "Sans titre", tags: rec.tags ?? [] };
  if (hasVaultSecret(secret) && rec.enc) {
    try {
      const m = await decryptAtRest<ItemMeta>(rec.enc, secret);
      return { ...shared, title: m.title, tags: m.tags ?? [] };
    } catch {
      /* mot de passe incorrect : repli verrouillé ci-dessous */
    }
  }
  return { ...shared, title: LOCKED_TITLE, tags: [], locked: true };
}

export async function sealFolder(f: WorkFolder, secret?: VaultSecret): Promise<FolderRecord> {
  const base: FolderRecord = {
    id: f.id,
    parentId: f.parentId,
    createdAt: f.createdAt,
    trashedAt: f.trashedAt,
    trashedBy: f.trashedBy,
    vaultProtected: false,
  };
  if (!hasVaultSecret(secret)) return { ...base, name: f.name };
  return { ...base, vaultProtected: true, enc: await encryptAtRest({ name: f.name } satisfies FolderMeta, secret) };
}

export async function openFolder(rec: FolderRecord, secret?: VaultSecret): Promise<WorkFolder> {
  const shared = {
    id: rec.id,
    parentId: rec.parentId ?? null,
    createdAt: rec.createdAt,
    trashedAt: rec.trashedAt,
    trashedBy: rec.trashedBy,
    vaultProtected: !!rec.vaultProtected,
  };
  if (!rec.vaultProtected) return { ...shared, name: rec.name ?? "Dossier" };
  if (hasVaultSecret(secret) && rec.enc) {
    try {
      return { ...shared, name: (await decryptAtRest<FolderMeta>(rec.enc, secret)).name };
    } catch {
      /* repli verrouillé */
    }
  }
  return { ...shared, name: LOCKED_FOLDER, locked: true };
}

/** Champs d'organisation modifiables sans toucher au contenu chiffré. */
export type PlainPatch = Partial<
  Pick<
    WorkItem,
    "size" | "modifiedAt" | "lastOpenedAt" | "folderId" | "starred" | "profile" | "trashedAt" | "trashedBy"
  >
>;

export interface CatalogDeps {
  items: KvStore<ItemRecord>;
  folders: KvStore<FolderRecord>;
  getSecret: () => VaultSecret | undefined;
  now?: () => string;
  newId?: () => string;
}

const defaultNewId = () => {
  const c = globalThis.crypto;
  return c && typeof c.randomUUID === "function"
    ? c.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

function applyPlain<T>(rec: T, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...(rec as object) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete next[k];
    else next[k] = v;
  }
  return next as T;
}

export class Catalog {
  private now: () => string;
  private newId: () => string;
  constructor(private deps: CatalogDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.newId = deps.newId ?? defaultNewId;
  }

  async load(): Promise<{ items: WorkItem[]; folders: WorkFolder[] }> {
    const secret = this.deps.getSecret();
    const [ir, fr] = await Promise.all([this.deps.items.getAll(), this.deps.folders.getAll()]);
    const [items, folders] = await Promise.all([
      Promise.all(ir.map((r) => openItem(r, secret))),
      Promise.all(fr.map((r) => openFolder(r, secret))),
    ]);
    return { items, folders };
  }

  async getItem(id: string): Promise<WorkItem | undefined> {
    const rec = await this.deps.items.get(id);
    return rec ? openItem(rec, this.deps.getSecret()) : undefined;
  }

  async upsertItem(item: WorkItem): Promise<void> {
    await this.deps.items.put(await sealItem(item, this.deps.getSecret()));
  }

  async upsertItems(items: WorkItem[]): Promise<void> {
    const secret = this.deps.getSecret();
    await this.deps.items.putMany(await Promise.all(items.map((i) => sealItem(i, secret))));
  }

  /** Modifie des champs d'organisation (sans déchiffrer). Sans effet si l'élément n'existe pas. */
  async patchItems(ids: string[], patch: PlainPatch): Promise<void> {
    const recs = (await Promise.all(ids.map((id) => this.deps.items.get(id)))).filter((r): r is ItemRecord => !!r);
    await this.deps.items.putMany(recs.map((r) => applyPlain(r, patch as Record<string, unknown>)));
  }

  /** Modifie le titre et/ou les étiquettes (rechiffre si le coffre est actif). */
  async setMeta(id: string, meta: { title?: string; tags?: string[] }): Promise<void> {
    const cur = await this.getItem(id);
    if (!cur || cur.locked) throw new Error("Élément introuvable ou verrouillé (déverrouillez le coffre).");
    await this.upsertItem({
      ...cur,
      title: meta.title !== undefined ? meta.title.trim() || cur.title : cur.title,
      tags: meta.tags !== undefined ? normalizeTags(meta.tags) : cur.tags,
      modifiedAt: cur.modifiedAt,
    });
  }

  /** Applique un plan de corbeille/restauration (champs d'organisation uniquement). */
  async applyPlan(plan: TrashPlan): Promise<void> {
    const ir = await Promise.all([...plan.items.keys()].map((id) => this.deps.items.get(id)));
    const fr = await Promise.all([...plan.folders.keys()].map((id) => this.deps.folders.get(id)));
    await this.deps.items.putMany(
      ir.filter((r): r is ItemRecord => !!r).map((r) => applyPlain(r, plan.items.get(r.id) as Record<string, unknown>)),
    );
    await this.deps.folders.putMany(
      fr
        .filter((r): r is FolderRecord => !!r)
        .map((r) => applyPlain(r, plan.folders.get(r.id) as Record<string, unknown>)),
    );
  }

  async removeItems(ids: string[]): Promise<void> {
    await this.deps.items.deleteMany(ids);
  }

  async createFolder(name: string, parentId: string | null): Promise<WorkFolder> {
    const folder: WorkFolder = {
      id: this.newId(),
      parentId,
      name: name.trim() || "Nouveau dossier",
      createdAt: this.now(),
      vaultProtected: hasVaultSecret(this.deps.getSecret()),
    };
    await this.deps.folders.put(await sealFolder(folder, this.deps.getSecret()));
    return folder;
  }

  /** Écrit un dossier existant tel quel (restauration d'une sauvegarde). */
  async putFolder(folder: WorkFolder): Promise<void> {
    await this.deps.folders.put(await sealFolder(folder, this.deps.getSecret()));
  }

  async renameFolder(id: string, name: string): Promise<void> {
    const rec = await this.deps.folders.get(id);
    if (!rec) return;
    const cur = await openFolder(rec, this.deps.getSecret());
    if (cur.locked) throw new Error("Dossier verrouillé (déverrouillez le coffre).");
    await this.deps.folders.put(await sealFolder({ ...cur, name: name.trim() || cur.name }, this.deps.getSecret()));
  }

  async moveFolder(id: string, target: string | null): Promise<void> {
    const recs = await this.deps.folders.getAll();
    const asFolders = recs.map(
      (r) => ({ id: r.id, parentId: r.parentId ?? null, trashedAt: r.trashedAt }) as WorkFolder,
    );
    const check = canMoveFolder(asFolders, id, target);
    if (!check.ok) {
      throw new Error(
        check.reason === "self" || check.reason === "descendant"
          ? "Impossible de déplacer un dossier dans lui-même ou dans l'un de ses sous-dossiers."
          : "Dossier de destination introuvable.",
      );
    }
    const rec = recs.find((r) => r.id === id)!;
    await this.deps.folders.put({ ...rec, parentId: target });
  }

  async removeFolders(ids: string[]): Promise<void> {
    await this.deps.folders.deleteMany(ids);
  }

  /**
   * Rechiffre tout le catalogue de `from` à `to` (activation / changement /
   * désactivation du coffre). Un seul lot par table : tout ou rien.
   */
  async reencrypt(from: VaultSecret | undefined, to: VaultSecret | undefined): Promise<void> {
    const [ir, fr] = await Promise.all([this.deps.items.getAll(), this.deps.folders.getAll()]);
    const items: ItemRecord[] = [];
    for (const r of ir) {
      if (r.vaultProtected && !hasVaultSecret(from))
        throw new Error("Mot de passe du coffre requis pour rechiffrer l'espace de travail.");
      const it = await openItem(r, from);
      if (it.locked) throw new Error("Mot de passe du coffre incorrect : l'espace de travail n'a pas été rechiffré.");
      items.push(await sealItem(it, to));
    }
    const folders: FolderRecord[] = [];
    for (const r of fr) {
      if (r.vaultProtected && !hasVaultSecret(from))
        throw new Error("Mot de passe du coffre requis pour rechiffrer l'espace de travail.");
      const f = await openFolder(r, from);
      if (f.locked) throw new Error("Mot de passe du coffre incorrect : l'espace de travail n'a pas été rechiffré.");
      folders.push(await sealFolder(f, to));
    }
    await this.deps.items.putMany(items);
    await this.deps.folders.putMany(folders);
  }
}
