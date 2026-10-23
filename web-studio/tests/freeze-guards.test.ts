import { describe, expect, it } from "vitest";
import { zlibSync } from "fflate";
import { toB64 } from "../src/crypto/local-vault";
import { logIncident, getCrashLog, clearCrashLog } from "../src/ui/crash-log";

describe("base64 du coffre", () => {
  it("aller-retour identique et rapide sur 40 Mo", () => {
    const a = new Uint8Array(40 * 1024 * 1024);
    for (let i = 0; i < a.length; i += 997) a[i] = i & 255;
    const t0 = performance.now();
    const b64 = toB64(a);
    const dt = performance.now() - t0;
    expect(Buffer.from(b64, "base64").equals(Buffer.from(a))).toBe(true);
    expect(dt).toBeLessThan(8000); // marge pour une machine chargée ; l'ancien code dépassait la minute
  });
  it("petites entrées", () => {
    expect(toB64(new Uint8Array([]))).toBe("");
    expect(toB64(new Uint8Array([104, 105]))).toBe("aGk=");
  });
});

describe("journal d'incidents de performance", () => {
  it("logIncident ajoute une entrée sans lever", () => {
    const store = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    clearCrashLog();
    logIncident("gel", "Interface figée 450 ms (vue /)");
    expect(getCrashLog().at(-1)).toMatchObject({ source: "gel" });
  });
});

describe("décompression bornée d'un chunk PNG", () => {
  it("rejette une bombe zlib sans la déployer", async () => {
    const { decodePngTextChunk } = await import("../src/detector/imageSignals");
    const bomb = zlibSync(new Uint8Array(200 * 1024 * 1024), { level: 9 }); // quelques centaines de Ko → 200 Mo
    expect(bomb.length).toBeLessThan(400_000);
    const t0 = performance.now();
    const data = new Uint8Array([...new TextEncoder().encode("Comment"), 0, 0, ...bomb]);
    expect(decodePngTextChunk({ type: "zTXt", data } as never)).toBeUndefined();
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
