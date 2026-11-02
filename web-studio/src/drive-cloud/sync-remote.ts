/** Adaptateur du moteur de sauvegarde incrémentale (workspace/drive-sync.ts) sur les opérations réelles du Drive. */
import { LEGACY_FILE, SYNC_FOLDER, type RemoteEntry, type SyncRemote, type SyncState } from "../workspace/drive-sync";
import { emptyState } from "../workspace/drive-sync";
import { ApiError } from "./api";
import { backupFolderCandidates, ownedBy, sharesArePrivate, type ShareRow } from "../workspace/sync-guard";
import {
  createFolder,
  decryptEntries,
  downloadFile,
  listFolder,
  renameNode,
  saveNewVersion,
  uploadFile,
  type DriveEntry,
  type OpsCtx,
} from "./ops";

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
  // Dossiers déjà contrôlés (évite deux requêtes à chaque envoi) : revérifiés toutes les 10 minutes.
  const verified = new Map<string, number>();
  const RECHECK_MS = 10 * 60_000;
  /** Partagé seulement avec le compte et son organisation (droits insuffisants pour lister : propriétaire suffit). */
  const isPrivate = async (folderId: string): Promise<boolean> => {
    try {
      const { shares } = await ctx.api.listShares(folderId);
      return sharesArePrivate(shares as ShareRow[], ctx.userId, ctx.orgId);
    } catch {
      return true;
    }
  };
  // Le dossier est retrouvé par son nom MAIS n'est retenu que s'il a été créé par le compte et reste privé :
  // un autre membre peut créer et partager un dossier de même nom (injection de réglages, fuite des clés).
  const find = async (pinned?: string): Promise<string | null> => {
    const roots = await listFolder(ctx, null);
    for (const id of backupFolderCandidates(roots, ctx.userId, SYNC_FOLDER, pinned)) {
      if (await isPrivate(id)) {
        verified.set(id, Date.now());
        return id;
      }
    }
    return null;
  };
  return {
    findFolder: find,
    async ensureFolder() {
      return (await find()) ?? (await createFolder(ctx, null, SYNC_FOLDER)).id;
    },
    async checkFolder(folderId) {
      const at = verified.get(folderId);
      if (at && Date.now() - at < RECHECK_MS) return true;
      try {
        const { node } = await ctx.api.getNode(folderId);
        const ok =
          node.ownerUserId === ctx.userId && !node.trashedAt && node.parentId === null && (await isPrivate(folderId));
        if (ok) verified.set(folderId, Date.now());
        else verified.delete(folderId);
        return ok;
      } catch (e) {
        // Dossier supprimé ou plus accessible : le moteur recrée le sien. Toute autre erreur (hors ligne,
        // serveur indisponible) remonte : on ne jette pas les liens sur une panne passagère.
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
          verified.delete(folderId);
          return false;
        }
        throw e;
      }
    },
    async list(folderId) {
      const entries = await listFolder(ctx, folderId);
      // Seuls les fichiers déposés par le compte lui-même font partie de SA sauvegarde.
      const files = ownedBy(
        entries.filter((e) => e.kind === "file" && !e.trashedAt),
        ctx.userId,
      );
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
      const e = roots.find(
        (x) => x.kind === "file" && x.name === LEGACY_FILE && !x.trashedAt && x.ownerUserId === ctx.userId,
      );
      if (e) known.set(e.id, e);
      return e ? toRemote(e) : null;
    },
  };
}
