/** Adaptateur du moteur de sauvegarde incrémentale (workspace/drive-sync.ts) sur les opérations réelles du Drive. */
import { LEGACY_FILE, SYNC_FOLDER, type RemoteEntry, type SyncRemote, type SyncState } from "../workspace/drive-sync";
import { emptyState } from "../workspace/drive-sync";
import {
  decryptEntries,
  downloadFile,
  listFolder,
  renameNode,
  saveNewVersion,
  uploadFile,
  type DriveEntry,
  type OpsCtx,
} from "./ops";
import { ensureRootFolder } from "./named-file";

const stateKey = (w: Pick<OpsCtx, "userId" | "orgId">) => `elium_drive_sync_v1:${w.userId}:${w.orgId}`;

/** État de synchronisation local (par compte et organisation) : perdu avec les données du navigateur → réconciliation. */
export function localSyncStore(w: Pick<OpsCtx, "userId" | "orgId">) {
  return {
    load(): SyncState {
      try {
        const raw = localStorage.getItem(stateKey(w));
        const v = raw ? (JSON.parse(raw) as SyncState) : null;
        return v && v.v === 1 ? v : emptyState();
      } catch {
        return emptyState();
      }
    },
    save(s: SyncState): void {
      try {
        localStorage.setItem(stateKey(w), JSON.stringify(s));
      } catch {
        /* stockage plein : l'état reste celui de la session */
      }
    },
  };
}

const toRemote = (e: { id: string; name: string; modifiedAt: string }): RemoteEntry => ({
  id: e.id,
  name: e.name,
  modifiedAt: e.modifiedAt,
});

export function opsRemote(ctx: OpsCtx): SyncRemote {
  const known = new Map<string, DriveEntry>();
  const find = async (): Promise<string | null> => {
    const roots = await listFolder(ctx, null);
    return roots.find((e) => e.kind === "folder" && e.name === SYNC_FOLDER && !e.trashedAt)?.id ?? null;
  };
  return {
    findFolder: find,
    ensureFolder: () => ensureRootFolder(ctx, SYNC_FOLDER),
    async list(folderId) {
      const entries = await listFolder(ctx, folderId);
      const files = entries.filter((e) => e.kind === "file" && !e.trashedAt);
      for (const e of files) known.set(e.id, e);
      return files.map(toRemote);
    },
    async upload(folderId, name, bytes) {
      const node = await uploadFile(ctx, folderId, new File([bytes as BlobPart], name));
      return { id: node.id, name, modifiedAt: node.modifiedAt };
    },
    async update(nodeId, bytes) {
      const node = await saveNewVersion(ctx, nodeId, bytes, { force: true });
      return { id: node.id, name: known.get(nodeId)?.name ?? "", modifiedAt: node.modifiedAt };
    },
    async rename(nodeId, name) {
      const e = known.get(nodeId);
      if (e) await renameNode(ctx, e, name);
    },
    async download(entry) {
      let e = known.get(entry.id);
      if (!e) {
        // Nœud non listé par cette instance (contexte de session recréé) : relu avec ses clés.
        const { node, myWrappedKey } = await ctx.api.getNode(entry.id);
        e = (await decryptEntries(ctx, [{ ...node, myWrappedKey }]))[0];
        if (!e) throw new Error("Fichier de sauvegarde introuvable dans le Drive.");
        known.set(entry.id, e);
      }
      return (await downloadFile(ctx, e)).bytes;
    },
    async findLegacy() {
      const roots = await listFolder(ctx, null);
      const e = roots.find((x) => x.kind === "file" && x.name === LEGACY_FILE && !x.trashedAt);
      if (e) known.set(e.id, e);
      return e ? toRemote(e) : null;
    },
  };
}
