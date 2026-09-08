/**
 * Real-behavior tests for the anti-N+1 SCIM batching in src/routes/scim.ts —
 * `addGroupMembers` (exercised via POST /scim/v2/Groups, the route that calls
 * it) and `resyncOrgGroupRoles` (exported directly). Before this file, only
 * the pure helper `mostPrivilegedRole` had any coverage (tests/scim.test.ts);
 * the batched resolve-then-UNNEST-insert/update behavior introduced when the
 * per-member query loops were replaced was never actually exercised.
 * DB is mocked (SQL-text dispatch), matching tests/orgs.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const ORG = "00000000-0000-4000-8000-0000000000cc";
const GROUP = "00000000-0000-4000-8000-0000000000d3";
const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000a2";

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
  closePool: vi.fn(async () => {}),
}));

vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));

import { query, queryOne } from "../src/db/pool.js";
import { ApiError } from "../src/lib/errors.js";
import scimRoutes, { resyncOrgGroupRoles } from "../src/routes/scim.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);

async function makeApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: "bad_request", message: "validation" } });
    }
    return reply.status(500).send({ error: { code: "internal", message: err.message } });
  });
  await app.register(scimRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

const AUTH = { authorization: "Bearer test-scim-token" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /scim/v2/Groups — addGroupMembers batching", () => {
  /** Wires the queryOne/query branches common to every test in this block:
   * org-token lookup, new-group insert, empty scim config (groupRoleMap={})
   * so recomputeRoleForEmail's mappedRolesForEmail JOIN comes back empty and
   * short-circuits with no further writes — isolating the assertions to
   * addGroupMembers itself. */
  function wireBaseline() {
    mQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("scim_token_hash")) return { id: ORG } as never; // orgFromScim
      if (sql.includes("FROM scim_groups WHERE org_id")) return null as never; // no existing group (idempotent check)
      if (sql.includes("INSERT INTO scim_groups"))
        return { id: GROUP, external_id: null, display_name: "Eng" } as never;
      if (sql.includes("SELECT settings FROM organizations")) return { settings: {} } as never; // resolveScimConfig: empty map
      return null as never;
    });
  }

  it("resolves all member values in ONE query and inserts all rows in ONE query (not per-member)", async () => {
    wireBaseline();
    const resolveCalls: string[] = [];
    const insertCalls: unknown[][] = [];
    mQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM users u JOIN memberships")) {
        resolveCalls.push(sql);
        return [
          { val: USER_A, email: "a@example.org" },
          { val: USER_B, email: "b@example.org" },
        ] as never;
      }
      if (sql.includes("INSERT INTO scim_group_members")) {
        insertCalls.push(params ?? []);
        return [] as never;
      }
      if (sql.includes("FROM scim_group_members gm")) return [] as never; // mappedRolesForEmail (empty map -> [])
      if (sql.includes("SELECT email, member_value")) return [] as never; // final groupMembers() for the response
      return [] as never;
    });

    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/scim/v2/Groups",
      headers: AUTH,
      payload: { displayName: "Eng", members: [{ value: USER_A }, { value: USER_B }] },
    });
    expect(res.statusCode).toBe(201);
    expect(resolveCalls).toHaveLength(1); // ONE resolution query for both members, not two
    expect(insertCalls).toHaveLength(1); // ONE multi-row insert, not two
    // group_id + parallel arrays of (email, member_value) — both rows present in one call.
    const [groupIdArg, emails, values] = insertCalls[0]!;
    expect(groupIdArg).toBe(GROUP);
    expect(emails).toEqual(expect.arrayContaining(["a@example.org", "b@example.org"]));
    expect(values).toEqual(expect.arrayContaining([USER_A, USER_B]));
  });

  it("last member wins when two members resolve to the same email (dedup before INSERT)", async () => {
    wireBaseline();
    let insertParams: unknown[] = [];
    mQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM users u JOIN memberships")) {
        // Both SCIM values resolve to the SAME email (e.g. re-invited under a new id).
        return [
          { val: USER_A, email: "shared@example.org" },
          { val: USER_B, email: "shared@example.org" },
        ] as never;
      }
      if (sql.includes("INSERT INTO scim_group_members")) {
        insertParams = params ?? [];
        return [] as never;
      }
      if (sql.includes("FROM scim_group_members gm")) return [] as never;
      if (sql.includes("SELECT email, member_value")) return [] as never;
      return [] as never;
    });

    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/scim/v2/Groups",
      headers: AUTH,
      payload: { displayName: "Eng", members: [{ value: USER_A }, { value: USER_B }] },
    });
    expect(res.statusCode).toBe(201);
    const [, emails, values] = insertParams;
    expect(emails).toEqual(["shared@example.org"]); // one row, not a duplicate-key insert
    expect(values).toEqual([USER_B]); // the LATER member (B) wins, matching the old per-member ON CONFLICT loop
  });

  it("silently skips a member value that resolves to no known user or invite", async () => {
    wireBaseline();
    let insertCalled = false;
    mQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM users u JOIN memberships")) return [] as never; // nothing resolves
      if (sql.includes("INSERT INTO scim_group_members")) {
        insertCalled = true;
        return [] as never;
      }
      if (sql.includes("FROM scim_group_members gm")) return [] as never;
      if (sql.includes("SELECT email, member_value")) return [] as never;
      return [] as never;
    });

    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/scim/v2/Groups",
      headers: AUTH,
      payload: { displayName: "Eng", members: [{ value: "00000000-0000-4000-8000-000000000099" }] },
    });
    expect(res.statusCode).toBe(201);
    expect(insertCalled).toBe(false); // no rows resolved -> INSERT is skipped entirely, not called with empty arrays
  });
});

describe("resyncOrgGroupRoles", () => {
  it("does nothing (no query beyond the config check) when no group->role mapping is configured", async () => {
    mQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT settings FROM organizations"))
        return { settings: { scim: { groupRoleMap: {} } } } as never;
      return null as never;
    });
    mQuery.mockResolvedValue([] as never);

    await resyncOrgGroupRoles(ORG);
    expect(mQuery).not.toHaveBeenCalled(); // short-circuited before the member-roles JOIN
  });

  it("bulk-updates memberships and invites in at most 2 queries for many members, never demoting an unmapped one", async () => {
    mQueryOne.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT settings FROM organizations")) {
        return { settings: { scim: { groupRoleMap: { Engineers: "editor" } } } } as never;
      }
      return null as never;
    });
    const updateCalls: { sql: string; params: unknown[] }[] = [];
    mQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM scim_group_members gm")) {
        // Two mapped members (a, b) — c is NOT in this result set (not in any mapped group).
        return [
          { email: "a@example.org", key: "Engineers", role_id: "role-editor", pc: 10 },
          { email: "b@example.org", key: "Engineers", role_id: "role-editor", pc: 10 },
        ] as never;
      }
      if (sql.includes("UPDATE memberships") || sql.includes("UPDATE invites")) {
        updateCalls.push({ sql, params: params ?? [] });
        return [] as never;
      }
      return [] as never;
    });

    await resyncOrgGroupRoles(ORG);

    expect(updateCalls).toHaveLength(2); // one UPDATE memberships + one UPDATE invites, batched — not per-member
    for (const call of updateCalls) {
      const [orgArg, emails, roleIds] = call.params;
      expect(orgArg).toBe(ORG);
      expect(emails).toEqual(["a@example.org", "b@example.org"]); // c@example.org never appears: never demoted
      expect(roleIds).toEqual(["role-editor", "role-editor"]);
    }
  });
});
