/**
 * Sauvegarde du passeport dans le Drive entreprise (serveur) : un fichier JSON
 * chiffré de bout en bout, versionné par le serveur. Sert à retrouver son
 * passeport depuis un autre appareil ou navigateur, et à le garder quand les
 * données locales sont effacées.
 */
import { strFromU8, strToU8 } from "fflate";
import {
  DriveConflict,
  downloadFile,
  listFolder,
  saveNewVersion,
  uploadFile,
  type DriveEntry,
  type OpsCtx,
} from "../drive-cloud/ops";
import { backupJson, parseBackup } from "./exportPasseport";
import { normalizePassport } from "./model";
import type { PassportData } from "./types";

export const DRIVE_FILE_NAME = "Passeport-BTS-GPME.json";

export interface DriveLink {
  nodeId: string;
  /** `modifiedAt` du nœud à notre dernière écriture/lecture (détection de conflit). */
  modifiedAt: string;
  syncedAt: string;
}

const linkKey = (ctx: Pick<OpsCtx, "userId" | "orgId">) => `elium_passport_drive:${ctx.userId}:${ctx.orgId}`;
const autoKey = (ctx: Pick<OpsCtx, "userId" | "orgId">) => `elium_passport_drive_auto:${ctx.userId}:${ctx.orgId}`;

export function readLink(ctx: Pick<OpsCtx, "userId" | "orgId">): DriveLink | null {
  try {
    const raw = localStorage.getItem(linkKey(ctx));
    return raw ? (JSON.parse(raw) as DriveLink) : null;
  } catch {
    return null;
  }
}

function writeLink(ctx: Pick<OpsCtx, "userId" | "orgId">, link: DriveLink | null): void {
  try {
    if (link) localStorage.setItem(linkKey(ctx), JSON.stringify(link));
    else localStorage.removeItem(linkKey(ctx));
  } catch {
    /* stockage indisponible : on se contente de l'état en mémoire */
  }
}

export function readAuto(ctx: Pick<OpsCtx, "userId" | "orgId">): boolean {
  try {
    return localStorage.getItem(autoKey(ctx)) === "1";
  } catch {
    return false;
  }
}

export function writeAuto(ctx: Pick<OpsCtx, "userId" | "orgId">, on: boolean): void {
  try {
    if (on) localStorage.setItem(autoKey(ctx), "1");
    else localStorage.removeItem(autoKey(ctx));
  } catch {
    /* sans effet */
  }
}

async function findRemote(ctx: OpsCtx): Promise<DriveEntry | null> {
  const entries = await listFolder(ctx, null);
  return entries.find((e) => e.kind === "file" && e.name === DRIVE_FILE_NAME && !e.trashedAt) ?? null;
}

/**
 * Écrit le passeport dans le Drive (nouvelle version du fichier s'il existe).
 * Lève `DriveConflict` si le fichier a été modifié ailleurs depuis notre dernière
 * synchronisation, sauf `force`.
 */
export async function pushPassport(
  ctx: OpsCtx,
  data: PassportData,
  opts: { force?: boolean } = {},
): Promise<DriveLink> {
  const bytes = strToU8(backupJson(data));
  const known = readLink(ctx);
  let nodeId = known?.nodeId;
  if (!nodeId) nodeId = (await findRemote(ctx))?.id;
  const base = known && known.nodeId === nodeId ? known.modifiedAt : undefined;
  let node;
  if (nodeId) {
    node = await saveNewVersion(ctx, nodeId, bytes, {
      // Sans lien local (autre navigateur) on n'écrase pas aveuglément un fichier existant.
      expectedModifiedAt: opts.force ? undefined : (base ?? "__unknown__"),
      force: opts.force,
    });
  } else {
    node = await uploadFile(ctx, null, new File([bytes as BlobPart], DRIVE_FILE_NAME, { type: "application/json" }));
  }
  const link: DriveLink = { nodeId: node.id, modifiedAt: node.modifiedAt, syncedAt: new Date().toISOString() };
  writeLink(ctx, link);
  return link;
}

/** Lit le passeport du Drive. `null` si aucun fichier n'existe. */
export async function pullPassport(ctx: OpsCtx): Promise<{ data: PassportData; link: DriveLink } | null> {
  const entry = await findRemote(ctx);
  if (!entry) return null;
  const { bytes } = await downloadFile(ctx, entry);
  const data = normalizePassport(parseBackup(strFromU8(bytes)));
  if (!data) throw new Error("Le fichier du Drive n'est pas un passeport Elium valide.");
  const link: DriveLink = { nodeId: entry.id, modifiedAt: entry.modifiedAt, syncedAt: new Date().toISOString() };
  writeLink(ctx, link);
  return { data, link };
}

export function forgetLink(ctx: Pick<OpsCtx, "userId" | "orgId">): void {
  writeLink(ctx, null);
}

export { DriveConflict };
