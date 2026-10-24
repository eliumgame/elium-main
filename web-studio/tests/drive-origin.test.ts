import { describe, it, expect } from "vitest";
import { driveOriginOf, syncDriveOrigin } from "../src/storage/drive-origin";

const mem = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};

function launcher(current: string | null, accept = true) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (init?.method === "POST") return new Response("{}", { status: accept ? 200 : 400 });
    return new Response(JSON.stringify({ origin: current }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("origine du Drive pour la CSP du lanceur", () => {
  it("extrait l'origine, ignore le relatif et les autres schémas", () => {
    expect(driveOriginOf("https://drive.example.com/api")).toBe("https://drive.example.com");
    expect(driveOriginOf("http://127.0.0.1:8787/api")).toBe("http://127.0.0.1:8787");
    expect(driveOriginOf("/api")).toBeNull();
    expect(driveOriginOf("javascript:alert(1)")).toBeNull();
    expect(driveOriginOf(null)).toBeNull();
  });

  it("déclare l'origine avec le jeton, puis recharge UNE seule fois", async () => {
    const l = launcher(null);
    let reloads = 0;
    const env = {
      fetchFn: l.fetchFn,
      storage: mem({ elium_drive_api_base: "https://drive.example.com/api" }),
      session: mem(),
      token: () => "jeton",
      reload: () => void reloads++,
    };
    expect(await syncDriveOrigin(env)).toBe("reloaded");
    expect(reloads).toBe(1);
    const post = l.calls.find((c) => c.init?.method === "POST")!;
    expect((post.init!.headers as Record<string, string>)["X-Elium-Token"]).toBe("jeton");
    expect(JSON.parse(post.init!.body as string)).toEqual({ origin: "https://drive.example.com" });
    // Le lanceur n'a pas (encore) appliqué : pas de boucle de rechargement.
    expect(await syncDriveOrigin(env)).toBe("ok");
    expect(reloads).toBe(1);
  });

  it("rien à faire si déjà déclarée, sans réglage, sans jeton ou refusée par le lanceur", async () => {
    const base = { storage: mem({ elium_drive_api_base: "https://drive.example.com" }), session: mem() };
    expect(
      await syncDriveOrigin({ ...base, fetchFn: launcher("https://drive.example.com").fetchFn, token: () => "t" }),
    ).toBe("ok");
    expect(
      await syncDriveOrigin({ storage: mem(), session: mem(), fetchFn: launcher(null).fetchFn, token: () => "t" }),
    ).toBe("none");
    expect(await syncDriveOrigin({ ...base, fetchFn: launcher(null).fetchFn, token: () => null })).toBe("none");
    expect(
      await syncDriveOrigin({ ...base, fetchFn: launcher(null, false).fetchFn, token: () => "t", reload: () => {} }),
    ).toBe("refused");
    const notLauncher = (async () =>
      new Response("<html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;
    expect(await syncDriveOrigin({ ...base, fetchFn: notLauncher, token: () => "t" })).toBe("none");
  });
});
