/**
 * Versioned schema migrations.
 *
 * Migration files live in `./migrations/NNNN_name.sql` and are applied in
 * filename order, each exactly once, recorded in the `schema_migrations` table.
 * The runner is safe to invoke on every deploy / container start (idempotent):
 * already-applied migrations are skipped.
 *
 * Adoption of pre-existing databases: `0001_baseline.sql` IS the historical
 * schema and is fully idempotent (CREATE ... IF NOT EXISTS + guarded blocks),
 * so a database that already carries the full schema simply runs it once as a
 * no-op and records it — no special baseline detection needed.
 *
 * Run standalone via `npm run migrate`.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool, query, withTx, closePool } from "./pool.js";
import { SYSTEM_ROLE_TEMPLATES } from "../rbac/roles.js";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "migrations");

export interface Migration {
  version: string; // filename without extension, e.g. "0001_baseline"
  sql: string;
  checksum: string; // sha256 of the LF-normalized SQL
}

/** sha256 hex of the content, with CRLF normalized to LF so checksums are
 *  stable across platforms (a Windows CRLF checkout must match a Linux LF one). */
function checksumOf(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

/** Read + sort every migration file. Pure aside from disk I/O. */
export function readMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b, "en"));
  return files.map((f) => {
    const sql = readFileSync(join(dir, f), "utf8");
    return { version: f.replace(/\.sql$/, ""), sql, checksum: checksumOf(sql) };
  });
}

/**
 * Pure decision logic: which migrations still need applying, in order.
 * Exposed for unit testing (the disk/DB paths above/below are not unit-testable
 * without a live Postgres). Also surfaces checksum drift on already-applied
 * migrations (a developer editing an immutable, already-shipped migration).
 */
export function planMigrations(
  all: Migration[],
  applied: Map<string, string>,
): { pending: Migration[]; drift: { version: string; expected: string; actual: string }[] } {
  const pending: Migration[] = [];
  const drift: { version: string; expected: string; actual: string }[] = [];
  for (const m of all) {
    const priorChecksum = applied.get(m.version);
    if (priorChecksum === undefined) {
      pending.push(m);
    } else if (priorChecksum !== m.checksum) {
      drift.push({ version: m.version, expected: priorChecksum, actual: m.checksum });
    }
  }
  return { pending, drift };
}

async function ensureMigrationsTable(): Promise<void> {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version    TEXT PRIMARY KEY,
       checksum   TEXT NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

async function runMigrations(): Promise<number> {
  await ensureMigrationsTable();

  const appliedRows = await query<{ version: string; checksum: string }>(
    `SELECT version, checksum FROM schema_migrations`,
  );
  const applied = new Map(appliedRows.map((r) => [r.version, r.checksum]));

  const all = readMigrations();
  const { pending, drift } = planMigrations(all, applied);

  for (const d of drift) {
    console.warn(
      `[migrate] ⚠ checksum drift on already-applied migration ${d.version} ` +
        `(recorded ${d.expected.slice(0, 12)}…, file ${d.actual.slice(0, 12)}…). ` +
        `Applied migrations are immutable — this edit was NOT re-run.`,
    );
  }

  for (const m of pending) {
    await withTx(async (client) => {
      await client.query(m.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)`,
        [m.version, m.checksum],
      );
    });
    console.log(`[migrate] applied ${m.version}`);
  }
  return pending.length;
}

/** Seed the global (org_id = NULL) system-role templates. These are the source
 *  for cloning per-org roles at organization creation. Re-run every time so
 *  permission-catalog updates to system roles propagate (idempotent upsert). */
async function seedSystemRoles(): Promise<void> {
  for (const tpl of SYSTEM_ROLE_TEMPLATES) {
    await query(
      `INSERT INTO roles (org_id, key, name, description, color, is_system, permissions)
       VALUES (NULL, $1, $2, $3, $4, true, $5)
       ON CONFLICT (key) WHERE org_id IS NULL DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             color = EXCLUDED.color,
             permissions = EXCLUDED.permissions,
             updated_at = now()`,
      [tpl.key, tpl.name, tpl.description, tpl.color, tpl.permissions],
    );
  }
}

/**
 * Apply pending migrations then (re)seed system roles. Safe on every start.
 * Signature unchanged (no args) — callers in tests/dev depend on it.
 */
export async function migrate(): Promise<void> {
  const n = await runMigrations();
  await seedSystemRoles();
  console.log(
    `[migrate] up to date (${n} migration${n === 1 ? "" : "s"} applied this run), ` +
      `${SYSTEM_ROLE_TEMPLATES.length} system roles seeded.`,
  );
}

// Run directly (node/tsx entrypoint).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[migrate] failed:", err);
      process.exit(1);
    });
}
