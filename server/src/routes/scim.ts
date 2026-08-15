/**
 * SCIM 2.0 (RFC 7644) — Users + Groups provisioning, scoped to one organization
 * by its SCIM bearer token. The IdP uses this to auto-provision and, crucially,
 * DE-provision members (when someone leaves, their membership is suspended and
 * they immediately lose all access, including SSO login).
 *
 * Zero-knowledge caveat: SCIM cannot create end-to-end keys (those are generated
 * client-side from a passphrase). So POST /Users creates an INVITE the person
 * completes by registering; lifecycle ops (PATCH active / DELETE) act on real
 * members. Likewise SCIM /Groups are NOT cryptographic teams (the server can't
 * mint group key material) — they are provisioning metadata + an optional
 * mapping to an Elium role (organizations.settings.scim.groupRoleMap).
 *
 * The provisioning role is configurable per org (settings.scim.defaultRoleKey,
 * default "editor"). A member of ≥1 mapped SCIM group is assigned the
 * most-privileged mapped role on their org membership (authoritative for mapped
 * users; being in no mapped group leaves the current role untouched).
 *
 * Mounted at "/api"; every route authenticates with the org SCIM token.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { sha256Hex, randomToken } from "../lib/crypto-server.js";
import { unauthorized, notFound } from "../lib/errors.js";
import { audit } from "../lib/audit.js";
import { DEFAULT_MEMBER_ROLE_KEY } from "../rbac/roles.js";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const org = await queryOne<{ id: string }>(`SELECT id FROM organizations WHERE scim_token_hash = $1`, [
    sha256Hex(h.slice(7).trim()),
  ]);
  if (!org) throw unauthorized("Jeton SCIM invalide.");
  return org.id;
}

const MEMBER_COLS = "u.id, u.email, u.display_name, u.status, mem.status AS membership_status";

// --- Provisioning-role configuration + group→role mapping ------------------

export interface ScimConfig {
  defaultRoleKey: string;
  groupRoleMap: Record<string, string>; // SCIM group displayName -> Elium role key
}

async function resolveScimConfig(orgId: string): Promise<ScimConfig> {
  const row = await queryOne<{ settings: { scim?: Partial<ScimConfig> } | null }>(
    `SELECT settings FROM organizations WHERE id = $1`,
    [orgId],
  );
  const scim = row?.settings?.scim ?? {};
  return {
    defaultRoleKey: scim.defaultRoleKey || DEFAULT_MEMBER_ROLE_KEY,
    groupRoleMap: scim.groupRoleMap ?? {},
  };
}

async function roleIdByKey(orgId: string, key: string): Promise<string | null> {
  const r = await queryOne<{ id: string }>(`SELECT id FROM roles WHERE org_id = $1 AND key = $2`, [orgId, key]);
  return r?.id ?? null;
}

/** Pure: pick the role granting the most permissions (tie-break: role key asc). */
export function mostPrivilegedRole(roles: { key: string; permCount: number; roleId: string }[]): string | null {
  if (roles.length === 0) return null;
  return [...roles].sort((a, b) => b.permCount - a.permCount || a.key.localeCompare(b.key))[0]!.roleId;
}

/** The mapped roles a given email inherits from its SCIM group memberships. */
async function mappedRolesForEmail(orgId: string, email: string, map: Record<string, string>) {
  if (Object.keys(map).length === 0) return [] as { key: string; roleId: string; permCount: number }[];
  const rows = await query<{ key: string; role_id: string; pc: number }>(
    `SELECT r.key, r.id AS role_id, cardinality(r.permissions) AS pc
       FROM scim_group_members gm
       JOIN scim_groups g ON g.id = gm.group_id AND g.org_id = $1
       JOIN roles r ON r.org_id = $1 AND r.key = ($3::jsonb ->> g.display_name)
      WHERE gm.email = $2`,
    [orgId, email, JSON.stringify(map)],
  );
  return rows.map((r) => ({ key: r.key, roleId: r.role_id, permCount: Number(r.pc) }));
}

/**
 * Recompute one member's role from their mapped SCIM groups. Authoritative for
 * users in ≥1 mapped group (assigns the most-privileged mapped role, downgrades
 * included); a user in NO mapped group is left untouched (no auto-demotion when
 * a group is removed — avoids clobbering a manual role). Applies to the active
 * membership AND to a pending invite (so the role is right on acceptance).
 */
async function recomputeRoleForEmail(orgId: string, email: string, map: Record<string, string>): Promise<void> {
  const mapped = await mappedRolesForEmail(orgId, email, map);
  if (mapped.length === 0) return;
  const roleId = mostPrivilegedRole(mapped);
  if (!roleId) return;
  await query(
    `UPDATE memberships mem SET role_id = $3
       FROM users u WHERE u.id = mem.user_id AND mem.org_id = $1 AND u.email = $2`,
    [orgId, email, roleId],
  );
  await query(`UPDATE invites SET role_id = $3 WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL`, [
    orgId,
    email,
    roleId,
  ]);
}

/** Resolve a SCIM member `value` (a user id or an invite id) to an email. */
async function emailForScimValue(orgId: string, value: string): Promise<string | null> {
  if (!UUID_RE.test(value)) return null;
  const r = await queryOne<{ email: string }>(
    `SELECT u.email FROM users u JOIN memberships m ON m.user_id = u.id WHERE u.id = $1 AND m.org_id = $2
     UNION SELECT email FROM invites WHERE id = $1 AND org_id = $2
     LIMIT 1`,
    [value, orgId],
  );
  return r?.email ?? null;
}

/** Recompute every SCIM-group member's role for an org (after a config change). */
export async function resyncOrgGroupRoles(orgId: string): Promise<void> {
  const { groupRoleMap } = await resolveScimConfig(orgId);
  const emails = await query<{ email: string }>(
    `SELECT DISTINCT gm.email FROM scim_group_members gm JOIN scim_groups g ON g.id = gm.group_id WHERE g.org_id = $1`,
    [orgId],
  );
  for (const { email } of emails) await recomputeRoleForEmail(orgId, email, groupRoleMap);
}

interface GroupRow {
  id: string;
  external_id: string | null;
  display_name: string;
}
interface GroupMemberRow {
  email: string;
  member_value: string | null;
}

function scimGroup(g: GroupRow, members: GroupMemberRow[]) {
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    displayName: g.display_name,
    ...(g.external_id ? { externalId: g.external_id } : {}),
    members: members.map((m) => ({ value: m.member_value ?? m.email, display: m.email })),
    meta: { resourceType: "Group" },
  };
}

async function groupMembers(groupId: string): Promise<GroupMemberRow[]> {
  return query<GroupMemberRow>(
    `SELECT email, member_value FROM scim_group_members WHERE group_id = $1 ORDER BY email`,
    [groupId],
  );
}

/** Insert the given SCIM members into a group; returns the emails touched. */
async function addGroupMembers(orgId: string, groupId: string, members: { value?: string }[]): Promise<string[]> {
  const emails: string[] = [];
  for (const m of members) {
    if (!m?.value) continue;
    const email = await emailForScimValue(orgId, m.value);
    if (!email) continue; // unknown SCIM resource — ignore defensively
    await query(
      `INSERT INTO scim_group_members (group_id, email, member_value) VALUES ($1, $2, $3)
         ON CONFLICT (group_id, email) DO UPDATE SET member_value = EXCLUDED.member_value`,
      [groupId, email, m.value],
    );
    emails.push(email);
  }
  return emails;
}

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
    return {
      schemas: [LIST_SCHEMA],
      totalResults: rows.length,
      startIndex: 1,
      itemsPerPage: rows.length,
      Resources: rows.map(scimUser),
    };
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

    // Role = the most-privileged role mapped from the person's SCIM groups (if
    // any were provisioned first), else the org's configured default role.
    const { defaultRoleKey, groupRoleMap } = await resolveScimConfig(orgId);
    const mapped = await mappedRolesForEmail(orgId, email, groupRoleMap);
    let roleId = mapped.length ? mostPrivilegedRole(mapped) : await roleIdByKey(orgId, defaultRoleKey);
    if (!roleId) roleId = await roleIdByKey(orgId, DEFAULT_MEMBER_ROLE_KEY);
    if (!roleId) throw notFound("Rôle par défaut introuvable.");

    const token = randomToken(32);
    const invite = await queryOne<{ id: string }>(
      `INSERT INTO invites (org_id, email, role_id, token_hash, expires_at)
       VALUES ($1,$2,$3,$4, now() + interval '30 days') RETURNING id`,
      [orgId, email, roleId, sha256Hex(token)],
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
    const r = await query(
      `UPDATE memberships SET status = 'suspended' WHERE org_id = $1 AND user_id = $2 RETURNING id`,
      [orgId, id],
    );
    if (!r.length) throw notFound("Utilisateur SCIM introuvable.");
    await audit(orgId, null, "scim.user.deprovision", "user", id, {}, req.ip);
    reply.code(204);
    return null;
  });

  // === Groups ================================================================
  // NOT cryptographic teams — provisioning metadata + optional role mapping.

  app.get("/scim/v2/Groups", async (req, reply) => {
    const orgId = await orgFromScim(req);
    const filter = String((req.query as { filter?: string }).filter ?? "");
    const m = /displayName eq "([^"]+)"/i.exec(filter);
    const groups = m
      ? await query<GroupRow>(
          `SELECT id, external_id, display_name FROM scim_groups WHERE org_id = $1 AND display_name = $2`,
          [orgId, m[1]!],
        )
      : await query<GroupRow>(
          `SELECT id, external_id, display_name FROM scim_groups WHERE org_id = $1 ORDER BY display_name`,
          [orgId],
        );
    const resources = await Promise.all(groups.map(async (g) => scimGroup(g, await groupMembers(g.id))));
    reply.header("content-type", "application/scim+json");
    return {
      schemas: [LIST_SCHEMA],
      totalResults: resources.length,
      startIndex: 1,
      itemsPerPage: resources.length,
      Resources: resources,
    };
  });

  app.get("/scim/v2/Groups/:id", async (req, reply) => {
    const orgId = await orgFromScim(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const g = await queryOne<GroupRow>(
      `SELECT id, external_id, display_name FROM scim_groups WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    if (!g) throw notFound("Groupe SCIM introuvable.");
    reply.header("content-type", "application/scim+json");
    return scimGroup(g, await groupMembers(g.id));
  });

  app.post("/scim/v2/Groups", async (req, reply) => {
    const orgId = await orgFromScim(req);
    const b = z
      .object({
        displayName: z.string().min(1).max(256),
        externalId: z.string().max(256).optional(),
        members: z
          .array(z.object({ value: z.string().max(256).optional() }))
          .max(5000)
          .optional(),
      })
      .parse(req.body);

    // Idempotent on (org, displayName).
    const existing = await queryOne<GroupRow>(
      `SELECT id, external_id, display_name FROM scim_groups WHERE org_id = $1 AND display_name = $2`,
      [orgId, b.displayName],
    );
    let group = existing;
    if (!group) {
      group = await queryOne<GroupRow>(
        `INSERT INTO scim_groups (org_id, external_id, display_name) VALUES ($1,$2,$3)
           RETURNING id, external_id, display_name`,
        [orgId, b.externalId ?? null, b.displayName],
      );
    }
    const emails = await addGroupMembers(orgId, group!.id, b.members ?? []);
    const { groupRoleMap } = await resolveScimConfig(orgId);
    for (const email of emails) await recomputeRoleForEmail(orgId, email, groupRoleMap);
    await audit(
      orgId,
      null,
      "scim.group.create",
      "group",
      group!.id,
      { displayName: b.displayName, members: emails.length },
      req.ip,
    );
    reply.code(existing ? 200 : 201).header("content-type", "application/scim+json");
    return scimGroup(group!, await groupMembers(group!.id));
  });

  // Replace (PUT): displayName + full member set.
  app.put("/scim/v2/Groups/:id", async (req, reply) => {
    const orgId = await orgFromScim(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        displayName: z.string().min(1).max(256),
        externalId: z.string().max(256).optional(),
        members: z
          .array(z.object({ value: z.string().max(256).optional() }))
          .max(5000)
          .optional(),
      })
      .parse(req.body);
    const g = await queryOne<GroupRow>(
      `SELECT id, external_id, display_name FROM scim_groups WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    if (!g) throw notFound("Groupe SCIM introuvable.");

    const before = (await groupMembers(g.id)).map((m) => m.email);
    await query(`UPDATE scim_groups SET display_name = $2, external_id = $3, updated_at = now() WHERE id = $1`, [
      id,
      b.displayName,
      b.externalId ?? null,
    ]);
    await query(`DELETE FROM scim_group_members WHERE group_id = $1`, [id]);
    const added = await addGroupMembers(orgId, id, b.members ?? []);

    const { groupRoleMap } = await resolveScimConfig(orgId);
    for (const email of new Set([...before, ...added])) await recomputeRoleForEmail(orgId, email, groupRoleMap);
    await audit(
      orgId,
      null,
      "scim.group.replace",
      "group",
      id,
      { displayName: b.displayName, members: added.length },
      req.ip,
    );
    const g2 = await queryOne<GroupRow>(`SELECT id, external_id, display_name FROM scim_groups WHERE id = $1`, [id]);
    reply.header("content-type", "application/scim+json");
    return scimGroup(g2!, await groupMembers(id));
  });

  // Patch (PATCH): add / remove members, replace displayName.
  app.patch("/scim/v2/Groups/:id", async (req, reply) => {
    const orgId = await orgFromScim(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const g = await queryOne<GroupRow>(
      `SELECT id, external_id, display_name FROM scim_groups WHERE id = $1 AND org_id = $2`,
      [id, orgId],
    );
    if (!g) throw notFound("Groupe SCIM introuvable.");
    const body = (req.body ?? {}) as { Operations?: { op?: string; path?: string; value?: unknown }[] };

    const touched = new Set<string>();
    const asMembers = (v: unknown): { value?: string }[] => {
      if (Array.isArray(v)) return v as { value?: string }[];
      if (v && typeof v === "object" && Array.isArray((v as { members?: unknown }).members)) {
        return (v as { members: { value?: string }[] }).members;
      }
      return [];
    };

    for (const op of body.Operations ?? []) {
      const opName = (op.op ?? "").toLowerCase();
      const path = op.path ?? "";
      if (/^displayname$/i.test(path) && opName === "replace" && typeof op.value === "string") {
        await query(`UPDATE scim_groups SET display_name = $2, updated_at = now() WHERE id = $1`, [id, op.value]);
        for (const m of await groupMembers(id)) touched.add(m.email);
      } else if (opName === "remove" && /^members\[/i.test(path)) {
        const mm = /value eq "([^"]+)"/i.exec(path);
        if (mm) {
          const email = await emailForScimValue(orgId, mm[1]!);
          if (email) {
            await query(`DELETE FROM scim_group_members WHERE group_id = $1 AND email = $2`, [id, email]);
            touched.add(email);
          }
        }
      } else if (/^members$/i.test(path) || !path) {
        if (opName === "add") {
          for (const e of await addGroupMembers(orgId, id, asMembers(op.value))) touched.add(e);
        } else if (opName === "replace") {
          for (const m of await groupMembers(id)) touched.add(m.email);
          await query(`DELETE FROM scim_group_members WHERE group_id = $1`, [id]);
          for (const e of await addGroupMembers(orgId, id, asMembers(op.value))) touched.add(e);
        } else if (opName === "remove") {
          for (const m of await groupMembers(id)) touched.add(m.email);
          await query(`DELETE FROM scim_group_members WHERE group_id = $1`, [id]);
        }
      }
    }

    const { groupRoleMap } = await resolveScimConfig(orgId);
    for (const email of touched) await recomputeRoleForEmail(orgId, email, groupRoleMap);
    await audit(orgId, null, "scim.group.patch", "group", id, { touched: touched.size }, req.ip);
    const g2 = await queryOne<GroupRow>(`SELECT id, external_id, display_name FROM scim_groups WHERE id = $1`, [id]);
    reply.header("content-type", "application/scim+json");
    return scimGroup(g2!, await groupMembers(id));
  });

  app.delete("/scim/v2/Groups/:id", async (req, reply) => {
    const orgId = await orgFromScim(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await query(`DELETE FROM scim_groups WHERE id = $1 AND org_id = $2 RETURNING id`, [id, orgId]);
    if (!r.length) throw notFound("Groupe SCIM introuvable.");
    await audit(orgId, null, "scim.group.delete", "group", id, {}, req.ip);
    reply.code(204);
    return null;
  });
}
