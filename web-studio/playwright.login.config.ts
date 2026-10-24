import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * Parcours de connexion de bout en bout dans un VRAI navigateur contre un VRAI
 * serveur Drive (PostgreSQL embarqué, base neuve à chaque lancement) :
 * tests/login-journey.spec.ts. Lancer : `npm run test:e2e:login`.
 */
// Posé dans l'environnement du processus parent : hérité par les workers et les serveurs.
process.env.LOGIN_E2E_DIR ??= mkdtempSync(join(tmpdir(), "elium-login-e2e-"));
const API_PORT = 8791;
const WEB_PORT = 3191;

export default defineConfig({
  testDir: "./tests",
  testMatch: /login-journey\.spec\.ts/,
  timeout: 900_000,
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
        DEV_DRIVE_DIR: process.env.LOGIN_E2E_DIR,
        DEV_PG_PORT: "54397",
        PORT: String(API_PORT),
        ACTIVATION_CODE: "AAAA-BBBB-CCCC",
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
