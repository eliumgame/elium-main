/**
 * Purge de TOUTES les données applicatives locales du navigateur (IndexedDB +
 * préférences liées à un compte) — sans toucher à la session Drive en cours
 * (`elium_drive_session_v1`, gérée par drive-cloud/session.tsx), qui doit
 * pouvoir survivre à un rechargement volontaire juste après l'appel.
 *
 * Deux appelants : le bouton « Effacer les données » (App.tsx) et la détection
 * de changement de compte sur le même navigateur (voir `claimLocalWorkspace`
 * ci-dessous) — les deux doivent effacer exactement la même liste, d'où ce
 * module partagé plutôt que deux listes dupliquées qui dériveraient.
 */

export const LOCAL_WORKSPACE_DATABASES = [
  "elium",
  "elium-drive",
  "elium-sheets",
  "elium-slides",
  "elium-parapheur",
  "elium-passeport",
  "elium-drafts",
  "elium-vault",
  "elium-keys",
  "elium-fonts",
  "elium-pdfs",
  "elium-pdf-recovery",
  "elium-workspace",
  "elium-backups",
] as const;

const LOCAL_WORKSPACE_STORAGE_KEYS = [
  "elium_trusted_key", // legacy (migré vers le carnet)
  "elium_trust_book",
  "elium_trust_revocations",
  "elium_keyring_idle_min",
  "elium_theme",
  "elium_seal_pins",
  "elium_prefs",
  "elium_shortcuts",
  "elium_locale",
  "elium_session",
  "elium_view_mode",
  "elium_recent_commands",
] as const;

/** Supprime les bases IndexedDB de l'espace de travail local et les préférences associées. */
export function wipeLocalWorkspaceData(): void {
  for (const k of LOCAL_WORKSPACE_STORAGE_KEYS) localStorage.removeItem(k);
  // État de synchronisation Drive par compte/organisation : effacé avec les données pour
  // qu'un espace vide ne soit jamais poussé par-dessus une sauvegarde au prochain démarrage.
  for (const k of Object.keys(localStorage))
    if (k.startsWith("elium_drive_sync_v1:") || k.startsWith("elium_drive_link:") || k === "elium_sync_dirty_v1")
      localStorage.removeItem(k);
  for (const db of LOCAL_WORKSPACE_DATABASES) {
    try {
      indexedDB.deleteDatabase(db);
    } catch {
      /* best effort */
    }
  }
}

const OWNER_KEY = "elium_local_workspace_owner";

/**
 * À appeler dès qu'un compte devient réellement utilisable (clés déchiffrées),
 * JAMAIS avant. Compare le compte qui vient de s'authentifier au propriétaire
 * enregistré de l'espace de travail local de ce navigateur :
 *  - aucun propriétaire enregistré (premier usage) → l'enregistre, ne purge rien ;
 *  - même compte (déconnexion/reconnexion normale, ou restauration de session)
 *    → ne purge rien : c'est l'usage courant d'un appareil local-first ;
 *  - compte DIFFÉRENT → l'espace local appartient à quelqu'un d'autre : purge
 *    tout avant que quoi que ce soit ne soit affiché à ce nouveau compte, et
 *    retourne true pour que l'appelant recharge la page (l'espace ne s'auto-
 *    régénère pas tout seul en mémoire : useWorkspace et consorts ont déjà pu
 *    charger l'ancien catalogue au premier rendu).
 */
export function claimLocalWorkspace(accountId: string): boolean {
  let previousOwner: string | null = null;
  try {
    previousOwner = localStorage.getItem(OWNER_KEY);
  } catch {
    return false; // localStorage indisponible (navigation privée stricte, etc.) : rien à comparer
  }
  if (previousOwner === accountId) return false;
  if (previousOwner) wipeLocalWorkspaceData();
  try {
    localStorage.setItem(OWNER_KEY, accountId);
  } catch {
    /* best effort */
  }
  return previousOwner !== null;
}
