import { defineConfig } from "@playwright/test";

/**
 * Application Windows de bout en bout (vrai lanceur Python + vrai navigateur) : tests/windows-app-journey.spec.ts.
 * Prérequis : `npm run build`. Lancer : `npm run test:e2e:winapp`.
 */
const DEV_PORT = Number(process.env.WINAPP_DEV_PORT ?? 3421);

export default defineConfig({
  testDir: "./tests",
  testMatch: /windows-app-journey\.spec\.ts/,
  timeout: 240_000,
  retries: 0,
  workers: 1,
  reporter: "list",
  use: {
    trace: "retain-on-failure",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: {
    command: `npx vite --port ${DEV_PORT} --strictPort`,
    url: `http://localhost:${DEV_PORT}`,
    reuseExistingServer: false,
    timeout: 90_000,
  },
});
