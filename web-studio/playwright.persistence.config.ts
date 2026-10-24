import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Persistance de bout en bout dans un VRAI navigateur contre un VRAI serveur Drive (PostgreSQL
 * embarqué, base neuve) : tests/persistence-journey.spec.ts. Un utilisateur crée du contenu dans tous
 * les modules, l'enregistrement disque est refusé (repli), la sauvegarde part dans le Drive ; un
 * navigateur VIERGE se reconnecte et retrouve tout à l'identique.
 * Lancer : `npm run test:e2e:persistence`.
 */
process.env.PERSIST_E2E_DIR ??= mkdtempSync(join(tmpdir(), "elium-persist-e2e-"));
const API_PORT = Number(process.env.PERSIST_API_PORT ?? 8797);
const WEB_PORT = Number(process.env.PERSIST_WEB_PORT ?? 3197);

export default defineConfig({
  testDir: "./tests",
  testMatch: /persistence-journey\.spec\.ts/,
  timeout: 420_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: [
    {
      command: "npx tsx tests/dev-drive-server.ts",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        DEV_DRIVE_DIR: process.env.PERSIST_E2E_DIR,
        DEV_PG_PORT: String(Number(process.env.PERSIST_PG_PORT ?? 54399)),
        PORT: String(API_PORT),
        ACTIVATION_CODE: "AAAA-BBBB-CCCC",
        SINGLE_DRIVE: "true",
        OWNER_EMAIL: "owner@example.test",
        CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 90_000,
      env: { DEV_API_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
