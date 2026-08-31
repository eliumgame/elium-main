/**
 * Unit tests for src/routes/shares.ts — internal ACL shares (node_keys) and
 * external share links (share_links), plus the PUBLIC anonymous link
 * resolution/content routes. DB and auth middleware are mocked (SQL-text /
 * call-order dispatched), matching the style of tests/signing.test.ts and
 * tests/node-access.test.ts: build a bare Fastify app, register the route
 * module directly, and exercise it via app.inject.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

const USER = "00000000-0000-4000-8000-0000000000aa";
const OWNER = "00000000-0000-4000-8000-0000000000ab";
const ORG = "00000000-0000-4000-8000-0000000000cc";
const NODE = "00000000-0000-4000-8000-0000000000bb";
const FOLDER = "00000000-0000-4000-8000-0000000000fd";
const ROLE = "00000000-0000-4000-8000-0000000000d1";
const SHARE = "00000000-0000-4000-8000-0000000000e2";
const LINK = "00000000-0000-4000-8000-0000000000e1";
const PRINCIPAL = "00000000-0000-4000-8000-0000000000a9";
const CHILD = "00000000-0000-4000-8000-0000000000c1";

const storageMock = vi.hoisted(() => ({
  getStream: vi.fn(async () => "the-stream"),
}));

vi.mock("../src/db/pool.js", () => ({
  pool: {},
  query: vi.fn(async () => []),
  queryOne: vi.fn(async () => null),
  withTx: vi.fn(),
  closePool: vi.fn(async () => {}),
}));

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: vi.fn(async (req: { user?: unknown }) => {
    req.user = { id: USER, email: "u@example.org", fingerprint: "f", displayName: "U" };
  }),
  requireUser: vi.fn(() => ({ id: USER, email: "u@example.org", fingerprint: "f", displayName: "U" })),
  requireNodePerm: vi.fn(async () => ({
    nodeId: NODE,
    orgId: ORG,
    ownerUserId: OWNER,
    kind: "file",
    trashed: false,
    isOwner: false,
    permissions: new Set<string>(),
    accessible: true,
  })),
}));

vi.mock("../src/storage/adapter.js", () => ({
  storage: () => storageMock,
}));
vi.mock("../src/lib/audit.js", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("../src/collab/relay.js", () => ({ kickRoom: vi.fn() }));

import { query, queryOne, withTx } from "../src/db/pool.js";
import { requireNodePerm } from "../src/middleware/auth.js";
import { audit } from "../src/lib/audit.js";
import { kickRoom } from "../src/collab/relay.js";
import { ApiError } from "../src/lib/errors.js";
import shareRoutes from "../src/routes/shares.js";

const mQuery = vi.mocked(query);
const mQueryOne = vi.mocked(queryOne);
const mWithTx = vi.mocked(withTx);
const mRequireNodePerm = vi.mocked(requireNodePerm);
const mAudit = vi.mocked(audit);
const mKickRoom = vi.mocked(kickRoom);

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
  await app.register(shareRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

/** withTx impl that dispatches client.query by SQL text and records the SQLs. */
function txDispatch(map: Array<[RegExp, { rows: unknown[] }]>, sink?: string[]) {
  return async (fn: (c: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }) => unknown) =>
    fn({
      query: async (sql: string, params?: unknown[]) => {
        sink?.push(sql);
        for (const [re, res] of map) if (re.test(sql)) return res;
        void params;
        return { rows: [] };
      },
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  mQuery.mockResolvedValue([] as never);
  mQueryOne.mockResolvedValue(null as never);
  mRequireNodePerm.mockResolvedValue({
    nodeId: NODE,
    orgId: ORG,
    ownerUserId: OWNER,
    kind: "file",
    trashed: false,
    isOwner: false,
    permissions: new Set<string>(),
    accessible: true,
  } as never);
});

// =============================================================================
//  Internal ACL shares
// =============================================================================

describe("GET /api/nodes/:id/shares", () => {
  it("lists the ACL with resolved principal names for user/group/org", async () => {
    mQuery.mockResolvedValueOnce([
      {
        id: SHARE,
        principal_type: "user",
        principal_id: PRINCIPAL,
        role_id: ROLE,
        inherited_from: null,
        role_key: "editor",
        role_name: "Éditeur",
        user_email: "alice@example.org",
        user_display_name: "Alice",
        group_name: null,
      },
      {
        id: "share-2",
        principal_type: "group",
        principal_id: "group-1",
        role_id: ROLE,
        inherited_from: FOLDER,
        role_key: "viewer",
        role_name: "Lecteur",
        user_email: null,
        user_display_name: null,
        group_name: "Marketing",
      },
      {
        id: "share-3",
        principal_type: "org",
        principal_id: ORG,
        role_id: ROLE,
        inherited_from: null,
        role_key: "commenter",
        role_name: "Commentateur",
        user_email: null,
        user_display_name: null,
        group_name: null,
      },
    ] as never);

    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes/${NODE}/shares` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.shares).toHaveLength(3);
    expect(body.shares[0]).toMatchObject({ principalType: "user", name: "Alice", inheritedFrom: null });
    expect(body.shares[1]).toMatchObject({ principalType: "group", name: "Marketing", inheritedFrom: FOLDER });
    expect(body.shares[2]).toMatchObject({ principalType: "org", name: "Organisation" });
    expect(mRequireNodePerm).toHaveBeenCalledWith(expect.anything(), NODE, "node.acl.view");
    await app.close();
  });

  it("falls back to email / generic labels when display name / group name are absent", async () => {
    mQuery.mockResolvedValueOnce([
      {
        id: SHARE,
        principal_type: "user",
        principal_id: PRINCIPAL,
        role_id: ROLE,
        inherited_from: null,
        role_key: "editor",
        role_name: "Éditeur",
        user_email: "bob@example.org",
        user_display_name: null,
        group_name: null,
      },
    ] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes/${NODE}/shares` });
    expect(res.statusCode).toBe(200);
    expect(res.json().shares[0].name).toBe("bob@example.org");
    await app.close();
  });

  it("403 when the caller lacks node.acl.view", async () => {
    mRequireNodePerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise : node.acl.view."));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes/${NODE}/shares` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });

  it("404 when the node isn't accessible at all", async () => {
    mRequireNodePerm.mockRejectedValueOnce(new ApiError(404, "not_found", "Ressource introuvable."));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes/${NODE}/shares` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("POST /api/nodes/:id/shares", () => {
  const payload = {
    principalType: "user" as const,
    principalId: PRINCIPAL,
    roleId: ROLE,
    wrappedKey: { recipients: [], content: "ab" },
  };

  it("grants (upserts) an internal share and returns the shareId", async () => {
    mQueryOne
      .mockResolvedValueOnce({ id: ROLE }) // validateRole
      .mockResolvedValueOnce({ id: SHARE }); // INSERT ... RETURNING id
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/nodes/${NODE}/shares`, payload });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ shareId: SHARE });
    expect(mRequireNodePerm).toHaveBeenCalledWith(expect.anything(), NODE, "node.share.internal");
    expect(mRequireNodePerm).toHaveBeenCalledWith(expect.anything(), NODE, "node.acl.manage");
    expect(mAudit).toHaveBeenCalledWith(
      ORG,
      USER,
      "node.share",
      "file",
      NODE,
      { principalType: "user", principalId: PRINCIPAL, roleId: ROLE },
      expect.any(String),
    );
    await app.close();
  });

  it("accepts an optional inheritedFrom (fanned-out deep share marker)", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE }).mockResolvedValueOnce({ id: SHARE });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/nodes/${CHILD}/shares`,
      payload: { ...payload, inheritedFrom: FOLDER },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("400 when the role does not belong to this org", async () => {
    mQueryOne.mockResolvedValueOnce(null); // validateRole fails
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/nodes/${NODE}/shares`, payload });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("400 on invalid body (bad principalType)", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/nodes/${NODE}/shares`,
      payload: { ...payload, principalType: "robot" },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("403 when the caller lacks node.share.internal", async () => {
    mRequireNodePerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({ method: "POST", url: `/api/nodes/${NODE}/shares`, payload });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("PATCH /api/nodes/:id/shares/:shareId", () => {
  it("updates the share's role", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE }).mockResolvedValueOnce({ id: SHARE });
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/nodes/${NODE}/shares/${SHARE}`,
      payload: { roleId: ROLE },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mAudit).toHaveBeenCalledWith(
      ORG,
      USER,
      "node.share.update",
      "file",
      NODE,
      { shareId: SHARE, roleId: ROLE },
      expect.any(String),
    );
    await app.close();
  });

  it("404 when the share row doesn't exist under this node", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE }).mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/nodes/${NODE}/shares/${SHARE}`,
      payload: { roleId: ROLE },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("400 for an invalid roleId", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/nodes/${NODE}/shares/${SHARE}`,
      payload: { roleId: ROLE },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe("DELETE /api/nodes/:id/shares/:shareId", () => {
  it("revokes a share (shallow) and kicks the room", async () => {
    mQueryOne.mockResolvedValueOnce({ principal_type: "user", principal_id: PRINCIPAL });
    mWithTx.mockImplementation(txDispatch([]) as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/shares/${SHARE}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mKickRoom).toHaveBeenCalledWith(NODE, "acl-changed");
    expect(mAudit).toHaveBeenCalledWith(
      ORG,
      USER,
      "node.unshare",
      "file",
      NODE,
      { shareId: SHARE, principalType: "user", principalId: PRINCIPAL, deep: false },
      expect.any(String),
    );
    await app.close();
  });

  it("?deep=true on a folder also purges fanned-out descendant grants and kicks every touched room", async () => {
    mRequireNodePerm.mockResolvedValueOnce({
      nodeId: FOLDER,
      orgId: ORG,
      ownerUserId: OWNER,
      kind: "folder",
      trashed: false,
      isOwner: false,
      permissions: new Set<string>(),
      accessible: true,
    } as never);
    mQueryOne.mockResolvedValueOnce({ principal_type: "group", principal_id: "group-1" });
    const sqls: string[] = [];
    mWithTx.mockImplementation(
      txDispatch([[/DELETE FROM node_keys nk/, { rows: [{ node_id: CHILD }, { node_id: "grandchild" }] }]], sqls) as never,
    );
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${FOLDER}/shares/${SHARE}?deep=true` });
    expect(res.statusCode).toBe(200);
    expect(sqls.some((s) => /RECURSIVE/.test(s))).toBe(true);
    expect(mKickRoom).toHaveBeenCalledWith(FOLDER, "acl-changed");
    expect(mKickRoom).toHaveBeenCalledWith(CHILD, "acl-changed");
    expect(mKickRoom).toHaveBeenCalledWith("grandchild", "acl-changed");
    expect(mKickRoom).toHaveBeenCalledTimes(3);
    await app.close();
  });

  it("?deep=true on a FILE (not a folder) does not attempt the recursive purge", async () => {
    mQueryOne.mockResolvedValueOnce({ principal_type: "user", principal_id: PRINCIPAL });
    const sqls: string[] = [];
    mWithTx.mockImplementation(txDispatch([], sqls) as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/shares/${SHARE}?deep=true` });
    expect(res.statusCode).toBe(200);
    expect(sqls.some((s) => /RECURSIVE/.test(s))).toBe(false);
    expect(mKickRoom).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("404 when the share doesn't exist", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/shares/${SHARE}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("409 conflict: refuses to strip the node owner's own access", async () => {
    mQueryOne.mockResolvedValueOnce({ principal_type: "user", principal_id: OWNER });
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/shares/${SHARE}` });
    expect(res.statusCode).toBe(409);
    expect(mWithTx).not.toHaveBeenCalled();
    await app.close();
  });

  it("403 when the caller lacks node.share.manage", async () => {
    mRequireNodePerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/shares/${SHARE}` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// =============================================================================
//  External share links (authenticated management side)
// =============================================================================

describe("POST /api/nodes/:id/links", () => {
  it("creates a link and returns a fresh unhashed token", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE }).mockResolvedValueOnce({ id: LINK });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/nodes/${NODE}/links`,
      payload: { roleId: ROLE, wrappedKey: { c: "x" }, hasPassword: true, maxDownloads: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.linkId).toBe(LINK);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
    expect(mAudit).toHaveBeenCalledWith(ORG, USER, "node.link.create", "file", NODE, { linkId: LINK }, expect.any(String));
    await app.close();
  });

  it("defaults hasPassword to false and allows omitting expiresAt/maxDownloads", async () => {
    mQueryOne.mockResolvedValueOnce({ id: ROLE }).mockResolvedValueOnce({ id: LINK });
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/nodes/${NODE}/links`,
      payload: { roleId: ROLE, wrappedKey: { c: "x" } },
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("400 for an invalid roleId", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/nodes/${NODE}/links`,
      payload: { roleId: ROLE, wrappedKey: {} },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("403 when the caller lacks node.share.link", async () => {
    mRequireNodePerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/nodes/${NODE}/links`,
      payload: { roleId: ROLE, wrappedKey: {} },
    });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe("GET /api/nodes/:id/links", () => {
  it("lists active links only, annotated with can_sign + the signature party's label/status", async () => {
    mQuery.mockResolvedValueOnce([
      {
        id: LINK,
        has_password: false,
        expires_at: null,
        max_downloads: null,
        download_count: 3,
        created_at: "2026-08-01T00:00:00Z",
        can_sign: false,
        party_label: null,
        party_status: null,
      },
      {
        id: "00000000-0000-4000-8000-0000000000e3",
        has_password: false,
        expires_at: null,
        max_downloads: null,
        download_count: 0,
        created_at: "2026-08-02T00:00:00Z",
        can_sign: true,
        party_label: "Signataire 1",
        party_status: "pending",
      },
    ] as never);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes/${NODE}/links` });
    expect(res.statusCode).toBe(200);
    expect(res.json().links).toEqual([
      {
        id: LINK,
        hasPassword: false,
        expiresAt: null,
        maxDownloads: null,
        downloadCount: 3,
        createdAt: "2026-08-01T00:00:00Z",
        canSign: false,
        partyLabel: null,
        partyStatus: null,
      },
      {
        id: "00000000-0000-4000-8000-0000000000e3",
        hasPassword: false,
        expiresAt: null,
        maxDownloads: null,
        downloadCount: 0,
        createdAt: "2026-08-02T00:00:00Z",
        canSign: true,
        partyLabel: "Signataire 1",
        partyStatus: "pending",
      },
    ]);
    await app.close();
  });

  it("404 when the node is not accessible", async () => {
    mRequireNodePerm.mockRejectedValueOnce(new ApiError(404, "not_found", "Ressource introuvable."));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/nodes/${NODE}/links` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe("DELETE /api/nodes/:id/links/:linkId", () => {
  it("revokes a plain link (no signature party to cancel)", async () => {
    mQueryOne.mockResolvedValueOnce({ can_sign: false });
    mWithTx.mockImplementation(txDispatch([[/UPDATE share_links/, { rows: [{ id: LINK }] }]]) as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/links/${LINK}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(mAudit).toHaveBeenCalledWith(
      ORG,
      USER,
      "node.link.revoke",
      "file",
      NODE,
      { linkId: LINK, cancelledSignParty: false },
      expect.any(String),
    );
    await app.close();
  });

  it("revoking a signature link also cancels its still-pending party", async () => {
    mQueryOne.mockResolvedValueOnce({ can_sign: true });
    const sqls: string[] = [];
    mWithTx.mockImplementation(txDispatch([[/UPDATE share_links/, { rows: [{ id: LINK }] }]], sqls) as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/links/${LINK}` });
    expect(res.statusCode).toBe(200);
    expect(sqls.some((s) => /UPDATE signature_request_parties/.test(s) && /'cancelled'/.test(s))).toBe(true);
    expect(mAudit).toHaveBeenCalledWith(
      ORG,
      USER,
      "node.link.revoke",
      "file",
      NODE,
      { linkId: LINK, cancelledSignParty: true },
      expect.any(String),
    );
    await app.close();
  });

  it("404 when the link is already revoked or unknown", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/links/${LINK}` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("403 when the caller lacks node.share.manage on a plain link (no node.sign.request fallback)", async () => {
    mQueryOne.mockResolvedValueOnce({ can_sign: false });
    mRequireNodePerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise."));
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/links/${LINK}` });
    expect(res.statusCode).toBe(403);
    expect(mRequireNodePerm).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("a signature link can still be revoked via node.sign.request when node.share.manage is missing", async () => {
    mQueryOne.mockResolvedValueOnce({ can_sign: true });
    mRequireNodePerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise.")); // node.share.manage
    mWithTx.mockImplementation(txDispatch([[/UPDATE share_links/, { rows: [{ id: LINK }] }]]) as never);
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/links/${LINK}` });
    expect(res.statusCode).toBe(200);
    expect(mRequireNodePerm).toHaveBeenNthCalledWith(2, expect.anything(), NODE, "node.sign.request");
    await app.close();
  });

  it("403 when a signature link's caller lacks both node.share.manage and node.sign.request", async () => {
    mQueryOne.mockResolvedValueOnce({ can_sign: true });
    mRequireNodePerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise.")); // node.share.manage
    mRequireNodePerm.mockRejectedValueOnce(new ApiError(403, "forbidden", "Permission requise.")); // node.sign.request
    const app = await makeApp();
    const res = await app.inject({ method: "DELETE", url: `/api/nodes/${NODE}/links/${LINK}` });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

// =============================================================================
//  PUBLIC anonymous link resolution routes (no authenticate hook)
// =============================================================================

function linkRow(over: Record<string, unknown> = {}) {
  return {
    id: LINK,
    node_id: NODE,
    wrapped_key: { c: "wrapped" },
    has_password: false,
    role_key: "viewer",
    expires_at: null,
    max_downloads: null,
    download_count: 0,
    revoked_at: null,
    n_id: NODE,
    n_kind: "file",
    n_name_encrypted: Buffer.from("aa", "hex"),
    n_name_nonce: Buffer.from("bb", "hex"),
    n_meta_encrypted: null,
    n_meta_nonce: null,
    n_app_kind: null,
    n_size_bytes: 42,
    n_content_ref: "blob-key-1",
    n_content_nonce: Buffer.from("cc", "hex"),
    n_created_at: "2026-08-01T00:00:00Z",
    n_modified_at: "2026-08-02T00:00:00Z",
    ...over,
  };
}

describe("GET /api/links/:token (public resolution)", () => {
  it("resolves a live link to node metadata + wrapped key, without requiring auth", async () => {
    mQueryOne.mockResolvedValueOnce(linkRow());
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/links/sometoken` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.wrappedKey).toEqual({ c: "wrapped" });
    expect(body.hasPassword).toBe(false);
    expect(body.roleKey).toBe("viewer");
    expect(body.node).toMatchObject({ id: NODE, kind: "file", nameEncrypted: "aa", nameNonce: "bb", hasContent: true, sizeBytes: 42 });
    await app.close();
  });

  it("404 for an unknown token", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/links/unknown` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404 (generic, no leak) for a revoked link", async () => {
    mQueryOne.mockResolvedValueOnce(linkRow({ revoked_at: "2026-01-01T00:00:00Z" }));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/links/revoked` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404 for an expired link", async () => {
    mQueryOne.mockResolvedValueOnce(linkRow({ expires_at: "2020-01-01T00:00:00Z" }));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/links/expired` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("404 once the download cap has been reached", async () => {
    mQueryOne.mockResolvedValueOnce(linkRow({ max_downloads: 3, download_count: 3 }));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/links/capped` });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("under the download cap still resolves", async () => {
    mQueryOne.mockResolvedValueOnce(linkRow({ max_downloads: 3, download_count: 2 }));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/links/notyetcapped` });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it("400 on an empty token (zod min(1) rejects before any DB lookup)", async () => {
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/links/` });
    expect(res.statusCode).toBe(400);
    expect(mQueryOne).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("GET /api/links/:token/content (public streaming)", () => {
  it("streams the encrypted blob and bumps the download counter", async () => {
    mQueryOne.mockResolvedValueOnce(linkRow());
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/links/sometoken/content` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers["x-content-nonce"]).toBe(Buffer.from("cc", "hex").toString("hex"));
    expect(mQuery).toHaveBeenCalledWith(expect.stringMatching(/UPDATE share_links SET download_count/), [LINK]);
    expect(storageMock.getStream).toHaveBeenCalledWith("blob-key-1");
    await app.close();
  });

  it("404 when the link has no content (e.g. an empty file node)", async () => {
    mQueryOne.mockResolvedValueOnce(linkRow({ n_content_ref: null }));
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/links/sometoken/content` });
    expect(res.statusCode).toBe(404);
    expect(storageMock.getStream).not.toHaveBeenCalled();
    await app.close();
  });

  it("404 for an unresolvable token (unknown/revoked/expired/capped)", async () => {
    mQueryOne.mockResolvedValueOnce(null);
    const app = await makeApp();
    const res = await app.inject({ method: "GET", url: `/api/links/bogus/content` });
    expect(res.statusCode).toBe(404);
    expect(storageMock.getStream).not.toHaveBeenCalled();
    await app.close();
  });
});
