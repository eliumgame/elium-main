/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    // Dev uniquement (ignoré par `vite build`) : proxifie l'API Drive + le relais
    // WebSocket collab vers le serveur local (tests/dev-drive-server.ts) en
    // MÊME origine, ce qui évite toute configuration CORS et fait fonctionner le
    // WebSocket chiffré sans réglage. Surchargeable via DEV_API_TARGET.
    proxy: {
      "/api": {
        target: process.env.DEV_API_TARGET ?? "http://127.0.0.1:8787",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    target: "esnext",
    rollupOptions: {
      output: {
        // Split the heaviest vendor libraries into their own chunks. Each is
        // reached only through a lazy view (PDF, Studio, Drive), so these stay
        // async — and tiptap/yjs are shared between the Studio and Drive editors
        // instead of duplicated. Keeps the main bundle small and caches well.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          // React must have its own chunk: it's a dependency of @tiptap/react, so
          // without this it gets folded into vendor-tiptap and the eager main
          // bundle then static-imports (and eagerly loads) all of tiptap.
          if (/[\\/]node_modules[\\/](react-dom|react|scheduler)[\\/]/.test(id)) return "vendor-react";
          if (id.includes("pdf-lib") || id.includes("@pdf-lib") || id.includes("fontkit")) return "vendor-pdf-lib";
          if (id.includes("pdfjs-dist")) return "vendor-pdfjs";
          if (id.includes("@tiptap") || id.includes("prosemirror")) return "vendor-tiptap";
          if (id.includes("yjs") || id.includes("y-protocols") || id.includes("lib0")) return "vendor-yjs";
          if (id.includes("lowlight") || id.includes("highlight.js") || id.includes("refractor"))
            return "vendor-lowlight";
          // Only pulled in by the equation node view's dynamic import() (see
          // equationExtension.ts) — its own chunk keeps it out of the eager
          // main bundle for documents with no equation in them.
          if (id.includes("katex")) return "vendor-katex";
        },
      },
    },
  },
  test: {
    // Les tests crypto enchaînent plusieurs dérivations Argon2id (256 MiB,
    // ~1,3 s chacune) : le délai par défaut de 5 s peut être dépassé sur une
    // machine chargée. On laisse une marge confortable.
    testTimeout: 30000,
    // *.spec.ts (tests/a11y.spec.ts) est réservé à Playwright (voir
    // playwright.config.ts) : il importe @playwright/test, pas les globals
    // Vitest. Sans cette restriction, le glob par défaut de Vitest inclut
    // aussi *.spec.ts et tente (et échoue) de l'exécuter.
    include: ["tests/**/*.test.{ts,tsx}", "src/**/*.test.{ts,tsx}"],
  },
});
