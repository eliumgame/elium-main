import { defineConfig } from "@playwright/test";

/**
 * Config minimale dédiée aux tests d'accessibilité (axe-core) — voir
 * tests/a11y.spec.ts. Pas de tests fonctionnels Playwright ici : ceux-là
 * restent en Vitest (tests/*.test.ts) ; Playwright n'existe dans ce repo
 * QUE pour driver un vrai navigateur au service d'axe-core, qui a besoin
 * d'un rendu réel (calcul de contraste, mise en page) qu'un DOM jsdom ne
 * fournit pas.
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /a11y\.spec\.ts/,
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "npx vite --port 3100 --strictPort",
    url: "http://localhost:3100",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
