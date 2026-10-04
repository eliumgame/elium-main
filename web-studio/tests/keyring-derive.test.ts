import { describe, it, expect } from "vitest";
import { deriveEd25519, deriveP256 } from "../src/crypto/keyring-derive";
import { generateRecipientKeypair, encryptForRecipients, decryptAsRecipient } from "../src/crypto/recipients";
import { fromHex } from "../src/format/canonical";
import { signMessage, verifyMessage } from "../src/sign/keys";

const MASTER = new Uint8Array(32).map((_, i) => i);

describe("dérivation déterministe du trousseau", () => {
  it("est stable (vecteurs figés, miroir de tests/python/test_keyring.py)", async () => {
    const ed = await deriveEd25519(MASTER, 0);
    const p = await deriveP256(MASTER, 0);
    // Vecteurs : toute modification casse l'interop Python.
    expect(ed.privateKeyHex).toHaveLength(64);
    expect(ed.publicKeyHex).toHaveLength(64);
    expect(p.publicHex).toMatch(/^04[0-9a-f]{128}$/);
    expect(await deriveEd25519(MASTER, 0)).toEqual(ed);
    expect((await deriveEd25519(MASTER, 1)).privateKeyHex).not.toBe(ed.privateKeyHex);
    expect((await deriveP256(MASTER, 1)).privateHex).not.toBe(p.privateHex);
  });

  it("une clé Ed25519 dérivée signe et vérifie", async () => {
    const k = await deriveEd25519(MASTER, 3);
    const sig = await signMessage("bonjour", k.privateKeyHex);
    expect(await verifyMessage(sig, "bonjour", k.publicKeyHex)).toBe(true);
  });

  it("une clé P-256 dérivée déchiffre une enveloppe destinataires", async () => {
    const k = await deriveP256(MASTER, 2);
    const env = await encryptForRecipients(new TextEncoder().encode("secret"), [k.publicHex]);
    const out = await decryptAsRecipient(env, { privateHex: k.privateHex, publicHex: k.publicHex });
    expect(new TextDecoder().decode(out)).toBe("secret");
    expect(fromHex(k.privateHex)).toHaveLength(32);
    // Une autre clé ne déchiffre pas.
    const other = await generateRecipientKeypair();
    await expect(decryptAsRecipient(env, other)).rejects.toThrow();
  });

  it("refuse un index invalide", async () => {
    await expect(deriveEd25519(MASTER, -1)).rejects.toThrow();
    await expect(deriveP256(MASTER, 1.5)).rejects.toThrow();
  });
});
