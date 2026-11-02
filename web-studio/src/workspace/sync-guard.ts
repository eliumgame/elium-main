/**
 * Garde-fous PURS de la sauvegarde Drive (testés sans navigateur) :
 *  - le dossier « Sauvegarde Elium » n'est accepté que s'il appartient au compte et n'est partagé
 *    qu'avec lui-même et son organisation (un autre membre pourrait sinon en créer un du même nom,
 *    le partager, injecter des réglages / ancres de confiance et récupérer une part de clé de chaque
 *    fichier envoyé) ;
 *  - les ancres de confiance (certificats PDF approuvés, racines C2PA) ne sont jamais restaurées
 *    automatiquement : uniquement sur action explicite de l'utilisateur.
 */

export interface FolderCandidate {
  id: string;
  kind: string;
  name: string;
  trashedAt: string | null;
  ownerUserId: string;
  parentId?: string | null;
}

export interface ShareRow {
  principalType: string;
  principalId: string;
}

/**
 * Dossiers de sauvegarde acceptables, dans l'ordre de préférence (l'identifiant épinglé d'abord) :
 * racine, non supprimé, bon nom, créé par le compte lui-même.
 */
export function backupFolderCandidates(
  entries: FolderCandidate[],
  userId: string,
  name: string,
  pinned?: string,
): string[] {
  const ok = entries.filter(
    (e) =>
      e.kind === "folder" &&
      e.name === name &&
      !e.trashedAt &&
      e.ownerUserId === userId &&
      (e.parentId ?? null) === null,
  );
  ok.sort((a, b) => (a.id === pinned ? -1 : b.id === pinned ? 1 : 0));
  return ok.map((e) => e.id);
}

/** Le dossier n'est partagé qu'avec le compte lui-même et (recouvrement) son organisation. */
export function sharesArePrivate(rows: ShareRow[], userId: string, orgId: string): boolean {
  return rows.every(
    (r) =>
      (r.principalType === "user" && r.principalId === userId) ||
      (r.principalType === "org" && r.principalId === orgId),
  );
}

/** Fichiers de sauvegarde retenus : uniquement ceux déposés par le compte lui-même. */
export const ownedBy = <T extends { ownerUserId: string }>(entries: T[], userId: string): T[] =>
  entries.filter((e) => e.ownerUserId === userId);

/** Réglages qui sont des ANCRES DE CONFIANCE : jamais restaurés sans demande explicite. */
export const TRUST_SETTINGS_KEYS: readonly string[] = ["elium.detector.c2paTrust.v1"];

export const withoutTrustSettings = <V>(settings: Record<string, V>): Record<string, V> =>
  Object.fromEntries(Object.entries(settings).filter(([k]) => !TRUST_SETTINGS_KEYS.includes(k)));

export const onlyTrustSettings = (settings: Record<string, string | null>): Record<string, string | null> =>
  Object.fromEntries(Object.entries(settings).filter(([k, v]) => TRUST_SETTINGS_KEYS.includes(k) && v != null));

/** Nombre d'entrées d'une valeur de réglage de confiance (tableau JSON → longueur, sinon 1). */
export function trustSettingCount(value: string | null): number {
  if (!value) return 0;
  try {
    const v = JSON.parse(value) as unknown;
    if (Array.isArray(v)) return v.length;
    if (v && typeof v === "object") {
      const arr = Object.values(v as Record<string, unknown>).find(Array.isArray);
      return arr ? arr.length : 1;
    }
    return 1;
  } catch {
    return 1;
  }
}

/**
 * Sépare les enregistrements d'une pièce annexe : `kept` (restaurés normalement) et `trust`
 * (magasins marqués `trust`, retenus jusqu'à une importation explicite).
 */
export function splitTrustRecords(
  stores: { name: string; trust?: boolean }[],
  records: Record<string, unknown[]>,
): { kept: Record<string, unknown[]>; trust: Record<string, unknown[]>; trustCount: number } {
  const kept: Record<string, unknown[]> = {};
  const trust: Record<string, unknown[]> = {};
  let trustCount = 0;
  for (const [name, list] of Object.entries(records)) {
    if (stores.find((s) => s.name === name)?.trust) {
      trust[name] = list;
      trustCount += list.length;
    } else kept[name] = list;
  }
  return { kept, trust, trustCount };
}

// --- Organisation de sauvegarde --------------------------------------------------------------------
// L'espace local est propre au COMPTE, pas à l'organisation : sans garde-fou, passer sur (ou rejoindre)
// une seconde organisation y enverrait tout l'espace, avec une part de clé pour cette organisation.

/** Organisations où l'utilisateur a accepté que son espace soit sauvegardé (par compte). */
export const backupOrgsKey = (userId: string) => `elium_drive_backup_orgs_v1:${userId}`;

export function parseBackupOrgs(raw: string | null): string[] {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Première sauvegarde dans `orgId` : confirmation requise si l'espace est déjà sauvegardé ailleurs. */
export const needsOrgConsent = (approved: string[], orgId: string): boolean =>
  approved.length > 0 && !approved.includes(orgId);
