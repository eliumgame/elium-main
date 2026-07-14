import { describe, it, expect } from "vitest";
import { generateIdentity } from "../src/sign/keys";
import {
  encryptPrivateKey, decryptPrivateKey, buildKeyFile, parseKeyFile, keyFileName,
  restoreFromKeyFile, identityFromPrivateHex, EliumKeyFileError,
} from "../src/sign/identity-store";

describe("identity backup (.eliumkey)", () => {
  it("export → parse → restore round-trips and validates key coherence", async () => {
    const id = await generateIdentity();
    const enc = await encryptPrivateKey(id.privateKeyHex!, "p@ssw0rd");
    const stored = { publicKeyHex: id.publicKeyHex, fingerprint: id.fingerprint, enc };

    const json = JSON.stringify(buildKeyFile(stored));
    const parsed = parseKeyFile(json);
    expect(parsed).toEqual(stored);

    const restored = await restoreFromKeyFile(parsed, "p@ssw0rd");
    expect(restored.privateKeyHex).toBe(id.privateKeyHex);
    expect(restored.publicKeyHex).toBe(id.publicKeyHex);
    expect(restored.fingerprint).toBe(id.fingerprint);

    expect(keyFileName(id.fingerprint)).toBe(`identite-elium-${id.fingerprint.slice(0, 12)}.eliumkey`);
  });

  it("rejects a wrong password and a backup whose public key was swapped", async () => {
    const id = await generateIdentity();
    const enc = await encryptPrivateKey(id.privateKeyHex!, "bon-mdp");
    const stored = { publicKeyHex: id.publicKeyHex, fingerprint: id.fingerprint, enc };

    await expect(restoreFromKeyFile(stored, "mauvais-mdp")).rejects.toThrow();

    // Un attaquant qui substitue la clé publique annoncée doit être détecté.
    const other = await generateIdentity();
    const swapped = { ...stored, publicKeyHex: other.publicKeyHex, fingerprint: other.fingerprint };
    await expect(restoreFromKeyFile(swapped, "bon-mdp")).rejects.toThrow(EliumKeyFileError);

    await expect(decryptPrivateKey(enc, "bon-mdp")).resolves.toBe(id.privateKeyHex);
  });

  it("rejects malformed .eliumkey files with typed errors", () => {
    expect(() => parseKeyFile("pas du json")).toThrow(EliumKeyFileError);
    expect(() => parseKeyFile(JSON.stringify({ format: "autre" }))).toThrow(EliumKeyFileError);
    expect(() => parseKeyFile(JSON.stringify({ format: "elium-key", version: 99 }))).toThrow(EliumKeyFileError);
    expect(() =>
      parseKeyFile(JSON.stringify({ format: "elium-key", version: 1, publicKeyHex: "zz", fingerprint: "ab", enc: "cd" })),
    ).toThrow(EliumKeyFileError);
    expect(() =>
      parseKeyFile(JSON.stringify({
        format: "elium-key", version: 1,
        publicKeyHex: "ab".repeat(32), fingerprint: "cd".repeat(32), enc: "abc", // longueur impaire
      })),
    ).toThrow(EliumKeyFileError);
  });

  it("imports a raw private key hex and derives the matching identity", async () => {
    const id = await generateIdentity();
    const fromHexImport = await identityFromPrivateHex(`0x${id.privateKeyHex!.toUpperCase()}`);
    expect(fromHexImport.publicKeyHex).toBe(id.publicKeyHex);
    expect(fromHexImport.fingerprint).toBe(id.fingerprint);

    await expect(identityFromPrivateHex("abcd")).rejects.toThrow(EliumKeyFileError);
    await expect(identityFromPrivateHex("g".repeat(64))).rejects.toThrow(EliumKeyFileError);
  });
});
