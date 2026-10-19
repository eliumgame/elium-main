/**
 * Sauvegarde de TOUT l'espace de travail local (documents, tableurs, présentations, PDF, dossiers)
 * dans le Drive entreprise : une archive `.elium-workspace` — la même que la sauvegarde manuelle —
 * déposée à la racine du Drive, où le chiffrement de bout en bout et le versionnage du serveur
 * s'appliquent. Aucun mot de passe d'archive : le Drive chiffre déjà le fichier.
 */
import { pullNamedFile, pushNamedFile, type DriveLink } from "../drive-cloud/named-file";
import type { OpsCtx } from "../drive-cloud/ops";
import type { WorkItem } from "./types";
import { collectSnapshot, openBackup, packBackup, type BackupDeps } from "./backup-io";
import type { BackupManifest, BackupSnapshot } from "./backup";

export const WORKSPACE_DRIVE_FILE = "Espace-de-travail-Elium.elium-workspace";
export const WORKSPACE_SLOT = "workspace";
export const AUTO_EVENT = "elium-drive-auto-changed";
export const AUTO_STATUS_EVENT = "elium-drive-auto-status";
const MIME = "application/x-elium-workspace";

/** Archive de tout l'espace de travail (sans secrets : clés et identité ne quittent jamais l'appareil). */
export async function buildWorkspaceArchive(deps: BackupDeps): Promise<Uint8Array> {
  const snap = await collectSnapshot(deps, { includeSecrets: false });
  return packBackup(snap, { includeSecrets: false });
}

export function pushWorkspace(ctx: OpsCtx, deps: BackupDeps, opts: { force?: boolean } = {}): Promise<DriveLink> {
  return buildWorkspaceArchive(deps).then((bytes) =>
    pushNamedFile(ctx, WORKSPACE_SLOT, WORKSPACE_DRIVE_FILE, bytes, { ...opts, mime: MIME }),
  );
}

/** Lit l'archive du Drive. `null` si aucune sauvegarde n'existe encore. */
export async function pullWorkspace(
  ctx: OpsCtx,
): Promise<{ backup: { manifest: BackupManifest; snapshot: BackupSnapshot }; link: DriveLink } | null> {
  const got = await pullNamedFile(ctx, WORKSPACE_SLOT, WORKSPACE_DRIVE_FILE);
  if (!got) return null;
  return { backup: await openBackup(got.bytes), link: got.link };
}

/** Empreinte du contenu de l'espace de travail : change dès qu'un élément est créé, modifié ou supprimé. */
export function workspaceSignature(items: WorkItem[]): string {
  let latest = "";
  let total = 0;
  for (const i of items) {
    if (i.modifiedAt > latest) latest = i.modifiedAt;
    total += i.size;
  }
  return `${items.length}|${latest}|${total}`;
}
