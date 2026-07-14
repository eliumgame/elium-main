/**
 * Apply the schema (idempotent) and seed the global system-role templates.
 * Run via `npm run migrate`. Safe to run on every deploy / container start.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { pool, query, closePool } from "./pool.js";
import { SYSTEM_ROLE_TEMPLATES } from "../rbac/roles.js";

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate(): Promise<void> {
  const schema = readFileSync(join(here, "schema.sql"), "utf8");
  await pool.query(schema);

  // Seed global (org_id = NULL) system-role templates. These are the source
  // for cloning per-org roles at organization creation.
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
  // eslint-disable-next-line no-console
  console.log(`[migrate] schema applied, ${SYSTEM_ROLE_TEMPLATES.length} system roles seeded.`);
}

// Run directly (node/tsx entrypoint).
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[migrate] failed:", err);
      process.exit(1);
    });
}
