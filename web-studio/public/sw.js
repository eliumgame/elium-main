/*
 * Elium offline service worker.
 * Elium est hors-ligne d'abord : une fois installé, tout fonctionne sans réseau.
 *
 * `scripts/gen-precache.mjs` (lancé après `vite build`) remplace les deux
 * marqueurs ci-dessous par la liste réelle des fichiers de dist/ et par un
 * identifiant de build. Deux niveaux de précache :
 *   - CORE  : le shell et tous les chunks JS/CSS → mis en cache à l'installation
 *             (l'application est utilisable hors-ligne dès que le SW est actif) ;
 *   - HEAVY : polices, modèles OCR, cœur WASM → mis en cache à l'activation, en
 *             tâche de fond, sans bloquer le démarrage.
 * Navigations : réseau d'abord, repli sur le shell. Assets : cache d'abord.
 * Le cross-origin n'est jamais touché.
 */
const BUILD = "__BUILD_ID__";
const CACHE = "elium-cache-" + BUILD;
const CORE = /*__PRECACHE_CORE__*/ [];
const HEAVY = /*__PRECACHE_HEAVY__*/ [];

async function warm(urls) {
  const cache = await caches.open(CACHE);
  await Promise.allSettled(
    urls.map(async (u) => {
      if (await cache.match(u)) return;
      const res = await fetch(u, { cache: "reload" });
      if (res && res.ok) await cache.put(u, res);
    }),
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(warm(["/index.html", ...CORE]).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
      await warm(HEAVY);
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // don't touch cross-origin
  // Endpoints dynamiques du lanceur de bureau (/__update__, /__open__ …) : jamais en cache.
  if (url.pathname.startsWith("/__")) return;

  if (req.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE);
          cache.put("/index.html", fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(CACHE);
          return (await cache.match("/index.html")) || (await cache.match(req)) || Response.error();
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req);
      if (cached) {
        // Les fichiers hashés sont immuables ; les autres sont rafraîchis en tâche de fond.
        if (!/\/assets\//.test(url.pathname) && !/\/(fonts|tesseract|tessdata|pdfjs)\//.test(url.pathname)) {
          fetch(req)
            .then((res) => {
              if (res && res.ok) cache.put(req, res.clone());
            })
            .catch(() => {});
        }
        return cached;
      }
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return Response.error();
      }
    })(),
  );
});
