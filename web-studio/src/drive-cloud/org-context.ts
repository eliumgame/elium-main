import type { OpsCtx } from "./ops";
import { requireKeyPin } from "./key-pins";

/** Re-read before wrapping, then send that epoch to the server's atomic precondition. */
export async function freshOrgContext(ctx: OpsCtx): Promise<OpsCtx> {
  if (typeof ctx.api.listOrgs !== "function") return ctx;
  const { organizations } = await ctx.api.listOrgs();
  const org = (organizations as { id: string; orgPublicHex: string; orgKeyEpoch: number }[]).find((o) => o.id === ctx.orgId);
  if (!org) throw new Error("Organisation inaccessible.");
  if (org.orgPublicHex) requireKeyPin("org", org.id, org.orgPublicHex);
  if (!Number.isSafeInteger(org.orgKeyEpoch) || org.orgKeyEpoch < 0) throw new Error("Époque de clé d'organisation absente : mettez à jour le serveur.");
  return { ...ctx, orgPublicHex: org.orgPublicHex, orgKeyEpoch: org.orgKeyEpoch };
}
