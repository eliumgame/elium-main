/**
 * Postgres access. A single pool for the process; a tiny query helper and a
 * transaction wrapper. All SQL uses parameterized queries ($1, $2, ...) —
 * never string interpolation of user input.
 */
import pg from "pg";
import { config } from "../config.js";

// Return BIGINT (int8) as JS number where safe; sizes/seq stay within 2^53.
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
});

export type Row = Record<string, unknown>;

// Note: no `extends Row` constraint — that would reject named `interface` row
// types (interfaces have no implicit index signature). Callers pass whatever
// shape their SELECT returns; the cast is unchecked either way.
export async function query<T = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(text, params);
  return res.rows as T[];
}

/** Convenience: first row or null. */
export async function queryOne<T = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/** Run `fn` inside a transaction; commit on success, rollback on throw. */
export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* ignore rollback error, surface the original */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
