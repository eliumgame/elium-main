/** Point d'entrée : charge la configuration, démarre l'API, s'arrête proprement (compteurs sauvegardés). */
import { buildApp } from "./app.js";
import { envSettings, loadConfigFile } from "./config.js";
import { UsageTracker } from "./usage.js";

async function main(): Promise<void> {
  const s = envSettings();
  const cfg = loadConfigFile(s.configPath);
  const usage = new UsageTracker(s.usageFile);
  const app = buildApp(cfg, { usage, logger: { level: s.logLevel } });

  for (const [id, p] of Object.entries(cfg.providers)) {
    if (p.apiKeyEnv && !process.env[p.apiKeyEnv]) {
      app.log.warn(`fournisseur « ${id} » : variable ${p.apiKeyEnv} absente, il sera ignoré`);
    }
  }

  await app.listen({ host: s.host, port: s.port });

  const stop = async (signal: string) => {
    app.log.info(`${signal} reçu, arrêt…`);
    try {
      await app.close();
    } finally {
      usage.flush();
      process.exit(0);
    }
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
