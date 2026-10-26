/**
 * Purge de TOUTES les données applicatives locales du navigateur (IndexedDB +
 * préférences liées à un compte) — sans toucher à la session Drive en cours
 * (`elium_drive_session_v1`, gérée par drive-cloud/session.tsx), qui doit
 * pouvoir survivre à un rechargement volontaire juste après l'appel.
 *
 * Deux appelants : le bouton « Effacer les données » (App.tsx) et la détection
 * de changement de compte sur le même navigateur (voir `claimLocalWorkspace`
 * ci-dessous) — les deux doivent effacer exactement la même liste, d'où ce
 * module partagé plutôt que deux listes dupliquées qui dériveraient (c'est
 * exactement ce qui s'est produit une première fois : cette liste avait été
 * recopiée à la main depuis l'ancien bouton et avait hérité son oubli de
 * `elium-pdf-ids`, corrigé ici en import des listes maintenues par
 * workspace/backup.ts plutôt que par une seconde recopie).
 */
import { SETTINGS_KEYS, SECRET_KEYS } from "./backup";

// Toutes les bases du cadre de migration (format/db-specs.ts ALL_DB_SPECS),
// plus celles qui vivent en dehors de ce cadre (trousseau, polices, sauvegardes,
// passeport — ce dernier existe mais n'est volontairement pas dans
// ALL_DB_SPECS ; il reste une donnée de compte à purger comme les autres).
export const LOCAL_WORKSPACE_DATABASES = [
  "elium", // historique de versions (VERSIONS_SPEC)
  "elium-drive",
  "elium-sheets",
  "elium-slides",
  "elium-parapheur",
  "elium-passeport",
  "elium-drafts",
  "elium-vault",
  "elium-pdfs",
  "elium-pdf-recovery",
  "elium-pdf-ids", // identités PDF : certificats, P12/PFX, clé privée WebCrypto non extractible
  "elium-workspace",
  "elium-keys", // KEYRING_DB (crypto/keyring.ts)
  "elium-fonts",
  "elium-backups", // BACKUP_DB (format/idb-migrate.ts)
] as const;

const LOCAL_WORKSPACE_STORAGE_KEYS = [
  ...SETTINGS_KEYS,
  ...SECRET_KEYS, // inclut les legacy elium_identity / elium_recipient_key
  "elium_drive_prf_v1", // registre de déverrouillage par clé d'accès (PRF)
  "elium_trust_revocations",
  "elium_keyring_idle_min",
  "elium_session",
  "elium_view_mode",
] as const;

/**
 * Supprime une base IndexedDB et n'avance qu'une fois réellement réglée
 * (succès, erreur, ou blocage persistant) — un simple appel fire-and-forget à
 * `indexedDB.deleteDatabase` ne garantit rien : si un AUTRE onglet garde la
 * base ouverte, la suppression reste en attente (`onblocked`) potentiellement
 * indéfiniment, et le rechargement qui suit `claimLocalWorkspace` afficherait
 * alors l'espace du compte précédent malgré tout. Un blocage persistant après
 * le délai ci-dessous n'est donc PAS traité comme un succès silencieux.
 */
function deleteDatabase(name: string, blockedTimeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => finish();
      req.onerror = () => finish(); // best effort : une base déjà absente/corrompue ne doit pas bloquer la purge
      req.onblocked = () => {
        // Un autre onglet garde la base ouverte : la suppression reste en
        // attente. On n'attend pas indéfiniment, mais on ne prétend pas non
        // plus avoir réussi — voir wipeLocalWorkspaceData.
        setTimeout(finish, blockedTimeoutMs);
      };
    } catch {
      finish();
    }
  });
}

/**
 * Supprime les bases IndexedDB de l'espace de travail local et les préférences
 * associées, et n'avance qu'une fois CHAQUE suppression réglée (voir
 * `deleteDatabase`). Un onglet A → déconnexion → onglet B ouvert simultanément
 * sur un PROFIL NAVIGATEUR commun reste un cas limite : la base purgée depuis
 * B peut rester bloquée tant que A ne se ferme pas, et A continue de voir ses
 * propres données jusqu'à sa fermeture — ce module ne prétend pas invalider
 * les autres onglets déjà ouverts, seulement ne pas mentir sur la purge faite
 * depuis CELUI-ci.
 */
export async function wipeLocalWorkspaceData(): Promise<void> {
  for (const k of LOCAL_WORKSPACE_STORAGE_KEYS) localStorage.removeItem(k);
  // État de synchronisation Drive par compte/organisation : effacé avec les données pour
  // qu'un espace vide ne soit jamais poussé par-dessus une sauvegarde au prochain démarrage.
  for (const k of Object.keys(localStorage))
    if (k.startsWith("elium_drive_sync_v1:") || k.startsWith("elium_drive_link:") || k === "elium_sync_dirty_v1")
      localStorage.removeItem(k);
  await Promise.all(LOCAL_WORKSPACE_DATABASES.map((db) => deleteDatabase(db)));
}

const OWNER_KEY = "elium_local_workspace_owner";
// Posée UNIQUEMENT quand un espace local non vide est réclamé sans propriétaire
// enregistré (profil antérieur à ce mécanisme, ou navigateur partagé jamais
// passé par un changement de compte) : l'origine réelle des données est alors
// INCONNUE. Par prudence contre une perte de données du cas très majoritaire
// (un seul utilisateur qui met à jour son installation), ce module adopte
// sans purger — mais pose cette trace plutôt que de l'ignorer en silence.
// Une vraie décision produit (tout purger par défaut sur un profil partagé ?
// proposer un choix explicite ?) reste à prendre ; voir le réaudit du
// 26/10/2026, §5 « purge locale partielle ».
const UNVERIFIED_CLAIM_KEY = "elium_local_workspace_unverified_claim";

async function hasAnyLocalData(): Promise<boolean> {
  if (typeof indexedDB.databases !== "function") return true; // navigateur sans introspection : prudence maximale
  try {
    const dbs = await indexedDB.databases();
    const present = new Set(dbs.map((d) => d.name).filter(Boolean));
    return LOCAL_WORKSPACE_DATABASES.some((n) => present.has(n));
  } catch {
    return true;
  }
}

/**
 * À appeler dès qu'un compte devient réellement utilisable (clés déchiffrées),
 * JAMAIS avant. Compare le compte qui vient de s'authentifier au propriétaire
 * enregistré de l'espace de travail local de ce navigateur :
 *  - aucun propriétaire enregistré et espace local VIDE (premier usage réel)
 *    → l'enregistre, ne purge rien ;
 *  - aucun propriétaire enregistré mais espace local NON VIDE (profil créé
 *    avant ce mécanisme) → origine non vérifiable ; adopté sans purge pour ne
 *    pas risquer de détruire les données légitimes du cas majoritaire, mais
 *    tracé via UNVERIFIED_CLAIM_KEY plutôt qu'ignoré silencieusement ;
 *  - même compte (déconnexion/reconnexion normale, ou restauration de session)
 *    → ne purge rien : c'est l'usage courant d'un appareil local-first ;
 *  - compte DIFFÉRENT → l'espace local appartient à quelqu'un d'autre : purge
 *    tout avant que quoi que ce soit ne soit affiché à ce nouveau compte, et
 *    retourne true pour que l'appelant recharge la page (l'espace ne s'auto-
 *    régénère pas tout seul en mémoire : useWorkspace et consorts ont déjà pu
 *    charger l'ancien catalogue au premier rendu).
 */
export async function claimLocalWorkspace(accountId: string): Promise<boolean> {
  let previousOwner: string | null = null;
  try {
    previousOwner = localStorage.getItem(OWNER_KEY);
  } catch {
    return false; // localStorage indisponible (navigation privée stricte, etc.) : rien à comparer
  }
  if (previousOwner === accountId) return false;
  let shouldReload = false;
  if (previousOwner) {
    await wipeLocalWorkspaceData();
    shouldReload = true;
  } else if (await hasAnyLocalData()) {
    try {
      localStorage.setItem(UNVERIFIED_CLAIM_KEY, JSON.stringify({ accountId, at: new Date().toISOString() }));
    } catch {
      /* best effort */
    }
  }
  try {
    localStorage.setItem(OWNER_KEY, accountId);
  } catch {
    /* best effort */
  }
  return shouldReload;
}
