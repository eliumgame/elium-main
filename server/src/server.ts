/** Process entrypoint: build the app, apply migrations, listen, shut down cleanly. */
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { closePool } from "./db/pool.js";
import { migrate } from "./db/migrate.js";

async function main(): Promise<void> {
  if (process.env.RUN_MIGRATIONS !== "false") {
    await migrate();
  }
  const app = await buildApp();
  await app.listen({ port: config.port, host: config.host });

  const shutdown = async (signal: string) => {
    app.log.info(`Signal ${signal} reçu — arrêt en cours…`);
    await app.close();
    await closePool();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Démarrage impossible:", err);
  process.exit(1);
});
