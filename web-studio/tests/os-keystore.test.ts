import { describe, it, expect } from "vitest";
import { createLauncherKeystore, osKeystoreAvailable, type FetchLike } from "../src/crypto/os-keystore";
import { createMemoryStore, createMaster, getMasterRecord, setOsProtection, KeyringError } from "../src/crypto/keyring";
import { KeyringSession } from "../src/crypto/keyring-session";
import { changeKeyringPassword } from "../src/crypto/keyring-password";
import { toHex, fromHex } from "../src/format/canonical";

/** Faux « DPAPI » : XOR réversible avec un marqueur, pour tester le câblage sans Windows. */
function fakeOs(opts: { failUnwrap?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    wrap: async (hex: string) => (calls.push("wrap"), "dd" + hex),
    unwrap: async (hex: string) => {
      calls.push("unwrap");
      if (opts.failUnwrap || !hex.startsWith("dd")) throw new Error("refusé");
      return hex.slice(2);
    },
  };
}

describe("couche Windows (DPAPI) — client", () => {
  it("envoie le jeton de session, du binaire, et traduit 501/refus en messages français", async () => {
    const seen: { url: string; token: string | null; body: string }[] = [];
    const f: FetchLike = async (url, init) => {
      const h = init!.headers as Record<string, string>;
      seen.push({ url, token: h["X-Elium-Token"], body: toHex(init!.body as Uint8Array) });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };
    const os = createLauncherKeystore(f, "tok")!;
    expect(await os.wrap("aabb")).toBe("010203");
    expect(seen[0]).toEqual({ url: "/__keystore__/wrap", token: "tok", body: "aabb" });
    expect(createLauncherKeystore(f, null)).toBeNull();

    const f501: FetchLike = async () => new Response("", { status: 501 });
    await expect(createLauncherKeystore(f501, "t")!.wrap("00")).rejects.toThrow(/plateforme/);
    const f422: FetchLike = async () => new Response("", { status: 422 });
    await expect(createLauncherKeystore(f422, "t")!.unwrap("00")).rejects.toThrow(/autre compte/);
    expect(await osKeystoreAvailable(createLauncherKeystore(f501, "t"))).toBe(false);
    expect(await osKeystoreAvailable(null)).toBe(false);
    expect(fromHex("00")).toHaveLength(1);
  });
});

describe("couche Windows — trousseau", () => {
  it("le mot de passe reste exigé ; la couche se retire ; un autre compte Windows est refusé explicitement", async () => {
    const store = createMemoryStore();
    const { master } = await createMaster(store, "pw");
    const os = fakeOs();
    const plain = (await getMasterRecord(store))!.passwordWrap!;
    await setOsProtection(store, os, true);
    const rec = (await getMasterRecord(store))!;
    expect(rec.osLayer).toBe(true);
    expect(rec.passwordWrap).toBe("dd" + plain);

    const s = new KeyringSession({ idleMinutes: 0 });
    await s.unlockWithPassword(store, "pw", os);
    expect(Array.from(s.getMaster()!)).toEqual(Array.from(master));
    await expect(new KeyringSession({ idleMinutes: 0 }).unlockWithPassword(store, "faux", os)).rejects.toThrow(KeyringError);
    // Sans lanceur (navigateur) ou autre compte : message dédié, pas « mauvais mot de passe ».
    await expect(new KeyringSession({ idleMinutes: 0 }).unlockWithPassword(store, "pw", null)).rejects.toThrow(/protégé par Windows/);
    await expect(new KeyringSession({ idleMinutes: 0 }).unlockWithPassword(store, "pw", fakeOs({ failUnwrap: true }))).rejects.toThrow();

    // Le changement de mot de passe conserve la couche.
    await changeKeyringPassword(store, "pw", "pw2", os);
    expect((await getMasterRecord(store))!.passwordWrap!.startsWith("dd")).toBe(true);
    await new KeyringSession({ idleMinutes: 0 }).unlockWithPassword(store, "pw2", os);

    await setOsProtection(store, os, false);
    const off = (await getMasterRecord(store))!;
    expect(off.osLayer).toBeUndefined();
    expect(off.passwordWrap!.startsWith("dd")).toBe(false);
    await new KeyringSession({ idleMinutes: 0 }).unlockWithPassword(store, "pw2", null);
  }, 120000);
});
