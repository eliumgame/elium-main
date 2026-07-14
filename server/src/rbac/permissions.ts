/**
 * The permission catalog — the single source of truth for every granular
 * capability in the platform. Custom roles are any subset of these keys, which
 * is what makes roles "ultra-detailed and modifiable". Keep in sync with the
 * client (web-studio/src/drive-cloud/permissions.ts mirrors this list).
 */

export interface PermissionDef {
  key: string;
  /** Domain used to group permissions in the role editor UI. */
  domain: "content" | "share" | "members" | "roles" | "org" | "security";
  /** Short human label (FR). */
  label: string;
  /** Whether this permission applies to a node (resource-scoped) or the org. */
  scope: "node" | "org";
}

export const PERMISSIONS: readonly PermissionDef[] = [
  // --- Content (node-scoped) ------------------------------------------------
  { key: "node.view", domain: "content", scope: "node", label: "Voir / ouvrir" },
  { key: "node.download", domain: "content", scope: "node", label: "Télécharger" },
  { key: "node.export", domain: "content", scope: "node", label: "Exporter (PDF/DOCX/…)" },
  { key: "node.print", domain: "content", scope: "node", label: "Imprimer" },
  { key: "node.create", domain: "content", scope: "node", label: "Créer (fichier/dossier)" },
  { key: "node.edit", domain: "content", scope: "node", label: "Modifier le contenu" },
  { key: "node.rename", domain: "content", scope: "node", label: "Renommer" },
  { key: "node.move", domain: "content", scope: "node", label: "Déplacer" },
  { key: "node.copy", domain: "content", scope: "node", label: "Copier / dupliquer" },
  { key: "node.delete", domain: "content", scope: "node", label: "Mettre à la corbeille" },
  { key: "node.restore", domain: "content", scope: "node", label: "Restaurer / vider la corbeille" },
  { key: "node.comment", domain: "content", scope: "node", label: "Commenter" },
  { key: "node.version.view", domain: "content", scope: "node", label: "Voir l'historique des versions" },
  { key: "node.version.restore", domain: "content", scope: "node", label: "Restaurer une version" },

  // --- Sharing (node-scoped) ------------------------------------------------
  { key: "node.share.internal", domain: "share", scope: "node", label: "Partager (interne : membres/groupes)" },
  { key: "node.share.link", domain: "share", scope: "node", label: "Créer un lien externe" },
  { key: "node.share.manage", domain: "share", scope: "node", label: "Gérer / révoquer les partages" },
  { key: "node.acl.view", domain: "share", scope: "node", label: "Voir les accès" },
  { key: "node.acl.manage", domain: "share", scope: "node", label: "Gérer les accès (attribuer des rôles)" },

  // --- Members (org-scoped) -------------------------------------------------
  { key: "member.view", domain: "members", scope: "org", label: "Voir les membres" },
  { key: "member.invite", domain: "members", scope: "org", label: "Inviter des membres" },
  { key: "member.remove", domain: "members", scope: "org", label: "Retirer des membres" },
  { key: "member.role.assign", domain: "members", scope: "org", label: "Attribuer des rôles d'organisation" },
  { key: "group.view", domain: "members", scope: "org", label: "Voir les groupes/équipes" },
  { key: "group.create", domain: "members", scope: "org", label: "Créer des groupes/équipes" },
  { key: "group.manage", domain: "members", scope: "org", label: "Gérer les groupes/équipes" },

  // --- Roles (org-scoped) ---------------------------------------------------
  { key: "role.view", domain: "roles", scope: "org", label: "Voir les rôles" },
  { key: "role.create", domain: "roles", scope: "org", label: "Créer des rôles personnalisés" },
  { key: "role.manage", domain: "roles", scope: "org", label: "Modifier / supprimer des rôles" },

  // --- Organization (org-scoped) -------------------------------------------
  { key: "org.settings.view", domain: "org", scope: "org", label: "Voir les paramètres de l'organisation" },
  { key: "org.settings.manage", domain: "org", scope: "org", label: "Modifier les paramètres de l'organisation" },
  { key: "space.create", domain: "org", scope: "org", label: "Créer des espaces" },
  { key: "space.manage", domain: "org", scope: "org", label: "Gérer les espaces" },
  { key: "storage.quota.manage", domain: "org", scope: "org", label: "Gérer les quotas de stockage" },

  // --- Security (org-scoped) ------------------------------------------------
  { key: "audit.view", domain: "security", scope: "org", label: "Consulter le journal d'audit" },
  { key: "recovery.perform", domain: "security", scope: "org", label: "Recouvrer les fichiers (clé d'organisation)" },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

export const ALL_PERMISSION_KEYS: readonly string[] = PERMISSIONS.map((p) => p.key);
const PERMISSION_SET = new Set(ALL_PERMISSION_KEYS);

export function isPermissionKey(k: string): k is PermissionKey {
  return PERMISSION_SET.has(k);
}

/** Filter an arbitrary list down to valid, de-duplicated permission keys. */
export function sanitizePermissions(keys: unknown): PermissionKey[] {
  if (!Array.isArray(keys)) return [];
  const out = new Set<string>();
  for (const k of keys) if (typeof k === "string" && PERMISSION_SET.has(k)) out.add(k);
  return [...out] as PermissionKey[];
}

/** Node-scoped subset — the permissions meaningful on a resource. */
export const NODE_PERMISSION_KEYS: readonly string[] = PERMISSIONS.filter((p) => p.scope === "node").map((p) => p.key);
