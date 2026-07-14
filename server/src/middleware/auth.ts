/**
 * Authentication (who are you) and authorization helpers (may you do this).
 * `authenticate` is a Fastify preHandler; the `requireOrgPerm` / `requireNodePerm`
 * helpers are called inside route handlers where the resource id is known.
 */
import type { FastifyRequest } from "fastify";
import { verifyAccessToken } from "../lib/tokens.js";
import { queryOne } from "../db/pool.js";
import { unauthorized, forbidden, notFound } from "../lib/errors.js";
import {
  loadOrgContext,
  orgHasPermission,
  resolveNodeAccess,
  nodeHasPermission,
  type OrgContext,
  type NodeAccess,
} from "../rbac/engine.js";

export interface AuthUser {
  id: string;
  fingerprint: string;
  email: string;
  displayName: string;
}

declare module "fastify" {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/** preHandler: require a valid Bearer access token; attach req.user. */
export async function authenticate(req: FastifyRequest): Promise<void> {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) throw unauthorized();
  const claims = verifyAccessToken(header.slice("Bearer ".length).trim());
  if (!claims) throw unauthorized("Jeton invalide ou expiré.");

  const user = await queryOne<{ id: string; fingerprint: string; email: string; display_name: string; status: string }>(
    `SELECT id, fingerprint, email, display_name, status FROM users WHERE id = $1`,
    [claims.sub],
  );
  if (!user || user.status !== "active") throw unauthorized("Compte introuvable ou désactivé.");
  req.user = { id: user.id, fingerprint: user.fingerprint, email: user.email, displayName: user.display_name };
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

/** Load org context and assert a permission; returns the context for reuse. */
export async function requireOrgPerm(req: FastifyRequest, orgId: string, perm: string): Promise<OrgContext> {
  const user = requireUser(req);
  const ctx = await loadOrgContext(user.id, orgId);
  if (!ctx) throw forbidden("Vous n'êtes pas membre de cette organisation.");
  if (!orgHasPermission(ctx, perm)) throw forbidden(`Permission requise : ${perm}.`);
  return ctx;
}

/** Assert active membership of the org (any role). For non-sensitive reads that
 *  every member needs — e.g. the role list, required to render sharing UIs and
 *  to attach a role to a node key when creating/sharing content. */
export async function requireMembership(req: FastifyRequest, orgId: string): Promise<OrgContext> {
  const user = requireUser(req);
  const ctx = await loadOrgContext(user.id, orgId);
  if (!ctx) throw forbidden("Vous n'êtes pas membre de cette organisation.");
  return ctx;
}

/** Load node access and assert a node permission; returns the access for reuse. */
export async function requireNodePerm(req: FastifyRequest, nodeId: string, perm: string): Promise<NodeAccess> {
  const user = requireUser(req);
  const access = await resolveNodeAccess(user.id, nodeId);
  if (!access || !access.accessible) throw notFound(); // don't reveal existence
  if (!nodeHasPermission(access, perm)) throw forbidden(`Permission requise : ${perm}.`);
  return access;
}
