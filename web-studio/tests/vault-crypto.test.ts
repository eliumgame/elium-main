import { describe, it, expect } from "vitest";
import { encryptAtRest, decryptAtRest, encryptBytesAtRest, decryptBytesAtRest } from "../src/crypto/local-vault";

describe("local-vault — encryptBytesAtRest / decryptBytesAtRest", () => {
  it("round-trips arbitrary binary content", async () => {
    const bytes = new Uint8Array(2000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) % 256; // non-trivial pattern
    const enc = await encryptBytesAtRest(bytes, { password: "coffre" });
    expect(typeof enc).toBe("string");
    const back = await decryptBytesAtRest(enc, { password: "coffre" });
    expect(back).toEqual(bytes);
  });

  it("fails with the wrong password", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const enc = await encryptBytesAtRest(bytes, { password: "bon" });
    await expect(decryptBytesAtRest(enc, { password: "mauvais" })).rejects.toBeTruthy();
  });

  it("handles an empty byte array", async () => {
    const bytes = new Uint8Array(0);
    const enc = await encryptBytesAtRest(bytes, { password: "x" });
    const back = await decryptBytesAtRest(enc, { password: "x" });
    expect(back).toEqual(bytes);
  });
});

// The vault's unlock verifier is just encryptAtRest/decryptAtRest against a
// fixed canary string (see format/vault-store.ts) — exercised here without
// touching IndexedDB, consistent with the project's other *-store tests.
describe("local-vault — vault verifier pattern", () => {
  const CANARY = "elium-vault-v1";

  it("the right password recovers the canary", async () => {
    const verifier = await encryptAtRest(CANARY, { password: "mon-coffre" });
    await expect(decryptAtRest<string>(verifier, { password: "mon-coffre" })).resolves.toBe(CANARY);
  });

  it("the wrong password neither recovers the canary nor throws a misleading success", async () => {
    const verifier = await encryptAtRest(CANARY, { password: "mon-coffre" });
    await expect(decryptAtRest<string>(verifier, { password: "autre-chose" })).rejects.toBeTruthy();
  });
});
