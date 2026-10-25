import { defineConfig } from "@playwright/test";

/** Collaboration Présentations (2 navigateurs, vrai serveur Drive isolé) — voir tests/slides-collab.spec.ts. */
export default defineConfig({
  testDir: "./tests",
  testMatch: /slides-collab\.spec\.ts/,
  timeout: 240_000,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.SLIDES_BASE_URL ?? "http://localhost:3203",
    trace: "retain-on-failure",
    viewport: { width: 1500, height: 950 },
    actionTimeout: 20_000,
  },
});
