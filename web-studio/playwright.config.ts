import { defineConfig } from "@playwright/test";

/**
 * Config Playwright — voir tests/a11y.spec.ts (scan d'accessibilité axe-core)
 * et tests/journeys.spec.ts (parcours utilisateur "gestes réels" : création/
 * édition, round-trip chiffré, imports, exports réels, ouverture des modules).
 * Les deux ont besoin d'un vrai navigateur (rendu, mise en page, téléchargements
 * de fichiers) qu'un DOM jsdom ne fournit pas — le reste des tests fonctionnels
 * (logique pure) reste en Vitest (tests/*.test.ts).
 */
export default defineConfig({
  testDir: "./tests",
  testMatch: /(a11y|journeys)\.spec\.ts/,
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
