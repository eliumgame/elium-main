/**
 * Sauvegarde d'un fichier NOMMÉ à la racine du Drive entreprise (chiffré de bout en bout, versionné
 * par le serveur) : sert au Passeport et à la sauvegarde de l'espace de travail. Le lien local
 * (identifiant du nœud + date de dernière synchronisation) est gardé par compte, organisation et
 * « slot », pour détecter qu'un autre appareil a écrit entre-temps.
 */
import {
  DriveConflict,
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

export function writeAuto(slot: string, w: Who, on: boolean): void {
  try {
    if (on) localStorage.setItem(autoKey(slot, w), "1");
    else localStorage.removeItem(autoKey(slot, w));
  } catch {
    /* sans effet */
  }
}

async function findRemote(ctx: OpsCtx, name: string): Promise<DriveEntry | null> {
  const entries = await listFolder(ctx, null);
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
  opts: { force?: boolean; mime?: string } = {},
): Promise<DriveLink> {
  const known = readLink(slot, ctx);
  let nodeId = known?.nodeId;
  if (!nodeId) nodeId = (await findRemote(ctx, name))?.id;
  const base = known && known.nodeId === nodeId ? known.modifiedAt : undefined;
  const node = nodeId
    ? await saveNewVersion(ctx, nodeId, bytes, {
        // Sans lien local (autre navigateur) on n'écrase pas aveuglément un fichier existant.
        expectedModifiedAt: opts.force ? undefined : (base ?? "__unknown__"),
        force: opts.force,
      })
    : await uploadFile(
        ctx,
        null,
        new File([bytes as BlobPart], name, { type: opts.mime ?? "application/octet-stream" }),
      );
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
