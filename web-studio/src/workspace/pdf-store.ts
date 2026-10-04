/**
 * Bibliothèque locale de PDF (IndexedDB `elium-pdfs`). Un enregistrement par PDF :
 * les octets du fichier (modifications incrémentales comprises) et son nom.
 * Avec le coffre local actif, le nom et les octets sont chiffrés au repos.
 *
 * Le module PDF enregistre ici par une destination d'enregistrement
 * (`libraryDestination`, voir pdf-library.ts), exactement comme il écrit dans
 * un fichier du disque ou dans le Drive.
 */
import {
  decryptAtRest,
  decryptBytesAtRest,
  encryptAtRest,
  encryptBytesAtRest,
  hasVaultSecret,
  type VaultSecret,
} from "../crypto/local-vault";
import { PDFS_SPEC } from "../format/db-specs";
import { idbKv, type KvStore } from "./kv";

export interface PdfRecord {
  id: string;
  vaultProtected: boolean;
  size: number;
  updatedAt: string;
  name?: string; // clair — hors coffre
  bytes?: Uint8Array; // clair — hors coffre
  enc?: string; // { name } chiffré
  encBytes?: string; // octets chiffrés
}

export interface StoredPdf {
  id: string;
  name: string;
  bytes: Uint8Array;
  updatedAt: string;
}

export async function buildPdfRecord(
  input: { id: string; name: string; bytes: Uint8Array },
  secret: VaultSecret | undefined,
  now: string,
): Promise<PdfRecord> {
  if (!hasVaultSecret(secret))
    return {
      id: input.id,
      vaultProtected: false,
      size: input.bytes.length,
      updatedAt: now,
      name: input.name,
      bytes: input.bytes,
    };
  return {
    id: input.id,
    vaultProtected: true,
    size: input.bytes.length,
    updatedAt: now,
    enc: await encryptAtRest({ name: input.name }, secret),
    encBytes: await encryptBytesAtRest(input.bytes, secret),
  };
}

/** Résout un enregistrement ; lève s'il est chiffré et que le coffre n'est pas déverrouillé. */
export async function resolvePdfRecord(rec: PdfRecord, secret?: VaultSecret): Promise<StoredPdf> {
  if (!rec.vaultProtected) {
    if (!rec.bytes) throw new Error("PDF vide.");
    return { id: rec.id, name: rec.name ?? "document.pdf", bytes: rec.bytes, updatedAt: rec.updatedAt };
  }
  if (!hasVaultSecret(secret) || !rec.enc || !rec.encBytes)
    throw new Error("Ce PDF est chiffré par le coffre local — déverrouillez-le d'abord.");
  const { name } = await decryptAtRest<{ name: string }>(rec.enc, secret);
  return { id: rec.id, name, bytes: await decryptBytesAtRest(rec.encBytes, secret), updatedAt: rec.updatedAt };
}

export function createPdfStore(kv: KvStore<PdfRecord>) {
  return {
    async put(
      input: { id: string; name: string; bytes: Uint8Array },
      secret?: VaultSecret,
      now = new Date().toISOString(),
    ) {
      await kv.put(await buildPdfRecord(input, secret, now));
    },
    async get(id: string, secret?: VaultSecret): Promise<StoredPdf | undefined> {
      const rec = await kv.get(id);
      return rec ? resolvePdfRecord(rec, secret) : undefined;
    },
    keys: () => kv.keys(),
    async info(id: string) {
      const r = await kv.get(id);
      return r ? { size: r.size, updatedAt: r.updatedAt } : undefined;
    },
    async copy(from: string, to: string, now = new Date().toISOString()) {
      const r = await kv.get(from);
      if (!r) throw new Error("Contenu introuvable.");
      await kv.put({ ...r, id: to, updatedAt: now });
    },
    remove: (id: string) => kv.delete(id),
    removeMany: (ids: string[]) => kv.deleteMany(ids),
    /** Rechiffre toute la bibliothèque de `from` à `to`, dans une seule transaction. */
    async reencrypt(from: VaultSecret | undefined, to: VaultSecret | undefined) {
      const all = await kv.getAll();
      const next: PdfRecord[] = [];
      for (const r of all) {
        const plain = await resolvePdfRecord(r, from);
        next.push(await buildPdfRecord(plain, to, r.updatedAt));
      }
      if (next.length) await kv.putMany(next);
    },
  };
}

export type PdfStore = ReturnType<typeof createPdfStore>;

export const pdfStore: PdfStore = createPdfStore(idbKv<PdfRecord>(PDFS_SPEC, "files"));
