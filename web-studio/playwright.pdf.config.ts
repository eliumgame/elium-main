import { defineConfig } from "@playwright/test";

/**
 * Parcours PDF dans un vrai navigateur, sous les DEUX environnements où le
 * module doit marcher :
 *  - « drive »   : serveur de développement Vite, sans CSP (comme le Drive web) ;
 *  - « desktop » : build de production servi avec la CSP et les en-têtes lus
 *                  dans installer/elium_launcher.py (tests/support/desktop-server.py).
 * Lancer `npx vite build` avant (le projet desktop sert dist/).
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /pdf-.*\.spec\.ts/,
  timeout: 60_000,
  // Assertions wait longer than the default 5 s: under a loaded machine (the full suite in parallel), a
  // first render or a save can take that long, and an early timeout is not a defect.
  expect: { timeout: 12_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    trace: "retain-on-failure",
    acceptDownloads: true,
    // Conteneurs où le Chromium de Playwright est préinstallé ailleurs (cloud).
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  projects: [
    { name: "drive", use: { baseURL: "http://localhost:3101" } },
    { name: "desktop", use: { baseURL: "http://127.0.0.1:3102" } },
  ],
  webServer: [
    {
      command: "npx vite --port 3101 --strictPort",
      url: "http://localhost:3101",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "python3 tests/support/desktop-server.py 3102",
      url: "http://127.0.0.1:3102",
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
});
