/**
 * System role templates. Cloned per-organization at creation so each org can
 * then tweak them freely; the global (org_id = NULL) copies are the seed.
 * Custom roles are created on top of these.
 */
import { ALL_PERMISSION_KEYS, NODE_PERMISSION_KEYS, type PermissionKey } from "./permissions.js";

export interface RoleTemplate {
  key: string;
  name: string;
  description: string;
  color: string;
  permissions: readonly string[];
}

const p = (keys: readonly string[]): string[] => [...keys];

// Editor: full content control + internal sharing + versions (no org admin).
const EDITOR_PERMS: string[] = [
  ...NODE_PERMISSION_KEYS,
  "node.share.internal",
  "node.acl.view",
];

const COMMENTER_PERMS: string[] = [
  "node.view",
  "node.download",
  "node.comment",
  "node.version.view",
  "node.acl.view",
];

const VIEWER_PERMS: string[] = ["node.view", "node.download", "node.version.view"];

// Manager: people & structure, but not full org settings.
const MANAGER_PERMS: string[] = [
  ...EDITOR_PERMS,
  "node.share.link",
  "node.share.manage",
  "node.acl.manage",
  "member.view",
  "member.invite",
  "member.role.assign",
  "group.view",
  "group.create",
  "group.manage",
  "role.view",
  "space.create",
];

// Admin: everything except that "owner" is the sole ownership-transfer holder
// (ownership transfer is modeled outside the permission list).
const ADMIN_PERMS: string[] = [...ALL_PERMISSION_KEYS];

export const SYSTEM_ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    key: "owner",
    name: "Propriétaire",
    description: "Contrôle total, y compris le transfert de propriété et la clé de recouvrement.",
    color: "#7c3aed",
    permissions: p(ALL_PERMISSION_KEYS),
  },
  {
    key: "admin",
    name: "Administrateur",
    description: "Gère l'organisation, les membres, les rôles, la sécurité et tout le contenu.",
    color: "#1d4ed8",
    permissions: ADMIN_PERMS,
  },
  {
    key: "manager",
    name: "Gestionnaire",
    description: "Gère les personnes, les groupes, les rôles et les partages dans son périmètre.",
    color: "#0ea5e9",
    permissions: p([...new Set(MANAGER_PERMS)]),
  },
  {
    key: "editor",
    name: "Éditeur",
    description: "Crée et modifie le contenu, partage en interne, gère les versions.",
    color: "#16a34a",
    permissions: p([...new Set(EDITOR_PERMS)]),
  },
  {
    key: "commenter",
    name: "Commentateur",
    description: "Consulte et commente, sans modifier le contenu.",
    color: "#ca8a04",
    permissions: p(COMMENTER_PERMS),
  },
  {
    key: "viewer",
    name: "Lecteur",
    description: "Consultation seule (voir et télécharger).",
    color: "#64748b",
    permissions: p(VIEWER_PERMS),
  },
  {
    key: "guest",
    name: "Invité",
    description: "Accès externe minimal via lien de partage.",
    color: "#94a3b8",
    permissions: p(["node.view"]),
  },
] as const;

/** The org-level default role assigned to a freshly invited member. */
export const DEFAULT_MEMBER_ROLE_KEY = "editor";

export function templateByKey(key: string): RoleTemplate | undefined {
  return SYSTEM_ROLE_TEMPLATES.find((t) => t.key === key);
}

export type { PermissionKey };
