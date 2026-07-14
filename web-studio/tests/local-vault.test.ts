import { describe, it, expect } from "vitest";
import { encryptAtRest, decryptAtRest, hasVaultSecret } from "../src/crypto/local-vault";

describe("local-vault — hasVaultSecret", () => {
  it("is false for undefined, empty password and no keyfile", () => {
    expect(hasVaultSecret(undefined)).toBe(false);
    expect(hasVaultSecret({})).toBe(false);
    expect(hasVaultSecret({ password: "" })).toBe(false);
  });

  it("is true for a non-empty password", () => {
    expect(hasVaultSecret({ password: "abcd" })).toBe(true);
  });

  it("is true for a keyfile alone, even with an empty password", () => {
    expect(hasVaultSecret({ password: "", keyfile: new Uint8Array([1, 2, 3]) })).toBe(true);
  });
});

describe("local-vault — encryptAtRest / decryptAtRest", () => {
  const value = { title: "Secret", n: 42, nested: { list: [1, 2, 3] } };

  it("round-trips with a password", async () => {
    const enc = await encryptAtRest(value, { password: "correct horse" });
    expect(typeof enc).toBe("string");
    expect(enc).not.toContain("Secret"); // ciphertext, not plaintext
    const back = await decryptAtRest<typeof value>(enc, { password: "correct horse" });
    expect(back).toEqual(value);
  });

  it("round-trips with a keyfile-only secret (empty password)", async () => {
    const keyfile = new TextEncoder().encode("contenu-du-fichier-cle");
    const enc = await encryptAtRest(value, { password: "", keyfile });
    const back = await decryptAtRest<typeof value>(enc, { password: "", keyfile });
    expect(back).toEqual(value);
  });

  it("fails to decrypt with a different password", async () => {
    const enc = await encryptAtRest(value, { password: "bon" });
    await expect(decryptAtRest(enc, { password: "mauvais" })).rejects.toBeTruthy();
  });

  it("fails to decrypt with a different keyfile even when the password matches", async () => {
    const enc = await encryptAtRest(value, { password: "p", keyfile: new TextEncoder().encode("cle-A") });
    await expect(decryptAtRest(enc, { password: "p", keyfile: new TextEncoder().encode("cle-B") })).rejects.toBeTruthy();
  });

  it("produces a different ciphertext each time (random salt/iv)", async () => {
    const a = await encryptAtRest(value, { password: "x" });
    const b = await encryptAtRest(value, { password: "x" });
    expect(a).not.toEqual(b);
  });
});
