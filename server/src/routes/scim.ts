/**
 * SCIM 2.0 (RFC 7644) — Users provisioning, scoped to one organization by its
 * SCIM bearer token. The IdP uses this to auto-provision and, crucially,
 * DE-provision members (when someone leaves, their membership is suspended and
 * they immediately lose all access, including SSO login).
 *
 * Zero-knowledge caveat: SCIM cannot create end-to-end keys (those are generated
 * client-side from a passphrase). So POST creates an INVITE the person completes
 * by registering; lifecycle ops (PATCH active / DELETE) act on real members.
 *
 * Mounted at "/api"; every route authenticates with the org SCIM token.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { sha256Hex, randomToken } from "../lib/crypto-server.js";
import { unauthorized, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";

interface MemberRow {
  id: string;
  email: string;
  display_name: string;
  status: string;
  membership_status: string;
}

function scimUser(u: MemberRow) {
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    userName: u.email,
    name: { formatted: u.display_name },
    active: u.status === "active" && u.membership_status === "active",
    meta: { resourceType: "User" },
  };
}

/** Resolve the org from the SCIM bearer token, or 401. */
async function orgFromScim(req: FastifyRequest): Promise<string> {
  const h = req.headers.authorization ?? "";
  if (!h.startsWith("Bearer ")) throw unauthorized("Jeton SCIM requis.");
  const org = await queryOne<{ id: string }>(`SELECT id FROM organizations WHERE scim_token_hash = $1`, [sha256Hex(h.slice(7).trim())]);
  if (!org) throw unauthorized("Jeton SCIM invalide.");
  return org.id;
}

const MEMBER_COLS =
  "u.id, u.email, u.display_name, u.status, mem.status AS membership_status";

export default async function scimRoutes(app: FastifyInstance): Promise<void> {
  // --- List / filter members ------------------------------------------------
  app.get("/scim/v2/Users", async (req, reply) => {
    const orgId = await orgFromScim(req);
    const filter = String((req.query as { filter?: string }).filter ?? "");
    const m = /userName eq "([^"]+)"/i.exec(filter);
    const rows = m
      ? await query<MemberRow>(
          `SELECT ${MEMBER_COLS} FROM users u JOIN memberships mem ON mem.user_id = u.id
            WHERE mem.org_id = $1 AND u.email = $2`,
          [orgId, m[1]!.toLowerCase()],
        )
      : await query<MemberRow>(
          `SELECT ${MEMBER_COLS} FROM users u JOIN memberships mem ON mem.user_id = u.id
            WHERE mem.org_id = $1 ORDER BY u.email`,
          [orgId],
        );
    reply.header("content-type", "application/scim+json");
    return { schemas: [LIST_SCHEMA], totalResults: rows.length, startIndex: 1, itemsPerPage: rows.length, Resources: rows.map(scimUser) };
  });

  // --- Get one member -------------------------------------------------------
  app.get("/scim/v2/Users/:id", async (req, reply) => {
    const orgId = await orgFromScim(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await queryOne<MemberRow>(
      `SELECT ${MEMBER_COLS} FROM users u JOIN memberships mem ON mem.user_id = u.id WHERE mem.org_id = $1 AND u.id = $2`,
      [orgId, id],
    );
    if (!row) throw notFound("Utilisateur SCIM introuvable.");
    reply.header("content-type", "application/scim+json");
    return scimUser(row);
  });

  // --- Provision (create) → an invite the person completes by registering ---
  app.post("/scim/v2/Users", async (req, reply) => {
    const orgId = await orgFromScim(req);
    const b = z.object({ userName: z.string().email().max(320), active: z.boolean().optional() }).parse(req.body);
    const email = b.userName.toLowerCase();

    // Idempotent: if already a member, return them.
    const existing = await queryOne<MemberRow>(
      `SELECT ${MEMBER_COLS} FROM users u JOIN memberships mem ON mem.user_id = u.id WHERE mem.org_id = $1 AND u.email = $2`,
      [orgId, email],
    );
    if (existing) {
      reply.code(200).header("content-type", "application/scim+json");
      return scimUser(existing);
    }

    const role = await queryOne<{ id: string }>(`SELECT id FROM roles WHERE org_id = $1 AND key = 'editor'`, [orgId]);
    if (!role) throw notFound("Rôle par défaut introuvable.");
    const token = randomToken(32);
    const invite = await queryOne<{ id: string }>(
      `INSERT INTO invites (org_id, email, role_id, token_hash, expires_at)
       VALUES ($1,$2,$3,$4, now() + interval '30 days') RETURNING id`,
      [orgId, email, role.id, sha256Hex(token)],
    );
    await audit(orgId, null, "scim.user.invite", "invite", invite!.id, { email }, req.ip);
    reply.code(201).header("content-type", "application/scim+json");
    // The invite token lets the person register + join (zero-knowledge: they
    // generate their own keys then). `active:false` until they complete it.
    return {
      schemas: [USER_SCHEMA],
      id: invite!.id,
      userName: email,
      active: false,
      meta: { resourceType: "User" },
      "urn:elium:params:scim:invite": { token },
    };
  });

  // --- De-provision / re-activate (PATCH active) ----------------------------
  app.patch("/scim/v2/Users/:id", async (req, reply) => {
    const orgId = await orgFromScim(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = (req.body ?? {}) as { Operations?: { op?: string; path?: string; value?: unknown }[] };
    // Extract the target `active` from the (verbose) SCIM PATCH operations.
    let active: boolean | undefined;
    for (const op of body.Operations ?? []) {
      if ((op.path ?? "").toLowerCase() === "active") active = op.value === true || op.value === "true";
      else if (op.value && typeof op.value === "object" && "active" in (op.value as Record<string, unknown>)) {
        active = (op.value as { active: unknown }).active === true;
      }
    }
    const row = await queryOne<MemberRow>(
      `SELECT ${MEMBER_COLS} FROM users u JOIN memberships mem ON mem.user_id = u.id WHERE mem.org_id = $1 AND u.id = $2`,
      [orgId, id],
    );
    if (!row) throw notFound("Utilisateur SCIM introuvable.");
    if (active === false) {
      await query(`UPDATE memberships SET status = 'suspended' WHERE org_id = $1 AND user_id = $2`, [orgId, id]);
      await audit(orgId, null, "scim.user.deprovision", "user", id, {}, req.ip);
      row.membership_status = "suspended";
    } else if (active === true) {
      await query(`UPDATE memberships SET status = 'active' WHERE org_id = $1 AND user_id = $2`, [orgId, id]);
      await audit(orgId, null, "scim.user.reactivate", "user", id, {}, req.ip);
      row.membership_status = "active";
    }
    reply.header("content-type", "application/scim+json");
    return scimUser(row);
  });

  // --- De-provision (DELETE) → suspend membership ---------------------------
  app.delete("/scim/v2/Users/:id", async (req, reply) => {
    const orgId = await orgFromScim(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await query(`UPDATE memberships SET status = 'suspended' WHERE org_id = $1 AND user_id = $2 RETURNING id`, [orgId, id]);
    if (!r.length) throw notFound("Utilisateur SCIM introuvable.");
    await audit(orgId, null, "scim.user.deprovision", "user", id, {}, req.ip);
    reply.code(204);
    return null;
  });
}
