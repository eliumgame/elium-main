/**
 * Indexation INCRÉMENTALE de l'espace de travail : à chaque synchronisation, ne
 * ré-extrait que les éléments nouveaux ou modifiés (empreinte `rev`), retire
 * ceux qui ont disparu ou sont à la corbeille, et travaille par petits morceaux
 * en rendant la main au navigateur entre deux éléments (pas de gel de l'interface).
 *
 * Persistance (IndexedDB `elium-workspace`, table `search`) :
 *  - sans coffre : un enregistrement par élément (texte en clair — le contenu
 *    de ces éléments est lui-même stocké en clair sur ce poste) ;
 *  - avec coffre : UN SEUL enregistrement chiffré (`enc`) contenant tout l'index.
 *    Le texte n'est donc jamais écrit en clair, et on ne paie qu'un déchiffrement
 *    au démarrage (pas un par élément). Les éléments protégés ne sont indexés
 *    que coffre déverrouillé.
 * L'index est une donnée DÉRIVÉE : changer le mot de passe du coffre ou une
 * lecture impossible le vide et le reconstruit, rien d'autre.
 */
import { decryptAtRest, encryptAtRest, hasVaultSecret, type VaultSecret } from "../../crypto/local-vault";
import type { KvStore } from "../kv";
import type { WorkItem } from "../types";
import { SearchIndex, type IndexEntry } from "./index";

export interface IndexRecord {
  id: string;
  rev?: string;
  title?: string;
  text?: string;
  /** Présent seulement sur l'enregistrement unique du coffre. */
  vaultProtected?: boolean;
  enc?: string;
}

export const VAULT_BUNDLE_ID = "__vault_bundle__";

export const revOf = (item: Pick<WorkItem, "modifiedAt" | "title">): string => `${item.modifiedAt}|${item.title}`;

export interface IndexProgress {
  running: boolean;
  done: number;
  total: number;
}

export interface IndexerDeps {
  store: KvStore<IndexRecord>;
  index: SearchIndex;
  /** Texte indexable de l'élément ("" si rien n'est lisible, ex. document chiffré par son propre mot de passe). */
  extract: (item: WorkItem) => Promise<string>;
  getSecret: () => VaultSecret | undefined;
  /** Rend la main au navigateur (requestIdleCallback / setTimeout). */
  yieldNow: () => Promise<void>;
  onProgress?: (p: IndexProgress) => void;
  onError?: (item: WorkItem, err: unknown) => void;
}

const PERSIST_EVERY = 20;

export class SearchIndexer {
  private generation = 0;
  private loadedWith: "plain" | "vault" | null = null;
  /** Écritures en attente : survivent à une synchronisation interrompue. */
  private dirty = new Map<string, IndexEntry>();
  private gone = new Set<string>();

  constructor(private d: IndexerDeps) {}

  private mode(): "plain" | "vault" {
    return hasVaultSecret(this.d.getSecret()) ? "vault" : "plain";
  }

  /** Recharge l'index persisté en mémoire. Un index illisible est abandonné (il sera reconstruit). */
  async loadPersisted(): Promise<void> {
    this.d.index.clear();
    const records = await this.d.store.getAll();
    const secret = this.d.getSecret();
    const bundle = records.find((r) => r.id === VAULT_BUNDLE_ID);
    if (this.mode() === "vault") {
      if (bundle?.enc && hasVaultSecret(secret)) {
        try {
          const entries = await decryptAtRest<IndexEntry[]>(bundle.enc, secret);
          for (const e of entries) this.d.index.set(e);
        } catch {
          await this.d.store.delete(VAULT_BUNDLE_ID); // mauvais secret / corrompu : on reconstruira
        }
      }
      // Entrées en clair d'avant l'activation du coffre : jamais conservées en clair.
      const plain = records.filter((r) => r.id !== VAULT_BUNDLE_ID);
      if (plain.length) await this.d.store.deleteMany(plain.map((r) => r.id));
    } else {
      if (bundle) await this.d.store.delete(VAULT_BUNDLE_ID); // illisible sans le coffre
      for (const r of records) {
        if (r.id === VAULT_BUNDLE_ID || r.rev === undefined) continue;
        this.d.index.set({ id: r.id, rev: r.rev, title: r.title ?? "", text: r.text ?? "" });
      }
    }
    this.loadedWith = this.mode();
  }

  /** Vide l'index (mémoire et disque) : à appeler quand le coffre change. */
  async reset(): Promise<void> {
    this.generation++;
    this.d.index.clear();
    this.dirty.clear();
    this.gone.clear();
    await this.d.store.clear();
    this.loadedWith = null;
  }

  cancel(): void {
    this.generation++;
  }

  /** Écrit sur disque tout ce qui est en attente (remplacements et suppressions). */
  private async persist(): Promise<void> {
    if (this.mode() === "vault") {
      const secret = this.d.getSecret()!;
      const all: IndexEntry[] = [];
      for (const id of this.d.index.ids()) {
        const e = this.d.index.get(id);
        if (e) all.push(e);
      }
      await this.d.store.put({ id: VAULT_BUNDLE_ID, vaultProtected: true, enc: await encryptAtRest(all, secret) });
    } else {
      if (this.gone.size) await this.d.store.deleteMany([...this.gone]);
      if (this.dirty.size)
        await this.d.store.putMany([...this.dirty.values()].map((e) => ({ id: e.id, rev: e.rev, title: e.title, text: e.text })));
    }
    this.dirty.clear();
    this.gone.clear();
  }

  /**
   * Met l'index à jour pour `items`. Un nouvel appel interrompt le précédent
   * (il reprendra où l'état persisté s'était arrêté).
   */
  async sync(items: WorkItem[]): Promise<void> {
    if (this.loadedWith !== this.mode()) await this.loadPersisted();
    const gen = ++this.generation;
    const live = items.filter((i) => !i.trashedAt && !i.locked);
    const liveIds = new Set(live.map((i) => i.id));
    const removed = this.d.index.ids().filter((id) => !liveIds.has(id));
    for (const id of removed) {
      this.d.index.delete(id);
      this.dirty.delete(id);
      this.gone.add(id);
    }
    const todo = live.filter((i) => this.d.index.revOf(i.id) !== revOf(i));
    if (removed.length || todo.length === 0) await this.persist();
    if (todo.length === 0) {
      this.d.onProgress?.({ running: false, done: 0, total: 0 });
      return;
    }
    let done = 0;
    this.d.onProgress?.({ running: true, done, total: todo.length });
    for (const item of todo) {
      if (gen !== this.generation) return;
      await this.d.yieldNow();
      if (gen !== this.generation) return;
      let text = "";
      try {
        text = await this.d.extract(item);
      } catch (e) {
        this.d.onError?.(item, e); // illisible : titre seul, et on n'insiste pas à chaque synchronisation
      }
      if (gen !== this.generation) return;
      const entry: IndexEntry = { id: item.id, rev: revOf(item), title: item.title, text };
      this.d.index.set(entry);
      this.dirty.set(entry.id, entry);
      this.gone.delete(entry.id);
      done++;
      this.d.onProgress?.({ running: true, done, total: todo.length });
      if (this.dirty.size >= PERSIST_EVERY) await this.persist();
    }
    if (gen === this.generation) {
      await this.persist();
      this.d.onProgress?.({ running: false, done, total: todo.length });
    }
  }
}
