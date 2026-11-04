import { describe, it, expect } from "vitest";
import { contentPreconditions, assertContentBase } from "../src/lib/content-preconditions.js";

describe("content write preconditions", () => {
  it("requires both headers and rejects malformed versions and epochs", () => {
    expect(() => contentPreconditions({})).toThrow(/requises/);
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
});
