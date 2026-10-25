import { defineConfig } from "@playwright/test";

/**
 * Parcours « PDF complémentaires » et « Détecteur » dans un vrai navigateur (Vite de développement, faux
 * serveur d'API local pour une console propre) : tests/pdf-complement.spec.ts et tests/detector.spec.ts.
 * Lancer : `npm run test:browser:pdf-detector`. Ports : PDFDET_WEB_PORT (3231) et PDFDET_API_PORT (8799).
 */
const WEB = Number(process.env.PDFDET_WEB_PORT ?? 3231);
const API = Number(process.env.PDFDET_API_PORT ?? 8799);

export default defineConfig({
  testDir: "./tests",
  testMatch: /(pdf-complement|detector)\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 12_000 },
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: `http://localhost:${WEB}`,
    locale: "fr-FR",
    acceptDownloads: true,
    trace: "retain-on-failure",
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
  webServer: [
    {
      command: `node tests/support/api-stub.mjs ${API}`,
      url: `http://127.0.0.1:${API}/api/site/policy`,
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    {
      command: `npx vite --port ${WEB} --strictPort`,
      url: `http://localhost:${WEB}`,
      env: { DEV_API_TARGET: `http://127.0.0.1:${API}` },
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
  ],
});
