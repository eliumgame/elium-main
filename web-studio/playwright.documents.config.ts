import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Test complet du module Documents dans un VRAI navigateur contre un VRAI serveur Drive (PostgreSQL
 * embarqué, base neuve) : tests/documents-*.spec.ts. Tout passe par le clavier réel et les boutons
 * du ruban ; chaque résultat est relu (contenu, export ouvert, erreurs console, tâches longues).
 * Lancer : `npm run test:e2e:documents` (ports surchargeables : DOCS_API_PORT, DOCS_WEB_PORT, DOCS_PG_PORT).
 */
process.env.DOCS_E2E_DIR ??= mkdtempSync(join(tmpdir(), "elium-docs-e2e-"));
const API_PORT = Number(process.env.DOCS_API_PORT ?? 8801);
const WEB_PORT = Number(process.env.DOCS_WEB_PORT ?? 3201);

export default defineConfig({
  testDir: "./tests",
  testMatch: /documents-.*\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 15_000 },
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    acceptDownloads: true,
    trace: "retain-on-failure",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: [
    {
      command: "npx tsx tests/dev-drive-server.ts",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: !!process.env.DOCS_REUSE,
      timeout: 240_000,
      env: {
        DEV_DRIVE_DIR: process.env.DOCS_E2E_DIR,
        DEV_PG_PORT: String(Number(process.env.DOCS_PG_PORT ?? 54411)),
        PORT: String(API_PORT),
        ACTIVATION_CODE: "AAAA-BBBB-CCCC",
        SINGLE_DRIVE: "true",
        OWNER_EMAIL: "owner-b@test.local",
        CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !!process.env.DOCS_REUSE,
      timeout: 90_000,
      env: { DEV_API_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
