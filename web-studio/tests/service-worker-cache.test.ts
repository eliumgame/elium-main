import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function worker(response: Response | Error) {
  const handlers = new Map<string, (event: unknown) => void>();
  const cache = { match: vi.fn(), put: vi.fn(), delete: vi.fn() };
  const fetch = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), {
    self: { location: { origin: "https://app.test" }, addEventListener: (n: string, f: (e: unknown) => void) => handlers.set(n, f) },
    caches: { open: async () => cache }, URL, Response, fetch,
  });
  return {
    cache, fetch,
    async request(path: string, mode = "navigate") {
      let pending: Promise<Response> | undefined;
      handlers.get("fetch")!({ request: { url: `https://app.test${path}`, method: "GET", mode },
        respondWith: (p: Promise<Response>) => { pending = p; }, waitUntil: vi.fn() });
      return pending;
    },
  };
}

describe("service worker — intégrité du shell hors ligne", () => {
  it.each([502, 404])("ne remplace pas le shell par une erreur %i", async (status) => {
    const w = worker(new Response("error", { status, headers: { "content-type": "text/html" } }));
    await w.request("/");
    expect(w.cache.put).not.toHaveBeenCalled();
  });
  it.each(["/robots.txt", "/sitemap.xml", "/assets/a.js", "/api", "/api/health"])("ne traite pas %s comme shell", async (path) => {
    const w = worker(new Response("file"));
    await w.request(path);
    expect(w.fetch).not.toHaveBeenCalled();
  });
  it("ne met pas de HTML à la place d'un asset, même pendant le préchargement", async () => {
    const w = worker(new Response("<html>fallback</html>", { headers: { "content-type": "text/html" } }));
    await w.request("/assets/missing.js", "cors");
    expect(w.cache.put).not.toHaveBeenCalled();
  });
  it("conserve seulement une réponse HTML saine pour le shell", async () => {
    const w = worker(new Response("<html>app</html>", { headers: { "content-type": "text/html; charset=utf-8" } }));
    await w.request("/");
    expect(w.cache.put).toHaveBeenCalledWith("/index.html", expect.any(Response));
  });
  it("retrouve le shell en cas de panne réseau", async () => {
    const w = worker(new Error("offline"));
    w.cache.match.mockResolvedValue(new Response("cached shell"));
    expect(await (await w.request("/"))!.text()).toBe("cached shell");
  });
});
