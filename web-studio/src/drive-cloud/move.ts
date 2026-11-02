/**
 * Déplacement d'un nœud AVEC ses parts de clé.
 *
 * Au déplacement, le serveur supprime toutes les parts HÉRITÉES (`inherited_from` non nul) du
 * sous-arbre — il ne peut pas en recréer : il n'a pas les CEK. Sans ré-emballage côté client, les
 * collaborateurs d'un dossier partagé perdaient la clé d'un fichier simplement glissé d'un sous-dossier
 * à un autre (fichier invisible, « Clé du nœud indisponible »).
 *
 * Ici, comme à la création d'un nœud (`inheritedShares`), chaque nœud du sous-arbre reçoit, après
 * le déplacement, une part pour chaque principal de l'ACL de son (nouveau) parent qu'il n'a pas déjà.
 * Les CEK sont lues AVANT le déplacement : celui qui déplace peut lui-même ne tenir sa part que par
 * héritage, part que le serveur vient de supprimer.
 */
import type { OpsCtx, DriveEntry } from "./ops";
import { listFolder, nodeKeyFrom } from "./ops";
import { wrapNodeKeyFor } from "./node-crypto";
import { makePrincipalResolver, type PrincipalKeyResolver } from "./principal-keys";
import type { ShareInfo } from "./types";

export interface MoveStats {
  /** Parts de clé recréées pour des ayants droit du nouvel emplacement. */
  rewrapped: number;
  /** Parts qui n'ont pas pu être recréées (droits, clé introuvable, réseau) : à repartager à la main. */
  failed: number;
}

interface SubtreeNode {
  id: string;
  parentId: string | null;
  key: Uint8Array | null;
}

/** Sous-arbre (corbeille comprise) en ordre parent → enfants, avec les CEK que l'on peut ouvrir. */
async function collectSubtree(ctx: OpsCtx, root: DriveEntry): Promise<SubtreeNode[]> {
  const out: SubtreeNode[] = [];
  const walk = async (e: DriveEntry, parentId: string | null) => {
    out.push({ id: e.id, parentId, key: await nodeKeyFrom(ctx, e.myWrappedKey) });
    if (e.kind !== "folder") return;
    const children = [
      ...(await listFolder(ctx, e.id).catch(() => [] as DriveEntry[])),
      ...(await listFolder(ctx, e.id, true).catch(() => [] as DriveEntry[])),
    ];
    for (const c of children) await walk(c, e.id);
  };
  await walk(root, root.parentId);
  return out;
}

const principalKey = (s: { principalType: string; principalId: string }) => `${s.principalType}:${s.principalId}`;

/**
 * Recrée, pour chaque nœud de `nodes` (ordre parent → enfants), les parts héritées de son parent.
 * Exporté pour les tests ; `moveWithKeyShares` est le point d'entrée de l'interface.
 */
export async function refanInheritedShares(
  ctx: OpsCtx,
  nodes: SubtreeNode[],
  resolver: PrincipalKeyResolver,
): Promise<MoveStats> {
  const stats: MoveStats = { rewrapped: 0, failed: 0 };
  for (const n of nodes) {
    if (!n.parentId) continue; // racine du Drive : seules les parts directes s'appliquent
    let parentRows: ShareInfo[];
    let own: ShareInfo[];
    try {
      parentRows = ((await ctx.api.listShares(n.parentId)) as unknown as { shares: ShareInfo[] }).shares ?? [];
      own = ((await ctx.api.listShares(n.id)) as unknown as { shares: ShareInfo[] }).shares ?? [];
    } catch {
      stats.failed++;
      continue;
    }
    const have = new Set(own.map(principalKey));
    const missing = parentRows.filter((r) => !have.has(principalKey(r)));
    if (!missing.length) continue;
    if (!n.key) {
      stats.failed += missing.length;
      continue;
    }
    for (const r of missing) {
      try {
        const pub = await resolver.resolve(r);
        if (!pub) {
          stats.failed++;
          continue;
        }
        await ctx.api.share(n.id, {
          principalType: r.principalType,
          principalId: r.principalId,
          roleId: r.roleId,
          wrappedKey: await wrapNodeKeyFor(n.key, pub),
          inheritedFrom: r.inheritedFrom ?? n.parentId,
        });
        stats.rewrapped++;
      } catch {
        stats.failed++;
      }
    }
  }
  return stats;
}

/** Déplace `entry` sous `newParentId` puis ré-emballe les parts héritées sur tout le sous-arbre. */
export async function moveWithKeyShares(
  ctx: OpsCtx,
  entry: DriveEntry,
  newParentId: string | null,
  resolver: PrincipalKeyResolver = makePrincipalResolver(ctx),
): Promise<MoveStats> {
  const nodes = await collectSubtree(ctx, entry);
  await ctx.api.patchNode(entry.id, { parentId: newParentId });
  nodes[0]!.parentId = newParentId;
  return refanInheritedShares(ctx, nodes, resolver);
}
