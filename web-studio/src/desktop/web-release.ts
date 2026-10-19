/**
 * Informations de version affichées sur l'accueil du site HÉBERGÉ (hors application de bureau, qui a
 * son propre pied de page avec le lanceur local) : la version PRÉCISE de ce build, ses notes de mise à
 * jour et les installeurs Windows de la dernière version publiée.
 *
 * Source : `/release.json`, écrit au build (version, date, notes — scripts/gen-release-info.mjs) et
 * complété côté serveur avec la dernière publication GitHub (deploy/release-feed.py). La page ne
 * contacte jamais GitHub elle-même : la CSP n'autorise que sa propre origine.
 */

export interface InstallerAsset {
  name: string;
  url: string;
  size: number;
}

export interface PublishedRelease {
  tag: string;
  publishedAt: string;
  url: string;
  assets: InstallerAsset[];
}

export interface WebReleaseInfo {
  version: string;
  builtAt?: string;
  buildId?: string;
  heading?: string;
  notes: string[];
  /** Dernière version publiée avec ses installeurs (ajoutée par le serveur). */
  latest?: PublishedRelease;
}

/** Version compilée dans ce bundle (repli quand `/release.json` est absent). */
export const BUNDLED_VERSION: string = typeof __ELIUM_VERSION__ === "string" ? __ELIUM_VERSION__ : "";

export type InstallerKind = "machine" | "user" | "portable";

export interface Installer extends InstallerAsset {
  kind: InstallerKind;
  label: string;
  hint: string;
}

/** Les installeurs utiles parmi les fichiers d'une publication, dans l'ordre d'affichage. */
export function pickInstallers(release: PublishedRelease | undefined): Installer[] {
  if (!release) return [];
  const find = (re: RegExp) => release.assets.find((a) => re.test(a.name));
  const out: Installer[] = [];
  const machine = find(/^Elium-[\d.]+-Setup\.msi$/i);
  if (machine)
    out.push({
      ...machine,
      kind: "machine",
      label: "Installer pour tous les utilisateurs (MSI)",
      hint: "Droits administrateur requis · recommandé pour un poste partagé",
    });
  const user = find(/^Elium-User-[\d.]+\.msi$/i);
  if (user)
    out.push({
      ...user,
      kind: "user",
      label: "Installer pour mon compte (MSI)",
      hint: "Sans droits administrateur · installation dans votre profil",
    });
  const exe = find(/^Elium\.exe$/i);
  if (exe) out.push({ ...exe, kind: "portable", label: "Version portable (Elium.exe)", hint: "Sans installation" });
  return out;
}

/** Compare deux versions « X.Y.Z » : positif si a > b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map(Number);
  const pb = b.replace(/^v/i, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

export function formatSize(bytes: number): string {
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(0)} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

/** Charge `/release.json` ; `null` si le site n'est pas servi avec (dev, application de bureau). */
export async function fetchWebRelease(): Promise<WebReleaseInfo | null> {
  try {
    const r = await fetch("/release.json", { cache: "no-store" });
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    const j = (await r.json()) as Partial<WebReleaseInfo>;
    if (!j || typeof j.version !== "string") return null;
    return {
      version: j.version,
      builtAt: j.builtAt,
      buildId: j.buildId,
      heading: j.heading,
      notes: Array.isArray(j.notes) ? j.notes.filter((n): n is string => typeof n === "string") : [],
      latest: j.latest,
    };
  } catch {
    return null;
  }
}
