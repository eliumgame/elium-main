import { describe, it, expect, vi } from "vitest";
import { encryptAtRest, decryptAtRest, hasVaultSecret, sealBytesAtRest, openSealedBytes, toB64 } from "../src/crypto/local-vault";
import { EliumCryptoEngine } from "../src/crypto/elium-crypto";
import { KDF_PROFILES } from "../src/crypto/kdf-profiles";

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
    await expect(
      decryptAtRest(enc, { password: "p", keyfile: new TextEncoder().encode("cle-B") }),
    ).rejects.toBeTruthy();
  });

  it("produces a different ciphertext each time (random salt/iv)", async () => {
    const a = await encryptAtRest(value, { password: "x" });
    const b = await encryptAtRest(value, { password: "x" });
    expect(a).not.toEqual(b);
  });

  it("nouveau format = enveloppe versionnée Argon2id document (v4)", async () => {
    const enc = await encryptAtRest(value, { password: "x" });
    expect(JSON.parse(enc)).toMatchObject({ v: 4, d: expect.any(String) });
  });

  it("écrit au coût document et lit encore les caches Argon2id hérités", async () => {
    const secret = { password: "legacy-password" };
    const salt = new Uint8Array(16).fill(7);
    const iv = new Uint8Array(12).fill(9);
    const { t, m, p } = KDF_PROFILES["local-cache"];
    const raw = await EliumCryptoEngine.deriveMasterKey(secret.password, salt, t, m, p);
    const key = await crypto.subtle.importKey("raw", raw as BufferSource, "AES-GCM", false, ["encrypt"]);
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
    const legacy = JSON.stringify({ v: 2, d: toB64(new Uint8Array([...salt, ...iv, ...ct])) });
    expect(await decryptAtRest(legacy, secret)).toEqual(value);
    expect(await openSealedBytes({ v: 3, salt, iv, ct }, secret)).toEqual(bytes);

    const spy = vi.spyOn(EliumCryptoEngine, "deriveMasterKey");
    try {
      const modern = await sealBytesAtRest(bytes, secret);
      const doc = KDF_PROFILES.document;
      expect(spy).toHaveBeenCalledWith(secret.password, modern.salt, doc.t, doc.m, doc.p);
      expect(await openSealedBytes(modern, { ...secret })).toEqual(bytes);
      await expect(openSealedBytes(modern, { password: "wrong" })).rejects.toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  }, 30000);

  // Compat descendante : un blob écrit par l'ANCIENNE dérivation (PBKDF2-100k,
  // base64 brut de salt(16)||iv(12)||ct) doit rester déchiffrable après le
  // passage à Argon2id — sinon les brouillons/versions déjà en cache seraient
  // perdus. On fabrique ici un blob legacy à la main.
  it("déchiffre un blob PBKDF2 hérité (base64 brut, sans enveloppe)", async () => {
    const secret = "correct horse";
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", salt, iterations: 100_000, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const ct = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value))),
    );
    const blob = new Uint8Array(salt.length + iv.length + ct.length);
    blob.set(salt, 0);
    blob.set(iv, salt.length);
    blob.set(ct, salt.length + iv.length);
    const legacyB64 = btoa(String.fromCharCode(...blob));
    const back = await decryptAtRest<typeof value>(legacyB64, { password: secret });
    expect(back).toEqual(value);
  });
});
