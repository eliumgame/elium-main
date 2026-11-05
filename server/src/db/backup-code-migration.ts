import { withTx } from "./pool.js";
import { protectBackupDigest } from "../lib/crypto-server.js";

/** Idempotent startup migration. No plaintext codes and no weak-hash fallback. */
export async function hardenBackupCodes(): Promise<void> {
  for (;;) {
    const count = await withTx(async (c) => {
      const { rows } = await c.query<{ id: string; user_id: string; code_hash: string }>(
        `SELECT id, user_id, code_hash FROM mfa_backup_codes
          WHERE code_hash ~ '^[0-9a-f]{64}$' LIMIT 500 FOR UPDATE SKIP LOCKED`,
      );
      for (const row of rows) {
        await c.query(`UPDATE mfa_backup_codes SET code_hash = $2 WHERE id = $1`, [
          row.id,
          protectBackupDigest(row.user_id, row.code_hash),
        ]);
      }
      return rows.length;
    });
    if (count < 500) break;
  }
}
