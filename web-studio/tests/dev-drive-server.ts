/**
 * Lanceur de développement LOCAL de la pile Drive entreprise — SANS Docker.
 *
 * Boote un VRAI PostgreSQL embarqué (persistant, pour garder les comptes et les
 * documents entre deux redémarrages), applique les migrations, puis démarre la
 * VRAIE API Fastify + le relais WebSocket collab sur le port 8787 — exactement
 * ce que `server/src/server.ts` fait, mais sans exiger un Postgres système ni
 * Docker sur la machine de dev.
 *
 * Lancer :  npx tsx tests/dev-drive-server.ts   (depuis web-studio/)
 * Puis :    npm run dev  (Vite) et pointer VITE_API_BASE / l'override runtime
 *           sur http://localhost:8787/api pour co-éditer en vrai à deux onglets.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const PG_PORT = Number(process.env.DEV_PG_PORT ?? 54321);
const API_PORT = Number(process.env.PORT ?? 8787);
// Données persistantes sous le dossier du projet (ignoré par git) : les comptes
// et documents survivent aux redémarrages, indispensable pour tester le collab.
const DATA_ROOT = join(process.cwd(), ".dev-drive");
const PG_DIR = join(DATA_ROOT, "pg");
const BLOB_DIR = join(DATA_ROOT, "blobs");

async function main(): Promise<void> {
  mkdirSync(PG_DIR, { recursive: true });
  mkdirSync(BLOB_DIR, { recursive: true });

  // L'environnement DOIT être posé avant l'import des modules serveur
  // (config.ts lit process.env à l'import).
  process.env.NODE_ENV = process.env.NODE_ENV ?? "development";
  process.env.DATABASE_URL = `postgres://elium:elium@127.0.0.1:${PG_PORT}/elium`;
  process.env.TOKEN_SECRET = process.env.TOKEN_SECRET ?? "dev-only-change-me-please-32bytes-minimum-secret";
  process.env.STORAGE_DRIVER = "fs";
  process.env.STORAGE_FS_ROOT = BLOB_DIR;
  process.env.PORT = String(API_PORT);
  process.env.HOST = "127.0.0.1";
  // Autorise le front Vite (5173) et le preview (3100) à parler à l'API.
  process.env.CORS_ORIGINS =
    process.env.CORS_ORIGINS ?? "http://localhost:5173,http://localhost:3100,http://127.0.0.1:5173";

  console.log(`[dev-drive] PostgreSQL embarqué → ${PG_DIR} (port ${PG_PORT})`);
  const pg = new EmbeddedPostgres({
    databaseDir: PG_DIR,
    user: "elium",
    password: "elium",
    port: PG_PORT,
    persistent: true,
    onLog: () => {},
    onError: (e: unknown) => console.error("[pg]", e),
  });

  // initialise() échoue si le cluster existe déjà : on démarre alors directement.
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("elium");
  } catch {
    await pg.start().catch(() => {});
  }
  console.log("[dev-drive] PostgreSQL démarré.");

  const { migrate } = await import("../../server/src/db/migrate");
  const { buildApp } = await import("../../server/src/app");
  const { closePool } = await import("../../server/src/db/pool");

  await migrate();
  console.log("[dev-drive] Migrations appliquées.");

  const app = await buildApp();
  await app.listen({ port: API_PORT, host: "127.0.0.1" });
  console.log(`\n  ✅  API Drive prête → http://127.0.0.1:${API_PORT}/api`);
  console.log(`      Health          → http://127.0.0.1:${API_PORT}/api/health`);
  console.log(`      WS collab        → ws://127.0.0.1:${API_PORT}/api/collab/:nodeId\n`);

  const shutdown = async (sig: string) => {
    console.log(`\n[dev-drive] ${sig} — arrêt…`);
    try {
      await app.close();
      await closePool();
      await pg.stop();
    } catch {
      /* best-effort */
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[dev-drive] Démarrage impossible:", err);
  process.exit(1);
});
