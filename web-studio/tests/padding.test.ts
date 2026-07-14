import { describe, it, expect } from "vitest";
import { padmeLength, generateNodeKey, encryptContent, decryptContent } from "../src/drive-cloud/node-crypto";

describe("size padding (Padmé) for Drive content", () => {
  it("collapses distinct small sizes onto the same bucket", () => {
    // Everything <= 64 (incl. the 4-byte length frame) lands on the 64 floor.
    expect(padmeLength(1)).toBe(64);
    expect(padmeLength(40)).toBe(64);
    expect(padmeLength(64)).toBe(64);
  });

  it("keeps the overhead bounded (< 12 %) across a wide size range", () => {
    for (const n of [100, 300, 1000, 5000, 50_000, 500_000, 5_000_000]) {
      const padded = padmeLength(n);
      expect(padded).toBeGreaterThanOrEqual(n);
      expect((padded - n) / n).toBeLessThan(0.12);
    }
  });

  it("is monotonic (never shrinks) and quantizes to few distinct values", () => {
    const buckets = new Set<number>();
    let prev = 0;
    for (let n = 1; n <= 4096; n++) {
      const p = padmeLength(n);
      expect(p).toBeGreaterThanOrEqual(prev === 0 ? 0 : padmeLength(n - 1) === p ? p : 0);
      buckets.add(p);
      prev = p;
    }
    // 4096 distinct input sizes must collapse onto a small number of buckets.
    expect(buckets.size).toBeLessThan(120);
  });

  it("encrypt→decrypt round-trips exactly for many sizes, and pads the ciphertext", async () => {
    const key = generateNodeKey();
    for (const n of [0, 1, 17, 63, 64, 65, 200, 1234]) {
      const pt = crypto.getRandomValues(new Uint8Array(n));
      const { nonceHex, ciphertext } = await encryptContent(key, pt);
      // Ciphertext = padme(n+4) + 16-byte GCM tag → hides the true length.
      expect(ciphertext.length).toBe(padmeLength(n + 4) + 16);
      const back = await decryptContent(key, nonceHex, ciphertext);
      expect(back.length).toBe(n);
      expect([...back]).toEqual([...pt]);
    }
  });

  it("two very different small payloads yield identical stored ciphertext length", async () => {
    const key = generateNodeKey();
    const a = await encryptContent(key, new Uint8Array(1));
    const b = await encryptContent(key, new Uint8Array(50));
    expect(a.ciphertext.length).toBe(b.ciphertext.length);
  });
});
