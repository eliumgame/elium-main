/**
 * Unit tests for server-side crypto helpers (server/src/lib/crypto-server.ts):
 * hashing, random tokens, Ed25519 login-proof verification, and the
 * AES-256-GCM at-rest encryption used for MFA seeds.
 */
import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import {
  sha256Hex,
  randomToken,
  randomHex,
  verifyEd25519,
  encryptServerSecret,
  decryptServerSecret,
} from "../src/lib/crypto-server.js";

describe("hashing & random", () => {
  it("sha256Hex matches the canonical 'abc' vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("sha256Hex accepts Buffers and strings identically", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(sha256Hex("abc"));
  });

  it("randomToken is url-safe base64 and of the expected length", () => {
    expect(randomToken(32)).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(randomToken(16)).toHaveLength(22); // ceil(16/3)*4 - padding
    expect(randomToken()).not.toBe(randomToken());
  });

  it("randomHex returns 2*bytes hex chars", () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});

describe("Ed25519 signature verification", () => {
  function keypairHex(): { pubHex: string; sign: (m: string) => string } {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const jwk = publicKey.export({ format: "jwk" }) as { x: string };
    const pubHex = Buffer.from(jwk.x, "base64url").toString("hex");
    return {
      pubHex,
      sign: (m: string) => edSign(null, Buffer.from(m, "utf8"), privateKey).toString("hex"),
    };
  }

  it("accepts a genuine signature", () => {
    const { pubHex, sign } = keypairHex();
    const msg = "challenge:9f3c-login";
    expect(verifyEd25519(msg, sign(msg), pubHex)).toBe(true);
  });

  it("rejects a signature over a different message", () => {
    const { pubHex, sign } = keypairHex();
    expect(verifyEd25519("other-message", sign("challenge"), pubHex)).toBe(false);
  });

  it("rejects a signature verified against a different key", () => {
    const a = keypairHex();
    const b = keypairHex();
    expect(verifyEd25519("m", a.sign("m"), b.pubHex)).toBe(false);
  });

  it("rejects a public key of the wrong length", () => {
    const { sign } = keypairHex();
    expect(verifyEd25519("m", sign("m"), "00ff")).toBe(false);
  });

  it("rejects a tampered signature without throwing", () => {
    const { pubHex, sign } = keypairHex();
    const sig = sign("m");
    const tampered = sig.slice(0, -2) + (sig.endsWith("00") ? "11" : "00");
    expect(verifyEd25519("m", tampered, pubHex)).toBe(false);
  });

  it("returns false (not throw) on garbage input", () => {
    expect(verifyEd25519("m", "zz", "not-hex")).toBe(false);
  });
});

describe("server-secret encryption (AES-256-GCM at rest)", () => {
  it("round-trips a secret", () => {
    const { ct, nonce } = encryptServerSecret("totp-seed-ABC123");
    expect(decryptServerSecret(ct, nonce)).toBe("totp-seed-ABC123");
  });

  it("uses a fresh nonce per call and produces different ciphertext", () => {
    const a = encryptServerSecret("same");
    const b = encryptServerSecret("same");
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ct.equals(b.ct)).toBe(false);
    expect(decryptServerSecret(a.ct, a.nonce)).toBe("same");
    expect(decryptServerSecret(b.ct, b.nonce)).toBe("same");
  });

  it("fails authentication when the ciphertext is tampered with", () => {
    const { ct, nonce } = encryptServerSecret("secret");
    const bad = Buffer.from(ct);
    bad[0] ^= 0xff;
    expect(() => decryptServerSecret(bad, nonce)).toThrow();
  });

  it("fails authentication under the wrong nonce", () => {
    const { ct } = encryptServerSecret("secret");
    const wrongNonce = Buffer.alloc(12, 7);
    expect(() => decryptServerSecret(ct, wrongNonce)).toThrow();
  });
});
