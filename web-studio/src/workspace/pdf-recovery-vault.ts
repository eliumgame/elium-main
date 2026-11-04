/** PDF recovery is part of the vault: drafts AND recomposed source bytes migrate together. */
import { hasVaultSecret, sealBytesAtRest, type VaultSecret } from "../crypto/local-vault";
import { PDF_RECOVERY_SPEC } from "../format/db-specs";
import { openMigrated } from "../format/idb-migrate";
import { resolvePdfDraft, resolvePdfDraftSource, type PdfDraft, type PdfSourceRecord } from "../pdf/model/recovery";
import { markDirty } from "./sync-dirty";

export async function migratePdfRecoveryRecords(
  drafts: PdfDraft[], sources: PdfSourceRecord[], from?: VaultSecret, to?: VaultSecret,
): Promise<{ drafts: PdfDraft[]; sources: PdfSourceRecord[] }> {
  const nextDrafts: PdfDraft[] = [];
  const nextSources = new Map<string, PdfSourceRecord>();
  const migrateSource = async (draft: PdfDraft, source?: PdfSourceRecord) => {
    const bytes = await resolvePdfDraftSource(draft, { stored: source, secret: from });
    if (!bytes) throw new Error("Source de récupération PDF illisible.");
    nextSources.set(draft.id, hasVaultSecret(to)
      ? { id: draft.id, protected: true, sealed: await sealBytesAtRest(bytes, to!) }
      : { id: draft.id, protected: false, bytes });
  };
  for (const draft of drafts) {
    const state = await resolvePdfDraft(draft, from);
    const { state: _s, enc: _e, sealed: _sealed, source: _src, sourceEnc: _se, ...meta } = draft;
    nextDrafts.push(hasVaultSecret(to)
      ? { ...meta, protected: true, sealed: await sealBytesAtRest(new TextEncoder().encode(JSON.stringify({ state })), to!) }
      : { ...meta, protected: false, state });
    if (draft.source || draft.sourceEnc) await migrateSource(draft);
  }
  for (const source of sources) await migrateSource({ id: source.id } as PdfDraft, source);
  return { drafts: nextDrafts, sources: [...nextSources.values()] };
}

export async function reencryptPdfRecovery(from?: VaultSecret, to?: VaultSecret): Promise<void> {
  const db = await openMigrated(PDF_RECOVERY_SPEC);
  try {
    const read = <T>(store: string) => new Promise<T[]>((resolve, reject) => {
      const tx = db.transaction(store, "readonly");
      const req = tx.objectStore(store).getAll();
      tx.oncomplete = () => resolve(req.result as T[]);
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Lecture PDF interrompue."));
    });
    const [drafts, sources] = await Promise.all([read<PdfDraft>("drafts"), read<PdfSourceRecord>("sources")]);
    // Decrypt every record before the first write. A wrong secret leaves both stores intact.
    const next = await migratePdfRecoveryRecords(drafts, sources, from, to);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["drafts", "sources"], "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error ?? new Error("Migration PDF annulée."));
      for (const d of next.drafts) tx.objectStore("drafts").put(d);
      for (const s of next.sources) tx.objectStore("sources").put(s);
    });
    markDirty("brouillons-pdf");
  } finally { db.close(); }
}
