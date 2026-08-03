import { describe, it, expect } from "vitest";
import { wrapMaster, unwrapMaster } from "../src/drive-cloud/prf-unlock";

const bytes = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe("prf-unlock: enveloppe de la masterKey", () => {
  it("round-trip : unwrap(wrap(master)) == master avec le bon secret PRF", async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const master = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await wrapMaster(prf, master);
    const out = await unwrapMaster(prf, wrapped);
    expect(Array.from(out)).toEqual(Array.from(master));
  });

  it("un secret PRF différent échoue (GCM authentifié)", async () => {
    const prf = bytes(32, 7);
    const wrong = bytes(32, 9);
    const master = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await wrapMaster(prf, master);
    await expect(unwrapMaster(wrong, wrapped)).rejects.toBeTruthy();
  });

  it("un ciphertext altéré échoue", async () => {
    const prf = bytes(32, 3);
    const master = crypto.getRandomValues(new Uint8Array(32));
    const wrapped = await wrapMaster(prf, master);
    const tampered = { ...wrapped, ct: (wrapped.ct.startsWith("00") ? "ff" : "00") + wrapped.ct.slice(2) };
    await expect(unwrapMaster(prf, tampered)).rejects.toBeTruthy();
  });

  it("nonce unique à chaque enveloppe", async () => {
    const prf = bytes(32, 5);
    const master = bytes(32, 1);
    const a = await wrapMaster(prf, master);
    const b = await wrapMaster(prf, master);
    expect(a.nonce).not.toEqual(b.nonce);
  });
});
