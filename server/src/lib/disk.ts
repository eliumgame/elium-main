/**
 * Espace disque réel du stockage (STORAGE_FS_ROOT) : jauge du portail et
 * garde-fou contre la saturation du disque (donc de la base, qui partage la
 * machine). Sans objet avec S3 : il n'y a pas de disque local à mesurer.
 * `statfs` est injectable pour les tests.
 */
import { statfs as nodeStatfs } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { config } from "../config.js";
import { insufficientStorage } from "./errors.js";
import { getSiteSettings, type SiteSettings } from "./site-settings.js";

type StatfsFn = (path: string) => Promise<{ blocks: number | bigint; bsize: number | bigint; bavail: number | bigint }>;
let impl: StatfsFn = nodeStatfs as unknown as StatfsFn;

export function setStatfsForTests(fn: StatfsFn | null): void {
  impl = fn ?? (nodeStatfs as unknown as StatfsFn);
}

export interface DiskStats {
  totalBytes: number;
  freeBytes: number;
}

/** Espace du disque portant le dossier de stockage ; null avec S3 ou si la mesure échoue. */
export async function getDiskStats(): Promise<DiskStats | null> {
  if (config.storage.driver !== "fs") return null;
  let dir = resolve(config.storage.fsRoot);
  for (let i = 0; i < 4; i++) {
    try {
      const s = await impl(dir);
      return { totalBytes: Number(s.blocks) * Number(s.bsize), freeBytes: Number(s.bavail) * Number(s.bsize) };
    } catch {
      dir = dirname(dir); // le dossier peut ne pas encore exister
    }
  }
  return null;
}

/** Marge de sécurité : le plus grand de X % du disque et d'un volume fixe. */
export function diskMarginBytes(total: number, s: Pick<SiteSettings, "diskMarginPercent" | "diskMarginBytes">): number {
  return Math.max(Math.floor((total * s.diskMarginPercent) / 100), s.diskMarginBytes);
}

/** Refuse (507) un envoi qui ferait passer l'espace libre sous la marge de sécurité. */
export async function assertDiskSpace(addBytes: number): Promise<void> {
  const stats = await getDiskStats();
  if (!stats) return;
  const margin = diskMarginBytes(stats.totalBytes, await getSiteSettings());
  if (stats.freeBytes - addBytes < margin) {
    throw insufficientStorage(
      "Espace disque du serveur insuffisant : l'envoi est refusé pour ne pas saturer le disque. Prévenez le propriétaire du Drive.",
    );
  }
}
