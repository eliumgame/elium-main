/**
 * Résolution des clés publiques des principaux d'une ACL (utilisateur, équipe, organisation), commune
 * à la création de nœud (parts héritées), au déplacement (ré-emballage) et à la rotation.
 *
 * - Équipes : `GET /groups` exige `group.view` (absent du rôle Éditeur) → repli sur `GET /group-keys`
 *   (ouvert à tout membre), sinon un Éditeur qui révoque un accès effacerait les parts des équipes.
 * - Chaque clé est passée à l'épinglage TOFU (`key-pins.ts`) : un changement lève une alerte visible.
 * - Les erreurs NE SONT PAS avalées ici : c'est à l'appelant de décider (la rotation doit s'arrêter si
 *   une part restante ne peut pas être ré-emballée, au lieu de la supprimer en silence).
 */
import type { OpsCtx } from "./ops";
import { requireKeyPin, type PinKind } from "./key-pins";

export interface PrincipalRef {
  principalType: "user" | "group" | "org";
  principalId: string;
}

export interface PrincipalKeyResolver {
  /** Clé publique P-256 du principal, ou `null` s'il est introuvable (aucune clé connue). Lève sur erreur réseau. */
  resolve(p: PrincipalRef): Promise<string | null>;
}

type GroupKeyRow = { id: string; groupPublicHex: string; name?: string };

export function makePrincipalResolver(ctx: Pick<OpsCtx, "api" | "orgId" | "orgPublicHex">): PrincipalKeyResolver {
  let groups: Promise<GroupKeyRow[]> | null = null;
  const loadGroups = () =>
    (groups ??= (async () => {
      try {
        return ((await ctx.api.listGroups(ctx.orgId)).groups ?? []) as GroupKeyRow[];
      } catch {
        return ((await ctx.api.groupKeys(ctx.orgId)).groups ?? []) as GroupKeyRow[];
      }
    })().catch((e: unknown) => {
      groups = null; // ne pas mémoriser un échec transitoire
      throw e;
    }));
  const pinned = (kind: PinKind, id: string, pub: string | null | undefined, label?: string) => {
    if (!pub) return null;
    requireKeyPin(kind, id, pub, label);
    return pub;
  };
  return {
    async resolve(p) {
      if (p.principalType === "user") {
        const { user } = await ctx.api.getUser(p.principalId);
        return pinned("user", p.principalId, user?.p256PublicHex, user?.email);
      }
      if (p.principalType === "group") {
        const g = (await loadGroups()).find((x) => x.id === p.principalId);
        return pinned("group", p.principalId, g?.groupPublicHex, g?.name);
      }
      return pinned("org", ctx.orgId, ctx.orgPublicHex || null);
    },
  };
}
