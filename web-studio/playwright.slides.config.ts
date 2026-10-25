import { defineConfig } from "@playwright/test";

/** Parcours Présentations (vrai navigateur, clavier et souris réels) — suite locale, sans serveur Drive. */
export default defineConfig({
  testDir: "./tests",
  testMatch: /slides-full\.spec\.ts/,
  timeout: 30_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.SLIDES_BASE_URL ?? "http://localhost:3203",
    trace: "retain-on-failure",
    actionTimeout: 8_000,
    viewport: { width: 1500, height: 950 },
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: process.env.SLIDES_BASE_URL
    ? undefined
    : {
        command: "npx vite --port 3203 --strictPort",
        url: "http://localhost:3203",
        reuseExistingServer: true,
        timeout: 60_000,
      },
});
