/**
 * Indexation INCRÉMENTALE de l'espace de travail : à chaque synchronisation, ne
 * ré-extrait que les éléments nouveaux ou modifiés (empreinte `rev`), retire
 * ceux qui ont disparu ou sont à la corbeille, et travaille par petits morceaux
 * en rendant la main au navigateur entre deux éléments (pas de gel de l'interface).
 *
 * Persistance (IndexedDB `elium-workspace`, table `search`) :
 *  - sans coffre : un enregistrement par élément (texte en clair — le contenu
 *    de ces éléments est lui-même stocké en clair sur ce poste) ;
 *  - avec coffre : un enregistrement SCELLÉ par élément (`sealed`, AES-GCM, clé Argon2id
 *    dérivée une fois par session). Le texte n'est jamais écrit en clair, et chaque
 *    modification ne ré-encrypte que les éléments touchés (l'ancien format — un seul
 *    enregistrement `enc` pour tout l'index — est relu puis migré). Les éléments
 *    protégés ne sont indexés que coffre déverrouillé.
 * L'index est une donnée DÉRIVÉE : changer le mot de passe du coffre ou une
 * lecture impossible le vide et le reconstruit, rien d'autre.
 */
import {
  decryptAtRest,
  hasVaultSecret,
  openSealedBytes,
  sealBytesAtRest,
  type SealedBytes,
  type VaultSecret,
} from "../../crypto/local-vault";
import type { KvStore } from "../kv";
import type { WorkItem } from "../types";
import { SearchIndex, type IndexEntry } from "./index";

export interface IndexRecord {
  id: string;
  rev?: string;
  title?: string;
  text?: string;
  /** Enregistrement du coffre (scellé par élément, ou ancien paquet unique `enc`). */
  vaultProtected?: boolean;
  /** Ancien format : tout l'index chiffré dans un seul enregistrement (`VAULT_BUNDLE_ID`). */
  enc?: string;
  /** Entrée d'index scellée (JSON de `{ rev, title, text }`). */
  sealed?: SealedBytes;
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
/** Durée maximale (ms) de repliage de texte avant de rendre la main au navigateur lors du chargement. */
const LOAD_SLICE_MS = 8;

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
    // Remplissage de l'index par tranches : replier le texte de centaines d'éléments d'un bloc figeait l'interface.
    let last = performance.now();
    const set = async (e: IndexEntry) => {
      this.d.index.set(e);
      if (performance.now() - last >= LOAD_SLICE_MS) {
        await this.d.yieldNow();
        last = performance.now();
      }
    };
    if (this.mode() === "vault") {
      const stale: string[] = [];
      if (hasVaultSecret(secret)) {
        for (const r of records) {
          if (r.id === VAULT_BUNDLE_ID || !r.sealed) continue;
          try {
            const body = JSON.parse(new TextDecoder().decode(await openSealedBytes(r.sealed, secret))) as {
              rev: string;
              title: string;
              text: string;
            };
            await set({ id: r.id, rev: body.rev, title: body.title, text: body.text });
          } catch {
            stale.push(r.id); // mauvais secret / corrompu : supprimé, il sera reconstruit
          }
        }
        // Ancien paquet unique : relu, puis migré vers des enregistrements par élément.
        if (bundle?.enc) {
          try {
            const entries = await decryptAtRest<IndexEntry[]>(bundle.enc, secret);
            for (const e of entries) {
              await set(e);
              this.dirty.set(e.id, e);
            }
          } catch {
            /* paquet illisible : abandonné (supprimé plus bas), l'index sera reconstruit */
          }
        }
      }
      if (bundle && this.dirty.size === 0) stale.push(VAULT_BUNDLE_ID); // illisible ou vide : abandonné
      // Entrées en clair d'avant l'activation du coffre : jamais conservées en clair.
      for (const r of records) if (r.id !== VAULT_BUNDLE_ID && !r.sealed) stale.push(r.id);
      if (stale.length) await this.d.store.deleteMany([...new Set(stale)]);
      if (this.dirty.size) await this.persist(); // migration : l'ancien paquet est supprimé à la fin de persist()
    } else {
      const stale = records.filter((r) => r.sealed || r.id === VAULT_BUNDLE_ID).map((r) => r.id); // illisibles sans le coffre
      if (stale.length) await this.d.store.deleteMany(stale);
      for (const r of records) {
        if (r.sealed || r.id === VAULT_BUNDLE_ID || r.rev === undefined) continue;
        await set({ id: r.id, rev: r.rev, title: r.title ?? "", text: r.text ?? "" });
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
    if (this.gone.size) await this.d.store.deleteMany([...this.gone]);
    if (this.dirty.size) {
      if (this.mode() === "vault") {
        const secret = this.d.getSecret()!;
        const enc = new TextEncoder();
        const records: IndexRecord[] = [];
        for (const e of this.dirty.values()) {
          const body = enc.encode(JSON.stringify({ rev: e.rev, title: e.title, text: e.text }));
          records.push({ id: e.id, vaultProtected: true, sealed: await sealBytesAtRest(body, secret) });
        }
        await this.d.store.putMany(records);
        // L'ancien paquet unique (chiffré avec le même secret) est devenu redondant.
        await this.d.store.delete(VAULT_BUNDLE_ID);
      } else {
        await this.d.store.putMany(
          [...this.dirty.values()].map((e) => ({ id: e.id, rev: e.rev, title: e.title, text: e.text })),
        );
      }
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
