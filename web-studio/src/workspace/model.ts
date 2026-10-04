/**
 * Logique PURE de l'espace de travail : arbre de dossiers, corbeille, tri,
 * filtres, réconciliation catalogue ↔ contenus. Aucune dépendance au
 * navigateur : tout est testé dans tests/workspace-model.test.ts.
 */
import { TRASH_RETENTION_DAYS, type ContentStoreId, type ItemKind, type WorkFolder, type WorkItem } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Dossiers
// ---------------------------------------------------------------------------

export function isTrashed(x: { trashedAt?: string }): boolean {
  return !!x.trashedAt;
}

/** Sous-dossiers directs (hors corbeille par défaut), triés par nom. */
export function childFolders(folders: WorkFolder[], parentId: string | null, includeTrashed = false): WorkFolder[] {
  return folders
    .filter((f) => f.parentId === parentId && (includeTrashed || !f.trashedAt))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
}

/** Identifiants de tous les descendants d'un dossier (le dossier lui-même exclu). */
export function descendantFolderIds(folders: WorkFolder[], id: string): string[] {
  const out: string[] = [];
  const byParent = new Map<string | null, WorkFolder[]>();
  for (const f of folders) byParent.set(f.parentId, [...(byParent.get(f.parentId) ?? []), f]);
  const stack = [id];
  const seen = new Set<string>([id]);
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of byParent.get(cur) ?? []) {
      if (seen.has(c.id)) continue; // protège d'un cycle déjà corrompu
      seen.add(c.id);
      out.push(c.id);
      stack.push(c.id);
    }
  }
  return out;
}

/** Chemin racine → dossier (liste vide pour la racine ou un id inconnu). */
export function folderPath(folders: WorkFolder[], id: string | null): WorkFolder[] {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const path: WorkFolder[] = [];
  const seen = new Set<string>();
  let cur = id ? byId.get(id) : undefined;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    path.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return path;
}

export type MoveCheck = { ok: true } | { ok: false; reason: "self" | "descendant" | "missing" | "trashed" };

/** Un dossier peut-il être déplacé sous `target` (null = racine) ? Interdit : lui-même, un de ses descendants. */
export function canMoveFolder(folders: WorkFolder[], id: string, target: string | null): MoveCheck {
  if (!folders.some((f) => f.id === id)) return { ok: false, reason: "missing" };
  if (target === null) return { ok: true };
  if (target === id) return { ok: false, reason: "self" };
  const dest = folders.find((f) => f.id === target);
  if (!dest) return { ok: false, reason: "missing" };
  if (dest.trashedAt) return { ok: false, reason: "trashed" };
  if (descendantFolderIds(folders, id).includes(target)) return { ok: false, reason: "descendant" };
  return { ok: true };
}

/** Éléments directement dans un dossier (null = racine), hors corbeille. */
export function itemsIn(items: WorkItem[], folderId: string | null): WorkItem[] {
  return items.filter((i) => !i.trashedAt && i.folderId === folderId);
}

// ---------------------------------------------------------------------------
// Noms
// ---------------------------------------------------------------------------

/** « Rapport », « Rapport (2) », « Rapport (3) »… — premier nom libre parmi `existing` (insensible à la casse). */
export function uniqueName(desired: string, existing: string[]): string {
  const taken = new Set(existing.map((s) => s.trim().toLowerCase()));
  const base = desired.trim() || "Sans titre";
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

/** Nom d'une copie : « Copie de Rapport », puis « Copie de Rapport (2) »… */
export function copyName(title: string, existing: string[], prefix = "Copie de "): string {
  const stripped = title.startsWith(prefix) ? title.slice(prefix.length) : title;
  return uniqueName(prefix + stripped, existing);
}

export function normalizeTag(raw: string): string {
  return raw.trim().replace(/^#+/, "").replace(/\s+/g, " ").toLowerCase().slice(0, 40);
}

export function normalizeTags(raw: string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const t = normalizeTag(r);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function collectTags(items: WorkItem[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const i of items) {
    if (i.trashedAt) continue;
    for (const t of i.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ---------------------------------------------------------------------------
// Corbeille
// ---------------------------------------------------------------------------

export interface TrashPlan {
  items: Map<string, Partial<WorkItem> & { trashedAt?: string | undefined; trashedBy?: string | undefined }>;
  folders: Map<string, Partial<WorkFolder> & { trashedAt?: string | undefined; trashedBy?: string | undefined }>;
}

/**
 * Mise à la corbeille. Un dossier emporte son contenu : sous-dossiers et
 * éléments reçoivent `trashedBy = dossier` (et la même date) pour que la
 * restauration du dossier les ramène ensemble. Un élément déjà à la corbeille
 * individuellement garde sa propre date.
 */
export function planTrash(
  items: WorkItem[],
  folders: WorkFolder[],
  sel: { itemIds?: string[]; folderIds?: string[] },
  now: string,
): TrashPlan {
  const plan: TrashPlan = { items: new Map(), folders: new Map() };
  const folderTop = new Set(sel.folderIds ?? []);
  // Un dossier sélectionné dont un ancêtre l'est aussi est déjà emporté par celui-ci.
  for (const fid of folderTop) {
    const f = folders.find((x) => x.id === fid);
    if (!f || f.trashedAt) continue;
    plan.folders.set(fid, { trashedAt: now, trashedBy: undefined });
    const inside = descendantFolderIds(folders, fid);
    for (const d of inside) {
      const df = folders.find((x) => x.id === d)!;
      if (!df.trashedAt && !folderTop.has(d)) plan.folders.set(d, { trashedAt: now, trashedBy: fid });
    }
    const scope = new Set([fid, ...inside]);
    for (const it of items) {
      if (it.trashedAt || it.folderId === null || !scope.has(it.folderId)) continue;
      plan.items.set(it.id, { trashedAt: now, trashedBy: fid });
    }
  }
  for (const id of sel.itemIds ?? []) {
    const it = items.find((x) => x.id === id);
    if (!it || it.trashedAt || plan.items.has(id)) continue;
    plan.items.set(id, { trashedAt: now, trashedBy: undefined });
  }
  return plan;
}

/**
 * Restauration. Restaurer un dossier ramène aussi ce qui est parti avec lui.
 * Un élément/dossier dont le parent est encore à la corbeille (ou n'existe
 * plus) est remonté à la racine plutôt que laissé invisible.
 */
export function planRestore(
  items: WorkItem[],
  folders: WorkFolder[],
  sel: { itemIds?: string[]; folderIds?: string[] },
): TrashPlan {
  const plan: TrashPlan = { items: new Map(), folders: new Map() };
  const folderById = new Map(folders.map((f) => [f.id, f]));
  const restoringFolders = new Set<string>();
  for (const fid of sel.folderIds ?? []) {
    const f = folderById.get(fid);
    if (!f || !f.trashedAt) continue;
    restoringFolders.add(fid);
    plan.folders.set(fid, { trashedAt: undefined, trashedBy: undefined });
    const parent = f.parentId ? folderById.get(f.parentId) : undefined;
    if (f.parentId && (!parent || (parent.trashedAt && !restoringFolders.has(parent.id)))) {
      plan.folders.get(fid)!.parentId = null;
    }
    for (const d of folders)
      if (d.trashedBy === fid) plan.folders.set(d.id, { trashedAt: undefined, trashedBy: undefined });
    for (const it of items)
      if (it.trashedBy === fid) plan.items.set(it.id, { trashedAt: undefined, trashedBy: undefined });
  }
  const aliveAfter = (folderId: string | null): boolean => {
    if (folderId === null) return true;
    const f = folderById.get(folderId);
    if (!f) return false;
    if (plan.folders.has(folderId)) return true; // restauré dans ce même lot
    return !f.trashedAt;
  };
  for (const id of sel.itemIds ?? []) {
    const it = items.find((x) => x.id === id);
    if (!it || !it.trashedAt) continue;
    const patch: Partial<WorkItem> & { trashedAt?: string; trashedBy?: string } = {
      trashedAt: undefined,
      trashedBy: undefined,
    };
    if (!aliveAfter(it.folderId)) patch.folderId = null;
    plan.items.set(id, patch);
  }
  return plan;
}

/** Entrées de premier niveau de la corbeille (ce que l'utilisateur a réellement supprimé). */
export function trashRoots(items: WorkItem[], folders: WorkFolder[]): { items: WorkItem[]; folders: WorkFolder[] } {
  return {
    items: items.filter((i) => i.trashedAt && !i.trashedBy).sort((a, b) => (a.trashedAt! < b.trashedAt! ? 1 : -1)),
    folders: folders.filter((f) => f.trashedAt && !f.trashedBy).sort((a, b) => (a.trashedAt! < b.trashedAt! ? 1 : -1)),
  };
}

export function daysLeftInTrash(trashedAt: string, now: Date, retentionDays = TRASH_RETENTION_DAYS): number {
  const age = (now.getTime() - new Date(trashedAt).getTime()) / DAY_MS;
  return Math.max(0, Math.ceil(retentionDays - age));
}

/** Ce qui dépasse la rétention : entrées de premier niveau périmées + tout ce qui est parti avec elles. */
export function expiredTrash(
  items: WorkItem[],
  folders: WorkFolder[],
  now: Date,
  retentionDays = TRASH_RETENTION_DAYS,
): { itemIds: string[]; folderIds: string[] } {
  const limit = now.getTime() - retentionDays * DAY_MS;
  const expired = (iso: string | undefined) => !!iso && new Date(iso).getTime() <= limit;
  const rootFolders = folders.filter((f) => f.trashedAt && !f.trashedBy && expired(f.trashedAt)).map((f) => f.id);
  const rootSet = new Set(rootFolders);
  return {
    folderIds: folders.filter((f) => rootSet.has(f.id) || (f.trashedBy && rootSet.has(f.trashedBy))).map((f) => f.id),
    itemIds: items
      .filter((i) => (i.trashedAt && !i.trashedBy && expired(i.trashedAt)) || (i.trashedBy && rootSet.has(i.trashedBy)))
      .map((i) => i.id),
  };
}

// ---------------------------------------------------------------------------
// Filtres et tri
// ---------------------------------------------------------------------------

export type SortKey = "title" | "modifiedAt" | "createdAt" | "size" | "kind";

export interface ItemFilter {
  /** Texte libre sur le titre et les étiquettes. */
  query?: string;
  kinds?: ItemKind[];
  /** undefined = n'importe où ; null = racine uniquement ; id = ce dossier (et rien d'autre). */
  folderId?: string | null;
  tag?: string;
  starred?: boolean;
  /** Plage de modification, ISO (jour inclus). */
  modifiedFrom?: string;
  modifiedTo?: string;
  trashed?: boolean;
}

const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();

export function filterItems(items: WorkItem[], f: ItemFilter): WorkItem[] {
  const q = f.query ? fold(f.query.trim()) : "";
  const to = f.modifiedTo ? new Date(f.modifiedTo).getTime() + DAY_MS : Infinity;
  const from = f.modifiedFrom ? new Date(f.modifiedFrom).getTime() : -Infinity;
  return items.filter((i) => {
    if (!!i.trashedAt !== !!f.trashed) return false;
    if (f.kinds && f.kinds.length && !f.kinds.includes(i.kind)) return false;
    if (f.folderId !== undefined && i.folderId !== f.folderId) return false;
    if (f.tag && !i.tags.includes(f.tag)) return false;
    if (f.starred && !i.starred) return false;
    const m = new Date(i.modifiedAt).getTime();
    if (m < from || m >= to) return false;
    if (q && !fold(i.title).includes(q) && !i.tags.some((t) => fold(t).includes(q))) return false;
    return true;
  });
}

export function sortItems(items: WorkItem[], key: SortKey, dir: "asc" | "desc" = "asc"): WorkItem[] {
  const sign = dir === "asc" ? 1 : -1;
  const cmp = (a: WorkItem, b: WorkItem): number => {
    switch (key) {
      case "title":
        return a.title.localeCompare(b.title, undefined, { sensitivity: "base", numeric: true });
      case "size":
        return a.size - b.size;
      case "kind":
        return a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
      case "createdAt":
        return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
      default:
        return a.modifiedAt < b.modifiedAt ? -1 : a.modifiedAt > b.modifiedAt ? 1 : 0;
    }
  };
  return [...items].sort((a, b) => sign * cmp(a, b) || a.id.localeCompare(b.id));
}

/** Éléments ouverts ou modifiés le plus récemment (hors corbeille). */
export function recentItems(items: WorkItem[], limit = 8): WorkItem[] {
  const stamp = (i: WorkItem) => (i.lastOpenedAt && i.lastOpenedAt > i.modifiedAt ? i.lastOpenedAt : i.modifiedAt);
  return items
    .filter((i) => !i.trashedAt)
    .sort((a, b) => (stamp(a) < stamp(b) ? 1 : stamp(a) > stamp(b) ? -1 : 0))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Réconciliation catalogue ↔ contenus
// ---------------------------------------------------------------------------

export interface Reconciliation {
  /** Éléments du catalogue dont le contenu n'existe plus (contenu effacé : coffre réinitialisé…). */
  orphanItemIds: string[];
  /** Contenus sans élément de catalogue (bibliothèque d'avant l'espace de travail). */
  untracked: { store: ContentStoreId; id: string }[];
}

export function reconcile(
  items: Pick<WorkItem, "id" | "contentStore">[],
  contentKeys: Record<ContentStoreId, string[]>,
): Reconciliation {
  const known = new Map<ContentStoreId, Set<string>>();
  for (const it of items) known.set(it.contentStore, (known.get(it.contentStore) ?? new Set()).add(it.id));
  const orphanItemIds: string[] = [];
  for (const it of items) if (!contentKeys[it.contentStore]?.includes(it.id)) orphanItemIds.push(it.id);
  const untracked: Reconciliation["untracked"] = [];
  for (const store of Object.keys(contentKeys) as ContentStoreId[]) {
    const have = known.get(store);
    for (const id of contentKeys[store]) if (!have?.has(id)) untracked.push({ store, id });
  }
  return { orphanItemIds, untracked };
}

export function kindOfStore(store: ContentStoreId): ItemKind {
  return store === "sheets" ? "sheet" : store === "slides" ? "slides" : store === "pdfs" ? "pdf" : "doc";
}

export function storeOfKind(kind: ItemKind): ContentStoreId {
  return kind === "sheet" ? "sheets" : kind === "slides" ? "slides" : kind === "pdf" ? "pdfs" : "drive";
}
