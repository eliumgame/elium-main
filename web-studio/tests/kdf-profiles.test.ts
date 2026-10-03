import { describe, it, expect } from "vitest";
import { KDF_PROFILES, kdfWithinBounds } from "../src/crypto/kdf-profiles";
import { DEFAULT_KDF_PARAMS } from "../src/drive-cloud/kdf";

describe("profils KDF nommés", () => {
  it("tous les profils d'écriture respectent les bornes de décodage", () => {
    for (const p of Object.values(KDF_PROFILES)) expect(kdfWithinBounds(p)).toBe(true);
  });

  it("le profil account reste celui des comptes Drive existants (pas de migration silencieuse)", () => {
    expect(DEFAULT_KDF_PARAMS).toEqual({ alg: "argon2id", t: 3, m: 262144, p: 4 });
  });

  it("refuse les paramètres hors bornes ou non entiers", () => {
    expect(kdfWithinBounds({ t: 0, m: 65536, p: 1 })).toBe(false);
    expect(kdfWithinBounds({ t: 3, m: 524288, p: 1 })).toBe(false);
    expect(kdfWithinBounds({ t: 3, m: 65536, p: 17 })).toBe(false);
    expect(kdfWithinBounds({ t: 3.5, m: 65536, p: 1 })).toBe(false);
  });
});
