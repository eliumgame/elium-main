import { describe, it, expect } from "vitest";
import { contentPreconditions, assertContentBase, requireNewClientBody } from "../src/lib/content-preconditions.js";
import { assertFreshPrincipalKeys } from "../src/lib/key-share-policy.js";

const VER = "00000000-0000-4000-8000-000000000b01";

describe("content write preconditions", () => {
  it("rejects malformed versions and epochs, and a lone header", () => {
    expect(() => contentPreconditions({ "x-key-epoch": "1" }, true)).toThrow(/requises/);
    expect(() => contentPreconditions({ "x-base-version-id": VER }, true)).toThrow(/requises/);
    for (const version of ["*", "", "undefined", ["null"]]) {
      expect(() => contentPreconditions({ "x-base-version-id": version, "x-key-epoch": "1" })).toThrow();
    }
    for (const epoch of ["", "NaN", "0", "1e0", "1.1", "9007199254740992"]) {
      expect(() => contentPreconditions({ "x-base-version-id": "null", "x-key-epoch": epoch })).toThrow();
    }
  });
  it("permits first upload, rejects a concurrent version or rotation", () => {
    const base = contentPreconditions({ "x-base-version-id": "null", "x-key-epoch": "1" });
    expect(() => assertContentBase(base, { key_epoch: 1, current_version_id: null })).not.toThrow();
    expect(() => assertContentBase(base, { key_epoch: 1, current_version_id: "new-version" })).toThrow(/changé/);
    expect(() => assertContentBase(base, { key_epoch: 2, current_version_id: null })).toThrow(/changé/);
    expect(() => assertContentBase(base, { key_epoch: 1, current_version_id: null, key_rotation_required: true })).toThrow(/révocation/);
  });
  it("sans en-têtes + compat : base déduite de l'état courant, rotation requise toujours refusée", () => {
    const base = contentPreconditions({}, true);
    expect(base.legacy).toBe(true);
    expect(() => assertContentBase(base, { key_epoch: 4, current_version_id: VER })).not.toThrow();
    expect(() => assertContentBase(base, { key_epoch: 4, current_version_id: VER, key_rotation_required: true })).toThrow(/révocation/);
  });
  it("sans en-têtes + compat désactivée : 428 client_outdated", () => {
    expect(() => contentPreconditions({}, false)).toThrow(expect.objectContaining({ statusCode: 428, code: "client_outdated", message: expect.stringContaining("trop ancienne") }));
  });
  it("corps de nouveau client requis : 400 client_outdated", () => {
    expect(() => requireNewClientBody(undefined, ["a"])).toThrow(expect.objectContaining({ statusCode: 400, code: "client_outdated" }));
    expect(() => requireNewClientBody({}, ["a"])).toThrow(expect.objectContaining({ code: "client_outdated" }));
    expect(() => requireNewClientBody({ a: 1 }, ["a"])).not.toThrow();
  });
});

describe("assertFreshPrincipalKeys — part org (orgKeyEpoch)", () => {
  const ORG = "00000000-0000-4000-8000-0000000000cc";
  const client = (rotation: boolean | null = false) => ({
    query: async (sql: string) => (/FROM organizations/.test(sql) ? { rows: [{ org_key_epoch: 3, rotation_required: rotation }] } : { rows: [] }),
  }) as never;
  const share = [{ principalType: "org", principalId: ORG }];
  it("compat : époque absente -> époque courante, legacy=true", async () => {
    await expect(assertFreshPrincipalKeys(client(), ORG, share, undefined, true)).resolves.toEqual({ legacy: true });
  });
  it("compat : époque absente mais rotation requise -> 409", async () => {
    await expect(assertFreshPrincipalKeys(client(true), ORG, share, undefined, true)).rejects.toMatchObject({ statusCode: 409 });
  });
  it("sans compat : époque absente -> 428 client_outdated", async () => {
    await expect(assertFreshPrincipalKeys(client(), ORG, share, undefined, false)).rejects.toMatchObject({ statusCode: 428, code: "client_outdated" });
  });
  it("époque fournie obsolète -> 409 même en compat", async () => {
    await expect(assertFreshPrincipalKeys(client(), ORG, share, 2, true)).rejects.toMatchObject({ statusCode: 409 });
    await expect(assertFreshPrincipalKeys(client(), ORG, share, 3, true)).resolves.toEqual({ legacy: false });
  });
});
