/**
 * Unit tests for the RBAC catalog, system role templates, and the pure
 * permission-resolution helpers (server/src/rbac/*). The DB-backed loaders
 * (loadOrgContext / resolveNodeAccess) are covered by the e2e suite; here we
 * test the deterministic logic that decides "does this context grant X?".
 */
import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  ALL_PERMISSION_KEYS,
  NODE_PERMISSION_KEYS,
  isPermissionKey,
  sanitizePermissions,
} from "../src/rbac/permissions.js";
import {
  SYSTEM_ROLE_TEMPLATES,
  DEFAULT_MEMBER_ROLE_KEY,
  templateByKey,
} from "../src/rbac/roles.js";
import {
  orgHasPermission,
  nodeHasPermission,
  type OrgContext,
  type NodeAccess,
} from "../src/rbac/engine.js";

describe("permission catalog", () => {
  it("has unique keys", () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("exposes a substantial catalog (the 35+ granular permissions)", () => {
    expect(PERMISSIONS.length).toBeGreaterThanOrEqual(35);
    expect(ALL_PERMISSION_KEYS.length).toBe(PERMISSIONS.length);
  });

  it("only uses the 'node' and 'org' scopes", () => {
    for (const p of PERMISSIONS) expect(["node", "org"]).toContain(p.scope);
  });

  it("NODE_PERMISSION_KEYS is exactly the node-scoped subset", () => {
    const expected = PERMISSIONS.filter((p) => p.scope === "node").map((p) => p.key);
    expect([...NODE_PERMISSION_KEYS]).toEqual(expected);
    for (const k of NODE_PERMISSION_KEYS) expect(ALL_PERMISSION_KEYS).toContain(k);
  });

  it("isPermissionKey recognizes real keys and rejects others", () => {
    expect(isPermissionKey("node.view")).toBe(true);
    expect(isPermissionKey("member.invite")).toBe(true);
    expect(isPermissionKey("node.destroy-everything")).toBe(false);
    expect(isPermissionKey("")).toBe(false);
  });

  it("sanitizePermissions filters, de-duplicates, and drops non-arrays", () => {
    expect(sanitizePermissions("nope")).toEqual([]);
    expect(sanitizePermissions(null)).toEqual([]);
    const cleaned = sanitizePermissions(["node.view", "node.view", "bogus", 42, "member.invite"]);
    expect(cleaned).toEqual(["node.view", "member.invite"]);
  });
});

describe("system role templates", () => {
  it("defines the 7 expected system roles", () => {
    expect(SYSTEM_ROLE_TEMPLATES).toHaveLength(7);
    expect(new Set(SYSTEM_ROLE_TEMPLATES.map((r) => r.key))).toEqual(
      new Set(["owner", "admin", "manager", "editor", "commenter", "viewer", "guest"]),
    );
  });

  it("owner and admin hold every permission", () => {
    const all = new Set(ALL_PERMISSION_KEYS);
    for (const key of ["owner", "admin"]) {
      const role = templateByKey(key)!;
      expect(new Set(role.permissions)).toEqual(all);
    }
  });

  it("every template references only valid permission keys", () => {
    for (const role of SYSTEM_ROLE_TEMPLATES) {
      for (const perm of role.permissions) expect(isPermissionKey(perm)).toBe(true);
    }
  });

  it("viewer's permissions are a strict subset of editor's", () => {
    const viewer = new Set(templateByKey("viewer")!.permissions);
    const editor = new Set(templateByKey("editor")!.permissions);
    for (const p of viewer) expect(editor.has(p)).toBe(true);
    expect(editor.size).toBeGreaterThan(viewer.size);
  });

  it("guest is minimal (view only)", () => {
    expect(templateByKey("guest")!.permissions).toEqual(["node.view"]);
  });

  it("templateByKey resolves known roles and returns undefined otherwise", () => {
    expect(templateByKey("manager")?.key).toBe("manager");
    expect(templateByKey("nonexistent")).toBeUndefined();
  });

  it("the default member role exists and is a real template", () => {
    expect(templateByKey(DEFAULT_MEMBER_ROLE_KEY)).toBeDefined();
  });
});

describe("orgHasPermission", () => {
  const base: OrgContext = {
    orgId: "o1",
    membershipId: "m1",
    roleId: "r1",
    roleKey: "editor",
    permissions: new Set(["member.view", "node.edit"]),
    isOwner: false,
  };

  it("denies everything for a null context", () => {
    expect(orgHasPermission(null, "member.view")).toBe(false);
  });

  it("grants a permission that is in the membership set", () => {
    expect(orgHasPermission(base, "member.view")).toBe(true);
  });

  it("denies a permission absent from the set", () => {
    expect(orgHasPermission(base, "org.settings.manage")).toBe(false);
  });

  it("the org owner is granted every permission regardless of the set", () => {
    const owner: OrgContext = { ...base, isOwner: true, permissions: new Set() };
    expect(orgHasPermission(owner, "org.settings.manage")).toBe(true);
    expect(orgHasPermission(owner, "anything.at.all")).toBe(true);
  });
});

describe("nodeHasPermission", () => {
  const access: NodeAccess = {
    nodeId: "n1",
    orgId: "o1",
    ownerUserId: "u1",
    kind: "file",
    trashed: false,
    isOwner: false,
    permissions: new Set(["node.view", "node.download"]),
    accessible: true,
  };

  it("denies everything for a null access", () => {
    expect(nodeHasPermission(null, "node.view")).toBe(false);
  });

  it("reflects the resolved node permission set", () => {
    expect(nodeHasPermission(access, "node.view")).toBe(true);
    expect(nodeHasPermission(access, "node.edit")).toBe(false);
  });
});
