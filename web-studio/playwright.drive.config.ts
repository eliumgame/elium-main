import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Parcours du Drive entreprise / portail / parapheur dans un VRAI navigateur, plusieurs comptes
 * (tests/drive-*.spec.ts). Environnement isolé : base PostgreSQL embarquée neuve, ports dédiés.
 * Lancer : `npm run test:e2e:drive`.
 */
process.env.DRIVE_E2E_DIR ??= mkdtempSync(join(tmpdir(), "elium-drive-e2e-"));
const API_PORT = 8805;
const WEB_PORT = 3205;

export default defineConfig({
  testDir: "./tests",
  testMatch: /drive-[a-z-]+\.spec\.ts/,
  timeout: 300_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: "retain-on-failure",
    actionTimeout: 30_000,
    screenshot: "only-on-failure",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: [
    {
      command: "npx tsx tests/dev-drive-server.ts",
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: !!process.env.DRIVE_E2E_REUSE, // DRIVE_E2E_REUSE=1 : serveurs déjà lancés (itération rapide)
      timeout: 240_000,
      env: {
        DEV_DRIVE_DIR: process.env.DRIVE_E2E_DIR,
        DEV_PG_PORT: "54415",
        PORT: String(API_PORT),
        SINGLE_DRIVE: "true",
        OWNER_EMAIL: "owner-p@test.local",
        ACTIVATION_CODE: "DRIV-EE2E-TEST",
        CORS_ORIGINS: `http://localhost:${WEB_PORT}`,
      },
    },
    {
      command: `npx vite --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: !!process.env.DRIVE_E2E_REUSE, // DRIVE_E2E_REUSE=1 : serveurs déjà lancés (itération rapide)
      timeout: 90_000,
      env: { DEV_API_TARGET: `http://127.0.0.1:${API_PORT}` },
    },
  ],
});
