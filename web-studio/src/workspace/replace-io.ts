/**
 * E/S réelles du « rechercher / remplacer dans tout l'espace » : lecture et
 * réécriture des .elium de la bibliothèque (IndexedDB), journal d'annulation.
 */
import type { VaultSecret } from "../crypto/local-vault";
import { WORKSPACE_SPEC } from "../format/db-specs";
import { getDriveDoc, putDriveDoc } from "../format/drive-store";
import { EliumPasswordRequired, EliumRecipientKeyRequired, readEliumPackage, writeEliumPackage } from "../format/elium-package";
import { idbKv } from "./kv";
import { EncryptedDocument, type ParsedDoc, type ReplaceDeps, type UndoRecord } from "./replace";

export function createReplaceDeps(
  getSecret: () => VaultSecret | undefined,
  /** Appelé après chaque réécriture : met à jour la taille et la date de l'élément dans le catalogue. */
  onWritten: (id: string, size: number, savedAt: string) => Promise<void>,
): ReplaceDeps {
  return {
    async read(id) {
      const doc = await getDriveDoc(id, getSecret());
      return doc ? { bytes: doc.bytes, version: doc.savedAt } : undefined;
    },
    async parse(bytes): Promise<ParsedDoc> {
      try {
        const { file } = await readEliumPackage(bytes, {});
        return {
          doc: file.document.doc,
          signed: file.signatures.length > 0,
          sealed: !!file.manifest.seal,
          rewrite: (doc) => writeEliumPackage({ ...file, document: { ...file.document, doc } }, {}),
        };
      } catch (e) {
        if (e instanceof EliumPasswordRequired || e instanceof EliumRecipientKeyRequired) throw new EncryptedDocument("Document chiffré.");
        throw e;
      }
    },
    async write(id, bytes, title) {
      const secret = getSecret();
      const cur = await getDriveDoc(id, secret);
      const savedAt = new Date().toISOString();
      await putDriveDoc({ id, title, profile: cur?.profile ?? "standard", savedAt, size: bytes.length, bytes }, secret);
      await onWritten(id, bytes.length, savedAt);
      return savedAt;
    },
    undo: idbKv<UndoRecord>(WORKSPACE_SPEC, "undo"),
    getSecret,
  };
}
