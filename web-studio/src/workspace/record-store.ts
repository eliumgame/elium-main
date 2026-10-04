/**
 * Magasin générique « un élément JSON par clé », chiffré au repos par le coffre
 * local quand il est actif. Sert de base aux classeurs (elium-sheets) et aux
 * présentations (elium-slides) : plusieurs éléments par base, la clé historique
 * « current » restant lisible (migration non destructive, voir legacy-import.ts).
 *
 * Même convention que drafts-store / deck-store : un enregistrement chiffré
 * qu'on ne peut pas déchiffrer LÈVE une erreur (jamais « aucun contenu »), pour
 * que l'autosauvegarde ne l'écrase pas par un contenu vierge.
 */
import { decryptAtRest, encryptAtRest, hasVaultSecret, type VaultSecret } from "../crypto/local-vault";
import type { KvStore } from "./kv";

export interface JsonRecord {
  id: string;
  vaultProtected?: boolean;
  enc?: string;
  updatedAt?: string;
  /** Taille approximative du contenu sérialisé (octets), pour l'affichage. */
  size?: number;
  [field: string]: unknown;
}

export interface JsonStoreOptions {
  /** Nom du champ en clair (« wb », « deck »). */
  field: string;
  /** Message d'erreur quand le contenu est chiffré et qu'aucun secret n'est fourni. */
  lockedMessage: string;
}

export function createJsonStore<T>(kv: KvStore<JsonRecord>, opts: JsonStoreOptions) {
  const { field, lockedMessage } = opts;

  /** Résout un enregistrement (pur hors déchiffrement). Lève s'il est chiffré et indéchiffrable. */
  async function resolve(rec: JsonRecord | undefined, secret?: VaultSecret): Promise<T | undefined> {
    if (!rec) return undefined;
    if (!rec.vaultProtected) return rec[field] as T | undefined; // y compris l'ancien format d'avant le coffre
    if (!hasVaultSecret(secret) || !rec.enc) throw new Error(lockedMessage);
    return decryptAtRest<T>(rec.enc, secret);
  }

  async function build(id: string, value: T, secret: VaultSecret | undefined, now: string): Promise<JsonRecord> {
    const size = JSON.stringify(value).length;
    return hasVaultSecret(secret)
      ? { id, vaultProtected: true, enc: await encryptAtRest(value, secret), updatedAt: now, size }
      : { id, vaultProtected: false, [field]: value, updatedAt: now, size };
  }

  return {
    resolve,
    build,
    async load(id: string, secret?: VaultSecret): Promise<T | undefined> {
      return resolve(await kv.get(id), secret);
    },
    async save(id: string, value: T, secret?: VaultSecret, now = new Date().toISOString()): Promise<void> {
      await kv.put(await build(id, value, secret, now));
    },
    keys: () => kv.keys(),
    async info(id: string): Promise<{ size: number; updatedAt?: string } | undefined> {
      const r = await kv.get(id);
      return r ? { size: r.size ?? (r.enc ? r.enc.length : 0), updatedAt: r.updatedAt } : undefined;
    },
    /** Copie brute (sans déchiffrer) sous une nouvelle clé. */
    async copy(from: string, to: string, now = new Date().toISOString()): Promise<void> {
      const r = await kv.get(from);
      if (!r) throw new Error("Contenu introuvable.");
      await kv.put({ ...r, id: to, updatedAt: now });
    },
    /** Déplacement atomique côté données : écrit sous la nouvelle clé PUIS retire l'ancienne. */
    async move(from: string, to: string): Promise<boolean> {
      const r = await kv.get(from);
      if (!r) return false;
      await kv.put({ ...r, id: to });
      await kv.delete(from);
      return true;
    },
    remove: (id: string) => kv.delete(id),
    removeMany: (ids: string[]) => kv.deleteMany(ids),
    /**
     * Rechiffre chaque enregistrement de `from` à `to` (coffre activé/changé/
     * désactivé) dans UNE transaction. Les enregistrements chiffrés exigent `from`.
     */
    async reencrypt(from: VaultSecret | undefined, to: VaultSecret | undefined): Promise<void> {
      const all = await kv.getAll();
      const next: JsonRecord[] = [];
      for (const r of all) {
        const value = await resolve(r, from);
        if (value === undefined) continue;
        next.push(await build(r.id, value, to, r.updatedAt ?? new Date().toISOString()));
      }
      if (next.length) await kv.putMany(next);
    },
  };
}

export type JsonStore<T> = ReturnType<typeof createJsonStore<T>>;
