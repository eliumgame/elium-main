/**
 * Sauvegarde d'un fichier NOMMÉ à la racine du Drive entreprise (chiffré de bout en bout, versionné
 * par le serveur) : sert au Passeport et à la sauvegarde de l'espace de travail. Le lien local
 * (identifiant du nœud + date de dernière synchronisation) est gardé par compte, organisation et
 * « slot », pour détecter qu'un autre appareil a écrit entre-temps.
 */
import {
  DriveConflict,
  createFolder,
  downloadFile,
  listFolder,
  saveNewVersion,
  uploadFile,
  type DriveEntry,
  type OpsCtx,
} from "./ops";

export interface DriveLink {
  nodeId: string;
  /** `modifiedAt` du nœud à notre dernière écriture/lecture (détection de conflit). */
  modifiedAt: string;
  syncedAt: string;
}

type Who = Pick<OpsCtx, "userId" | "orgId">;
const linkKey = (slot: string, w: Who) => `elium_drive_link:${slot}:${w.userId}:${w.orgId}`;
const autoKey = (slot: string, w: Who) => `elium_drive_auto:${slot}:${w.userId}:${w.orgId}`;

export function readLink(slot: string, w: Who): DriveLink | null {
  try {
    const raw = localStorage.getItem(linkKey(slot, w));
    return raw ? (JSON.parse(raw) as DriveLink) : null;
  } catch {
    return null;
  }
}

export function writeLink(slot: string, w: Who, link: DriveLink | null): void {
  try {
    if (link) localStorage.setItem(linkKey(slot, w), JSON.stringify(link));
    else localStorage.removeItem(linkKey(slot, w));
  } catch {
    /* stockage indisponible : on se contente de l'état en mémoire */
  }
}

export function readAuto(slot: string, w: Who): boolean {
  try {
    return localStorage.getItem(autoKey(slot, w)) === "1";
  } catch {
    return false;
  }
}

/** Comme `readAuto`, avec une valeur par défaut tant que l'utilisateur n'a rien choisi (« 0 » = refus explicite). */
export function readAutoOr(slot: string, w: Who, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(autoKey(slot, w));
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function writeAuto(slot: string, w: Who, on: boolean): void {
  try {
    localStorage.setItem(autoKey(slot, w), on ? "1" : "0");
  } catch {
    /* sans effet */
  }
}

async function findRemote(ctx: OpsCtx, name: string, parentId: string | null = null): Promise<DriveEntry | null> {
  const entries = await listFolder(ctx, parentId);
  return entries.find((e) => e.kind === "file" && e.name === name && !e.trashedAt) ?? null;
}

/**
 * Écrit `bytes` sous `name` (nouvelle version si le fichier existe). Lève `DriveConflict` si le
 * fichier a été modifié ailleurs depuis notre dernière synchronisation, sauf `force`.
 */
export async function pushNamedFile(
  ctx: OpsCtx,
  slot: string,
  name: string,
  bytes: Uint8Array,
  opts: { force?: boolean; mime?: string; parentId?: string | null } = {},
): Promise<DriveLink> {
  const parentId = opts.parentId ?? null;
  const known = readLink(slot, ctx);
  let nodeId = known?.nodeId;
  if (!nodeId) nodeId = (await findRemote(ctx, name, parentId))?.id;
  const base = known && known.nodeId === nodeId ? known.modifiedAt : undefined;
  const upload = () =>
    uploadFile(ctx, parentId, new File([bytes as BlobPart], name, { type: opts.mime ?? "application/octet-stream" }));
  let node;
  if (nodeId) {
    try {
      node = await saveNewVersion(ctx, nodeId, bytes, {
        // Sans lien local (autre navigateur) on n'écrase pas aveuglément un fichier existant.
        expectedModifiedAt: opts.force ? undefined : (base ?? "__unknown__"),
        force: opts.force,
      });
    } catch (e) {
      if (isConflict(e) || !known) throw e;
      // Le fichier lié a disparu (supprimé, corbeille vidée) : on le recrée plutôt que d'échouer.
      writeLink(slot, ctx, null);
      const remote = await findRemote(ctx, name, parentId);
      node = remote ? await saveNewVersion(ctx, remote.id, bytes, { force: true }) : await upload();
    }
  } else node = await upload();
  const link: DriveLink = { nodeId: node.id, modifiedAt: node.modifiedAt, syncedAt: new Date().toISOString() };
  writeLink(slot, ctx, link);
  return link;
}

/** Lit le fichier du Drive. `null` s'il n'existe pas. */
export async function pullNamedFile(
  ctx: OpsCtx,
  slot: string,
  name: string,
): Promise<{ bytes: Uint8Array; link: DriveLink } | null> {
  const entry = await findRemote(ctx, name);
  if (!entry) return null;
  const { bytes } = await downloadFile(ctx, entry);
  const link: DriveLink = { nodeId: entry.id, modifiedAt: entry.modifiedAt, syncedAt: new Date().toISOString() };
  writeLink(slot, ctx, link);
  return { bytes, link };
}

export const isConflict = (e: unknown): boolean =>
  e instanceof DriveConflict || (e instanceof Error && e.name === "DriveConflict");

/** Dossier à la racine du Drive portant ce nom (créé au besoin). Renvoie son identifiant. */
export async function ensureRootFolder(ctx: OpsCtx, name: string): Promise<string> {
  const entries = await listFolder(ctx, null);
  const hit = entries.find((e) => e.kind === "folder" && e.name === name && !e.trashedAt);
  return hit ? hit.id : (await createFolder(ctx, null, name)).id;
}
