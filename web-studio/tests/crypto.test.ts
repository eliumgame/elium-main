import { describe, it, expect } from "vitest";
import { EliumCryptoEngine } from "../src/crypto/elium-crypto";

describe("EliumCryptoEngine v3", () => {
  it("should generate a valid identity", async () => {
    const id = await EliumCryptoEngine.generateIdentity();
    expect(id).toHaveProperty("privateKeyHex");
    expect(id).toHaveProperty("publicKeyHex");
    expect(id).toHaveProperty("fingerprint");
    expect(id.privateKeyHex.length).toBeGreaterThan(0);
  });

  it("should correctly encode and decode without cascade", async () => {
    const payload = new TextEncoder().encode("Hello WebCrypto without cascade!");
    const password = "SuperSecretWebPassword1!";

    const encoded = await EliumCryptoEngine.encodeContainer(payload, password, "test.txt");

    // Check magic bytes
    expect(encoded[0]).toBe(0x45); // E
    expect(encoded[1]).toBe(0x4c); // L
    expect(encoded[2]).toBe(0x49); // I
    expect(encoded[3]).toBe(0x55); // U
    expect(encoded[4]).toBe(0x4d); // M
    expect(encoded[5]).toBe(0x03); // v3

    const { payload: decoded, header, signatureValid } = await EliumCryptoEngine.decodeContainer(encoded, password);
    const decodedText = new TextDecoder().decode(decoded);

    expect(decodedText).toBe("Hello WebCrypto without cascade!");
    expect(header.version).toBe(3);
    expect(header.crypto.cascade).toBeNull();
    expect(signatureValid).toBeNull();
  });

  it("should correctly encode and decode with signatures", async () => {
    const payload = new TextEncoder().encode("Hello Signed Data!");
    const password = "pwd";

    const id = await EliumCryptoEngine.generateIdentity();

    const encoded = await EliumCryptoEngine.encodeContainer(payload, password, "signed.txt", id.privateKeyHex);

    const { payload: decoded, signatureValid } = await EliumCryptoEngine.decodeContainer(
      encoded,
      password,
      id.publicKeyHex,
    );
    const decodedText = new TextDecoder().decode(decoded);

    expect(decodedText).toBe("Hello Signed Data!");
    expect(signatureValid).toBe(true);
  });

  it("rejects a header advertising an unsupported cipher (honest dispatch)", async () => {
    const encoded = await EliumCryptoEngine.encodeContainer(new TextEncoder().encode("payload"), "pwd", "x.txt");
    const enc = new TextEncoder();
    const needle = enc.encode('"cipher":"aes-256-gcm"');
    const repl = enc.encode('"cipher":"aes-256-xyz"'); // même longueur → offsets intacts
    let at = -1;
    outer: for (let i = 0; i + needle.length <= encoded.length; i++) {
      for (let j = 0; j < needle.length; j++) if (encoded[i + j] !== needle[j]) continue outer;
      at = i;
      break;
    }
    expect(at).toBeGreaterThanOrEqual(0);
    const tampered = encoded.slice();
    tampered.set(repl, at);
    // La garde cipher tourne AVANT le HMAC → c'est elle qui refuse.
    await expect(EliumCryptoEngine.decodeContainer(tampered, "pwd")).rejects.toThrow(/cipher/i);
  });
});
