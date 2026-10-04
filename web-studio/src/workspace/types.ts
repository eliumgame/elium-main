/**
 * Espace de travail local : un SEUL catalogue de tous les éléments (documents,
 * tableurs, présentations, PDF), quel que soit le magasin qui en garde le contenu.
 *
 * Le catalogue ne contient que des MÉTADONNÉES (titre, dossier, étiquettes…).
 * Le contenu reste dans les magasins par type (elium-drive, elium-sheets,
 * elium-slides, elium-pdfs) : `contentStore` dit où, `id` en est la clé.
 */

export type ItemKind = "doc" | "sheet" | "slides" | "pdf";
export type ContentStoreId = "drive" | "sheets" | "slides" | "pdfs";

export const ITEM_KINDS: ItemKind[] = ["doc", "sheet", "slides", "pdf"];

/** Élément du catalogue, tel qu'utilisé par l'interface (champs toujours en clair en mémoire). */
export interface WorkItem {
  /** Clé de l'élément = clé de son contenu dans `contentStore`. */
  id: string;
  kind: ItemKind;
  contentStore: ContentStoreId;
  title: string;
  /** Taille du contenu enregistré, en octets (approximative pour les contenus chiffrés). */
  size: number;
  createdAt: string; // ISO
  modifiedAt: string; // ISO
  lastOpenedAt?: string; // ISO
  folderId: string | null;
  tags: string[];
  starred: boolean;
  /** Mis à la corbeille le… (ISO). Les éléments supprimés définitivement n'existent plus. */
  trashedAt?: string;
  /** Si l'élément est parti à la corbeille AVEC un dossier : l'id de ce dossier. */
  trashedBy?: string;
  /** Titre/étiquettes chiffrés au repos par le coffre local. */
  vaultProtected: boolean;
  /** Profil de protection du document (.elium) — pour le badge. */
  profile?: string;
  /** Coffre verrouillé / mot de passe incorrect : titre générique, contenu inaccessible. */
  locked?: boolean;
}

export interface WorkFolder {
  id: string;
  parentId: string | null;
  name: string;
  createdAt: string;
  trashedAt?: string;
  trashedBy?: string;
  vaultProtected: boolean;
  locked?: boolean;
}

/** Enregistrement persistant d'un élément : titre et étiquettes passent dans `enc` quand le coffre est actif. */
export interface ItemRecord {
  id: string;
  kind: ItemKind;
  contentStore: ContentStoreId;
  size: number;
  createdAt: string;
  modifiedAt: string;
  lastOpenedAt?: string;
  folderId: string | null;
  starred: boolean;
  trashedAt?: string;
  trashedBy?: string;
  vaultProtected: boolean;
  profile?: string;
  title?: string; // clair — seulement hors coffre
  tags?: string[]; // clair — seulement hors coffre
  enc?: string; // { title, tags } chiffré — seulement avec le coffre
}

export interface FolderRecord {
  id: string;
  parentId: string | null;
  createdAt: string;
  trashedAt?: string;
  trashedBy?: string;
  vaultProtected: boolean;
  name?: string;
  enc?: string;
}

/** Durée de conservation à la corbeille avant suppression définitive. */
export const TRASH_RETENTION_DAYS = 30;
