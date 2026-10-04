/**
 * Service de l'espace de travail : orchestre le catalogue (métadonnées) et les
 * magasins de contenu. Toutes les dépendances sont injectées, de sorte que la
 * logique (création, doublon, corbeille, suppression définitive, purge
 * automatique, réconciliation, import de l'ancien « current ») est testée avec
 * des magasins en mémoire.
 */
import type { VaultSecret } from "../crypto/local-vault";
import { Catalog } from "./catalog";
import {
  copyName,
  expiredTrash,
  kindOfStore,
  normalizeTags,
  planRestore,
  planTrash,
  reconcile,
  storeOfKind,
  uniqueName,
} from "./model";
import type { ContentStoreId, ItemKind, WorkFolder, WorkItem } from "./types";

export interface ContentApi {
  keys(): Promise<string[]>;
  info(id: string): Promise<{ size: number; updatedAt?: string } | undefined>;
  remove(ids: string[]): Promise<void>;
  /** Copie brute sous une nouvelle clé. Absent pour le magasin de documents (voir `duplicateDoc`). */
  copy?(from: string, to: string): Promise<void>;
}

/** Contenu d'un ancien magasin à un seul élément (« current »). */
export interface LegacySlot {
  store: ContentStoreId;
  /** Clé historique. */
  legacyId: string;
  title: string;
  /** Charge le contenu pour savoir s'il est vierge ; lève s'il est chiffré et indéchiffrable. */
  isPristine(secret: VaultSecret | undefined): Promise<boolean>;
  /** Déplace l'enregistrement brut sous la nouvelle clé (atomique côté données). */
  move(from: string, to: string): Promise<boolean>;
}

export interface UntrackedDoc {
  id: string;
  title: string;
  profile?: string;
  size: number;
  savedAt: string;
  vaultProtected: boolean;
  kind?: ItemKind;
}

export interface ServiceDeps {
  catalog: Catalog;
  contents: Record<ContentStoreId, ContentApi>;
  getSecret: () => VaultSecret | undefined;
  /** Dossier courant de l'interface : destination des nouveaux éléments. */
  getCurrentFolder?: () => string | null;
  /** Duplique un .elium de la bibliothèque (nouvel identifiant interne + titre) ; renvoie la taille. */
  duplicateDoc?: (id: string, newId: string, newTitle: string) => Promise<{ size: number }>;
  /** Décrit les documents de la bibliothèque absents du catalogue (dossier d'avant l'espace de travail). */
  describeUntrackedDocs?: (ids: string[]) => Promise<UntrackedDoc[]>;
  /** Données annexes à effacer avec l'élément (brouillons, versions, index…). Meilleur effort. */
  purgeSideData?: (items: WorkItem[]) => Promise<void>;
  legacySlots?: LegacySlot[];
  now?: () => Date;
  newId?: () => string;
}

const defaultNewId = () => {
  const c = globalThis.crypto;
  return c && typeof c.randomUUID === "function"
    ? c.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
};

export const DEFAULT_TITLES: Record<ItemKind, string> = {
  doc: "Document sans titre",
  sheet: "Classeur sans titre",
  slides: "Présentation sans titre",
  pdf: "Document PDF",
};

export interface RegisterInput {
  id: string;
  kind: ItemKind;
  title?: string;
  size: number;
  profile?: string;
  /** Pour un NOUVEL élément seulement. Défaut : dossier courant. */
  folderId?: string | null;
}

export class WorkspaceService {
  private now: () => Date;
  private newId: () => string;
  constructor(private d: ServiceDeps) {
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? defaultNewId;
  }

  private iso() {
    return this.now().toISOString();
  }

  newItemId(): string {
    return this.newId();
  }

  load() {
    return this.d.catalog.load();
  }

  /**
   * Un contenu vient d'être enregistré : crée l'élément s'il est nouveau,
   * sinon met à jour sa taille et sa date. Le titre n'est repris que pour un nouvel élément
   * (un renommage de l'utilisateur ne doit jamais être écrasé par l'éditeur).
   */
  async registerSaved(input: RegisterInput, options: { updateTitle?: boolean } = {}): Promise<WorkItem> {
    const store = storeOfKind(input.kind);
    const existing = await this.d.catalog.getItem(input.id);
    const now = this.iso();
    if (existing) {
      if (options.updateTitle && input.title && !existing.locked && input.title !== existing.title) {
        await this.d.catalog.setMeta(input.id, { title: input.title });
      }
      await this.d.catalog.patchItems([input.id], {
        size: input.size,
        modifiedAt: now,
        profile: input.profile ?? existing.profile,
        // Un élément enregistré de nouveau sort de la corbeille s'il y était.
        trashedAt: undefined,
        trashedBy: undefined,
      });
      return { ...existing, size: input.size, modifiedAt: now, trashedAt: undefined, trashedBy: undefined };
    }
    const { items, folders } = await this.d.catalog.load();
    const folderId = this.liveFolder(
      folders,
      input.folderId === undefined ? (this.d.getCurrentFolder?.() ?? null) : input.folderId,
    );
    const siblings = items.filter((i) => !i.trashedAt && i.folderId === folderId).map((i) => i.title);
    const item: WorkItem = {
      id: input.id,
      kind: input.kind,
      contentStore: store,
      title: uniqueName(input.title?.trim() || DEFAULT_TITLES[input.kind], siblings),
      size: input.size,
      createdAt: now,
      modifiedAt: now,
      folderId,
      tags: [],
      starred: false,
      vaultProtected: !!this.d.getSecret(),
      profile: input.profile,
    };
    await this.d.catalog.upsertItem(item);
    return item;
  }

  private liveFolder(folders: WorkFolder[], id: string | null): string | null {
    if (id === null) return null;
    const f = folders.find((x) => x.id === id);
    return f && !f.trashedAt ? id : null;
  }

  async touchOpened(id: string): Promise<void> {
    await this.d.catalog.patchItems([id], { lastOpenedAt: this.iso() });
  }

  async rename(id: string, title: string): Promise<void> {
    await this.d.catalog.setMeta(id, { title });
  }

  async setTags(id: string, tags: string[]): Promise<void> {
    await this.d.catalog.setMeta(id, { tags: normalizeTags(tags) });
  }

  async addTag(ids: string[], tag: string): Promise<void> {
    const { items } = await this.d.catalog.load();
    for (const id of ids) {
      const it = items.find((i) => i.id === id);
      if (it && !it.locked) await this.d.catalog.setMeta(id, { tags: [...it.tags, tag] });
    }
  }

  async removeTag(ids: string[], tag: string): Promise<void> {
    const { items } = await this.d.catalog.load();
    for (const id of ids) {
      const it = items.find((i) => i.id === id);
      if (it && !it.locked) await this.d.catalog.setMeta(id, { tags: it.tags.filter((t) => t !== tag) });
    }
  }

  async setStarred(ids: string[], starred: boolean): Promise<void> {
    await this.d.catalog.patchItems(ids, { starred });
  }

  async moveItems(ids: string[], folderId: string | null): Promise<void> {
    if (folderId !== null) {
      const { folders } = await this.d.catalog.load();
      if (this.liveFolder(folders, folderId) === null) throw new Error("Dossier de destination introuvable.");
    }
    await this.d.catalog.patchItems(ids, { folderId });
  }

  async createFolder(name: string, parentId: string | null): Promise<WorkFolder> {
    const { folders } = await this.d.catalog.load();
    const siblings = folders.filter((f) => !f.trashedAt && f.parentId === parentId).map((f) => f.name);
    return this.d.catalog.createFolder(uniqueName(name, siblings), parentId);
  }

  renameFolder(id: string, name: string) {
    return this.d.catalog.renameFolder(id, name);
  }

  moveFolder(id: string, target: string | null) {
    return this.d.catalog.moveFolder(id, target);
  }

  // --- Doublons -----------------------------------------------------------

  async duplicate(ids: string[]): Promise<WorkItem[]> {
    const { items } = await this.d.catalog.load();
    const out: WorkItem[] = [];
    for (const id of ids) {
      const src = items.find((i) => i.id === id);
      if (!src || src.locked) continue;
      const siblings = [...items, ...out]
        .filter((i) => !i.trashedAt && i.folderId === src.folderId)
        .map((i) => i.title);
      const title = copyName(src.title, siblings);
      const newId = this.newId();
      let size = src.size;
      if (src.contentStore === "drive") {
        if (!this.d.duplicateDoc) throw new Error("La duplication de documents n'est pas disponible.");
        size = (await this.d.duplicateDoc(src.id, newId, title)).size;
      } else {
        const api = this.d.contents[src.contentStore];
        if (!api.copy) throw new Error("La duplication n'est pas disponible pour ce type d'élément.");
        await api.copy(src.id, newId);
      }
      const now = this.iso();
      const copy: WorkItem = {
        ...src,
        id: newId,
        title,
        size,
        createdAt: now,
        modifiedAt: now,
        lastOpenedAt: undefined,
        trashedAt: undefined,
        trashedBy: undefined,
        starred: false,
      };
      await this.d.catalog.upsertItem(copy);
      out.push(copy);
    }
    return out;
  }

  // --- Corbeille ----------------------------------------------------------

  async trash(sel: { itemIds?: string[]; folderIds?: string[] }): Promise<void> {
    const { items, folders } = await this.d.catalog.load();
    await this.d.catalog.applyPlan(planTrash(items, folders, sel, this.iso()));
  }

  async restore(sel: { itemIds?: string[]; folderIds?: string[] }): Promise<void> {
    const { items, folders } = await this.d.catalog.load();
    await this.d.catalog.applyPlan(planRestore(items, folders, sel));
  }

  /** Suppression DÉFINITIVE : contenu, données annexes (index, brouillons…) puis catalogue. */
  private async eraseItems(items: WorkItem[]): Promise<void> {
    if (items.length === 0) return;
    const byStore = new Map<ContentStoreId, string[]>();
    for (const it of items) byStore.set(it.contentStore, [...(byStore.get(it.contentStore) ?? []), it.id]);
    // Contenu d'abord : si l'effacement échoue, le catalogue garde l'élément (réessayable) au lieu d'un contenu orphelin invisible.
    for (const [store, ids] of byStore) await this.d.contents[store].remove(ids);
    await this.d.purgeSideData?.(items).catch(() => undefined);
    await this.d.catalog.removeItems(items.map((i) => i.id));
  }

  async deleteForever(sel: { itemIds?: string[]; folderIds?: string[] }): Promise<void> {
    const { items, folders } = await this.d.catalog.load();
    const folderIds = new Set(sel.folderIds ?? []);
    const itemSet = new Set(sel.itemIds ?? []);
    // Supprimer un dossier de la corbeille supprime ce qui est parti avec lui.
    for (const f of folders) if (f.trashedBy && folderIds.has(f.trashedBy)) folderIds.add(f.id);
    for (const i of items)
      if ((i.trashedBy && folderIds.has(i.trashedBy)) || (i.trashedAt && i.folderId && folderIds.has(i.folderId)))
        itemSet.add(i.id);
    await this.eraseItems(items.filter((i) => itemSet.has(i.id) && i.trashedAt));
    await this.d.catalog.removeFolders(folders.filter((f) => folderIds.has(f.id) && f.trashedAt).map((f) => f.id));
  }

  async emptyTrash(): Promise<number> {
    const { items, folders } = await this.d.catalog.load();
    const itemIds = items.filter((i) => i.trashedAt).map((i) => i.id);
    const folderIds = folders.filter((f) => f.trashedAt).map((f) => f.id);
    await this.deleteForever({ itemIds, folderIds });
    return itemIds.length + folderIds.length;
  }

  /** Supprime ce qui dépasse la rétention (30 jours). Renvoie le nombre d'éléments purgés. */
  async purgeExpired(): Promise<number> {
    const { items, folders } = await this.d.catalog.load();
    const exp = expiredTrash(items, folders, this.now());
    if (exp.itemIds.length === 0 && exp.folderIds.length === 0) return 0;
    await this.deleteForever(exp);
    return exp.itemIds.length;
  }

  // --- Cohérence et import de l'ancien « current » -----------------------

  /**
   * Premier lancement avec l'espace de travail : l'ancien classeur / l'ancienne
   * présentation unique devient le premier élément (déplacement de
   * l'enregistrement brut, sans déchiffrement ni recopie). Un contenu vierge
   * (jamais modifié) est simplement retiré. Idempotent : sans « current », rien à faire.
   */
  async importLegacy(): Promise<{ imported: number; locked: number }> {
    let imported = 0;
    let locked = 0;
    for (const slot of this.d.legacySlots ?? []) {
      const keys = await this.d.contents[slot.store].keys();
      if (!keys.includes(slot.legacyId)) continue;
      let pristine: boolean;
      try {
        pristine = await slot.isPristine(this.d.getSecret());
      } catch {
        locked++; // chiffré, coffre non déverrouillé : on réessaiera à la prochaine ouverture
        continue;
      }
      if (pristine) {
        await this.d.contents[slot.store].remove([slot.legacyId]);
        continue;
      }
      const id = this.newId();
      if (!(await slot.move(slot.legacyId, id))) continue;
      const info = await this.d.contents[slot.store].info(id);
      const now = this.iso();
      await this.d.catalog.upsertItem({
        id,
        kind: kindOfStore(slot.store),
        contentStore: slot.store,
        title: slot.title,
        size: info?.size ?? 0,
        createdAt: info?.updatedAt ?? now,
        modifiedAt: info?.updatedAt ?? now,
        folderId: null,
        tags: [],
        starred: false,
        vaultProtected: !!this.d.getSecret(),
      });
      imported++;
    }
    return { imported, locked };
  }

  /**
   * Aligne le catalogue sur les contenus réellement présents :
   *  - un élément dont le contenu a disparu (coffre réinitialisé…) est retiré ;
   *  - un document de la bibliothèque absent du catalogue (ajouté avant
   *    l'espace de travail) y est inscrit à la racine.
   */
  async reconcile(): Promise<{ removed: number; added: number }> {
    const { items } = await this.d.catalog.load();
    const keys = {} as Record<ContentStoreId, string[]>;
    for (const store of Object.keys(this.d.contents) as ContentStoreId[])
      keys[store] = await this.d.contents[store].keys();
    const legacy = new Set((this.d.legacySlots ?? []).map((s) => `${s.store}:${s.legacyId}`));
    const rec = reconcile(items, keys);
    // Un élément verrouillé n'est jamais retiré sur la foi d'un contenu manquant incertain : seul le contenu absent compte.
    if (rec.orphanItemIds.length) await this.d.catalog.removeItems(rec.orphanItemIds);
    let added = 0;
    const untrackedDocs = rec.untracked.filter((u) => u.store === "drive").map((u) => u.id);
    if (untrackedDocs.length && this.d.describeUntrackedDocs) {
      const described = await this.d.describeUntrackedDocs(untrackedDocs);
      const taken = items.filter((i) => !i.trashedAt && i.folderId === null).map((i) => i.title);
      const fresh: WorkItem[] = [];
      for (const doc of described) {
        const title = uniqueName(doc.title, [...taken, ...fresh.map((f) => f.title)]);
        fresh.push({
          id: doc.id,
          kind: doc.kind ?? "doc",
          contentStore: "drive",
          title,
          size: doc.size,
          createdAt: doc.savedAt,
          modifiedAt: doc.savedAt,
          folderId: null,
          tags: [],
          starred: false,
          vaultProtected: !!this.d.getSecret(),
          profile: doc.profile,
        });
      }
      if (fresh.length) {
        await this.d.catalog.upsertItems(fresh);
        added += fresh.length;
      }
    }
    // Contenus de feuilles/présentations/PDF sans élément (hors ancien « current ») : inscrits à la racine.
    const strays = rec.untracked.filter((u) => u.store !== "drive" && !legacy.has(`${u.store}:${u.id}`));
    if (strays.length) {
      const now = this.iso();
      const fresh: WorkItem[] = [];
      for (const s of strays) {
        const info = await this.d.contents[s.store].info(s.id);
        const kind = kindOfStore(s.store);
        fresh.push({
          id: s.id,
          kind,
          contentStore: s.store,
          title: uniqueName(DEFAULT_TITLES[kind], [...items.map((i) => i.title), ...fresh.map((f) => f.title)]),
          size: info?.size ?? 0,
          createdAt: info?.updatedAt ?? now,
          modifiedAt: info?.updatedAt ?? now,
          folderId: null,
          tags: [],
          starred: false,
          vaultProtected: !!this.d.getSecret(),
        });
      }
      await this.d.catalog.upsertItems(fresh);
      added += fresh.length;
    }
    return { removed: rec.orphanItemIds.length, added };
  }

  /** Rechiffre catalogue et contenus (coffre activé / changé / désactivé). */
  async reencryptCatalog(from: VaultSecret | undefined, to: VaultSecret | undefined): Promise<void> {
    await this.d.catalog.reencrypt(from, to);
  }
}
